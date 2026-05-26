import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { SimState, TransitEvent } from "../../types.ts";
import { makeInitialState } from "../markets.ts";
import { reducer, reduceWithShadow } from "../reducer.ts";
import { ShadowSimulationRuntime } from "../shadowRuntime.ts";
import { WasmMarketAdapter } from "../wasmAdapter.ts";
import { MatchingEngineKernel } from "../../wasm/orderBookKernel.ts";
import { ticksToCents } from "../../wasm/orderBookKernelTypes.ts";

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
    id: `wasm-shock-${marketId}-${tick}`,
    ts: FIXED_NOW + tick * TICK_MS,
    line: market.line,
    kind: "SIGNAL",
    severity: 3,
    text: `wasm-auth shock ${marketId}`,
    impacts: { [marketId]: 0.28 },
    source: "synthetic",
    category: "live",
  };
}

async function buildAdapters(state: SimState): Promise<{
  kernel: MatchingEngineKernel;
  adapters: Map<string, WasmMarketAdapter>;
}> {
  const kernel = await MatchingEngineKernel.create();
  const adapters = new Map<string, WasmMarketAdapter>();
  for (const id of state.marketOrder) {
    const market = state.markets[id];
    if (!market) continue;
    const handle = kernel.createEngine();
    const adapter = new WasmMarketAdapter(kernel, handle);
    adapter.seed(market.bookState);
    adapters.set(id, adapter);
  }
  return { kernel, adapters };
}

class CountingAdapter extends WasmMarketAdapter {
  readonly opCounts = { cancel: 0, submit: 0, execute: 0 };

  override cancelManyByIds(...args: Parameters<WasmMarketAdapter["cancelManyByIds"]>): void {
    if (args[0].size > 0) this.opCounts.cancel++;
    super.cancelManyByIds(...args);
  }

  override submitLimit(...args: Parameters<WasmMarketAdapter["submitLimit"]>): ReturnType<WasmMarketAdapter["submitLimit"]> {
    this.opCounts.submit++;
    return super.submitLimit(...args);
  }

  override executeMarket(...args: Parameters<WasmMarketAdapter["executeMarket"]>): ReturnType<WasmMarketAdapter["executeMarket"]> {
    this.opCounts.execute++;
    return super.executeMarket(...args);
  }
}

async function buildCountingAdapters(state: SimState): Promise<{
  kernel: MatchingEngineKernel;
  adapters: Map<string, CountingAdapter>;
}> {
  const kernel = await MatchingEngineKernel.create();
  const adapters = new Map<string, CountingAdapter>();
  for (const id of state.marketOrder) {
    const market = state.markets[id];
    if (!market) continue;
    const handle = kernel.createEngine();
    const adapter = new CountingAdapter(kernel, handle);
    adapter.seed(market.bookState);
    adapters.set(id, adapter);
  }
  return { kernel, adapters };
}

test(
  "WASM-authoritative execution: adapter path completes a tick without crashing",
  { skip: skipIfWasmMissing() },
  async () => {
    (globalThis as { window?: Window }).window = {} as Window;
    const initial = makeInitialState(FIXED_NOW);
    const marketId = initial.marketOrder[0]!;
    let state = narrowState(initial, [marketId]);
    const { adapters } = await buildAdapters(state);

    const traced = reduceWithShadow(state, { type: "TICK", now: FIXED_NOW + TICK_MS }, adapters);
    state = traced.nextState;

    assert.ok(traced.shadowTrace, "expected shadow trace from WASM-authoritative tick");
    const market = state.markets[marketId];
    assert.ok(market, "market exists after tick");
    assert.ok(market.book.bids.length > 0 || market.book.asks.length > 0, "WASM-derived book has content");
  },
);

test(
  "WASM-authoritative execution: long run with events stays internally consistent",
  { skip: skipIfWasmMissing() },
  async () => {
    (globalThis as { window?: Window }).window = {} as Window;
    const initial = makeInitialState(FIXED_NOW);
    const marketId = initial.marketOrder[0]!;
    let state = narrowState(initial, [marketId]);
    const { adapters } = await buildAdapters(state);

    const eventTicks = new Set([20, 60, 100]);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      for (let tick = 1; tick <= 120; tick++) {
        if (eventTicks.has(tick)) {
          state = reducer(state, {
            type: "INJECT_EVENTS",
            events: [makeShockEvent(state, marketId, tick)],
          });
        }
        const traced = reduceWithShadow(
          state,
          { type: "TICK", now: FIXED_NOW + tick * TICK_MS },
          adapters,
        );
        state = traced.nextState;
      }
    } finally {
      console.warn = originalWarn;
    }

    const market = state.markets[marketId];
    assert.ok(Number.isInteger(market.inventory), "WASM positionQty is integer");
    assert.ok(Math.abs(market.inventory) <= 100, "inventory within sane bounds");
    assert.ok(Number.isFinite(market.realizedPnl), "realizedPnl is finite");
    assert.ok(Number.isFinite(market.avgCost), "avgCost is finite");
    assert.ok(market.book.bids.length + market.book.asks.length > 0, "book persists across ticks");
  },
);

test(
  "WASM-authoritative execution: no structural / mapping faults during shadow replay",
  { skip: skipIfWasmMissing() },
  async () => {
    (globalThis as { window?: Window }).window = {} as Window;
    const initial = makeInitialState(FIXED_NOW);
    const marketIds = initial.marketOrder.slice(0, 3);
    let state = narrowState(initial, marketIds);

    const { adapters } = await buildAdapters(state);
    const runtime = await ShadowSimulationRuntime.create();
    runtime.initializeFromState(state);

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      for (let tick = 1; tick <= 60; tick++) {
        const traced = reduceWithShadow(
          state,
          { type: "TICK", now: FIXED_NOW + tick * TICK_MS },
          adapters,
        );
        assert.ok(traced.shadowTrace, `tick ${tick} shadow trace`);
        runtime.replayTick(traced.shadowTrace);
        state = traced.nextState;
      }
    } finally {
      console.warn = originalWarn;
    }

    const debug = runtime.getDebugStateSnapshot();
    assert.equal(debug.mismatchCounts.mapping ?? 0, 0, "no mapping mismatches");
    assert.equal(debug.mismatchCounts.ordering ?? 0, 0, "no ordering mismatches");
    assert.equal(debug.mismatchCounts.replay_fault ?? 0, 0, "no replay faults");
    assert.equal(debug.mismatchCounts.trace_coverage ?? 0, 0, "no trace coverage gaps");
    assert.equal(debug.enabled, true, "shadow stays enabled");
  },
);

test(
  "WASM-authoritative soak: 300 ticks all markets stay internally consistent",
  { skip: skipIfWasmMissing() },
  async () => {
    (globalThis as { window?: Window }).window = {} as Window;
    let state = makeInitialState(FIXED_NOW);
    const { adapters } = await buildAdapters(state);

    const shockTicks = new Set([50, 100, 150, 200]);
    const shockMarkets = [
      state.marketOrder[0]!, state.marketOrder[4]!,
      state.marketOrder[9]!, state.marketOrder[14]!,
    ];
    let shockIdx = 0;

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      for (let tick = 1; tick <= 300; tick++) {
        if (shockTicks.has(tick)) {
          const mid = shockMarkets[shockIdx++ % shockMarkets.length]!;
          state = reducer(state, { type: "INJECT_EVENTS", events: [makeShockEvent(state, mid, tick)] });
        }
        const { nextState } = reduceWithShadow(state, { type: "TICK", now: FIXED_NOW + tick * TICK_MS }, adapters);
        state = nextState;

        for (const id of state.marketOrder) {
          const m = state.markets[id]!;
          assert.ok(Number.isInteger(m.inventory),  `tick ${tick} ${id}: inventory integer`);
          assert.ok(Number.isFinite(m.avgCost),     `tick ${tick} ${id}: avgCost finite`);
          assert.ok(Number.isFinite(m.realizedPnl), `tick ${tick} ${id}: realizedPnl finite`);
          const prices = [...m.book.bids, ...m.book.asks].map((l) => l.price);
          assert.ok(prices.every((p) => !isNaN(p)), `tick ${tick} ${id}: no NaN prices`);
        }
      }
    } finally {
      console.warn = originalWarn;
    }

    for (const id of state.marketOrder) {
      const m = state.markets[id]!;
      assert.ok(m.book.bids.length + m.book.asks.length > 0, `final ${id}: book has content`);
      assert.ok(!isNaN(m.inventory),   `final ${id}: inventory not NaN`);
      assert.ok(!isNaN(m.realizedPnl), `final ${id}: realizedPnl not NaN`);
    }
  },
);

test(
  "WASM-authoritative lifecycle: destroy + reseed resets accounting state",
  { skip: skipIfWasmMissing() },
  async () => {
    (globalThis as { window?: Window }).window = {} as Window;
    const initial = makeInitialState(FIXED_NOW);
    const marketId = initial.marketOrder[0]!;
    let state = narrowState(initial, [marketId]);

    const { kernel, adapters } = await buildAdapters(state);
    const adapter = adapters.get(marketId)!;

    const s0 = adapter.getSnapshot();
    assert.strictEqual(s0.positionQty, 0,      "initial positionQty === 0");
    assert.strictEqual(s0.realizedPnlTicks, 0, "initial realizedPnlTicks === 0");
    assert.strictEqual(s0.avgCostTicks, 0,     "initial avgCostTicks === 0");

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      for (let tick = 1; tick <= 40; tick++) {
        if (tick === 10 || tick === 25) {
          state = reducer(state, { type: "INJECT_EVENTS", events: [makeShockEvent(state, marketId, tick)] });
        }
        state = reduceWithShadow(state, { type: "TICK", now: FIXED_NOW + tick * TICK_MS }, adapters).nextState;
      }
    } finally {
      console.warn = originalWarn;
    }

    adapter.destroy();
    void kernel;

    const freshState = narrowState(makeInitialState(FIXED_NOW), [marketId]);
    const { kernel: k2, adapters: adapters2 } = await buildAdapters(freshState);
    const adapter2 = adapters2.get(marketId)!;

    const s2 = adapter2.getSnapshot();
    assert.strictEqual(s2.positionQty, 0,      "reseeded positionQty === 0");
    assert.strictEqual(s2.realizedPnlTicks, 0, "reseeded realizedPnlTicks === 0");
    assert.strictEqual(s2.avgCostTicks, 0,     "reseeded avgCostTicks === 0");

    let state2 = freshState;
    console.warn = () => {};
    try {
      for (let tick = 1; tick <= 5; tick++) {
        state2 = reduceWithShadow(state2, { type: "TICK", now: FIXED_NOW + tick * TICK_MS }, adapters2).nextState;
      }
    } finally {
      console.warn = originalWarn;
    }

    const m2 = state2.markets[marketId]!;
    assert.ok(m2.book.bids.length + m2.book.asks.length > 0, "reseeded: book has content");
    assert.ok(Number.isFinite(m2.inventory),   "reseeded: inventory finite");
    assert.ok(Number.isFinite(m2.realizedPnl), "reseeded: realizedPnl finite");
    void k2;
  },
);

test(
  "WASM-authoritative ops: CountingAdapter confirms WASM methods are called (not TS fallback)",
  { skip: skipIfWasmMissing() },
  async () => {
    (globalThis as { window?: Window }).window = {} as Window;
    const initial = makeInitialState(FIXED_NOW);
    const marketId = initial.marketOrder[0]!;
    let state = narrowState(initial, [marketId]);

    const { adapters } = await buildCountingAdapters(state);
    const ca = adapters.get(marketId)!;

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      for (let tick = 1; tick <= 30; tick++) {
        state = reduceWithShadow(state, { type: "TICK", now: FIXED_NOW + tick * TICK_MS }, adapters).nextState;
      }
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(ca.opCounts.cancel > 0, `cancelManyByIds called ${ca.opCounts.cancel}× (expected > 0)`);
    assert.ok(ca.opCounts.submit > 0, `submitLimit called ${ca.opCounts.submit}× (expected > 0)`);
    assert.ok(
      ca.opCounts.execute > 0 || ca.opCounts.submit > 0,
      `adapter received ${ca.opCounts.execute} executeMarket + ${ca.opCounts.submit} submitLimit`,
    );
  },
);

test(
  "WASM-authoritative sourcing: per-field match between market state and adapter snapshot",
  { skip: skipIfWasmMissing() },
  async () => {
    (globalThis as { window?: Window }).window = {} as Window;
    const initial = makeInitialState(FIXED_NOW);
    const marketId = initial.marketOrder[0]!;
    let state = narrowState(initial, [marketId]);

    const { adapters } = await buildAdapters(state);
    const adapter = adapters.get(marketId)!;

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      for (let tick = 1; tick <= 20; tick++) {
        if (tick === 10) {
          state = reducer(state, { type: "INJECT_EVENTS", events: [makeShockEvent(state, marketId, tick)] });
        }
        state = reduceWithShadow(state, { type: "TICK", now: FIXED_NOW + tick * TICK_MS }, adapters).nextState;

        const m = state.markets[marketId]!;
        const snap = adapter.getSnapshot();

        assert.strictEqual(m.inventory, snap.positionQty,
          `tick ${tick}: inventory === positionQty`);
        assert.ok(Math.abs(m.avgCost - ticksToCents(snap.avgCostTicks)) < 1e-9,
          `tick ${tick}: avgCost matches avgCostTicks`);
        assert.ok(Math.abs(m.realizedPnl - ticksToCents(snap.realizedPnlTicks)) < 1e-9,
          `tick ${tick}: realizedPnl matches realizedPnlTicks`);

        assert.deepStrictEqual(
          m.book.bids.map((b) => b.price),
          snap.bidLevels.map((l) => ticksToCents(l.priceTicks)),
          `tick ${tick}: book.bids prices match snapshot`,
        );
        assert.deepStrictEqual(
          m.book.asks.map((a) => a.price),
          snap.askLevels.map((l) => ticksToCents(l.priceTicks)),
          `tick ${tick}: book.asks prices match snapshot`,
        );

        const thisFill = state.fills.find((f) => f.marketId === marketId && f.tick === tick);
        if (thisFill) {
          assert.strictEqual(m.lastFillTick, tick, `tick ${tick}: fill occurred → lastFillTick === ${tick}`);
        }

        if (tick > 10 && m.inventory !== 0) {
          assert.ok(state.fills.length > 0, `tick ${tick}: non-zero inventory implies fills`);
        }
      }
    } finally {
      console.warn = originalWarn;
    }
  },
);
