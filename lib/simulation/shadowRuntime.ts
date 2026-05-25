import type { Market, SimState } from "../types";
import { MatchingEngineKernel } from "../wasm/orderBookKernel.ts";
import {
  MatchingEngineFillKindTag,
  MatchingEngineOpcode,
  MatchingEngineOwnerTag,
  MatchingEngineSideTag,
  type MatchingEngineCommand,
  type MatchingEngineFillRecord,
} from "../wasm/orderBookKernelTypes.ts";
import type { ShadowCommand, ShadowMarketTrace, ShadowTickTrace } from "./shadowTrace";
import { compareShadowStep, type ShadowMismatch } from "./shadowDiff";
import {
  summarizeMarketReplay,
  summarizeTickReplay,
  type ShadowTickReplaySummary,
} from "./shadowDebug";

const SHADOW_ENV_FLAG = "1";
const MAX_RECENT_MISMATCHES = 100;
const MAX_RECENT_TICK_SUMMARIES = 20;

type MarketRuntimeState = {
  handle: number;
  tsToNativeOrderIds: Map<number, number>;
  accountingComparable: boolean;
};

export type ShadowDebugState = {
  enabled: boolean;
  ready: boolean;
  disabledReason?: string;
  handlesByMarket: Record<string, number>;
  lastTickByMarket: Record<string, number>;
  mismatchCounts: Record<string, number>;
  recentMismatches: ShadowMismatch[];
  accountingComparableByMarket: Record<string, boolean>;
  recentTickSummaries: ShadowTickReplaySummary[];
};

declare global {
  interface Window {
    __TRACKBOOK_SHADOW__?: ShadowDebugState;
  }
}

function isShadowEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_TRACKBOOK_SHADOW === SHADOW_ENV_FLAG
  );
}

function ownerToTag(owner: ShadowCommand["kind"] extends never ? never : string): MatchingEngineOwnerTag {
  switch (owner) {
    case "desk": return MatchingEngineOwnerTag.Desk;
    case "lp": return MatchingEngineOwnerTag.Lp;
    case "noise": return MatchingEngineOwnerTag.Noise;
    case "informed": return MatchingEngineOwnerTag.Informed;
    case "momentum": return MatchingEngineOwnerTag.Momentum;
    case "rebal": return MatchingEngineOwnerTag.Rebal;
    case "patient": return MatchingEngineOwnerTag.Patient;
    case "panic": return MatchingEngineOwnerTag.Panic;
    case "event": return MatchingEngineOwnerTag.Event;
    default: return MatchingEngineOwnerTag.Lp;
  }
}

function fillKindToTag(kind: "passive" | "aggressive" | "flatten" | "shock"): MatchingEngineFillKindTag {
  switch (kind) {
    case "passive": return MatchingEngineFillKindTag.Passive;
    case "aggressive": return MatchingEngineFillKindTag.Aggressive;
    case "flatten": return MatchingEngineFillKindTag.Flatten;
    case "shock": return MatchingEngineFillKindTag.Shock;
  }
}

function sideToTag(side: "BID" | "ASK"): MatchingEngineSideTag {
  return side === "BID" ? MatchingEngineSideTag.BidOrBuy : MatchingEngineSideTag.AskOrSell;
}

function tradeSideToTag(side: "BUY" | "SELL"): MatchingEngineSideTag {
  return side === "BUY" ? MatchingEngineSideTag.BidOrBuy : MatchingEngineSideTag.AskOrSell;
}

export class ShadowSimulationRuntime {
  static enabled(): boolean {
    return isShadowEnabled();
  }

  static async create(): Promise<ShadowSimulationRuntime> {
    const kernel = await MatchingEngineKernel.create();
    return new ShadowSimulationRuntime(kernel);
  }

  private readonly markets = new Map<string, MarketRuntimeState>();
  private readonly debugState: ShadowDebugState = {
    enabled: true,
    ready: false,
    handlesByMarket: {},
    lastTickByMarket: {},
    mismatchCounts: {},
    recentMismatches: [],
    accountingComparableByMarket: {},
    recentTickSummaries: [],
  };

  private constructor(private readonly kernel: MatchingEngineKernel) {
    this.publishDebugState();
  }

  initializeFromState(state: SimState): void {
    this.destroyAll();
    this.debugState.ready = false;
    this.debugState.disabledReason = undefined;
    this.debugState.recentTickSummaries = [];
    this.debugState.recentMismatches = [];
    this.debugState.mismatchCounts = {};
    for (const marketId of state.marketOrder) {
      this.seedMarket(state.markets[marketId]);
    }
    this.debugState.ready = true;
    this.publishDebugState();
  }

  disable(reason: string): void {
    this.debugState.enabled = false;
    this.debugState.disabledReason = reason;
    this.publishDebugState();
  }

  getDebugStateSnapshot(): ShadowDebugState {
    return {
      ...this.debugState,
      recentMismatches: [...this.debugState.recentMismatches],
      handlesByMarket: { ...this.debugState.handlesByMarket },
      lastTickByMarket: { ...this.debugState.lastTickByMarket },
      mismatchCounts: { ...this.debugState.mismatchCounts },
      accountingComparableByMarket: { ...this.debugState.accountingComparableByMarket },
      recentTickSummaries: this.debugState.recentTickSummaries.map((summary) => ({
        ...summary,
        markets: summary.markets.map((market) => ({ ...market })),
      })),
    };
  }

  replayTick(trace: ShadowTickTrace): void {
    if (!this.debugState.enabled || !this.debugState.ready) return;
    const marketSummaries: ShadowTickReplaySummary["markets"] = [];
    for (const marketTrace of trace.markets) {
      try {
        marketSummaries.push(this.replayMarketTrace(marketTrace));
      } catch (error) {
        const mismatch: ShadowMismatch = {
          marketId: marketTrace.marketId,
          tick: trace.tick,
          stepLabel: marketTrace.steps[0]?.label ?? "post_fills",
          type: "replay_fault",
          detail: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
        this.recordMismatch(mismatch);
        marketSummaries.push(summarizeMarketReplay({
          trace: marketTrace,
          mismatches: [mismatch],
          allowAccounting:
            this.markets.get(marketTrace.marketId)?.accountingComparable ?? false,
        }));
        this.disable(`shadow replay fault on market ${marketTrace.marketId}`);
        break;
      }
    }
    this.debugState.recentTickSummaries.unshift(summarizeTickReplay({
      tick: trace.tick,
      marketSummaries,
    }));
    this.debugState.recentTickSummaries = this.debugState.recentTickSummaries.slice(
      0,
      MAX_RECENT_TICK_SUMMARIES,
    );
    this.publishDebugState();
  }

  private seedMarket(market: Market): void {
    const handle = this.kernel.createEngine();
    const state: MarketRuntimeState = {
      handle,
      tsToNativeOrderIds: new Map<number, number>(),
      accountingComparable:
        market.inventory === 0 &&
        market.avgCost === 0 &&
        market.realizedPnl === 0,
    };

    for (const order of [...market.bookState.bids, ...market.bookState.asks]) {
      const result = this.kernel.executeHandle(handle, [{
        op: MatchingEngineOpcode.SubmitLimit,
        side: sideToTag(order.side),
        owner: ownerToTag(order.owner),
        priceTicks: Math.round(order.priceCents * 2),
        qty: order.size,
        logicalTime: order.postedTick,
        ttlTicks: order.ttlTicks,
        fillKind: MatchingEngineFillKindTag.Aggressive,
      }]);
      if (result.lastOrderId > 0) {
        state.tsToNativeOrderIds.set(order.id, result.lastOrderId);
      }
    }

    this.markets.set(market.id, state);
    this.debugState.handlesByMarket[market.id] = handle;
    this.debugState.accountingComparableByMarket[market.id] = state.accountingComparable;
  }

  private replayMarketTrace(trace: ShadowMarketTrace) {
    const marketState = this.markets.get(trace.marketId);
    if (!marketState) {
      const mismatch: ShadowMismatch = {
        marketId: trace.marketId,
        tick: trace.tick,
        stepLabel: trace.steps[0]?.label ?? "post_fills",
        type: "replay_fault",
        detail: {
          reason: "missing_market_state",
        },
      };
      this.recordMismatch(mismatch);
      return summarizeMarketReplay({
        trace,
        mismatches: [mismatch],
        allowAccounting: false,
      });
    }

    const mismatches: ShadowMismatch[] = [];

    for (let phaseIndex = 0; phaseIndex < trace.phaseVisits.length; phaseIndex++) {
      const phaseVisit = trace.phaseVisits[phaseIndex];
      if (phaseVisit.phaseIndex !== phaseIndex) {
        mismatches.push({
          marketId: trace.marketId,
          tick: trace.tick,
          stepLabel: phaseVisit.label,
          type: "ordering",
          detail: {
            reason: "phase_index_out_of_order",
            actual: phaseVisit.phaseIndex,
            expected: phaseIndex,
          },
        });
      }
      if (phaseVisit.bookChanged && !phaseVisit.traceEmitted) {
        mismatches.push({
          marketId: trace.marketId,
          tick: trace.tick,
          stepLabel: phaseVisit.label,
          type: "trace_coverage",
          detail: {
            reason: "book_changed_without_trace_step",
            phaseIndex,
          },
        });
      }
      if (phaseVisit.traceEmitted) {
        const linkedStep = phaseVisit.stepIndex === null
          ? undefined
          : trace.steps[phaseVisit.stepIndex];
        if (
          phaseVisit.stepIndex === null ||
          !linkedStep ||
          linkedStep.phaseIndex !== phaseVisit.phaseIndex ||
          linkedStep.label !== phaseVisit.label
        ) {
          mismatches.push({
            marketId: trace.marketId,
            tick: trace.tick,
            stepLabel: phaseVisit.label,
            type: "ordering",
            detail: {
              reason: "phase_step_link_broken",
              phaseIndex,
              stepIndex: phaseVisit.stepIndex,
            },
          });
        }
      }
    }

    for (let stepIndex = 0; stepIndex < trace.steps.length; stepIndex++) {
      const step = trace.steps[stepIndex];
      if (step.stepIndex !== stepIndex) {
        mismatches.push({
          marketId: trace.marketId,
          tick: trace.tick,
          stepLabel: step.label,
          type: "ordering",
          detail: {
            reason: "step_index_out_of_order",
            actual: step.stepIndex,
            expected: stepIndex,
          },
        });
      }
      const phaseVisit = trace.phaseVisits[step.phaseIndex];
      if (!phaseVisit || phaseVisit.stepIndex !== stepIndex || phaseVisit.label !== step.label) {
        mismatches.push({
          marketId: trace.marketId,
          tick: trace.tick,
          stepLabel: step.label,
          type: "ordering",
          detail: {
            reason: "step_phase_link_broken",
            phaseIndex: step.phaseIndex,
            stepIndex,
          },
        });
      }
    }

    for (const step of trace.steps) {
      let lastResult = this.kernel.executeHandle(marketState.handle, []);
      const stepFills: MatchingEngineFillRecord[] = [];
      for (const command of step.commands) {
        const native = this.toNativeCommand(command, marketState.tsToNativeOrderIds);
        if (!native) {
          mismatches.push({
            marketId: trace.marketId,
            tick: trace.tick,
            stepLabel: step.label,
            type: "mapping",
            detail: { command },
          });
          continue;
        }
        lastResult = this.kernel.executeHandle(marketState.handle, [native]);
        stepFills.push(...lastResult.fills);
        if (command.kind === "submit_limit" && command.expectedTsOrderId !== null) {
          if (lastResult.lastOrderId > 0) {
            marketState.tsToNativeOrderIds.set(command.expectedTsOrderId, lastResult.lastOrderId);
          } else {
            mismatches.push({
              marketId: trace.marketId,
              tick: trace.tick,
              stepLabel: step.label,
              type: "mapping",
              detail: {
                reason: "submit_limit_missing_native_order_id",
                command,
              },
            });
          }
        }
        if (command.kind === "cancel") {
          marketState.tsToNativeOrderIds.delete(command.tsOrderId);
        }
      }

      const expectedBidNativeId =
        step.expectedBook.deskBidTsOrderId !== null
          ? marketState.tsToNativeOrderIds.get(step.expectedBook.deskBidTsOrderId) ?? null
          : null;
      const expectedAskNativeId =
        step.expectedBook.deskAskTsOrderId !== null
          ? marketState.tsToNativeOrderIds.get(step.expectedBook.deskAskTsOrderId) ?? null
          : null;

      const bidQueueAhead = expectedBidNativeId !== null
        ? this.kernel.executeHandle(marketState.handle, [{
            op: MatchingEngineOpcode.QueryQueueAhead,
            orderId: expectedBidNativeId,
          }]).snapshot.queueAheadQty
        : null;
      const askQueueAhead = expectedAskNativeId !== null
        ? this.kernel.executeHandle(marketState.handle, [{
            op: MatchingEngineOpcode.QueryQueueAhead,
            orderId: expectedAskNativeId,
          }]).snapshot.queueAheadQty
        : null;

      const comparisonResult = step.commands.length > 0
        ? {
            ...lastResult,
            fills: stepFills,
          }
        : lastResult;

      mismatches.push(...compareShadowStep({
        marketId: trace.marketId,
        tick: trace.tick,
        step,
        result: comparisonResult,
        mappedDeskBidRef: expectedBidNativeId,
        mappedDeskAskRef: expectedAskNativeId,
        deskBidQueueAhead: bidQueueAhead,
        deskAskQueueAhead: askQueueAhead,
        allowAccounting: marketState.accountingComparable,
      }));
    }

    this.debugState.lastTickByMarket[trace.marketId] = trace.tick;
    for (const mismatch of mismatches) {
      this.recordMismatch(mismatch);
    }
    return summarizeMarketReplay({
      trace,
      mismatches,
      allowAccounting: marketState.accountingComparable,
    });
  }

  private toNativeCommand(
    command: ShadowCommand,
    orderMap: Map<number, number>,
  ): MatchingEngineCommand | null {
    switch (command.kind) {
      case "cancel": {
        const nativeOrderId = orderMap.get(command.tsOrderId);
        if (!nativeOrderId) return null;
        return {
          op: MatchingEngineOpcode.CancelOrder,
          orderId: nativeOrderId,
        };
      }
      case "submit_limit":
        return {
          op: MatchingEngineOpcode.SubmitLimit,
          side: sideToTag(command.side),
          owner: ownerToTag(command.owner),
          priceTicks: Math.round(command.priceCents * 2),
          qty: command.qty,
          logicalTime: command.logicalTime,
          ttlTicks: command.ttlTicks,
          fillKind: fillKindToTag(command.fillKind),
        };
      case "submit_market":
        return {
          op: MatchingEngineOpcode.SubmitMarket,
          side: tradeSideToTag(command.side),
          owner: ownerToTag(command.owner),
          qty: command.qty,
          logicalTime: command.logicalTime,
          fillKind: fillKindToTag(command.fillKind),
        };
    }
  }

  private recordMismatch(mismatch: ShadowMismatch): void {
    const key = mismatch.type;
    this.debugState.mismatchCounts[key] = (this.debugState.mismatchCounts[key] ?? 0) + 1;
    this.debugState.recentMismatches.unshift(mismatch);
    this.debugState.recentMismatches = this.debugState.recentMismatches.slice(0, MAX_RECENT_MISMATCHES);
    console.warn("[shadow]", mismatch);
  }

  private destroyAll(): void {
    for (const market of this.markets.values()) {
      this.kernel.destroyHandle(market.handle);
    }
    this.markets.clear();
    this.debugState.handlesByMarket = {};
    this.debugState.lastTickByMarket = {};
    this.debugState.accountingComparableByMarket = {};
  }

  private publishDebugState(): void {
    if (typeof window === "undefined") return;
    window.__TRACKBOOK_SHADOW__ = this.getDebugStateSnapshot();
  }
}
