import assert from "node:assert/strict";
import test from "node:test";

import { makeInitialState } from "../markets.ts";
import {
  buildScenarioMatrix,
  CONTINUATION_POLICIES,
  runPlanRollout,
  ROLLOUT_ACTIONS,
} from "../rollout.ts";
import { DEFAULT_REWARD_PARAMS, stepReward, terminalPenalty } from "../rolloutReward.ts";
import type { Market } from "../../types.ts";

const FIXED_NOW = 1735660800000;

// Minimal market stub for unit-testing reward functions in isolation.
function makeMarketStub(overrides: Partial<Market> = {}): Market {
  const base = makeInitialState(FIXED_NOW).markets;
  const id = Object.keys(base)[0]!;
  return { ...base[id]!, ...overrides };
}

test("stepReward: pure PnL delta with no fills", () => {
  (globalThis as { window?: Window }).window = {} as Window;
  const prev = makeMarketStub({ realizedPnl: 0, unrealizedPnl: 0, inventory: 0, lastAction: "HOLD" });
  // With inventory=0 markToFairPnl(m) = m.realizedPnl, so set realizedPnl=7 directly.
  const next = makeMarketStub({ realizedPnl: 7, unrealizedPnl: 0, inventory: 0, lastAction: "HOLD" });
  const r = stepReward(prev, next, [], DEFAULT_REWARD_PARAMS, "HOLD");
  // pnlΔ = 7, invRisk = 0, no adverse, no churn
  assert.ok(Math.abs(r - 7) < 1e-9, `expected ≈7, got ${r}`);
});

test("stepReward: inventory risk penalises large positions", () => {
  (globalThis as { window?: Window }).window = {} as Window;
  const prev = makeMarketStub({ realizedPnl: 0, unrealizedPnl: 0, inventory: 0, lastAction: "HOLD" });
  // Set avgCost = fair (forecastProb * 100) so markToFairPnl delta is zero; isolates invRisk term.
  const fair = prev.forecastProb * 100;
  const next = makeMarketStub({ realizedPnl: 0, unrealizedPnl: 0, inventory: 8, avgCost: fair, lastAction: "HOLD" });
  const r = stepReward(prev, next, [], DEFAULT_REWARD_PARAMS, "HOLD");
  // pnlΔ=0, invRisk = λInv * (8/8)^2 = λInv
  assert.ok(Math.abs(r - (-DEFAULT_REWARD_PARAMS.λInv)) < 1e-9, `expected -${DEFAULT_REWARD_PARAMS.λInv}, got ${r}`);
});

test("stepReward: churn cost when action changes", () => {
  (globalThis as { window?: Window }).window = {} as Window;
  const prev = makeMarketStub({ realizedPnl: 0, unrealizedPnl: 0, inventory: 0, lastAction: "HOLD" });
  const next = makeMarketStub({ realizedPnl: 0, unrealizedPnl: 0, inventory: 0, lastAction: "WIDEN" });
  const withChurn = stepReward(prev, next, [], DEFAULT_REWARD_PARAMS, "HOLD");
  const noChurn = stepReward(prev, next, [], DEFAULT_REWARD_PARAMS, undefined);
  assert.ok(Math.abs(withChurn - noChurn - (-DEFAULT_REWARD_PARAMS.λChurn)) < 1e-9,
    "churn cost = λChurn when action changes");
});

test("terminalPenalty: zero inventory gives zero penalty", () => {
  (globalThis as { window?: Window }).window = {} as Window;
  const m = makeMarketStub({ inventory: 0 });
  assert.ok(terminalPenalty(m, DEFAULT_REWARD_PARAMS) === 0);
});

test("terminalPenalty: full inventory gives max penalty", () => {
  (globalThis as { window?: Window }).window = {} as Window;
  const m = makeMarketStub({ inventory: DEFAULT_REWARD_PARAMS.maxInv });
  const p = terminalPenalty(m, DEFAULT_REWARD_PARAMS);
  assert.ok(Math.abs(p - (-DEFAULT_REWARD_PARAMS.λInv)) < 1e-9, `expected -${DEFAULT_REWARD_PARAMS.λInv}, got ${p}`);
});

test("runPlanRollout: single trajectory returns finite metrics", () => {
  (globalThis as { window?: Window }).window = {} as Window;
  const initial = makeInitialState(FIXED_NOW);
  const marketId = initial.marketOrder[0]!;
  const state = {
    ...initial,
    selectedMarketId: marketId,
    marketOrder: [marketId],
    markets: { [marketId]: initial.markets[marketId]! },
    fills: [],
  };
  const result = runPlanRollout(
    state, marketId, "PASS", CONTINUATION_POLICIES[0], 5, 42, DEFAULT_REWARD_PARAMS, 0.97,
  );
  assert.ok(Number.isFinite(result.discountedReturn), "discountedReturn is finite");
  assert.ok(Number.isFinite(result.invFinal), "invFinal is finite");
  assert.ok(result.maxAbsInv >= 0, "maxAbsInv >= 0");
  assert.ok(result.maxDrawdown >= 0, "maxDrawdown >= 0");
});

test("runPlanRollout: different seeds produce different returns", () => {
  (globalThis as { window?: Window }).window = {} as Window;
  const initial = makeInitialState(FIXED_NOW);
  const marketId = initial.marketOrder[0]!;
  const state = {
    ...initial,
    selectedMarketId: marketId,
    marketOrder: [marketId],
    markets: { [marketId]: initial.markets[marketId]! },
    fills: [],
  };
  const r1 = runPlanRollout(state, marketId, "PASS", CONTINUATION_POLICIES[0], 8, 1, DEFAULT_REWARD_PARAMS, 0.97);
  const r2 = runPlanRollout(state, marketId, "PASS", CONTINUATION_POLICIES[0], 8, 9999, DEFAULT_REWARD_PARAMS, 0.97);
  // Different seeds should give different trajectories most of the time
  assert.notEqual(r1.discountedReturn, r2.discountedReturn, "different seeds → different returns");
});

test("runPlanRollout: same seed is deterministic", () => {
  (globalThis as { window?: Window }).window = {} as Window;
  const initial = makeInitialState(FIXED_NOW);
  const marketId = initial.marketOrder[0]!;
  const state = {
    ...initial,
    selectedMarketId: marketId,
    marketOrder: [marketId],
    markets: { [marketId]: initial.markets[marketId]! },
    fills: [],
  };
  const r1 = runPlanRollout(state, marketId, "WIDEN", CONTINUATION_POLICIES[1], 6, 777, DEFAULT_REWARD_PARAMS, 0.97);
  const r2 = runPlanRollout(state, marketId, "WIDEN", CONTINUATION_POLICIES[1], 6, 777, DEFAULT_REWARD_PARAMS, 0.97);
  assert.strictEqual(r1.discountedReturn, r2.discountedReturn, "same seed → deterministic return");
  assert.strictEqual(r1.invFinal, r2.invFinal, "same seed → deterministic invFinal");
});

test("buildScenarioMatrix: correct shape and finite values (M=3, H=4)", () => {
  (globalThis as { window?: Window }).window = {} as Window;
  const initial = makeInitialState(FIXED_NOW);
  const marketId = initial.marketOrder[0]!;
  const matrix = buildScenarioMatrix(initial, marketId, 3, 4);

  assert.ok(matrix.N > 0 && matrix.N <= ROLLOUT_ACTIONS.length * CONTINUATION_POLICIES.length,
    `N=${matrix.N} in [1, ${ROLLOUT_ACTIONS.length * CONTINUATION_POLICIES.length}]`);
  assert.strictEqual(matrix.M, 3);
  assert.strictEqual(matrix.H, 4);
  assert.strictEqual(matrix.R.length, matrix.N);
  assert.strictEqual(matrix.invFinal.length, matrix.N);
  assert.strictEqual(matrix.maxAbsInv.length, matrix.N);
  assert.strictEqual(matrix.maxDrawdown.length, matrix.N);
  assert.strictEqual(matrix.plans.length, matrix.N);

  for (let n = 0; n < matrix.N; n++) {
    assert.strictEqual(matrix.R[n].length, 3, `R[${n}] has M=3 entries`);
    for (const v of matrix.R[n]) {
      assert.ok(Number.isFinite(v), `R[${n}] value is finite`);
    }
    for (const v of matrix.invFinal[n]) {
      assert.ok(Number.isFinite(v), `invFinal[${n}] value is finite`);
    }
    for (const v of matrix.maxAbsInv[n]) {
      assert.ok(v >= 0, `maxAbsInv[${n}] >= 0`);
    }
    for (const v of matrix.maxDrawdown[n]) {
      assert.ok(v >= 0, `maxDrawdown[${n}] >= 0`);
    }
  }
});

test("buildScenarioMatrix: plans have valid firstAction and policyName", () => {
  (globalThis as { window?: Window }).window = {} as Window;
  const initial = makeInitialState(FIXED_NOW);
  const marketId = initial.marketOrder[0]!;
  const matrix = buildScenarioMatrix(initial, marketId, 2, 3);

  const validActions = new Set(ROLLOUT_ACTIONS);
  const validPolicies = new Set(CONTINUATION_POLICIES.map((p) => p.name));

  for (const plan of matrix.plans) {
    assert.ok(validActions.has(plan.firstAction), `unknown firstAction: ${plan.firstAction}`);
    assert.ok(validPolicies.has(plan.policyName), `unknown policyName: ${plan.policyName}`);
    assert.ok(plan.firstActionIndex >= 0, "firstActionIndex >= 0");
    assert.ok(plan.policyIndex >= 0, "policyIndex >= 0");
  }
});

test("buildScenarioMatrix: context fields are finite and in range", () => {
  (globalThis as { window?: Window }).window = {} as Window;
  const initial = makeInitialState(FIXED_NOW);
  const marketId = initial.marketOrder[0]!;
  const matrix = buildScenarioMatrix(initial, marketId, 2, 3);

  const ctx = matrix.context;
  assert.ok(Number.isFinite(ctx.currentInventory), "currentInventory finite");
  assert.ok(ctx.maxInventory > 0, "maxInventory > 0");
  assert.ok(["calm", "alert", "shock", "recovery"].includes(ctx.regime), `valid regime: ${ctx.regime}`);
  assert.ok(ctx.forecastConfidence >= 0 && ctx.forecastConfidence <= 1, "confidence in [0,1]");
  assert.ok(ctx.adverseSelectionScore >= 0 && ctx.adverseSelectionScore <= 1, "adverseScore in [0,1]");
});

test("buildScenarioMatrix: AGG_BUY/SELL filtered at hard inventory limit", () => {
  (globalThis as { window?: Window }).window = {} as Window;
  const initial = makeInitialState(FIXED_NOW);
  const marketId = initial.marketOrder[0]!;
  // At the hard ceiling, AGG_BUY/SKEW_BID are structurally infeasible and pre-filtered.
  // Near-limit suppression (inv < maxInv) is left to JuMP constraints so they appear
  // as binding in the explanation rather than being silently pre-filtered.
  const state = {
    ...initial,
    markets: {
      ...initial.markets,
      [marketId]: {
        ...initial.markets[marketId]!,
        inventory: DEFAULT_REWARD_PARAMS.maxInv, // at hard ceiling
      },
    },
  };
  const matrix = buildScenarioMatrix(state, marketId, 1, 2);
  const aggBuyPlans = matrix.plans.filter((p) => p.firstAction === "AGG_BUY");
  const skewBidPlans = matrix.plans.filter((p) => p.firstAction === "SKEW_BID");
  assert.strictEqual(aggBuyPlans.length, 0, "AGG_BUY filtered at hard long limit");
  assert.strictEqual(skewBidPlans.length, 0, "SKEW_BID filtered at hard long limit");
});
