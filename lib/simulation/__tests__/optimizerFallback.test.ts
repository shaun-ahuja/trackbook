import assert from "node:assert/strict";
import test from "node:test";

import { makeInitialState } from "../markets.ts";
import { buildScenarioMatrix, ROLLOUT_ACTIONS } from "../rollout.ts";
import { computeLocalDecision, fetchOptimizerDecision, SAFE_PASS_POLICY } from "../../optimizer.ts";

const FIXED_NOW = 1735660800000;
(globalThis as { window?: Window }).window = {} as Window;

test("computeLocalDecision: non-null for default initial state", () => {
  const state = makeInitialState(FIXED_NOW);
  const matrix = buildScenarioMatrix(state, state.marketOrder[0]!, 4, 5);
  const d = computeLocalDecision(matrix, "", false, false, 0);
  assert.ok(d !== null, "should return a decision for a valid matrix");
});

test("computeLocalDecision: selectedFirstAction is a known rollout action", () => {
  const state = makeInitialState(FIXED_NOW);
  const matrix = buildScenarioMatrix(state, state.marketOrder[0]!, 4, 5);
  const d = computeLocalDecision(matrix, "", false, false, 0);
  assert.ok(d !== null);
  assert.ok(
    (ROLLOUT_ACTIONS as readonly string[]).includes(d.selectedFirstAction),
    `unexpected action: ${d.selectedFirstAction}`,
  );
});

test("computeLocalDecision: solveStatus === TS_GREEDY_FALLBACK", () => {
  const state = makeInitialState(FIXED_NOW);
  const matrix = buildScenarioMatrix(state, state.marketOrder[0]!, 4, 5);
  const d = computeLocalDecision(matrix, "", false, false, 0);
  assert.strictEqual(d?.solveStatus, "TS_GREEDY_FALLBACK");
});

test("computeLocalDecision: all trajectoryStats have finite meanReturn and cvarReturn", () => {
  const state = makeInitialState(FIXED_NOW);
  const matrix = buildScenarioMatrix(state, state.marketOrder[0]!, 4, 5);
  const d = computeLocalDecision(matrix, "", false, false, 0);
  assert.ok(d !== null);
  assert.ok(d.trajectoryStats.length > 0, "trajectoryStats non-empty");
  for (const s of d.trajectoryStats) {
    assert.ok(Number.isFinite(s.meanReturn), `meanReturn finite for plan ${s.planIndex}`);
    assert.ok(Number.isFinite(s.cvarReturn), `cvarReturn finite for plan ${s.planIndex}`);
  }
});

test("fetchOptimizerDecision: julia timeout → TS_GREEDY_FALLBACK (not null)", async () => {
  const origFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () => {
    throw new DOMException("Timeout", "TimeoutError");
  };
  try {
    const state = makeInitialState(FIXED_NOW);
    const r = await fetchOptimizerDecision(state, state.marketOrder[0]!, "", false, false, 0, 50);
    assert.ok(r !== null, "should return fallback, not null");
    assert.strictEqual(r.solveStatus, "TS_GREEDY_FALLBACK");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("fetchOptimizerDecision: julia 503 → TS_GREEDY_FALLBACK (not null)", async () => {
  const origFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () =>
    new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
  try {
    const state = makeInitialState(FIXED_NOW);
    const r = await fetchOptimizerDecision(state, state.marketOrder[0]!, "", false, false, 0, 750);
    assert.ok(r !== null, "should return fallback on 503, not null");
    assert.strictEqual(r.solveStatus, "TS_GREEDY_FALLBACK");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("SAFE_PASS_POLICY: selectedFirstAction is PASS with SAFE_DEFAULT status", () => {
  assert.strictEqual(SAFE_PASS_POLICY.selectedFirstAction, "PASS");
  assert.strictEqual(SAFE_PASS_POLICY.solveStatus, "SAFE_DEFAULT");
});
