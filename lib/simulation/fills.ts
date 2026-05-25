import {
  type Fill,
  type FillKind,
  type Market,
} from "../types.ts";

// Fill model. Three live sources + one post-hoc tag:
//   passive    — desk's resting quote crossed by an external market order
//                (matched via bookMatching.insertLimit / executeMarket)
//   aggressive — desk crosses the spread via deskAggressiveCross in
//                bookReducer.ts (LIFT/HIT postures, cooldown-throttled)
//   flatten    — desk's market cross while FLATTEN is engaged
//   shock      — sev-3 live event sweeps the desk's stale resting quote
//                via bookReducer.shockSweep
// `adverse` is set later by markAdverseSelection when a passive fill's
// mark moves against the desk over the next few ticks.

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
