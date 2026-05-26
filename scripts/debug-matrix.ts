/**
 * Print summary stats of the scenario matrix being sent to Julia.
 * Run: node --import tsx scripts/debug-matrix.ts
 */
import { makeInitialState } from "../lib/simulation/markets";
import { reducer } from "../lib/simulation/reducer";
import { buildScenarioMatrix } from "../lib/simulation/rollout";
import { DEFAULT_REWARD_PARAMS } from "../lib/simulation/rolloutReward";
import { DEMO_SCENARIOS } from "../lib/simulation/scenarios";

(globalThis as { window?: Window }).window = {} as Window;
const FIXED_EPOCH = 1735660800000;

for (const name of ["CALM_EDGE", "SHOCK", "INV_STRESS"] as const) {
  const base = makeInitialState(FIXED_EPOCH);
  const marketId = base.selectedMarketId;
  const { patch } = DEMO_SCENARIOS[name];
  const state = reducer(base, { type: "APPLY_SCENARIO", patch: { ...patch, marketId } });

  const matrix = buildScenarioMatrix(state, marketId, 10, 6, DEFAULT_REWARD_PARAMS, 0.97);

  const allR = matrix.R.flat();
  const mean = allR.reduce((s, v) => s + v, 0) / allR.length;
  const sorted = [...allR].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  // Per-plan means
  const planMeans = matrix.R.map((row, n) => ({
    action: matrix.plans[n].firstAction,
    policy: matrix.plans[n].policyName,
    mean: row.reduce((s, v) => s + v, 0) / row.length,
  }));
  const bestPlan = planMeans.reduce((a, b) => a.mean > b.mean ? a : b);
  const worstPlan = planMeans.reduce((a, b) => a.mean < b.mean ? a : b);

  console.log(`\n=== ${name} (N=${matrix.N}, M=10, H=6) ===`);
  console.log(`  R: mean=${mean.toFixed(2)} min=${min.toFixed(2)} p10=${p10.toFixed(2)} p90=${p90.toFixed(2)} max=${max.toFixed(2)}`);
  console.log(`  Best plan:  ${bestPlan.action} + ${bestPlan.policy} → μ=${bestPlan.mean.toFixed(2)}`);
  console.log(`  Worst plan: ${worstPlan.action} + ${worstPlan.policy} → μ=${worstPlan.mean.toFixed(2)}`);
  console.log(`  Context: regime=${matrix.context.regime} inv=${matrix.context.currentInventory} conf=${matrix.context.forecastConfidence.toFixed(2)}`);
}
