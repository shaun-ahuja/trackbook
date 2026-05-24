import {
  type Fill,
  type FillKind,
  type Market,
  type MarketAction,
  type TransitEvent,
} from "../types";
import { randInt } from "../rng";
import { clamp } from "../format";

// Fill model. Three live sources + one post-hoc tag:
//   passive    — desk's resting quote crossed by an external market order
//                in flow.ts (walk-the-desk gate)
//   aggressive — desk crosses the spread via desk_actor in flow.ts
//                (LIFT/HIT postures, cooldown-throttled)
//   flatten    — desk_actor in flow.ts emits a market order opposite
//                inventory while FLATTEN is engaged
//   shock      — sev-3 live event sweeps our stale resting quote here,
//                outside the flow tick (handled below)
// `adverse` is set later by markAdverseSelection when a passive fill's
// mark moves against the desk over the next few ticks.

// Shock executions ignore cooldown — they're driven by the event itself.
const SHOCK_MIN_IMPACT = 0.06;

export function mkFill(args: {
  now: number;
  tick: number;
  marketId: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  kind: FillKind;
  markFair: number;
  rngTag: number;
}): Fill {
  return {
    id: `f_${args.now}_${args.rngTag.toString(36)}`,
    ts: args.now,
    tick: args.tick,
    marketId: args.marketId,
    side: args.side,
    qty: args.qty,
    price: args.price,
    kind: args.kind,
    markFair: args.markFair,
  };
}

// Update inventory + realized PnL on a fill. Avg-cost accounting; realized
// PnL crystallises only on closing trades.
export function applyFill(market: Market, fill: Fill): Market {
  const invOld = market.inventory;
  const avgOld = market.avgCost;
  const signedQty = fill.side === "BUY" ? fill.qty : -fill.qty;
  const invNew = invOld + signedQty;

  let realizedDelta = 0;
  let avgNew = avgOld;

  if (invOld === 0 || Math.sign(invOld) === Math.sign(signedQty)) {
    const denom = Math.abs(invOld) + fill.qty;
    avgNew = (Math.abs(invOld) * avgOld + fill.qty * fill.price) / denom;
  } else {
    const closing = Math.min(Math.abs(invOld), fill.qty);
    if (invOld > 0) {
      realizedDelta = (fill.price - avgOld) * closing;
    } else {
      realizedDelta = (avgOld - fill.price) * closing;
    }
    const remaining = fill.qty - closing;
    if (remaining > 0) {
      avgNew = fill.price;
    } else if (invNew === 0) {
      avgNew = 0;
    } else {
      avgNew = avgOld;
    }
  }

  return {
    ...market,
    inventory: invNew,
    avgCost: avgNew,
    realizedPnl: market.realizedPnl + realizedDelta,
  };
}

type ShockGenInput = {
  // Pre-flow snapshot — shock fills execute against the *stale* resting
  // quote (we got run over before we could pull it).
  prev: Market;
  cur: Market;
  action: MarketAction;
  event: TransitEvent | null;
  now: number;
  currentTick: number;
  seed: number;
};

type ShockGenOutput = {
  fill: Fill | null;
  seed: number;
};

// Force-fire a shock execution when a sev-3 live event materially impacts
// our market and we're posted. Bypasses flow so the "got run over" feel
// stays sharp — the trader sees their stale quote hit before they could
// react. Planned/trip events are excluded: they're smooth signals, not
// sudden enough to take a quote that way.
export function generateShockFill(input: ShockGenInput): ShockGenOutput {
  const { prev, cur, action, event, now, currentTick } = input;
  let seed = input.seed;

  if (!event || event.severity !== 3) return { fill: null, seed };
  if ((event.category ?? "live") !== "live") return { fill: null, seed };
  if (event.impacts[cur.id] === undefined) return { fill: null, seed };
  if (action === "FLATTEN") return { fill: null, seed };

  const impact = event.impacts[cur.id];
  if (Math.abs(impact) < SHOCK_MIN_IMPACT) return { fill: null, seed };

  const fair = cur.fairValueCents;
  const r = randInt(seed, 0, 0x7fffffff);
  seed = r.seed;

  // impact > 0 → fair jumped UP → our ask was stale-cheap → we get
  // lifted (we sell). impact < 0 → mirror.
  if (impact > 0) {
    return {
      fill: mkFill({
        now,
        tick: currentTick,
        marketId: cur.id,
        side: "SELL",
        qty: 2,
        price: clamp(prev.ourAsk, 1, 99),
        kind: "shock",
        markFair: fair,
        rngTag: r.v,
      }),
      seed,
    };
  }
  return {
    fill: mkFill({
      now,
      tick: currentTick,
      marketId: cur.id,
      side: "BUY",
      qty: 2,
      price: clamp(prev.ourBid, 1, 99),
      kind: "shock",
      markFair: fair,
      rngTag: r.v,
    }),
    seed,
  };
}

// Walk recent passive fills and flag those whose mark has decisively moved
// against the desk in the 2–4 ticks since execution. Aggressive/shock fills
// are excluded — adverse selection is specifically a posted-quote risk.
const ADVERSE_LOOKBACK_MIN = 2;
const ADVERSE_LOOKBACK_MAX = 4;
const ADVERSE_THRESHOLD = 1.5; // cents
export function markAdverseSelection(
  fills: Fill[],
  markets: Record<string, Market>,
  currentTick: number,
): Fill[] {
  let changed = false;
  const out = fills.map((f) => {
    if (f.adverse || f.kind !== "passive") return f;
    const age = currentTick - f.tick;
    if (age < ADVERSE_LOOKBACK_MIN || age > ADVERSE_LOOKBACK_MAX) return f;
    const m = markets[f.marketId];
    if (!m) return f;
    const currentFair = m.fairValueCents;
    // We bought passively → adverse if fair fell below our buy by threshold.
    // We sold passively → adverse if fair rose above our sell by threshold.
    if (f.side === "BUY" && currentFair < f.markFair - ADVERSE_THRESHOLD) {
      changed = true;
      return { ...f, adverse: true };
    }
    if (f.side === "SELL" && currentFair > f.markFair + ADVERSE_THRESHOLD) {
      changed = true;
      return { ...f, adverse: true };
    }
    return f;
  });
  return changed ? out : fills;
}
