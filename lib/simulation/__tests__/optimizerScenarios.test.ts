import assert from "node:assert/strict";
import test from "node:test";

import { makeInitialState } from "../markets.ts";
import { reducer } from "../reducer.ts";
import { buildScenarioMatrix } from "../rollout.ts";
import { DEFAULT_REWARD_PARAMS } from "../rolloutReward.ts";
import { DEMO_SCENARIOS } from "../scenarios.ts";

const FIXED_NOW = 1735660800000;

// Build a state with a given scenario patch applied to the selected market.
function applyScenario(name: keyof typeof DEMO_SCENARIOS) {
  (globalThis as { window?: Window }).window = {} as Window;
  const state = makeInitialState(FIXED_NOW);
  const marketId = state.selectedMarketId;
  const { patch } = DEMO_SCENARIOS[name];
  const patched = reducer(state, { type: "APPLY_SCENARIO", patch: { ...patch, marketId } });
  return { state: patched, marketId };
}

// ────────────────────────────────────────────────────────────────────────────
// Scenario 1: CALM_EDGE
// ────────────────────────────────────────────────────────────────────────────

test("CALM_EDGE: aggressive actions are NOT filtered (inv=0, calm, high conf)", () => {
  const { state, marketId } = applyScenario("CALM_EDGE");
  const matrix = buildScenarioMatrix(state, marketId, 4, 6, DEFAULT_REWARD_PARAMS, 0.97);

  const aggBuy = matrix.plans.filter((p) => p.firstAction === "AGG_BUY");
  const aggSell = matrix.plans.filter((p) => p.firstAction === "AGG_SELL");
  assert.ok(aggBuy.length > 0, "AGG_BUY present: calm regime + inv=0 does not trigger feasibility filter");
  assert.ok(aggSell.length > 0, "AGG_SELL present for same reason");
});

test("CALM_EDGE: edge_following policy plans present (conf=0.78 > 0.62 threshold)", () => {
  const { state, marketId } = applyScenario("CALM_EDGE");
  const matrix = buildScenarioMatrix(state, marketId, 3, 5, DEFAULT_REWARD_PARAMS, 0.97);

  const efPlans = matrix.plans.filter((p) => p.policyName === "edge_following");
  assert.ok(efPlans.length > 0, "edge_following policy included at 78% confidence");
});

test("CALM_EDGE: context reflects patched values", () => {
  const { state, marketId } = applyScenario("CALM_EDGE");
  const matrix = buildScenarioMatrix(state, marketId, 3, 5, DEFAULT_REWARD_PARAMS, 0.97);

  assert.strictEqual(matrix.context.regime, "calm");
  assert.strictEqual(matrix.context.currentInventory, 0);
  assert.ok(Math.abs(matrix.context.forecastConfidence - 0.78) < 0.01, "confidence≈0.78");
  assert.ok(matrix.N > 0, "some feasible plans exist");
});

test("CALM_EDGE: all R values are finite", () => {
  const { state, marketId } = applyScenario("CALM_EDGE");
  const matrix = buildScenarioMatrix(state, marketId, 4, 6, DEFAULT_REWARD_PARAMS, 0.97);

  for (let n = 0; n < matrix.N; n++) {
    for (const v of matrix.R[n]) {
      assert.ok(Number.isFinite(v), `CALM_EDGE R[${n}] finite`);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 2: SHOCK
// ────────────────────────────────────────────────────────────────────────────

test("SHOCK: AGG_BUY and AGG_SELL are in candidate set (JuMP shock_aggr_limit suppresses them)", () => {
  const { state, marketId } = applyScenario("SHOCK");
  const matrix = buildScenarioMatrix(state, marketId, 3, 5, DEFAULT_REWARD_PARAMS, 0.97);

  // Pre-filter no longer removes AGG plans — they stay in the candidate set so
  // JuMP's shock_aggr_limit constraint is visible (binding) in the explanation.
  // Only structural impossibility (inv >= maxInv) is filtered at TS level.
  const aggPlans = matrix.plans.filter(
    (p) => p.firstAction === "AGG_BUY" || p.firstAction === "AGG_SELL",
  );
  assert.ok(aggPlans.length > 0, "AGG plans in candidate set so shock_aggr_limit can bind in JuMP");
});

test("SHOCK: defensive actions (WIDEN, PASS) are present", () => {
  const { state, marketId } = applyScenario("SHOCK");
  const matrix = buildScenarioMatrix(state, marketId, 3, 5, DEFAULT_REWARD_PARAMS, 0.97);

  const widePlans = matrix.plans.filter(
    (p) => p.firstAction === "WIDEN" || p.firstAction === "PASS",
  );
  assert.ok(widePlans.length >= 3, "WIDEN + PASS plans present across continuation policies");
  assert.ok(widePlans.length > 0, "defensive plans exist in shock scenario");
});

test("SHOCK: context reflects shock state", () => {
  const { state, marketId } = applyScenario("SHOCK");
  const matrix = buildScenarioMatrix(state, marketId, 3, 5, DEFAULT_REWARD_PARAMS, 0.97);

  assert.strictEqual(matrix.context.regime, "shock");
  assert.ok(matrix.context.forecastConfidence < 0.5, "confidence < 0.5 confirms shock low-conf state");
  assert.ok(matrix.context.currentInventory >= 0, "inventory is non-negative");
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 3: INV_STRESS
// ────────────────────────────────────────────────────────────────────────────

test("INV_STRESS: AGG_BUY and SKEW_BID in candidate set (JuMP inventory_skew suppresses them)", () => {
  const { state, marketId } = applyScenario("INV_STRESS");
  const matrix = buildScenarioMatrix(state, marketId, 3, 5, DEFAULT_REWARD_PARAMS, 0.97);

  // Pre-filter now only removes structurally impossible plans (inv >= maxInv=8).
  // inv=7 < 8 so AGG_BUY/SKEW_BID are included; JuMP inventory_skew constrains them.
  const buyPressure = matrix.plans.filter(
    (p) => p.firstAction === "AGG_BUY" || p.firstAction === "SKEW_BID",
  );
  assert.ok(buyPressure.length > 0, "AGG_BUY/SKEW_BID present so inventory_skew constraint can bind");
});

test("INV_STRESS: sell-side actions (AGG_SELL, SKEW_ASK) still present", () => {
  const { state, marketId } = applyScenario("INV_STRESS");
  const matrix = buildScenarioMatrix(state, marketId, 3, 5, DEFAULT_REWARD_PARAMS, 0.97);

  const sellSide = matrix.plans.filter(
    (p) => p.firstAction === "AGG_SELL" || p.firstAction === "SKEW_ASK",
  );
  assert.ok(sellSide.length > 0, "sell-side actions remain feasible when long");
});

test("INV_STRESS: flatten plans present", () => {
  const { state, marketId } = applyScenario("INV_STRESS");
  const matrix = buildScenarioMatrix(state, marketId, 3, 5, DEFAULT_REWARD_PARAMS, 0.97);

  const flattenPlans = matrix.plans.filter((p) => p.firstAction === "PARTIAL_FLATTEN");
  assert.ok(flattenPlans.length > 0, "PARTIAL_FLATTEN present in inventory-stress scenario");
});

test("INV_STRESS: context inventory ratio >= 0.75 (triggers JuMP inventory_skew constraint)", () => {
  const { state, marketId } = applyScenario("INV_STRESS");
  const matrix = buildScenarioMatrix(state, marketId, 3, 5, DEFAULT_REWARD_PARAMS, 0.97);

  const ratio = matrix.context.currentInventory / matrix.context.maxInventory;
  assert.ok(
    ratio >= 0.75,
    `inventory ratio ${ratio.toFixed(2)} must be ≥ 0.75 to trigger inventory_skew constraint in JuMP`,
  );
});

test("INV_STRESS: maxAbsInv high across trajectories (starting near limit)", () => {
  const { state, marketId } = applyScenario("INV_STRESS");
  const matrix = buildScenarioMatrix(state, marketId, 5, 8, DEFAULT_REWARD_PARAMS, 0.97);

  const overallAvgMax =
    matrix.maxAbsInv
      .flatMap((row) => row)
      .reduce((s, v) => s + v, 0) /
    (matrix.N * matrix.M);

  assert.ok(
    overallAvgMax > 5,
    `mean maxAbsInv=${overallAvgMax.toFixed(1)} should exceed 5 given initial inventory=7`,
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Reproducibility
// ────────────────────────────────────────────────────────────────────────────

test("All scenarios: same rngState → identical rollout tensors (determinism)", () => {
  for (const name of ["CALM_EDGE", "SHOCK", "INV_STRESS"] as const) {
    (globalThis as { window?: Window }).window = {} as Window;
    const { state, marketId } = applyScenario(name);
    const m1 = buildScenarioMatrix(state, marketId, 3, 4, DEFAULT_REWARD_PARAMS, 0.97);
    const m2 = buildScenarioMatrix(state, marketId, 3, 4, DEFAULT_REWARD_PARAMS, 0.97);

    for (let n = 0; n < m1.N; n++) {
      for (let i = 0; i < m1.M; i++) {
        assert.strictEqual(
          m1.R[n][i],
          m2.R[n][i],
          `${name}: R[${n}][${i}] must be deterministic for same rngState`,
        );
      }
    }
  }
});

test("Scenarios have distinct rngStates → distinct tensor distributions", () => {
  (globalThis as { window?: Window }).window = {} as Window;

  // Two different scenarios with different seeds produce different first-plan returns
  const s1 = applyScenario("CALM_EDGE");
  const s2 = applyScenario("SHOCK");
  const m1 = buildScenarioMatrix(s1.state, s1.marketId, 5, 4, DEFAULT_REWARD_PARAMS, 0.97);
  const m2 = buildScenarioMatrix(s2.state, s2.marketId, 5, 4, DEFAULT_REWARD_PARAMS, 0.97);

  // At least one trajectory value should differ (extremely unlikely to be equal by chance)
  const minN = Math.min(m1.N, m2.N);
  let anyDiff = false;
  outer: for (let n = 0; n < minN; n++) {
    for (let i = 0; i < Math.min(m1.M, m2.M); i++) {
      if (m1.R[n][i] !== m2.R[n][i]) {
        anyDiff = true;
        break outer;
      }
    }
  }
  assert.ok(anyDiff, "Different scenarios with different seeds produce different rollout tensors");
});
