import type {
  Fill,
  FillKind,
  FlowEvent,
  MarketAction,
  MarketRegime,
  TraderArchetype,
} from "../types";
import { rand } from "../rng";
import { clamp } from "../format";
import { cancelManyByIds, executeMarket, insertLimit } from "./bookMatching";
import {
  type BookSide,
  type BookState,
  type OrderOwner,
  type RestingOrder,
  bestAskPrice,
  bestBidPrice,
  clampPrice,
  insertIntoSide,
  makeOrder,
  snapToTick,
  TICK_CENTS,
} from "./orderBookState";
import {
  type DivergenceContext,
  type RoutedIntent,
  magnetLpPlacement,
  softCancelMultiplier,
  softCancelRate,
} from "./orderFlow";

// Desk clip sizes. Single static pair, scaled down in shock so the desk
// doesn't keep showing fat depth when it should be widening.
const DESK_SIZE_NORMAL = 4;
const DESK_SIZE_SHOCK = 2;

// Anti-flicker bound on soft-cancel intensity. Hard expiry runs first
// and is unaffected by this cap — only the random draw is throttled.
const SOFT_CANCEL_CAP_FRAC = 0.25;

// Replenishment trigger. If the visible spread blows out beyond this,
// or one side runs thin, we inject one or two LP orders to keep the
// ladder populated. Without this, a shock that wipes most LPs would
// leave the book flickering between empty and one or two orders.
const REPLENISH_SPREAD_TRIGGER = 3; // cents
const REPLENISH_MIN_LEVELS = 2;

// Hard cap on intents applied per tick. Poisson arrivals at λ≤3.5 rarely
// produce more than 6 even in shock, but the cap protects against a
// pathological inject burst.
const MAX_INTENTS_PER_TICK = 8;

export type AgeOutput = {
  book: BookState;
  seed: number;
  expiredCount: number;
  softCancelCount: number;
  expiredOrderIds: number[];
  softCancelOrderIds: number[];
};

// Drop expired orders, then draw soft-cancels on the survivors. Desk orders
// are never soft-cancelled — syncDeskQuote owns desk lifecycle. When divCtx
// is in "mild" / "strong" mode, wrong-side liquidity cancels faster so
// the touch can retreat toward fair without waiting for natural decay.
export function ageAndCancel(
  book: BookState,
  regime: MarketRegime,
  currentTick: number,
  seed: number,
  divCtx?: DivergenceContext,
): AgeOutput {
  // Pass 1 — hard expiry.
  const expiredIds = new Set<number>();
  const collect = (orders: RestingOrder[]) => {
    for (const o of orders) {
      if (o.owner === "desk") continue;
      if (currentTick - o.postedTick > o.ttlTicks) expiredIds.add(o.id);
    }
  };
  collect(book.bids);
  collect(book.asks);
  let next = cancelManyByIds(book, expiredIds);

  // Pass 2 — soft cancel draws on remaining non-desk orders. Capped at
  // SOFT_CANCEL_CAP_FRAC of resting orders to prevent a stampede.
  const candidates: RestingOrder[] = [];
  for (const o of next.bids) if (o.owner !== "desk") candidates.push(o);
  for (const o of next.asks) if (o.owner !== "desk") candidates.push(o);
  const cap = Math.max(1, Math.floor(candidates.length * SOFT_CANCEL_CAP_FRAC));

  const softIds = new Set<number>();
  let s = seed;
  for (const o of candidates) {
    if (softIds.size >= cap) break;
    const baseRate = softCancelRate(o.owner, regime);
    if (baseRate <= 0) continue;
    const mult = divCtx ? softCancelMultiplier(o.owner, o.side, divCtx) : 1;
    const rate = Math.min(0.9, baseRate * mult);
    const r = rand(s);
    s = r.seed;
    if (r.v < rate) softIds.add(o.id);
  }
  next = cancelManyByIds(next, softIds);

  return {
    book: next,
    seed: s,
    expiredCount: expiredIds.size,
    softCancelCount: softIds.size,
    expiredOrderIds: [...expiredIds],
    softCancelOrderIds: [...softIds],
  };
}

export type DeskSyncOutput = {
  book: BookState;
  changed: boolean;
  canceledDeskOrderIds: number[];
  postedDeskOrders: RestingOrder[];
};

// Reconcile resting desk orders with the latest ourBid / ourAsk decision.
// Strategy: drop every existing desk order, then insert one fresh order at
// each price. This is cheaper than diffing and avoids the case where an
// old desk order is stuck partially-filled at a stale price.
//
// Insertion auto-clamps inside the opposite best to prevent a self-cross
// during sync: if ourBid >= bestAsk we'd otherwise immediately match desk
// against its own bestAsk on the same tick. syncDeskQuote should never
// produce fills — desk-as-taker behavior belongs in the aggressive-posture
// market intent that runs separately.
export function syncDeskQuote(
  book: BookState,
  ourBid: number,
  ourAsk: number,
  currentTick: number,
  regime: MarketRegime,
): DeskSyncOutput {
  const deskIds = new Set<number>();
  for (const o of book.bids) if (o.owner === "desk") deskIds.add(o.id);
  for (const o of book.asks) if (o.owner === "desk") deskIds.add(o.id);
  const cleared = cancelManyByIds(book, deskIds);
  const postedDeskOrders: RestingOrder[] = [];

  const deskSize = regime === "shock" ? DESK_SIZE_SHOCK : DESK_SIZE_NORMAL;
  let next = cleared;

  const oppAsk = bestAskPrice(next, ourAsk + 1);
  const safeBid = clampPrice(Math.min(ourBid, oppAsk - TICK_CENTS));
  if (safeBid >= 1) {
    const made = makeOrder(next, "BID", safeBid, deskSize, "desk", currentTick, 999);
    next = {
      ...next,
      nextOrderId: made.nextId,
      bids: insertIntoSide(next.bids, made.order),
    };
    postedDeskOrders.push(made.order);
  }

  const oppBid = bestBidPrice(next, ourBid - 1);
  const safeAsk = clampPrice(Math.max(ourAsk, oppBid + TICK_CENTS));
  if (safeAsk <= 99) {
    const made = makeOrder(next, "ASK", safeAsk, deskSize, "desk", currentTick, 999);
    next = {
      ...next,
      nextOrderId: made.nextId,
      asks: insertIntoSide(next.asks, made.order),
    };
    postedDeskOrders.push(made.order);
  }

  return {
    book: next,
    changed: deskIds.size > 0 || true,
    canceledDeskOrderIds: [...deskIds],
    postedDeskOrders,
  };
}

export type ApplyIntentsArgs = {
  book: BookState;
  intents: RoutedIntent[];
  currentTick: number;
  marketId: string;
  fairCents: number;
  now: number;
};

export type ApplyIntentsOutput = {
  book: BookState;
  fills: Fill[];
  marketCount: number;
  limitCount: number;
  flowEvents: FlowEvent[];
  shadowOps: Array<
    | {
        kind: "submit_market";
        side: "BUY" | "SELL";
        owner: OrderOwner;
        qty: number;
        fillKind: FillKind;
        logicalTime: number;
      }
    | {
        kind: "submit_limit";
        side: BookSide;
        owner: OrderOwner;
        qty: number;
        priceCents: number;
        ttlTicks: number;
        fillKind: FillKind;
        logicalTime: number;
        expectedTsOrderId: number | null;
      }
  >;
};

// Walk routed external intents in order. Each market intent → executeMarket;
// each limit intent → insertLimit. We do NOT distinguish FillKind here for
// external takers — they generate desk passive fills (handled by the
// matching engine), and external-vs-external trades don't emit Fills.
export function applyIntents(args: ApplyIntentsArgs): ApplyIntentsOutput {
  const { currentTick, marketId, fairCents, now } = args;
  let book = args.book;
  const fills: Fill[] = [];
  let marketCount = 0;
  let limitCount = 0;
  const flowEvents: FlowEvent[] = [];
  const shadowOps: ApplyIntentsOutput["shadowOps"] = [];
  const intents = args.intents.slice(0, MAX_INTENTS_PER_TICK);

  for (let i = 0; i < intents.length; i++) {
    const r = intents[i];
    const ctx = {
      now,
      currentTick,
      marketId,
      markFair: fairCents,
      // Caller is always an external trader here — any desk fill produced
      // is by virtue of desk being a resting maker, so the matching engine
      // labels it "passive". The kind below is therefore only meaningful
      // if a desk-vs-desk path is ever reached, which can't happen
      // because external takerOwner != "desk".
      deskFillKind: "passive" as FillKind,
      rngTag: currentTick * 100 + i,
    };

    if (r.intent.kind === "market") {
      const res = executeMarket(
        book,
        r.intent.side,
        r.intent.qty,
        r.owner,
        ctx,
      );
      book = res.book;
      fills.push(...res.fills);
      marketCount++;
      shadowOps.push({
        kind: "submit_market",
        side: r.intent.side,
        owner: r.owner,
        qty: r.intent.qty,
        fillKind: "passive",
        logicalTime: currentTick,
      });
      flowEvents.push({
        tick: currentTick,
        archetype: r.archetype,
        side: r.intent.side,
        qty: r.intent.qty,
        priceCents: snapToTick(r.intent.priceCents),
      });
    } else {
      const res = insertLimit(
        book,
        r.intent.side === "BUY" ? "BID" : "ASK",
        clampPrice(r.intent.priceCents),
        r.intent.qty,
        r.owner,
        currentTick,
        r.ttlTicks,
        ctx,
      );
      book = res.book;
      fills.push(...res.fills);
      limitCount++;
      shadowOps.push({
        kind: "submit_limit",
        side: r.intent.side === "BUY" ? "BID" : "ASK",
        owner: r.owner,
        qty: r.intent.qty,
        priceCents: clampPrice(r.intent.priceCents),
        ttlTicks: r.ttlTicks,
        fillKind: "passive",
        logicalTime: currentTick,
        expectedTsOrderId: res.restedOrderId ?? null,
      });
      flowEvents.push({
        tick: currentTick,
        archetype: r.archetype,
        side: r.intent.side === "BUY" ? "LIMIT_BID" : "LIMIT_ASK",
        qty: r.intent.qty,
        priceCents: snapToTick(r.intent.priceCents),
      });
    }
  }

  return { book, fills, marketCount, limitCount, flowEvents, shadowOps };
}

// Desk-issued aggressive cross. Used when posture is LIFT, HIT, or FLATTEN
// and the cooldown has elapsed. Pulled out of flow.ts deskActorIntent.
export type DeskCrossOutput = {
  book: BookState;
  fills: Fill[];
  flowEvent: FlowEvent | null;
  shadowCommand:
    | {
        side: "BUY" | "SELL";
        qty: number;
        fillKind: FillKind;
        logicalTime: number;
      }
    | null;
};

export function deskAggressiveCross(args: {
  book: BookState;
  posture: MarketAction;
  inventory: number;
  ticksSinceFill: number;
  currentTick: number;
  marketId: string;
  fairCents: number;
  now: number;
}): DeskCrossOutput {
  const { posture, inventory, ticksSinceFill } = args;

  // Cooldowns retained from the prior flow.ts implementation so the desk
  // doesn't machine-gun crosses every tick on a sustained LIFT/HIT posture.
  const AGGRESSIVE_COOLDOWN = 6;
  const FLATTEN_COOLDOWN = 3;

  let side: "BUY" | "SELL" | null = null;
  let qty = 0;
  let fillKind: FillKind = "aggressive";

  if (posture === "FLATTEN" && ticksSinceFill >= FLATTEN_COOLDOWN) {
    if (inventory > 0) { side = "SELL"; qty = 2; fillKind = "flatten"; }
    else if (inventory < 0) { side = "BUY"; qty = 2; fillKind = "flatten"; }
  } else if (posture === "LIFT" && ticksSinceFill >= AGGRESSIVE_COOLDOWN) {
    side = "BUY"; qty = 1; fillKind = "aggressive";
  } else if (posture === "HIT" && ticksSinceFill >= AGGRESSIVE_COOLDOWN) {
    side = "SELL"; qty = 1; fillKind = "aggressive";
  }

  if (!side || qty <= 0) {
    return { book: args.book, fills: [], flowEvent: null, shadowCommand: null };
  }

  const res = executeMarket(args.book, side, qty, "desk", {
    now: args.now,
    currentTick: args.currentTick,
    marketId: args.marketId,
    markFair: args.fairCents,
    deskFillKind: fillKind,
    rngTag: args.currentTick * 100 + 99,
  });

  const refPrice = res.lastTradePriceCents ?? (side === "BUY"
    ? bestAskPrice(args.book, args.fairCents)
    : bestBidPrice(args.book, args.fairCents));

  return {
    book: res.book,
    fills: res.fills,
    flowEvent: {
      tick: args.currentTick,
      archetype: "desk_actor" as TraderArchetype,
      side,
      qty,
      priceCents: snapToTick(refPrice),
    },
    shadowCommand: {
      side,
      qty,
      fillKind,
      logicalTime: args.currentTick,
    },
  };
}

// Fair-value magnet pressure. Adds 1–2 deterministic market orders in the
// fair direction when divergence is mild/strong, plus a small RNG-gated
// sweep at strong. Owner = "informed" so soft-cancel + adverse-selection
// labelling treat the flow like any other informed trader.
export type MagnetOutput = {
  book: BookState;
  fills: Fill[];
  flowEvents: FlowEvent[];
  seed: number;
  fired: boolean;
  shadowCommands: Array<{
    side: "BUY" | "SELL";
    qty: number;
    fillKind: FillKind;
    logicalTime: number;
    owner: "informed";
  }>;
};

export function divergenceMagnet(args: {
  book: BookState;
  divergenceCents: number;
  mode: "none" | "mild" | "strong";
  currentTick: number;
  marketId: string;
  fairCents: number;
  now: number;
  seed: number;
}): MagnetOutput {
  if (args.mode === "none" || args.divergenceCents === 0) {
    return {
      book: args.book,
      fills: [],
      flowEvents: [],
      seed: args.seed,
      fired: false,
      shadowCommands: [],
    };
  }

  let book = args.book;
  let s = args.seed;
  const fills: Fill[] = [];
  const flowEvents: FlowEvent[] = [];
  const shadowCommands: MagnetOutput["shadowCommands"] = [];
  const side: "BUY" | "SELL" = args.divergenceCents > 0 ? "BUY" : "SELL";

  // Steady pressure: 1 order in mild, 2 in strong. Single contract each
  // so the magnet doesn't dominate any single tick.
  const steadyCount = args.mode === "strong" ? 2 : 1;
  for (let i = 0; i < steadyCount; i++) {
    const res = executeMarket(book, side, 1, "informed", {
      now: args.now,
      currentTick: args.currentTick,
      marketId: args.marketId,
      markFair: args.fairCents,
      deskFillKind: "passive",
      rngTag: args.currentTick * 100 + 70 + i,
    });
    book = res.book;
    fills.push(...res.fills);
    shadowCommands.push({
      side,
      qty: 1,
      fillKind: "passive",
      logicalTime: args.currentTick,
      owner: "informed",
    });
    flowEvents.push({
      tick: args.currentTick,
      archetype: "informed_transit",
      side,
      qty: 1,
      priceCents: snapToTick(res.lastTradePriceCents ?? args.fairCents),
    });
  }

  // Sweep: only on strong, RNG-gated to ~40% per tick so the magnet stays
  // visibly gradual rather than snapping. qty scales mildly with |div|.
  if (args.mode === "strong") {
    const r = rand(s);
    s = r.seed;
    if (r.v < 0.4) {
      const qty = Math.max(1, Math.min(3, Math.round(Math.abs(args.divergenceCents) / 10)));
      const sweep = executeMarket(book, side, qty, "informed", {
        now: args.now,
        currentTick: args.currentTick,
        marketId: args.marketId,
        markFair: args.fairCents,
        deskFillKind: "passive",
        rngTag: args.currentTick * 100 + 77,
      });
      book = sweep.book;
      fills.push(...sweep.fills);
      shadowCommands.push({
        side,
        qty,
        fillKind: "passive",
        logicalTime: args.currentTick,
        owner: "informed",
      });
      flowEvents.push({
        tick: args.currentTick,
        archetype: "informed_transit",
        side,
        qty,
        priceCents: snapToTick(sweep.lastTradePriceCents ?? args.fairCents),
      });
    }
  }

  return { book, fills, flowEvents, seed: s, fired: true, shadowCommands };
}

// Sweep desk's resting quote when a sev-3 live event lands. The pre-flow
// book is what gets hit — caller passes that snapshot. Bypasses cooldowns;
// the event itself is the trigger.
export type ShockSweepArgs = {
  book: BookState;
  impactSign: number;       // +1 if fair jumped up (we get lifted), -1 if down
  qty: number;
  currentTick: number;
  marketId: string;
  fairCents: number;
  now: number;
};

export function shockSweep(args: ShockSweepArgs): {
  book: BookState;
  fills: Fill[];
  shadowCommand: {
    side: "BUY" | "SELL";
    qty: number;
    fillKind: FillKind;
    logicalTime: number;
    owner: "panic";
  } | null;
} {
  if (args.impactSign === 0 || args.qty <= 0) {
    return { book: args.book, fills: [], shadowCommand: null };
  }
  // Positive impact → fair moved up → an external buyer sweeps the ask
  // side (so the desk's resting ask gets hit, desk sells).
  // Negative impact → mirror.
  const takerSide: "BUY" | "SELL" = args.impactSign > 0 ? "BUY" : "SELL";
  const res = executeMarket(args.book, takerSide, args.qty, "panic", {
    now: args.now,
    currentTick: args.currentTick,
    marketId: args.marketId,
    markFair: args.fairCents,
    deskFillKind: "shock",
    rngTag: args.currentTick * 100 + 88,
  });
  return {
    book: res.book,
    fills: res.fills,
    shadowCommand: {
      side: takerSide,
      qty: args.qty,
      fillKind: "shock",
      logicalTime: args.currentTick,
      owner: "panic",
    },
  };
}

// Inject one or two LP orders inside the touch if the book is too thin or
// the spread blew out. Prevents the visible ladder from collapsing to a
// single level after a shock cleans out depth. When divCtx is active, the
// magnet-side replenishment posts toward fair instead of one tick inside,
// so rebuilt depth nudges the touch in the right direction.
export function replenishIfThin(
  book: BookState,
  fairCents: number,
  regime: MarketRegime,
  currentTick: number,
  seed: number,
  divCtx?: DivergenceContext,
): {
  book: BookState;
  seed: number;
  injected: number;
  postedOrders: RestingOrder[];
} {
  const bid = bestBidPrice(book, fairCents - 1);
  const ask = bestAskPrice(book, fairCents + 1);
  const spread = ask - bid;
  const thinBids = book.bids.length < REPLENISH_MIN_LEVELS;
  const thinAsks = book.asks.length < REPLENISH_MIN_LEVELS;
  const wideSpread = spread > REPLENISH_SPREAD_TRIGGER;

  if (!thinBids && !thinAsks && !wideSpread) {
    return { book, seed, injected: 0, postedOrders: [] };
  }

  let next = book;
  let s = seed;
  let injected = 0;
  const postedOrders: RestingOrder[] = [];

  // One layer one tick inside whichever side needs it; tightens gradually
  // rather than re-pegging at the touch. When magnet is active and the
  // side aligns with the magnet direction, place toward fair instead.
  const placeInside = (sideTag: "BID" | "ASK") => {
    const ttl = regime === "shock" ? 3 : 12;
    const size = 4;
    const refBid = bestBidPrice(next, fairCents - 1);
    const refAsk = bestAskPrice(next, fairCents + 1);
    let px: number;
    const magnetWantsBid = divCtx && divCtx.mode !== "none" && divCtx.divergenceCents > 0;
    const magnetWantsAsk = divCtx && divCtx.mode !== "none" && divCtx.divergenceCents < 0;
    if (sideTag === "BID" && magnetWantsBid) {
      const mid = (refBid + refAsk) / 2;
      const placement = magnetLpPlacement(divCtx!, mid, fairCents, refBid, refAsk);
      px = placement && placement.side === "BID" ? snapToTick(placement.priceCents)
        : clampPrice(Math.min(refBid + TICK_CENTS, refAsk - TICK_CENTS));
    } else if (sideTag === "ASK" && magnetWantsAsk) {
      const mid = (refBid + refAsk) / 2;
      const placement = magnetLpPlacement(divCtx!, mid, fairCents, refBid, refAsk);
      px = placement && placement.side === "ASK" ? snapToTick(placement.priceCents)
        : clampPrice(Math.max(refAsk - TICK_CENTS, refBid + TICK_CENTS));
    } else {
      px = sideTag === "BID"
        ? clampPrice(Math.min(refBid + TICK_CENTS, refAsk - TICK_CENTS))
        : clampPrice(Math.max(refAsk - TICK_CENTS, refBid + TICK_CENTS));
    }
    if (px < 1 || px > 99) return;
    const made = makeOrder(next, sideTag, px, size, "lp", currentTick, ttl);
    next = sideTag === "BID"
      ? { ...next, nextOrderId: made.nextId, bids: insertIntoSide(next.bids, made.order) }
      : { ...next, nextOrderId: made.nextId, asks: insertIntoSide(next.asks, made.order) };
    injected++;
    postedOrders.push(made.order);
  };

  if (thinBids || wideSpread) placeInside("BID");
  if (thinAsks || wideSpread) placeInside("ASK");

  // One extra small LP somewhere random on busy ticks — keeps tail layers
  // alive when middle activity is high.
  if (regime !== "shock") {
    const r = rand(s);
    s = r.seed;
    if (r.v < 0.4) {
      const sideTag: "BID" | "ASK" = r.v < 0.2 ? "BID" : "ASK";
      const ttl = 14;
      const size = 3;
      const refBid = bestBidPrice(next, fairCents - 1);
      const refAsk = bestAskPrice(next, fairCents + 1);
      const px = sideTag === "BID"
        ? clampPrice(refBid - TICK_CENTS * 2)
        : clampPrice(refAsk + TICK_CENTS * 2);
      const made = makeOrder(next, sideTag, px, size, "patient", currentTick, ttl);
      next = sideTag === "BID"
        ? { ...next, nextOrderId: made.nextId, bids: insertIntoSide(next.bids, made.order) }
        : { ...next, nextOrderId: made.nextId, asks: insertIntoSide(next.asks, made.order) };
      injected++;
      postedOrders.push(made.order);
    }
  }

  // Silence unused-import-like warning on clamp; some compilers strip it.
  void clamp;

  return { book: next, seed: s, injected, postedOrders };
}

// Convenience re-export so callers can import projection from one place
// when they're already pulling from bookReducer.
export { projectVisibleBook } from "./orderBookState";

// Compute the touch prices used by the rest of the simulation. Returns
// best of book (including desk). Falls back to the prior bid/ask if a side
// is empty — better than letting downstream code see undefined.
export function topOfBook(
  book: BookState,
  fallbackBid: number,
  fallbackAsk: number,
): { bid: number; ask: number; mid: number } {
  const bid = bestBidPrice(book, fallbackBid);
  const ask = bestAskPrice(book, fallbackAsk);
  // Defensive: if book inversion ever sneaks in, present a sane mid.
  const safeAsk = Math.max(ask, bid + TICK_CENTS);
  return { bid, ask: safeAsk, mid: (bid + safeAsk) / 2 };
}
