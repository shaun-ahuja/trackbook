import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { SimState, TransitEvent } from "../../types.ts";
import { makeInitialState } from "../markets.ts";
import { reducer, reduceWithShadow } from "../reducer.ts";
import { ShadowSimulationRuntime } from "../shadowRuntime.ts";
import type { ShadowTickTrace } from "../shadowTrace.ts";

const wasmModulePath = fileURLToPath(
  new URL("../../../public/wasm/orderbook/orderbook.mjs", import.meta.url),
);

const FIXED_NOW = 1735660800000;
const TICK_MS = 750;

function skipIfWasmMissing(): boolean {
  return !existsSync(wasmModulePath);
}

function narrowState(state: SimState, marketIds: string[]): SimState {
  return {
    ...state,
    selectedMarketId: marketIds[0] ?? state.selectedMarketId,
    marketOrder: marketIds,
    markets: Object.fromEntries(
      marketIds.map((marketId) => [marketId, state.markets[marketId]]),
    ),
  };
}

function makeShockEvent(state: SimState, marketId: string, tick: number): TransitEvent {
  const market = state.markets[marketId];
  return {
    id: `shadow-shock-${marketId}-${tick}`,
    ts: FIXED_NOW + tick * TICK_MS,
    line: market.line,
    kind: "SIGNAL",
    severity: 3,
    text: `shadow shock ${marketId}`,
    impacts: { [marketId]: 0.28 },
    source: "synthetic",
    category: "live",
  };
}

async function runHarness(args: {
  initialState?: SimState;
  marketIds: string[];
  ticks: number;
  eventTicks?: number[];
}): Promise<{
  state: SimState;
  traces: ShadowTickTrace[];
  debug: ReturnType<ShadowSimulationRuntime["getDebugStateSnapshot"]>;
}> {
  (globalThis as { window?: Window }).window = {} as Window;

  let state = narrowState(args.initialState ?? makeInitialState(FIXED_NOW), args.marketIds);
  const runtime = await ShadowSimulationRuntime.create();
  runtime.initializeFromState(state);
  const originalWarn = console.warn;
  console.warn = () => {};

  const traces: ShadowTickTrace[] = [];
  try {
    for (let tick = 1; tick <= args.ticks; tick++) {
      if (args.eventTicks?.includes(tick)) {
        state = reducer(state, {
          type: "INJECT_EVENTS",
          events: [makeShockEvent(state, args.marketIds[0], tick)],
        });
      }
      const traced = reduceWithShadow(state, {
        type: "TICK",
        now: FIXED_NOW + tick * TICK_MS,
      });
      assert.ok(traced.shadowTrace, `missing shadow trace at tick ${tick}`);
      runtime.replayTick(traced.shadowTrace);
      traces.push(traced.shadowTrace);
      state = traced.nextState;
    }
  } finally {
    console.warn = originalWarn;
  }

  return {
    state,
    traces,
    debug: runtime.getDebugStateSnapshot(),
  };
}

function assertNoStructuralShadowFailures(
  debug: ReturnType<ShadowSimulationRuntime["getDebugStateSnapshot"]>,
) {
  assert.equal(debug.mismatchCounts.mapping ?? 0, 0);
  assert.equal(debug.mismatchCounts.ordering ?? 0, 0);
  assert.equal(debug.mismatchCounts.trace_coverage ?? 0, 0);
  assert.equal(debug.mismatchCounts.replay_fault ?? 0, 0);
}

test("shadow hardening harness stays in parity over many ticks for one market", { skip: skipIfWasmMissing() }, async () => {
  const initial = makeInitialState(FIXED_NOW);
  const marketId = initial.marketOrder[0]!;
  const { traces, debug } = await runHarness({
    marketIds: [marketId],
    ticks: 160,
    eventTicks: [20, 60, 120, 150],
  });

  assertNoStructuralShadowFailures(debug);
  assert.equal(debug.lastTickByMarket[marketId], 160);
  assert.ok(debug.recentTickSummaries.length > 0);
  assert.equal(debug.recentTickSummaries[0]?.tick, 160);
  assert.ok(
    debug.recentTickSummaries.some((summary) =>
      summary.markets.some((market) => market.deskRefChecks > 0 && market.queueAheadChecks > 0),
    ),
  );
  assert.ok(
    debug.recentTickSummaries.some((summary) =>
      summary.markets.some((market) => market.accountingChecks > 0),
    ),
  );

  for (const trace of traces) {
    const marketTrace = trace.markets[0]!;
    assert.ok(
      marketTrace.phaseVisits.every((visit, index) => visit.phaseIndex === index),
    );
    assert.ok(
      marketTrace.steps.every((step, index) => step.stepIndex === index),
    );
    assert.ok(
      marketTrace.phaseVisits.every((visit) => !visit.bookChanged || visit.traceEmitted),
    );
  }
  if (debug.recentMismatches.length > 0) {
    assert.ok(
      debug.recentMismatches.every((mismatch) =>
        mismatch.type === "top_of_book" ||
        mismatch.type === "visible_depth" ||
        mismatch.type === "fills" ||
        mismatch.type === "desk_refs" ||
        mismatch.type === "queue_ahead" ||
        mismatch.type === "accounting",
      ),
    );
  }
});

test("shadow hardening harness preserves isolation across multiple markets", { skip: skipIfWasmMissing() }, async () => {
  const initial = makeInitialState(FIXED_NOW);
  const marketIds = initial.marketOrder.slice(0, 6);
  const { debug } = await runHarness({
    marketIds,
    ticks: 80,
    eventTicks: [15, 30, 45, 60],
  });

  assertNoStructuralShadowFailures(debug);
  assert.equal(Object.keys(debug.handlesByMarket).length, marketIds.length);
  assert.equal(new Set(Object.values(debug.handlesByMarket)).size, marketIds.length);
  assert.ok(
    debug.recentTickSummaries.every((summary) => summary.marketCount <= marketIds.length),
  );
  assert.ok(
    debug.recentTickSummaries.some((summary) =>
      summary.markets.filter((market) => market.deskRefChecks > 0).length >= 2,
    ),
  );
  if (debug.recentMismatches.length > 0) {
    assert.ok(
      debug.recentTickSummaries.some((summary) => summary.mismatchCount > 0),
    );
  }
});

test("shadow hardening keeps accounting comparisons scoped to trustworthy seeds", { skip: skipIfWasmMissing() }, async () => {
  const initial = makeInitialState(FIXED_NOW);
  const marketId = initial.marketOrder[0]!;
  const market = initial.markets[marketId]!;
  const seededState = narrowState({
    ...initial,
    markets: {
      ...initial.markets,
      [marketId]: {
        ...market,
        inventory: 3,
        avgCost: 47,
        realizedPnl: 5,
        unrealizedPnl: 0,
      },
    },
  }, [marketId]);

  const { debug } = await runHarness({
    initialState: seededState,
    marketIds: [marketId],
    ticks: 24,
  });

  assert.equal(debug.accountingComparableByMarket[marketId], false);
  assert.equal(debug.mismatchCounts.accounting ?? 0, 0);
  assert.ok(
    debug.recentTickSummaries.some((summary) =>
      summary.markets.some((marketSummary) =>
        marketSummary.accountingChecks === 0 &&
        marketSummary.accountingSkippedChecks > 0,
      ),
    ),
  );
});

test("shadow hardening records full trace coverage for active book-affecting phases", { skip: skipIfWasmMissing() }, async () => {
  const initial = makeInitialState(FIXED_NOW);
  const marketId = initial.marketOrder[0]!;
  const { traces, debug } = await runHarness({
    marketIds: [marketId],
    ticks: 200,
    eventTicks: [10, 40, 80, 120, 160],
  });

  assertNoStructuralShadowFailures(debug);

  const seenLabels = new Set<string>();
  for (const trace of traces) {
    for (const phaseVisit of trace.markets[0]!.phaseVisits) {
      seenLabels.add(phaseVisit.label);
    }
  }

  assert.ok(seenLabels.has("sync_desk"));
  assert.ok(seenLabels.has("apply_intents"));
  assert.ok(seenLabels.has("post_fills"));
  assert.ok(seenLabels.has("replenish"));
});
