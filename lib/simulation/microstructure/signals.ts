import type { Market, MarketRegime, ShockMemory } from "../../types";
import { TICK_CENTS, type BookState, type RestingOrder } from "../orderBookState";
import { gaussian } from "../../rng";
import {
  ADVERSE_IMBALANCE_GAIN,
  ADVERSE_VOL_REGIME_MULT,
  INFORMED_OBS_EWMA_GAIN,
  INFORMED_OBS_SIGMA,
  INFORMED_ROUTE_NOISE_MULT_SIGMA,
  MOMENTUM_LONG_WINDOW,
  MOMENTUM_SHORT_WINDOW,
  MOMENTUM_VOL_REF_CENTS,
  STALE_EDGE_THRESHOLD_CENTS,
  STALENESS_TICKS,
  URGENCY_FRESH_SHOCK_BUMP,
  URGENCY_FRESH_TICKS,
  URGENCY_VOL_SCALE,
} from "./config";

// -------------------------------------------------------------------------
// Pure-ish signal layer. Composable scoring functions consumed by archetype
// handlers. Only the noisy-observation function consumes RNG (for the
// Gaussian draw); everything else is deterministic in (market, regime).
// -------------------------------------------------------------------------

export type MomentumScore = {
  slope: number;       // EMA(short) − EMA(long), in cents
  ageTicks: number;    // ticks since slope last changed sign
  strength: number;    // |slope| / volRef, ~[0, 3]
};

function ema(values: number[], window: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (window + 1);
  let v = values[Math.max(0, values.length - window)];
  for (let i = Math.max(0, values.length - window) + 1; i < values.length; i++) {
    v = v + k * (values[i] - v);
  }
  return v;
}

export function momentumScore(history: readonly number[]): MomentumScore {
  if (history.length < 2) return { slope: 0, ageTicks: 0, strength: 0 };
  const shortEma = ema(history as number[], MOMENTUM_SHORT_WINDOW);
  const longEma = ema(history as number[], MOMENTUM_LONG_WINDOW);
  const slope = shortEma - longEma;
  const sign = slope > 0 ? 1 : slope < 0 ? -1 : 0;
  // Walk history backwards to find the last sign flip in instantaneous diff;
  // this is a cheap proxy for "how long has slope been pointing this way".
  let ageTicks = 0;
  for (let i = history.length - 1; i > 0 && ageTicks < history.length; i--) {
    const d = history[i] - history[i - 1];
    const ds = d > 0 ? 1 : d < 0 ? -1 : 0;
    if (sign !== 0 && ds !== 0 && ds !== sign) break;
    ageTicks++;
  }
  const strength = Math.abs(slope) / MOMENTUM_VOL_REF_CENTS;
  return { slope, ageTicks, strength };
}

// -------- book features (queue-aware) --------

export type BookFeatures = {
  spreadTicks: number;       // (ask - bid) / TICK_CENTS
  bidDepth: number;          // total size at best bid level
  askDepth: number;          // total size at best ask level
  imbalance: number;         // (bid - ask) / (bid + ask), [-1, 1]
  isThin: boolean;           // either side at top is below threshold
};

export function bookFeatures(market: Market, thinThreshold: number): BookFeatures {
  const bids = market.book?.bids ?? [];
  const asks = market.book?.asks ?? [];
  const bidPrice = bids[0]?.price ?? market.marketBid;
  const askPrice = asks[0]?.price ?? market.marketAsk;
  const bidDepth = bids[0]?.size ?? 0;
  const askDepth = asks[0]?.size ?? 0;
  const spread = Math.max(0, askPrice - bidPrice);
  const spreadTicks = Math.round(spread / TICK_CENTS);
  const denom = bidDepth + askDepth;
  const imbalance = denom > 0 ? (bidDepth - askDepth) / denom : 0;
  const isThin = bidDepth < thinThreshold || askDepth < thinThreshold;
  return { spreadTicks, bidDepth, askDepth, imbalance, isThin };
}

// -------- stale-quote scan (real latency_arb signal) --------

export type StaleQuoteHit = {
  side: "BID" | "ASK";       // side of the resting order to pick off
  edgeCents: number;         // signed (positive = profitable to lift/hit)
  ageTicks: number;
  priceCents: number;
};

// Walk the top of bookState (full matching-engine view, has postedTick) and
// look for the most lift-able offside resting order: a bid priced above
// fairValue or an ask priced below it, that's also stale (age ≥ threshold).
// Returns null when no qualifying quote exists — the latency_arb flavor then
// emits nothing. This is the real "stale quote exploitation" the name implies.
export function staleQuoteScan(
  market: Market,
  currentTick: number,
  fairValueCents: number,
): StaleQuoteHit | null {
  const book: BookState | undefined = market.bookState;
  if (!book) return null;
  let best: StaleQuoteHit | null = null;
  // Stale ask: ask price BELOW fair → buyer can lift it for profit.
  const askScan: RestingOrder | undefined = book.asks?.[0];
  if (askScan && askScan.owner !== "desk") {
    const age = currentTick - askScan.postedTick;
    const edge = fairValueCents - askScan.priceCents;   // we'd BUY at ask
    if (age >= STALENESS_TICKS && edge >= STALE_EDGE_THRESHOLD_CENTS) {
      best = { side: "ASK", edgeCents: edge, ageTicks: age, priceCents: askScan.priceCents };
    }
  }
  // Stale bid: bid price ABOVE fair → seller can hit it for profit.
  const bidScan: RestingOrder | undefined = book.bids?.[0];
  if (bidScan && bidScan.owner !== "desk") {
    const age = currentTick - bidScan.postedTick;
    const edge = bidScan.priceCents - fairValueCents;   // we'd SELL at bid
    if (age >= STALENESS_TICKS && edge >= STALE_EDGE_THRESHOLD_CENTS) {
      if (!best || edge > best.edgeCents) {
        best = { side: "BID", edgeCents: edge, ageTicks: age, priceCents: bidScan.priceCents };
      }
    }
  }
  return best;
}

// -------- noisy observation (informed only) --------

// Update the informed agent's private smoothed observation of latent truth.
// obsRaw = latentTrue + N(0, σ(regime)); obsLatent EWMA's toward it. No
// archetype ever reads market.dynamics.lastLatentTrueProbability directly;
// they read agent.obsLatent. This enforces "informed ≠ omniscient".
export function noisyLatentObservation(
  latentTrue: number,
  prevObs: number,
  regime: MarketRegime,
  seed: number,
): { obsLatent: number; seed: number } {
  const sigma = INFORMED_OBS_SIGMA[regime];
  const g = gaussian(seed);
  const obsRaw = latentTrue + g.v * sigma;
  const k = INFORMED_OBS_EWMA_GAIN;
  const obsLatent = (1 - k) * prevObs + k * obsRaw;
  return { obsLatent, seed: g.seed };
}

// -------- route-specific shock signal --------

export type RouteShockSignal = {
  sum: number;            // signed sum of remaining magnitudes on own line
  sign: -1 | 0 | 1;
  freshTicks: number;     // age of newest entry, large = no fresh news
};

export function routeShockSignal(market: Market): RouteShockSignal {
  const mem = market.dynamics?.eventMemory ?? [];
  let sum = 0;
  let newestBorn = -Infinity;
  for (const m of mem as ShockMemory[]) {
    if (m.category === "live" && m.originLine === market.line) {
      sum += m.remaining;
      if (m.bornTick > newestBorn) newestBorn = m.bornTick;
    }
  }
  const lastUpdated = market.dynamics?.lastUpdatedTick ?? 0;
  const freshTicks = newestBorn === -Infinity ? Number.POSITIVE_INFINITY : lastUpdated - newestBorn;
  const sign: -1 | 0 | 1 = Math.abs(sum) < 1e-6 ? 0 : sum > 0 ? 1 : -1;
  return { sum, sign, freshTicks };
}

// Same shape but with multiplicative noise applied (used by informed only).
export function noisyRouteShockSignal(
  market: Market,
  seed: number,
): { signal: RouteShockSignal; seed: number } {
  const base = routeShockSignal(market);
  if (base.sum === 0) return { signal: base, seed };
  const g = gaussian(seed);
  const noisySum = base.sum * (1 + g.v * INFORMED_ROUTE_NOISE_MULT_SIGMA);
  const sign: -1 | 0 | 1 = Math.abs(noisySum) < 1e-6 ? 0 : noisySum > 0 ? 1 : -1;
  return {
    signal: { sum: noisySum, sign, freshTicks: base.freshTicks },
    seed: g.seed,
  };
}

// -------- urgency / adverse-selection --------

// Total recent live shock magnitude scaled by regime + vol. Public signal —
// no privileged information here. Drives taker gates and passive cancels.
export function urgencyScore(market: Market, regime: MarketRegime): number {
  const mem = market.dynamics?.eventMemory ?? [];
  let mag = 0;
  let freshest = Number.POSITIVE_INFINITY;
  const lastUpdated = market.dynamics?.lastUpdatedTick ?? 0;
  for (const m of mem as ShockMemory[]) {
    if (m.category !== "live") continue;
    mag += Math.abs(m.remaining);
    const age = lastUpdated - m.bornTick;
    if (age < freshest) freshest = age;
  }
  const vol = market.vol ?? 0;
  const volTerm = 1 + URGENCY_VOL_SCALE * vol;
  const regimeMult = ADVERSE_VOL_REGIME_MULT[regime];
  const freshBump = freshest <= URGENCY_FRESH_TICKS ? URGENCY_FRESH_SHOCK_BUMP : 0;
  return mag * regimeMult * volTerm + freshBump;
}

// Risk to a passive maker from being adversely selected. Combines vol,
// regime, and queue imbalance (lopsided book → more dangerous to rest).
export function adverseSelectionScore(
  market: Market,
  regime: MarketRegime,
  features: BookFeatures,
): number {
  const vol = market.vol ?? 0;
  const regimeMult = ADVERSE_VOL_REGIME_MULT[regime];
  const base = vol * regimeMult;
  return base + Math.abs(features.imbalance) * ADVERSE_IMBALANCE_GAIN;
}

// -------- mispricing (built from agent's obsLatent — not from omniscient truth) --------

export function mispricingScoreCents(market: Market, obsLatent: number): number {
  const mid = (market.marketBid + market.marketAsk) / 2;
  return obsLatent * 100 - mid;
}
