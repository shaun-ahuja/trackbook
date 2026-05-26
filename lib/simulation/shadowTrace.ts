import type { FillKind } from "../types";
import type { BookState, BookSide, OrderOwner } from "./orderBookState";
import {
  bestAskPrice,
  bestBidPrice,
  deskLiveOrderRefs,
  projectVisibleBook,
  queueAheadSize,
} from "./orderBookState";

export type ShadowStepLabel =
  | "age_cancel"
  | "sync_desk"
  | "apply_intents"
  | "desk_cross"
  | "divergence_magnet"
  | "shock_sweep"
  | "replenish"
  | "post_fills"
  | "seed_parity";

export type ShadowCommand =
  | {
      kind: "cancel";
      tsOrderId: number;
    }
  | {
      kind: "submit_limit";
      side: BookSide;
      owner: OrderOwner;
      priceCents: number;
      qty: number;
      ttlTicks: number;
      logicalTime: number;
      fillKind: FillKind;
      expectedTsOrderId: number | null;
    }
  | {
      kind: "submit_market";
      side: "BUY" | "SELL";
      owner: OrderOwner;
      qty: number;
      logicalTime: number;
      fillKind: FillKind;
    };

export type ShadowExpectedFill = {
  side: "BUY" | "SELL";
  qty: number;
  priceCents: number;
  kind: FillKind;
};

export type ShadowExpectedAccounting = {
  inventory: number;
  avgCost: number;
  realizedPnl: number;
};

export type ShadowExpectedBook = {
  bestBid: number | null;
  bestAsk: number | null;
  bestMid: number | null;
  visibleDepth: ReturnType<typeof projectVisibleBook>;
  deskBidTsOrderId: number | null;
  deskAskTsOrderId: number | null;
  deskBidQueueAhead: number | null;
  deskAskQueueAhead: number | null;
  activeOrderCount: number;
  lastTradePriceCents: number | null;
};

export type ShadowPhaseVisit = {
  label: ShadowStepLabel;
  phaseIndex: number;
  stepIndex: number | null;
  bookChanged: boolean;
  commandCount: number;
  fillCount: number;
  accountingIncluded: boolean;
  traceEmitted: boolean;
};

export type ShadowTraceStep = {
  label: ShadowStepLabel;
  phaseIndex: number;
  stepIndex: number;
  commands: ShadowCommand[];
  expectedBook: ShadowExpectedBook;
  expectedFills: ShadowExpectedFill[];
  expectedAccounting?: ShadowExpectedAccounting;
};

export type ShadowMarketTrace = {
  marketId: string;
  marketIndex: number;
  tick: number;
  phaseVisits: ShadowPhaseVisit[];
  steps: ShadowTraceStep[];
};

export type ShadowTickTrace = {
  kind: "tick";
  tick: number;
  now: number;
  markets: ShadowMarketTrace[];
};

export function normalizeExpectedFills(
  fills: Array<{ side: "BUY" | "SELL"; qty: number; price: number; kind: FillKind }>,
): ShadowExpectedFill[] {
  return fills.map((fill) => ({
    side: fill.side,
    qty: fill.qty,
    priceCents: fill.price,
    kind: fill.kind,
  }));
}

export function bookStateTraceSignature(book: BookState): string {
  return JSON.stringify({
    nextOrderId: book.nextOrderId,
    lastTradePriceCents: book.lastTradePriceCents ?? null,
    bids: book.bids.map((order) => [
      order.id,
      order.side,
      order.priceCents,
      order.size,
      order.owner,
      order.postedTick,
      order.ttlTicks,
    ]),
    asks: book.asks.map((order) => [
      order.id,
      order.side,
      order.priceCents,
      order.size,
      order.owner,
      order.postedTick,
      order.ttlTicks,
    ]),
  });
}

export function captureExpectedBook(
  book: BookState,
): ShadowExpectedBook {
  const refs = deskLiveOrderRefs(book);
  const bestBid = book.bids.length > 0 ? bestBidPrice(book, 0) : null;
  const bestAsk = book.asks.length > 0 ? bestAskPrice(book, 0) : null;
  const bestMid =
    bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;

  return {
    bestBid,
    bestAsk,
    bestMid,
    visibleDepth: projectVisibleBook(book),
    deskBidTsOrderId: refs.bidOrderId,
    deskAskTsOrderId: refs.askOrderId,
    deskBidQueueAhead:
      refs.bidOrderId !== null ? queueAheadSize(book, refs.bidOrderId) : null,
    deskAskQueueAhead:
      refs.askOrderId !== null ? queueAheadSize(book, refs.askOrderId) : null,
    activeOrderCount: book.bids.length + book.asks.length,
    lastTradePriceCents: book.lastTradePriceCents ?? null,
  };
}
