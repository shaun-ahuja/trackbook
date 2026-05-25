import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeInitialState } from "../markets.ts";
import { reduceWithShadow } from "../reducer.ts";
import { ShadowSimulationRuntime } from "../shadowRuntime.ts";

const wasmModulePath = fileURLToPath(
  new URL("../../../public/wasm/orderbook/orderbook.mjs", import.meta.url),
);

function skipIfWasmMissing(): boolean {
  return !existsSync(wasmModulePath);
}

const FIXED_NOW = 1735660800000;

test("shadow runtime replays trace without mismatches", { skip: skipIfWasmMissing() }, async () => {
  (globalThis as { window?: Window }).window = {} as Window;

  const runtime = await ShadowSimulationRuntime.create();
  const initial = makeInitialState(FIXED_NOW);
  runtime.initializeFromState(initial);

  const traced = reduceWithShadow(initial, { type: "TICK", now: FIXED_NOW + 750 });
  assert.ok(traced.shadowTrace);
  runtime.replayTick(traced.shadowTrace!);

  const debug = runtime.getDebugStateSnapshot();
  assert.ok(debug);
  assert.equal(debug.recentMismatches.length, 0);
  assert.equal(debug.mismatchCounts.top_of_book ?? 0, 0);
  assert.equal(debug.recentTickSummaries.length, 1);
  assert.equal(debug.recentTickSummaries[0]?.mismatchCount, 0);
});
