import type { MarketRegime, TraderArchetype } from "../types";
import type { Intent } from "./microstructure/archetypes";
import { TICK_CENTS, type BookSide, type OrderOwner } from "./orderBookState";

// Map archetype labels onto book-side owner tags. The owner drives soft-
// cancel rates (lp / patient are stickier than noise / momentum), TTL
// selection, and any downstream narrative.
const OWNER_BY_ARCHETYPE: Record<Exclude<TraderArchetype, "desk_actor">, OrderOwner> = {
  noise: "noise",
  liquidity_provider: "lp",
  event_follower: "event",
  inventory_rebalancer: "rebal",
  momentum: "momentum",
  mean_reversion: "lp",
  patient_value: "patient",
  informed_transit: "informed",
  latency_arb: "informed",
  panic: "panic",
};

export function ownerFor(archetype: TraderArchetype): OrderOwner {
  if (archetype === "desk_actor") return "desk";
  return OWNER_BY_ARCHETYPE[archetype];
}

// Default TTLs (ticks). Looked up by owner + regime. Calm/recovery let
// passive liquidity sit; shock evaporates everything except patient flow.
// patient_value posts deep limits that should still survive a brief shock
// because they're not really competing for the touch.
const TTL_BY_OWNER_REGIME: Record<OrderOwner, Record<MarketRegime, number>> = {
  desk:     { calm: 999, alert: 999, shock: 999, recovery: 999 }, // unused; desk handled by syncDeskQuote
  lp:       { calm: 14,  alert: 9,   shock: 3,   recovery: 11 },
  patient:  { calm: 40,  alert: 28,  shock: 16,  recovery: 30 },
  noise:    { calm: 6,   alert: 4,   shock: 2,   recovery: 5 },
  momentum: { calm: 4,   alert: 3,   shock: 2,   recovery: 4 },
  rebal:    { calm: 10,  alert: 7,   shock: 3,   recovery: 8 },
  informed: { calm: 3,   alert: 2,   shock: 1,   recovery: 3 },
  event:    { calm: 4,   alert: 3,   shock: 2,   recovery: 4 },
  panic:    { calm: 2,   alert: 2,   shock: 2,   recovery: 2 },
};

export function ttlFor(
  owner: OrderOwner,
  regime: MarketRegime,
  intent: Intent,
): number {
  if (typeof intent.ttlTicks === "number" && intent.ttlTicks > 0) {
    return Math.floor(intent.ttlTicks);
  }
  return TTL_BY_OWNER_REGIME[owner][regime];
}

// Convenience packaging: take what runArchetype emitted and produce a
// routing record. bookReducer.applyIntents iterates these.
export type RoutedIntent = {
  archetype: TraderArchetype;
  owner: OrderOwner;
  intent: Intent;
  ttlTicks: number;
};

export function route(
  archetype: TraderArchetype,
  intent: Intent,
  regime: MarketRegime,
): RoutedIntent {
  const owner = ownerFor(archetype);
  const ttlTicks = ttlFor(owner, regime, intent);
  return { archetype, owner, intent, ttlTicks };
}

// Soft-cancel base probability per tick, by owner + regime. ageAndCancel
// in bookReducer draws one uniform per resting non-desk order; if the draw
// is under this probability, the order is cancelled. Desk orders are
// explicitly replaced by syncDeskQuote, never soft-cancelled.
//
// Calm: low churn — orders sit and get filled or aged out naturally.
// Shock: aggressive pull as LPs widen / get out of the way.
const SOFT_CANCEL_RATE: Record<OrderOwner, Record<MarketRegime, number>> = {
  desk:     { calm: 0,    alert: 0,    shock: 0,    recovery: 0 },
  lp:       { calm: 0.04, alert: 0.10, shock: 0.32, recovery: 0.08 },
  patient:  { calm: 0.01, alert: 0.03, shock: 0.10, recovery: 0.02 },
  noise:    { calm: 0.12, alert: 0.18, shock: 0.40, recovery: 0.14 },
  momentum: { calm: 0.20, alert: 0.25, shock: 0.45, recovery: 0.22 },
  rebal:    { calm: 0.06, alert: 0.10, shock: 0.25, recovery: 0.08 },
  informed: { calm: 0.25, alert: 0.30, shock: 0.50, recovery: 0.28 },
  event:    { calm: 0.15, alert: 0.20, shock: 0.40, recovery: 0.18 },
  panic:    { calm: 0.30, alert: 0.35, shock: 0.55, recovery: 0.30 },
};

export function softCancelRate(owner: OrderOwner, regime: MarketRegime): number {
  return SOFT_CANCEL_RATE[owner][regime];
}

// Fair-value magnet. When the displayed mid drifts well away from fair,
// archetype matching alone is too slow to mean-revert (LP refills replace
// consumed depth at the same wrong price). The magnet leans against this
// without re-introducing direct Kyle drift:
//   - faster soft-cancel on the side propping up the mispricing
//   - extra market-order pressure in the fair direction
//   - LP replenishment biased toward fair
//   - a small RNG-gated sweep when divergence is wide
// All effects are gradual and seeded through SimState.rngState.

export type DivergenceMode = "none" | "mild" | "strong";

export type DivergenceContext = {
  // fair - mid, in cents. Sign indicates which way we need to move mid:
  // +ve → mid is too low, push UP. -ve → mid is too high, push DOWN.
  divergenceCents: number;
  mode: DivergenceMode;
};

// 8¢ is wide enough that two-sided flow alone won't close it within a
// minute of demo time; 15¢ is wide enough that the desk's edge is so
// large the demo would look broken without intervention.
const MILD_THRESHOLD = 8;
const STRONG_THRESHOLD = 15;

export function divergenceContext(
  fairCents: number,
  midCents: number,
): DivergenceContext {
  const div = fairCents - midCents;
  const abs = Math.abs(div);
  const mode: DivergenceMode =
    abs > STRONG_THRESHOLD ? "strong" : abs > MILD_THRESHOLD ? "mild" : "none";
  return { divergenceCents: div, mode };
}

// Multiplier on softCancelRate for orders on the "wrong" side — the side
// of the book that's propping up the current mispricing. Mid below fair
// (div > 0) means the asks are too cheap and the bids are too low — both
// hold mid down. We bias toward cancelling asks (cheap supply) and bids
// (low demand) on the way up, but the dominant pressure is on the side
// nearest the touch on the wrong direction.
//
// Practical rule:
//   div > 0 (need mid up):   asks are the wrong side — cancel them faster
//   div < 0 (need mid down): bids are the wrong side — cancel them faster
//
// Desk and patient orders are unaffected — desk is owned by syncDeskQuote
// and patient_value is by design slow.
export function softCancelMultiplier(
  owner: OrderOwner,
  side: BookSide,
  divCtx: DivergenceContext,
): number {
  if (divCtx.mode === "none") return 1;
  if (owner === "desk" || owner === "patient") return 1;
  const wrongSide: BookSide = divCtx.divergenceCents > 0 ? "ASK" : "BID";
  if (side !== wrongSide) return 1;
  return divCtx.mode === "strong" ? 2.5 : 1.5;
}

// Where a magnet LP should post. Picks a price one tick inside the touch
// on the side that pulls mid toward fair, bounded so it doesn't cross.
// Returns null when the geometry doesn't allow a non-crossing magnet
// (e.g. spread is already at the minimum tick).
export function magnetLpPlacement(
  divCtx: DivergenceContext,
  midCents: number,
  fairCents: number,
  bestBidCents: number,
  bestAskCents: number,
): { side: BookSide; priceCents: number } | null {
  if (divCtx.mode === "none") return null;

  // Halfway between current mid and fair, capped at 3¢ from mid so each
  // placement is a measured step rather than a leap.
  const halfStep = Math.min(3, Math.abs(divCtx.divergenceCents) / 2);
  if (divCtx.divergenceCents > 0) {
    // Need mid up — magnet posts a BID above the current best bid, just
    // shy of the best ask so it doesn't cross.
    const target = Math.min(midCents + halfStep, bestAskCents - TICK_CENTS);
    if (target <= bestBidCents) return null; // already covered
    return { side: "BID", priceCents: target };
  }
  const target = Math.max(midCents - halfStep, bestBidCents + TICK_CENTS);
  if (target >= bestAskCents) return null;
  return { side: "ASK", priceCents: target };
}

export function divergenceFlowReason(divCtx: DivergenceContext): string | null {
  if (divCtx.mode === "none") return null;
  // Plain-English explanation of why extra one-sided flow is showing up.
  // div > 0 means fair sits above mid → informed flow lifts the ask;
  // div < 0 means fair sits below mid → informed flow hits the bid.
  const leaning = divCtx.divergenceCents > 0 ? "lifting the ask" : "hitting the bid";
  const direction = divCtx.divergenceCents > 0 ? "above" : "below";
  return `Fair-value pressure: informed flow ${leaning} because model fair sits ${direction} market mid.`;
}

// Used by flow.ts to suppress flowReason dwell when the magnet activates
// or releases — the user should see the magnet annotation immediately,
// and see it disappear as soon as convergence happens.
export function divergenceFlowReasonKey(divCtx: DivergenceContext): string {
  return `magnet|${divCtx.mode}|${divCtx.divergenceCents > 0 ? "up" : divCtx.divergenceCents < 0 ? "dn" : "0"}`;
}
