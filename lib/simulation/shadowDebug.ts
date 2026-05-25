import type { ShadowMismatch, ShadowMismatchType } from "./shadowDiff";
import type { ShadowMarketTrace } from "./shadowTrace";

export type ShadowMarketReplaySummary = {
  marketId: string;
  marketIndex: number;
  tick: number;
  phaseCount: number;
  stepCount: number;
  commandCount: number;
  expectedFillCount: number;
  mismatchCount: number;
  coverageGapCount: number;
  orderingMismatchCount: number;
  replayFaultCount: number;
  deskRefChecks: number;
  queueAheadChecks: number;
  accountingChecks: number;
  accountingSkippedChecks: number;
  firstMismatchType: ShadowMismatchType | null;
};

export type ShadowTickReplaySummary = {
  tick: number;
  marketCount: number;
  mismatchCount: number;
  coverageGapCount: number;
  orderingMismatchCount: number;
  replayFaultCount: number;
  markets: ShadowMarketReplaySummary[];
};

function countDeskChecks(trace: ShadowMarketTrace): number {
  let checks = 0;
  for (const step of trace.steps) {
    if (step.expectedBook.deskBidTsOrderId !== null) checks++;
    if (step.expectedBook.deskAskTsOrderId !== null) checks++;
  }
  return checks;
}

export function summarizeMarketReplay(args: {
  trace: ShadowMarketTrace;
  mismatches: ShadowMismatch[];
  allowAccounting: boolean;
}): ShadowMarketReplaySummary {
  const { trace, mismatches, allowAccounting } = args;
  const commandCount = trace.steps.reduce((sum, step) => sum + step.commands.length, 0);
  const expectedFillCount = trace.steps.reduce((sum, step) => sum + step.expectedFills.length, 0);
  const coverageGapCount = mismatches.filter((mismatch) => mismatch.type === "trace_coverage").length;
  const orderingMismatchCount = mismatches.filter((mismatch) => mismatch.type === "ordering").length;
  const replayFaultCount = mismatches.filter((mismatch) => mismatch.type === "replay_fault").length;
  const accountingStepCount = trace.steps.filter((step) => step.expectedAccounting).length;

  return {
    marketId: trace.marketId,
    marketIndex: trace.marketIndex,
    tick: trace.tick,
    phaseCount: trace.phaseVisits.length,
    stepCount: trace.steps.length,
    commandCount,
    expectedFillCount,
    mismatchCount: mismatches.length,
    coverageGapCount,
    orderingMismatchCount,
    replayFaultCount,
    deskRefChecks: countDeskChecks(trace),
    queueAheadChecks: countDeskChecks(trace),
    accountingChecks: allowAccounting ? accountingStepCount : 0,
    accountingSkippedChecks: allowAccounting ? 0 : accountingStepCount,
    firstMismatchType: mismatches[0]?.type ?? null,
  };
}

export function summarizeTickReplay(args: {
  tick: number;
  marketSummaries: ShadowMarketReplaySummary[];
}): ShadowTickReplaySummary {
  const { tick, marketSummaries } = args;
  return {
    tick,
    marketCount: marketSummaries.length,
    mismatchCount: marketSummaries.reduce((sum, market) => sum + market.mismatchCount, 0),
    coverageGapCount: marketSummaries.reduce((sum, market) => sum + market.coverageGapCount, 0),
    orderingMismatchCount: marketSummaries.reduce((sum, market) => sum + market.orderingMismatchCount, 0),
    replayFaultCount: marketSummaries.reduce((sum, market) => sum + market.replayFaultCount, 0),
    markets: marketSummaries,
  };
}
