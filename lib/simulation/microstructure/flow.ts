import type {
  Fill,
  FillKind,
  FlowEvent,
  Market,
  MarketAction,
  MarketRegime,
  TraderArchetype,
} from "../../types";
import { rand, randInt } from "../../rng";
import { clamp } from "../../format";
import { mkFill } from "../fills";
import { safeRegimeState } from "./regimeFsm";
import { buildFlowReason } from "./explain";
import { poisson, weightedPick } from "./rng-helpers";
import {
  IMPACT_K,
  LAMBDA,
  WEIGHTS,
  runArchetype,
  type ArchetypeOutput,
} from "./archetypes";

// Kyle impact + spread constants. The denominator MIN_DEPTH floors how
// hard a thin book can be pushed by a small imbalance, while MAX_TICK_MOVE
// clamps |Δmid| so a single tick never blows through more than 4¢.
const MIN_DEPTH = 6;
const MAX_TICK_MOVE = 4;
const BASE_SPREAD = 2;
const WIDEN_PER_LOW_LP = 3;
const WIDEN_PER_VOL = 0.6;

// Per-regime mid-price inertia + minimum-move threshold. Inertia scales
// the raw Kyle impact each tick (calm only adopts a fraction; shock pushes
// the full amount). MIN_MOVE drops sub-threshold impacts to zero so a
// stray single-lot in calm doesn't nudge the quote, while still letting
// genuinely directional flow (≥3-4 lots same side or an informed print)
// break through to a snapped 0.5¢ move.
const INERTIA: Record<MarketRegime, number> = {
  calm: 0.85,
  alert: 0.6,
  shock: 1.0,
  recovery: 0.5,
};
// MIN_MOVE must clear the 0.5¢ tick-snap threshold (0.25¢) to produce a
// visible move — values inside [MIN_MOVE, 0.25) would round-trip back to
// oldMid and look like nothing happened. Set calm at 0.25 so the gate's
// pass condition aligns with the snap.
const MIN_MOVE: Record<MarketRegime, number> = {
  calm: 0.25,
  alert: 0.15,
  shock: 0.05,
  recovery: 0.2,
};

// EWMA tuning for the lpDepth signal. Baseline is added every tick so a
// market with zero LP arrivals still has a sane denominator.
const LP_DEPTH_BASELINE = 5;
const LP_DEPTH_ALPHA = 0.18;

const HISTORY_LEN = 60;
const FLOW_LOG_MAX = 8;
const VOL_ALPHA = 0.12;

// Minimum ticks between flowReason refreshes (when the bucket key changes).
// Regime transitions and large event impacts bypass this — everything else
// holds the prior reason so the panel reads as commentary, not a stream.
const FLOW_REASON_DWELL = 5;
const FLOW_REASON_MAJOR_IMPACT = 0.08;

// Desk-actor cooldowns (moved out of fills.ts). Aggressive postures fire
// at most every 6 ticks; flatten every 3.
const AGGRESSIVE_COOLDOWN = 6;
const FLATTEN_COOLDOWN = 3;

function safeNum(n: number | undefined, fallback: number): number {
  return Number.isFinite(n) ? (n as number) : fallback;
}

type DeskIntent =
  | { kind: "market"; side: "BUY" | "SELL"; qty: number; fillKind: FillKind }
  | { kind: "limit_both" }
  | null;

function deskActorIntent(
  market: Market,
  decision: MarketAction,
  currentTick: number,
): DeskIntent {
  const ticksSinceFill = currentTick - market.lastFillTick;

  if (decision === "FLATTEN" && ticksSinceFill >= FLATTEN_COOLDOWN) {
    if (market.inventory > 0) {
      return { kind: "market", side: "SELL", qty: 2, fillKind: "flatten" };
    }
    if (market.inventory < 0) {
      return { kind: "market", side: "BUY", qty: 2, fillKind: "flatten" };
    }
    return null;
  }

  if (decision === "LIFT" && ticksSinceFill >= AGGRESSIVE_COOLDOWN) {
    return { kind: "market", side: "BUY", qty: 1, fillKind: "aggressive" };
  }
  if (decision === "HIT" && ticksSinceFill >= AGGRESSIVE_COOLDOWN) {
    return { kind: "market", side: "SELL", qty: 1, fillKind: "aggressive" };
  }

  // HOLD / WIDEN — desk shows resting quote on both sides. Fills emerge
  // when external market orders cross it (walk-the-desk gate below).
  return { kind: "limit_both" };
}

export type FlowOutput = {
  market: Market;
  fills: Fill[];
  seed: number;
};

export function flowTick(args: {
  market: Market;
  seed: number;
  currentTick: number;
  now: number;
  regime: MarketRegime;
  decision: MarketAction;
  // |impact| if a live event hit this market this tick, else 0. Used by
  // the flowReason dwell gate to allow an immediate refresh on a major
  // tape event without waiting for the dwell window.
  eventImpactMag: number;
}): FlowOutput {
  const { market, currentTick, now, regime, decision, eventImpactMag } = args;
  let seed = args.seed;

  const fair = safeNum(market.fairValueCents, market.forecastProb * 100);
  const lpDepthPrev = safeNum(market.lpDepth, LP_DEPTH_BASELINE);
  const volPrev = safeNum(market.vol, 0.5);
  const oldBid = safeNum(market.marketBid, fair - 2);
  const oldAsk = safeNum(market.marketAsk, fair + 2);
  const oldMid = (oldBid + oldAsk) / 2;
  const flowLogPrev: FlowEvent[] = Array.isArray(market.flowLog)
    ? market.flowLog
    : [];

  // 1) Poisson sample external arrivals for this regime.
  const lambda = LAMBDA[regime];
  const pois = poisson(seed, lambda);
  seed = pois.seed;
  const arrivals: { archetype: TraderArchetype; out: ArchetypeOutput }[] = [];
  for (let i = 0; i < pois.v; i++) {
    const picked = weightedPick(seed, WEIGHTS[regime]);
    seed = picked.seed;
    const out = runArchetype(picked.v, { market, regime }, seed);
    seed = out.seed;
    arrivals.push({ archetype: picked.v, out });
  }

  // Skip flow entirely on quiet ticks: zero external arrivals AND the
  // desk isn't crossing the spread this tick. Quote stays still, vol
  // EWMA decays, priceHistory still advances with the prior mid. This
  // is what makes a calm market visually still — common in calm regime
  // where λ=1.2 (P(N=0) ≈ 30%).
  const deskWillCross =
    (decision === "LIFT" || decision === "HIT" || decision === "FLATTEN") &&
    currentTick - market.lastFillTick >=
      (decision === "FLATTEN" ? FLATTEN_COOLDOWN : AGGRESSIVE_COOLDOWN) &&
    !(decision === "FLATTEN" && market.inventory === 0);
  if (arrivals.length === 0 && !deskWillCross) {
    const newVol = (1 - VOL_ALPHA) * volPrev;
    const lpDepthNew =
      (1 - LP_DEPTH_ALPHA) * lpDepthPrev + LP_DEPTH_ALPHA * LP_DEPTH_BASELINE;
    const priceHistory = [...market.priceHistory, oldMid].slice(-HISTORY_LEN);
    return {
      market: {
        ...market,
        priceHistory,
        vol: newVol,
        lpDepth: lpDepthNew,
      },
      fills: [],
      seed,
    };
  }

  const flowFills: Fill[] = [];
  const newFlowEvents: FlowEvent[] = [];

  // 2) Pass 1 — limit (LP) arrivals add depth. Process FIRST so depth
  //    refills before market orders consume it.
  let lpQtyTick = 0;
  let lpCount = 0;
  for (const a of arrivals) {
    if (a.out.intent.kind !== "limit") continue;
    lpQtyTick += a.out.intent.qty;
    lpCount++;
    newFlowEvents.push({
      tick: currentTick,
      archetype: a.archetype,
      side: a.out.intent.side === "BUY" ? "LIMIT_BID" : "LIMIT_ASK",
      qty: a.out.intent.qty,
      priceCents: Math.round(a.out.intent.priceCents * 10) / 10,
    });
  }

  // 3) Pass 2 — market arrivals. Aggregate imbalance and walk-the-desk
  //    against our resting quote for each.
  let imbalance = 0;
  let grossMarket = 0;
  let informedCount = 0;
  let panicCount = 0;

  for (const a of arrivals) {
    if (a.out.intent.kind !== "market") continue;
    const qty = a.out.intent.qty;
    const signed = a.out.intent.side === "BUY" ? qty : -qty;
    imbalance += signed;
    grossMarket += qty;
    if (
      a.archetype === "informed_transit" ||
      a.archetype === "latency_arb"
    ) {
      informedCount++;
    }
    if (a.archetype === "panic") panicCount++;

    newFlowEvents.push({
      tick: currentTick,
      archetype: a.archetype,
      side: a.out.intent.side,
      qty,
      priceCents: Math.round(a.out.intent.priceCents * 10) / 10,
    });

    // Walk-the-desk gate. Market BUYs that arrive can lift our ask;
    // market SELLs can hit our bid. Probability decays with distance
    // from the venue touch.
    if (a.out.intent.side === "BUY") {
      const distance = Math.max(0, market.ourAsk - oldAsk);
      const pHit = clamp(0.55 - 0.1 * distance, 0.02, 0.85);
      const r = rand(seed);
      seed = r.seed;
      if (r.v < pHit) {
        const tagR = randInt(seed, 0, 0x7fffffff);
        seed = tagR.seed;
        flowFills.push(
          mkFill({
            now,
            tick: currentTick,
            marketId: market.id,
            side: "SELL",
            qty: 1,
            price: clamp(market.ourAsk, 1, 99),
            kind: "passive",
            markFair: fair,
            rngTag: tagR.v,
          }),
        );
      }
    } else {
      const distance = Math.max(0, oldBid - market.ourBid);
      const pHit = clamp(0.55 - 0.1 * distance, 0.02, 0.85);
      const r = rand(seed);
      seed = r.seed;
      if (r.v < pHit) {
        const tagR = randInt(seed, 0, 0x7fffffff);
        seed = tagR.seed;
        flowFills.push(
          mkFill({
            now,
            tick: currentTick,
            marketId: market.id,
            side: "BUY",
            qty: 1,
            price: clamp(market.ourBid, 1, 99),
            kind: "passive",
            markFair: fair,
            rngTag: tagR.v,
          }),
        );
      }
    }
  }

  // 4) desk_actor — always evaluated once per tick. Market orders create
  //    aggressive/flatten fills directly; quoting (limit_both) creates
  //    no fills here (those emerge from walk-the-desk above). We only
  //    log desk_actor when it crosses — resting-quote logging would
  //    flood the flow window every tick.
  const da = deskActorIntent(market, decision, currentTick);
  if (da && da.kind === "market") {
    const qty = da.qty;
    const price = da.side === "BUY" ? oldAsk : oldBid;
    const tagR = randInt(seed, 0, 0x7fffffff);
    seed = tagR.seed;
    flowFills.push(
      mkFill({
        now,
        tick: currentTick,
        marketId: market.id,
        side: da.side,
        qty,
        price: clamp(price, 1, 99),
        kind: da.fillKind,
        markFair: fair,
        rngTag: tagR.v,
      }),
    );
    newFlowEvents.push({
      tick: currentTick,
      archetype: "desk_actor",
      side: da.side,
      qty,
      priceCents: Math.round(price * 10) / 10,
    });
    // Desk's market order also moves mid via Kyle impact.
    imbalance += da.side === "BUY" ? qty : -qty;
    grossMarket += qty;
  }

  // 5) lpDepth EWMA — baseline keeps the denominator from collapsing.
  const lpDepthNew =
    (1 - LP_DEPTH_ALPHA) * lpDepthPrev +
    LP_DEPTH_ALPHA * (lpQtyTick + LP_DEPTH_BASELINE);

  // 6) Kyle impact on mid, dampened by per-regime inertia and floored by
  //    the minimum-move threshold. Sub-threshold impacts collapse to zero,
  //    so a stray single lot in calm doesn't budge the touch.
  const depthDenom = Math.max(MIN_DEPTH, lpDepthNew);
  const rawImpact = (imbalance / depthDenom) * IMPACT_K[regime];
  const dampened = rawImpact * INERTIA[regime];
  const dMid =
    Math.abs(dampened) < MIN_MOVE[regime]
      ? 0
      : clamp(dampened, -MAX_TICK_MOVE, MAX_TICK_MOVE);

  // 7) Spread + quote. We only resize the quote on ticks where something
  //    actually crossed — pure-LP arrivals don't push bid/ask around. If
  //    no market order hit, leave the touch exactly where it was so calm
  //    markets show long stretches of stable quotes.
  const totalArrivals = arrivals.length + (da ? 1 : 0);
  const lpShare = totalArrivals > 0 ? lpCount / totalArrivals : 0.5;
  const spread = clamp(
    BASE_SPREAD + WIDEN_PER_LOW_LP * (1 - lpShare) + WIDEN_PER_VOL * volPrev,
    1.5,
    9,
  );
  // Snap to 0.5¢ tick size — most prediction-market venues quote in
  // half-cent or one-cent ticks. Small Kyle impacts that don't cross
  // the tick boundary leave the displayed quote untouched, giving
  // calm markets long visually-stable stretches.
  const snap = (n: number) => Math.round(n * 2) / 2;
  let newMid: number;
  let newBid: number;
  let newAsk: number;
  // Quote only moves when the mid actually shifts. With per-regime inertia
  // + MIN_MOVE, calm-regime sub-threshold impacts already snap dMid to 0;
  // keeping bid/ask pinned to oldBid/oldAsk in that case prevents the
  // spread formula from churning the touch on noise alone.
  if (grossMarket > 0 && dMid !== 0) {
    newMid = clamp(snap(oldMid + dMid), 1, 99);
    newBid = clamp(snap(newMid - spread / 2), 1, 98);
    newAsk = clamp(snap(newMid + spread / 2), newBid + 0.5, 99);
  } else {
    newMid = oldMid;
    newBid = oldBid;
    newAsk = oldAsk;
  }

  // 8) Print + history + vol. The chart is sourced from the *displayed*
  //    mid — bid/ask after snap. If the quote didn't move (calm: dMid
  //    collapsed below MIN_MOVE, or grossMarket==0), the displayed mid
  //    equals the prior mid and the chart goes flat. We deliberately do
  //    NOT push a buy/sell-weighted last-trade offset here: any fractional
  //    print not visible in bid/ask would look like phantom movement on
  //    the chart relative to the quoted market.
  const displayMid = (newBid + newAsk) / 2;
  const newVol =
    (1 - VOL_ALPHA) * volPrev + VOL_ALPHA * Math.abs(displayMid - oldMid);
  const priceHistory = [...market.priceHistory, displayMid].slice(-HISTORY_LEN);

  // 9) Flow reason — bucketed so the displayed text only refreshes on
  //    material changes. The dwell gate (≥5 ticks) holds the prior reason
  //    through transient bucket flips; regime change or a major event
  //    bypasses dwell so commentary keeps up with real news.
  const imbalanceSign: -1 | 0 | 1 =
    imbalance === 0 ? 0 : imbalance > 0 ? 1 : -1;
  const { reason, key } = buildFlowReason({
    lpCount,
    marketCount: arrivals.filter((a) => a.out.intent.kind === "market").length,
    informedCount,
    panicCount,
    imbalanceMag: Math.abs(imbalance),
    imbalanceSign,
    regime,
    ourPosture: decision,
    totalArrivals,
  });
  const prevKey = market.flowReasonKey ?? "";
  const prevRegime = prevKey.split("|")[0];
  const regimeChanged = prevRegime !== "" && prevRegime !== regime;
  const reasonTickPrev = Number.isFinite(market.flowReasonTick)
    ? market.flowReasonTick
    : 0;
  const ticksSinceReason = currentTick - reasonTickPrev;
  const dwellElapsed = ticksSinceReason >= FLOW_REASON_DWELL;
  const majorImpact = eventImpactMag >= FLOW_REASON_MAJOR_IMPACT;
  const shouldRefresh =
    key !== prevKey && (regimeChanged || dwellElapsed || majorImpact);
  const flowReason = shouldRefresh ? reason : market.flowReason;
  const flowReasonKey = shouldRefresh ? key : market.flowReasonKey;
  const flowReasonTick = shouldRefresh ? currentTick : reasonTickPrev;

  // 10) Ring buffer: newest events first, cap at FLOW_LOG_MAX.
  const flowLog = [...newFlowEvents, ...flowLogPrev].slice(0, FLOW_LOG_MAX);

  return {
    market: {
      ...market,
      marketBid: newBid,
      marketAsk: newAsk,
      priceHistory,
      vol: newVol,
      lpDepth: lpDepthNew,
      flowLog,
      flowReason,
      flowReasonKey,
      flowReasonTick,
      regimeState: safeRegimeState(market.regimeState),
    },
    fills: flowFills,
    seed,
  };
}
