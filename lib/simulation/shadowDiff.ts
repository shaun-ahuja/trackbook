import type { FillKind } from "../types";
import type { MatchingEngineExecResult, MatchingEngineStateSnapshot } from "../wasm/orderBookKernelTypes.ts";
import { centsToTicks, ticksToCents } from "../wasm/orderBookKernelTypes.ts";
import type { ShadowExpectedAccounting, ShadowExpectedBook, ShadowExpectedFill, ShadowTraceStep } from "./shadowTrace";

export type ShadowMismatchType =
  | "top_of_book"
  | "visible_depth"
  | "fills"
  | "desk_refs"
  | "queue_ahead"
  | "accounting"
  | "mapping"
  | "ordering"
  | "trace_coverage"
  | "replay_fault";

export type ShadowMismatch = {
  marketId: string;
  tick: number;
  stepLabel: ShadowTraceStep["label"];
  type: ShadowMismatchType;
  detail: Record<string, unknown>;
};

function normalizeExpectedLevels(expected: ShadowExpectedBook["visibleDepth"]) {
  return {
    bids: expected.bids.map((level) => ({
      priceTicks: centsToTicks(level.price),
      qty: level.size,
      hasDesk: Boolean(level.isOurs),
    })),
    asks: expected.asks.map((level) => ({
      priceTicks: centsToTicks(level.price),
      qty: level.size,
      hasDesk: Boolean(level.isOurs),
    })),
  };
}

function normalizeExpectedFills(expected: ShadowExpectedFill[]) {
  return expected.map((fill) => ({
    side: fill.side,
    qty: fill.qty,
    priceTicks: centsToTicks(fill.priceCents),
    kind: fill.kind,
  }));
}

function normalizeNativeFills(result: MatchingEngineExecResult) {
  return result.fills.map((fill) => ({
    side: fill.deskSide,
    qty: fill.qty,
    priceTicks: fill.priceTicks,
    kind: fillKindFromTag(fill.kind),
  }));
}

function fillKindFromTag(kind: number): FillKind {
  switch (kind) {
    case 1: return "passive";
    case 2: return "aggressive";
    case 3: return "flatten";
    case 4: return "shock";
    default: return "aggressive";
  }
}

// Tolerance for float comparison between TS (cents, batch-applied) and C++
// (ticks, inline-applied). Both are IEEE 754 double but accumulate via
// different call chains; sub-nanosecond deltas are not meaningful.
const ACCOUNTING_EPSILON = 1e-9;

function compareAccounting(
  snapshot: MatchingEngineStateSnapshot,
  expected: ShadowExpectedAccounting,
): Record<string, unknown> | null {
  const avgCostActual = ticksToCents(snapshot.avgCostTicks);
  const realizedActual = ticksToCents(snapshot.realizedPnlTicks);
  if (
    snapshot.positionQty === expected.inventory &&
    Math.abs(avgCostActual - expected.avgCost) < ACCOUNTING_EPSILON &&
    Math.abs(realizedActual - expected.realizedPnl) < ACCOUNTING_EPSILON
  ) {
    return null;
  }
  return {
    actual: {
      inventory: snapshot.positionQty,
      avgCost: avgCostActual,
      realizedPnl: realizedActual,
    },
    expected,
  };
}

export function compareShadowStep(args: {
  marketId: string;
  tick: number;
  step: ShadowTraceStep;
  result: MatchingEngineExecResult;
  mappedDeskBidRef: number | null;
  mappedDeskAskRef: number | null;
  deskBidQueueAhead: number | null;
  deskAskQueueAhead: number | null;
  allowAccounting: boolean;
}): ShadowMismatch[] {
  const { marketId, tick, step, result } = args;
  const mismatches: ShadowMismatch[] = [];
  const expectedLevels = normalizeExpectedLevels(step.expectedBook.visibleDepth);

  const topMatches =
    result.snapshot.bestBidPriceTicks === (step.expectedBook.bestBid === null ? 0 : centsToTicks(step.expectedBook.bestBid)) &&
    result.snapshot.bestAskPriceTicks === (step.expectedBook.bestAsk === null ? 0 : centsToTicks(step.expectedBook.bestAsk)) &&
    result.snapshot.lastTradePriceTicks === (step.expectedBook.lastTradePriceCents === null ? 0 : centsToTicks(step.expectedBook.lastTradePriceCents));
  if (!topMatches) {
    mismatches.push({
      marketId,
      tick,
      stepLabel: step.label,
      type: "top_of_book",
      detail: {
        actual: {
          bestBid: result.snapshot.bestBidPriceTicks,
          bestAsk: result.snapshot.bestAskPriceTicks,
          lastTrade: result.snapshot.lastTradePriceTicks,
        },
        expected: {
          bestBid: step.expectedBook.bestBid === null ? 0 : centsToTicks(step.expectedBook.bestBid),
          bestAsk: step.expectedBook.bestAsk === null ? 0 : centsToTicks(step.expectedBook.bestAsk),
          lastTrade: step.expectedBook.lastTradePriceCents === null ? 0 : centsToTicks(step.expectedBook.lastTradePriceCents),
        },
      },
    });
  }

  if (
    JSON.stringify(result.snapshot.bidLevels) !== JSON.stringify(expectedLevels.bids) ||
    JSON.stringify(result.snapshot.askLevels) !== JSON.stringify(expectedLevels.asks)
  ) {
    mismatches.push({
      marketId,
      tick,
      stepLabel: step.label,
      type: "visible_depth",
      detail: {
        actual: {
          bids: result.snapshot.bidLevels,
          asks: result.snapshot.askLevels,
        },
        expected: expectedLevels,
      },
    });
  }

  const nativeFills = normalizeNativeFills(result);
  const expectedFills = normalizeExpectedFills(step.expectedFills);
  if (JSON.stringify(nativeFills) !== JSON.stringify(expectedFills)) {
    mismatches.push({
      marketId,
      tick,
      stepLabel: step.label,
      type: "fills",
      detail: {
        actual: nativeFills,
        expected: expectedFills,
      },
    });
  }

  if (
    result.snapshot.deskBidRef !== (args.mappedDeskBidRef ?? 0) ||
    result.snapshot.deskAskRef !== (args.mappedDeskAskRef ?? 0)
  ) {
    mismatches.push({
      marketId,
      tick,
      stepLabel: step.label,
      type: "desk_refs",
      detail: {
        actual: {
          deskBidRef: result.snapshot.deskBidRef,
          deskAskRef: result.snapshot.deskAskRef,
        },
        expected: {
          deskBidRef: args.mappedDeskBidRef ?? 0,
          deskAskRef: args.mappedDeskAskRef ?? 0,
        },
      },
    });
  }

  if (
    args.deskBidQueueAhead !== step.expectedBook.deskBidQueueAhead ||
    args.deskAskQueueAhead !== step.expectedBook.deskAskQueueAhead
  ) {
    mismatches.push({
      marketId,
      tick,
      stepLabel: step.label,
      type: "queue_ahead",
      detail: {
        actual: {
          bid: args.deskBidQueueAhead,
          ask: args.deskAskQueueAhead,
        },
        expected: {
          bid: step.expectedBook.deskBidQueueAhead,
          ask: step.expectedBook.deskAskQueueAhead,
        },
      },
    });
  }

  if (args.allowAccounting && step.expectedAccounting) {
    const accounting = compareAccounting(result.snapshot, step.expectedAccounting);
    if (accounting) {
      mismatches.push({
        marketId,
        tick,
        stepLabel: step.label,
        type: "accounting",
        detail: accounting,
      });
    }
  }

  return mismatches;
}
