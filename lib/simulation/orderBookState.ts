import type { BookLevel, OrderBook } from "../types.ts";

// Tick size used across all subway-contract books. Most prediction-market
// venues quote in half-cent or one-cent increments; 0.5¢ gives the desk
// enough granularity to skew quotes around the synthetic mid without
// flickering on sub-tick noise.
export const TICK_CENTS = 0.5;
export const PRICE_MIN = 1;
export const PRICE_MAX = 99;
// How many price levels each side surfaces to the UI. Beyond this the book
// still holds resting orders (e.g. patient_value layers) — they just don't
// render until they bubble into the top 4.
export const VISIBLE_LEVELS = 4;

export type OrderId = number;

// Who placed this order. Drives FillKind selection (desk involvement →
// passive/aggressive), TTL choice (lp/patient long, noise/momentum short),
// and tape narrative.
export type OrderOwner =
  | "desk"
  | "lp"
  | "noise"
  | "informed"
  | "momentum"
  | "rebal"
  | "patient"
  | "panic"
  | "event";

export type BookSide = "BID" | "ASK";

export type RestingOrder = {
  id: OrderId;
  side: BookSide;
  priceCents: number;
  size: number;
  owner: OrderOwner;
  postedTick: number;
  ttlTicks: number;
};

export type BookState = {
  nextOrderId: OrderId;
  // Bids: highest price first; ties broken by postedTick ascending (FIFO).
  // Asks: lowest price first; same FIFO tie-break.
  bids: RestingOrder[];
  asks: RestingOrder[];
  lastTradePriceCents?: number;
  lastTradeTick?: number;
};

export function emptyBookState(): BookState {
  return { nextOrderId: 1, bids: [], asks: [] };
}

// Self-heal hook: hot-reload / persisted state may leave bookState undefined
// or partially shaped. Mirrors the safeRegimeState pattern used elsewhere.
export function safeBookState(s: BookState | undefined): BookState {
  if (!s) return emptyBookState();
  return {
    nextOrderId: Number.isFinite(s.nextOrderId) ? s.nextOrderId : 1,
    bids: Array.isArray(s.bids) ? s.bids : [],
    asks: Array.isArray(s.asks) ? s.asks : [],
    lastTradePriceCents: s.lastTradePriceCents,
    lastTradeTick: s.lastTradeTick,
  };
}

export function snapToTick(p: number): number {
  return Math.round(p / TICK_CENTS) * TICK_CENTS;
}

export function clampPrice(p: number): number {
  return Math.max(PRICE_MIN, Math.min(PRICE_MAX, snapToTick(p)));
}

export function bestBid(book: BookState): RestingOrder | null {
  return book.bids[0] ?? null;
}

export function bestAsk(book: BookState): RestingOrder | null {
  return book.asks[0] ?? null;
}

export function bestBidPrice(book: BookState, fallback: number): number {
  const b = bestBid(book);
  return b ? b.priceCents : fallback;
}

export function bestAskPrice(book: BookState, fallback: number): number {
  const a = bestAsk(book);
  return a ? a.priceCents : fallback;
}

// Returns the best non-desk price on each side, falling back to the absolute
// best (which may be the desk) when the desk is alone at the top.
export function bestNonDeskBid(book: BookState): RestingOrder | null {
  for (const o of book.bids) if (o.owner !== "desk") return o;
  return book.bids[0] ?? null;
}

export function bestNonDeskAsk(book: BookState): RestingOrder | null {
  for (const o of book.asks) if (o.owner !== "desk") return o;
  return book.asks[0] ?? null;
}

// Sum sizes at a given price on a given side. Used by the visible-book
// projection and by syncDeskQuote to know how much depth sits at our touch.
export function sizeAtPrice(
  book: BookState,
  side: BookSide,
  priceCents: number,
): number {
  const levels = side === "BID" ? book.bids : book.asks;
  let total = 0;
  for (const o of levels) {
    if (o.priceCents === priceCents) total += o.size;
  }
  return total;
}

export function deskLiveOrderRefs(book: BookState): {
  bidOrderId: number | null;
  askOrderId: number | null;
} {
  let bidOrderId: number | null = null;
  let askOrderId: number | null = null;

  for (const order of book.bids) {
    if (order.owner === "desk") {
      bidOrderId = order.id;
      break;
    }
  }
  for (const order of book.asks) {
    if (order.owner === "desk") {
      askOrderId = order.id;
      break;
    }
  }

  return { bidOrderId, askOrderId };
}

export function queueAheadSize(book: BookState, orderId: number): number | null {
  for (const levels of [book.bids, book.asks]) {
    const targetIndex = levels.findIndex((order) => order.id === orderId);
    if (targetIndex === -1) continue;
    const targetPrice = levels[targetIndex]!.priceCents;
    let ahead = 0;
    for (let index = 0; index < targetIndex; index++) {
      if (levels[index]!.priceCents === targetPrice) {
        ahead += levels[index]!.size;
      }
    }
    return ahead;
  }
  return null;
}

// Project the top N levels of each side into the BookLevel[] shape the UI
// already renders. Aggregates by price; tags level as ours iff any desk
// order contributes to it.
export function projectVisibleBook(
  book: BookState,
  levels: number = VISIBLE_LEVELS,
): OrderBook {
  return {
    bids: projectSide(book.bids, levels),
    asks: projectSide(book.asks, levels),
  };
}

function projectSide(orders: RestingOrder[], levels: number): BookLevel[] {
  const out: BookLevel[] = [];
  if (orders.length === 0) return out;
  let currentPrice = orders[0].priceCents;
  let currentSize = 0;
  let currentOurs = false;
  for (const o of orders) {
    if (o.priceCents !== currentPrice) {
      out.push({ price: currentPrice, size: currentSize, isOurs: currentOurs || undefined });
      if (out.length >= levels) return out;
      currentPrice = o.priceCents;
      currentSize = 0;
      currentOurs = false;
    }
    currentSize += o.size;
    if (o.owner === "desk") currentOurs = true;
  }
  if (out.length < levels) {
    out.push({ price: currentPrice, size: currentSize, isOurs: currentOurs || undefined });
  }
  return out;
}

// Construct a resting order with a fresh ID. Caller is responsible for
// snapping the price to TICK_CENTS and clamping to [PRICE_MIN, PRICE_MAX].
export function makeOrder(
  state: BookState,
  side: BookSide,
  priceCents: number,
  size: number,
  owner: OrderOwner,
  postedTick: number,
  ttlTicks: number,
): { order: RestingOrder; nextId: OrderId } {
  const id = state.nextOrderId;
  return {
    order: { id, side, priceCents, size, owner, postedTick, ttlTicks },
    nextId: id + 1,
  };
}

// Insert into a side keeping price-priority + postedTick-FIFO ordering.
// Pure; returns a new array.
//
// For BID we want descending price; cmp = existing.price - new.price. We
// keep advancing while the existing order is "better" (cmp >= 0 with
// earlier FIFO position) and break — inserting the new order — when we
// reach an existing order with a worse (lower) price.
//
// For ASK we want ascending price; cmp = new.price - existing.price. Same
// shape: advance while existing is better (lower price), break when we
// hit a worse (higher) one.
export function insertIntoSide(
  orders: RestingOrder[],
  o: RestingOrder,
): RestingOrder[] {
  const out = orders.slice();
  let i = 0;
  while (i < out.length) {
    const cmp = o.side === "BID"
      ? out[i].priceCents - o.priceCents
      : o.priceCents - out[i].priceCents;
    if (cmp < 0) break;
    if (cmp === 0 && out[i].postedTick > o.postedTick) break;
    i++;
  }
  out.splice(i, 0, o);
  return out;
}

// Remove orders matching predicate; returns new array (or the same reference
// when nothing matched, to keep React identity stable for unchanged sides).
export function removeWhere(
  orders: RestingOrder[],
  pred: (o: RestingOrder) => boolean,
): RestingOrder[] {
  let i = 0;
  while (i < orders.length && !pred(orders[i])) i++;
  if (i === orders.length) return orders;
  return orders.filter((o) => !pred(o));
}

// Initial-state seed: drop 3 LP layers per side around the prior mid so the
// book renders populated on the very first frame. Without this the visible
// ladder would be empty until enough archetype arrivals fired to fill it.
export function seedInitialBook(midCents: number): BookState {
  const mid = clampPrice(midCents);
  let state = emptyBookState();
  for (let i = 0; i < 3; i++) {
    const bidPx = clampPrice(mid - (i + 1) * TICK_CENTS * 2);
    const askPx = clampPrice(mid + (i + 1) * TICK_CENTS * 2);
    const baseSize = 6 + i * 3;
    const made1 = makeOrder(state, "BID", bidPx, baseSize, "lp", 0, 999);
    state = {
      ...state,
      nextOrderId: made1.nextId,
      bids: insertIntoSide(state.bids, made1.order),
    };
    const made2 = makeOrder(state, "ASK", askPx, baseSize, "lp", 0, 999);
    state = {
      ...state,
      nextOrderId: made2.nextId,
      asks: insertIntoSide(state.asks, made2.order),
    };
  }
  return state;
}
