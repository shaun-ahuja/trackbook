import type { Fill, FillKind } from "../types.ts";
import { mkFill } from "./fills.ts";
import {
  type BookSide,
  type BookState,
  type OrderOwner,
  type RestingOrder,
  insertIntoSide,
  removeWhere,
} from "./orderBookState.ts";

// Pure matching helpers. No RNG inside; callers thread their own seed
// through ageAndCancel and replenishment in bookReducer.ts.
//
// Fill emission rules:
//   - A trade between desk and any external counterparty emits ONE Fill
//     from the desk's perspective. `deskFillKind` is the kind label
//     applied to that fill — caller picks the appropriate value:
//       passive    : external taker crossed desk's resting quote
//       aggressive : desk's market order crossed external resting depth
//       flatten    : desk's market order during FLATTEN posture
//       shock      : sev-3 event-driven sweep
//   - Desk-vs-desk trades (self-trade): skipped (cannot occur if
//     syncDeskQuote runs before executeMarket each tick).
//   - External-vs-external trades: not emitted as Fills (PnL untouched),
//     but bookState.lastTradePriceCents is still advanced so the vol
//     EWMA and tape see the print.

export type MatchContext = {
  now: number;
  currentTick: number;
  marketId: string;
  markFair: number;
  // Kind applied to the desk's side of any trade this call produces.
  deskFillKind: FillKind;
  // Tag source for the Fill ID. Caller can pass currentTick or an RNG int.
  // Doesn't need to be cryptographic — just enough to avoid collisions in
  // the recent-fills ring buffer.
  rngTag: number;
};

export type MatchResult = {
  book: BookState;
  fills: Fill[];
  lastTradePriceCents: number | null;
  restedOrderId?: number;
};

// Insert a limit order. If it crosses, match it greedily against the
// opposite side at price-then-FIFO order, then rest the remainder.
export function insertLimit(
  book: BookState,
  side: BookSide,
  priceCents: number,
  size: number,
  owner: OrderOwner,
  postedTick: number,
  ttlTicks: number,
  ctx: MatchContext,
): MatchResult {
  let opposing = side === "BID" ? book.asks : book.bids;
  const fills: Fill[] = [];
  let lastTradePriceCents: number | null = null;
  let remaining = size;
  let tagCounter = 0;

  while (remaining > 0 && opposing.length > 0) {
    const top = opposing[0];
    const crosses = side === "BID" ? priceCents >= top.priceCents : priceCents <= top.priceCents;
    if (!crosses) break;

    const tradeSize = Math.min(remaining, top.size);
    const tradePrice = top.priceCents;
    lastTradePriceCents = tradePrice;

    // Emit a desk-perspective fill if exactly one side is the desk.
    const deskIsMaker = top.owner === "desk";
    const deskIsTaker = owner === "desk";
    if (deskIsMaker !== deskIsTaker) {
      // Desk's BUY/SELL label is the side the desk traded.
      // If desk is the resting maker on BID → desk bought; on ASK → desk sold.
      // If desk is the incoming taker on BID → desk bought; on ASK → desk sold.
      const deskTradeSide: "BUY" | "SELL" = deskIsMaker
        ? (top.side === "BID" ? "BUY" : "SELL")
        : (side === "BID" ? "BUY" : "SELL");
      const kind: FillKind = deskIsMaker ? "passive" : ctx.deskFillKind;
      // For shock sweeps, override the maker's passive label too — the
      // desk getting run over by a stale resting quote is logically "shock".
      const finalKind: FillKind =
        ctx.deskFillKind === "shock" && deskIsMaker ? "shock" : kind;
      fills.push(
        mkFill({
          now: ctx.now,
          tick: ctx.currentTick,
          marketId: ctx.marketId,
          side: deskTradeSide,
          qty: tradeSize,
          price: tradePrice,
          kind: finalKind,
          markFair: ctx.markFair,
          rngTag: ctx.rngTag + tagCounter,
        }),
      );
      tagCounter++;
    }

    // Consume from top of opposing side.
    if (tradeSize >= top.size) {
      opposing = opposing.slice(1);
    } else {
      const reduced: RestingOrder = { ...top, size: top.size - tradeSize };
      opposing = [reduced, ...opposing.slice(1)];
    }
    remaining -= tradeSize;
  }

  // Stitch the consumed opposing side back into the book.
  let nextBook: BookState = side === "BID"
    ? { ...book, asks: opposing }
    : { ...book, bids: opposing };

  // Any unfilled remainder rests in the book at the original price. Skip
  // resting when remainder is zero (fully filled) or when the order was a
  // market order routed through here (callers use executeMarket for those).
  if (remaining > 0) {
    const resting: RestingOrder = {
      id: nextBook.nextOrderId,
      side,
      priceCents,
      size: remaining,
      owner,
      postedTick,
      ttlTicks,
    };
    nextBook = side === "BID"
      ? { ...nextBook, nextOrderId: nextBook.nextOrderId + 1, bids: insertIntoSide(nextBook.bids, resting) }
      : { ...nextBook, nextOrderId: nextBook.nextOrderId + 1, asks: insertIntoSide(nextBook.asks, resting) };
    if (lastTradePriceCents !== null) {
      nextBook = { ...nextBook, lastTradePriceCents, lastTradeTick: ctx.currentTick };
    }
    return { book: nextBook, fills, lastTradePriceCents, restedOrderId: resting.id };
  }

  if (lastTradePriceCents !== null) {
    nextBook = {
      ...nextBook,
      lastTradePriceCents,
      lastTradeTick: ctx.currentTick,
    };
  }

  return { book: nextBook, fills, lastTradePriceCents };
}

// Walk the opposite side FIFO and consume up to `size`. Unfilled remainder
// is dropped (market orders don't rest). Same fill-emission rules as
// insertLimit: desk-vs-external trades emit a desk-perspective Fill.
export function executeMarket(
  book: BookState,
  takerSide: "BUY" | "SELL",
  size: number,
  takerOwner: OrderOwner,
  ctx: MatchContext,
): MatchResult {
  let opposing = takerSide === "BUY" ? book.asks : book.bids;
  const fills: Fill[] = [];
  let lastTradePriceCents: number | null = null;
  let remaining = size;
  let tagCounter = 0;

  while (remaining > 0 && opposing.length > 0) {
    const top = opposing[0];
    const tradeSize = Math.min(remaining, top.size);
    const tradePrice = top.priceCents;
    lastTradePriceCents = tradePrice;

    const deskIsMaker = top.owner === "desk";
    const deskIsTaker = takerOwner === "desk";
    if (deskIsMaker !== deskIsTaker) {
      const deskTradeSide: "BUY" | "SELL" = deskIsMaker
        ? (top.side === "BID" ? "BUY" : "SELL")
        : takerSide;
      const kind: FillKind = deskIsMaker ? "passive" : ctx.deskFillKind;
      const finalKind: FillKind =
        ctx.deskFillKind === "shock" && deskIsMaker ? "shock" : kind;
      fills.push(
        mkFill({
          now: ctx.now,
          tick: ctx.currentTick,
          marketId: ctx.marketId,
          side: deskTradeSide,
          qty: tradeSize,
          price: tradePrice,
          kind: finalKind,
          markFair: ctx.markFair,
          rngTag: ctx.rngTag + tagCounter,
        }),
      );
      tagCounter++;
    }

    if (tradeSize >= top.size) {
      opposing = opposing.slice(1);
    } else {
      const reduced: RestingOrder = { ...top, size: top.size - tradeSize };
      opposing = [reduced, ...opposing.slice(1)];
    }
    remaining -= tradeSize;
  }

  let nextBook: BookState = takerSide === "BUY"
    ? { ...book, asks: opposing }
    : { ...book, bids: opposing };

  if (lastTradePriceCents !== null) {
    nextBook = {
      ...nextBook,
      lastTradePriceCents,
      lastTradeTick: ctx.currentTick,
    };
  }

  return { book: nextBook, fills, lastTradePriceCents };
}

// Cancel by ID. Used by syncDeskQuote on quote revision and by ageAndCancel
// for expiry / soft-cancel draws.
export function cancelById(book: BookState, id: number): BookState {
  const bids = removeWhere(book.bids, (o) => o.id === id);
  const asks = removeWhere(book.asks, (o) => o.id === id);
  if (bids === book.bids && asks === book.asks) return book;
  return { ...book, bids, asks };
}

// Cancel many IDs at once — single pass per side, avoids the O(n²) of
// chained cancelById calls when soft-cancel hits a swath of orders.
export function cancelManyByIds(book: BookState, ids: Set<number>): BookState {
  if (ids.size === 0) return book;
  const bids = removeWhere(book.bids, (o) => ids.has(o.id));
  const asks = removeWhere(book.asks, (o) => ids.has(o.id));
  if (bids === book.bids && asks === book.asks) return book;
  return { ...book, bids, asks };
}
