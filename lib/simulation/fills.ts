import {
  type Fill,
  type FillKind,
  type Market,
  type MarketAction,
  type TransitEvent,
} from "../types";
import { rand, randInt, randRange } from "../rng";
import { clamp } from "../format";

// Fill model. Three live sources + one post-hoc tag:
//   passive    — resting quote at the touch occasionally gets hit by noise
//   aggressive — desk lifts/hits when the conviction posture is engaged
//   flatten    — risk reduction, ignores edge
//   shock      — a sev-3 event sweeps our stale resting quote (we get run over)
// `adverse` is set later by markAdverseSelection when a passive fill's mark
// moves against the desk over the next few ticks.

const PASSIVE_COOLDOWN = 4;
const AGGRESSIVE_COOLDOWN = 6;
const FLATTEN_COOLDOWN = 3;
// Shock executions ignore cooldown — they're driven by the event, not by
// quote pacing.

const PASSIVE_BASE_RATE = 0.04;       // probability per eligible tick
const PASSIVE_INSIDE_BONUS = 0.06;    // added when ourQuote is inside touch
const AGGRESSIVE_BASE_RATE = 0.55;    // when posture engaged + cooldown ready
const AGGRESSIVE_FAR_PENALTY = 0.08;  // per cent away from touch

// Edge-decay scale: shock fills more likely when the event-driven probability
// jump is large.
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

type GenInput = {
  // Market state pre-tick — used for shock fills to execute at the *stale*
  // resting quote (we got run over before we could pull it).
  prev: Market;
  // Market state post-decide — current touch, current ourBid/Ask.
  cur: Market;
  action: MarketAction;
  // Event that fired this tick (may impact this market or another).
  event: TransitEvent | null;
  now: number;
  currentTick: number;
  seed: number;
};

type GenOutput = {
  fill: Fill | null;
  seed: number;
};

export function generateFill(input: GenInput): GenOutput {
  const { prev, cur, action, event, now, currentTick } = input;
  let seed = input.seed;

  const fair = cur.fairValueCents;
  const ticksSinceFill = currentTick - cur.lastFillTick;

  // 1) Shock fills — sev-3 LIVE event impacting this market while we're
  //    posted. Bypasses cooldown; uses the pre-shock resting quote.
  //    Planned-work alerts and trip-aggregate signals are excluded:
  //    they're scheduled or smoothed, never sudden enough to run a quote.
  const eventCategory = event?.category ?? "live";
  if (
    event &&
    event.severity === 3 &&
    eventCategory === "live" &&
    event.impacts[cur.id] !== undefined &&
    action !== "FLATTEN"
  ) {
    const impact = event.impacts[cur.id];
    if (Math.abs(impact) >= SHOCK_MIN_IMPACT) {
      const r = randInt(seed, 0, 0x7fffffff);
      seed = r.seed;
      // Impact > 0 means fair jumped UP — our ask was stale-cheap → we get
      // lifted (we sell). Impact < 0 means our bid was stale-rich → we get
      // hit (we buy).
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
      } else {
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
    }
  }

  // 2) Flatten fills — risk reduction, frequent until inventory clears.
  if (action === "FLATTEN" && ticksSinceFill >= FLATTEN_COOLDOWN) {
    const r = randInt(seed, 0, 0x7fffffff);
    seed = r.seed;
    if (cur.inventory > 0) {
      return {
        fill: mkFill({
          now,
          tick: currentTick,
          marketId: cur.id,
          side: "SELL",
          qty: 2,
          price: cur.marketBid,
          kind: "flatten",
          markFair: fair,
          rngTag: r.v,
        }),
        seed,
      };
    } else if (cur.inventory < 0) {
      return {
        fill: mkFill({
          now,
          tick: currentTick,
          marketId: cur.id,
          side: "BUY",
          qty: 2,
          price: cur.marketAsk,
          kind: "flatten",
          markFair: fair,
          rngTag: r.v,
        }),
        seed,
      };
    }
  }

  // 3) Aggressive fills — LIFT/HIT pursuing conviction edge.
  if ((action === "LIFT" || action === "HIT") && ticksSinceFill >= AGGRESSIVE_COOLDOWN) {
    const touch = action === "LIFT" ? cur.marketAsk : cur.marketBid;
    const ourPrice = action === "LIFT" ? cur.ourAsk : cur.ourBid;
    const distance = Math.abs(touch - ourPrice);
    const prob = clamp(AGGRESSIVE_BASE_RATE - distance * AGGRESSIVE_FAR_PENALTY, 0.1, 0.85);
    const fireR = rand(seed);
    seed = fireR.seed;
    if (fireR.v < prob) {
      // Slippage: on volatile ticks, the fill prints a bit through.
      const slipR = randRange(seed, 0, Math.min(1.0, cur.vol * 0.6));
      seed = slipR.seed;
      const r = randInt(seed, 0, 0x7fffffff);
      seed = r.seed;
      if (action === "LIFT") {
        return {
          fill: mkFill({
            now,
            tick: currentTick,
            marketId: cur.id,
            side: "BUY",
            qty: 1,
            price: clamp(cur.marketAsk + slipR.v, 1, 99),
            kind: "aggressive",
            markFair: fair,
            rngTag: r.v,
          }),
          seed,
        };
      } else {
        return {
          fill: mkFill({
            now,
            tick: currentTick,
            marketId: cur.id,
            side: "SELL",
            qty: 1,
            price: clamp(cur.marketBid - slipR.v, 1, 99),
            kind: "aggressive",
            markFair: fair,
            rngTag: r.v,
          }),
          seed,
        };
      }
    }
  }

  // 4) Passive fills — HOLD/WIDEN resting quote occasionally gets traded
  //    by noise. Higher prob when our quote is *inside* the synthetic touch.
  if ((action === "HOLD" || action === "WIDEN") && ticksSinceFill >= PASSIVE_COOLDOWN) {
    const bidInside = cur.ourBid > cur.marketBid;
    const askInside = cur.ourAsk < cur.marketAsk;
    const volDampener = 1 / (1 + cur.vol * 0.3); // people pull liquidity in vol
    const baseProb = (PASSIVE_BASE_RATE +
      (bidInside || askInside ? PASSIVE_INSIDE_BONUS : 0)) * volDampener;
    const fireR = rand(seed);
    seed = fireR.seed;
    if (fireR.v < baseProb) {
      // Decide which side gets hit. If both eligible, pick by chance.
      const sideR = rand(seed);
      seed = sideR.seed;
      const r = randInt(seed, 0, 0x7fffffff);
      seed = r.seed;
      const buySide = sideR.v < 0.5;
      if (buySide) {
        return {
          fill: mkFill({
            now,
            tick: currentTick,
            marketId: cur.id,
            side: "BUY",
            qty: 1,
            price: cur.ourBid,
            kind: "passive",
            markFair: fair,
            rngTag: r.v,
          }),
          seed,
        };
      } else {
        return {
          fill: mkFill({
            now,
            tick: currentTick,
            marketId: cur.id,
            side: "SELL",
            qty: 1,
            price: cur.ourAsk,
            kind: "passive",
            markFair: fair,
            rngTag: r.v,
          }),
          seed,
        };
      }
    }
  }

  return { fill: null, seed };
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
