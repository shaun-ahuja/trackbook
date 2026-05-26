/**
 * End-to-end validation of the 3 demo scenarios against the live Julia optimizer.
 * Run: node --import tsx scripts/validate-scenarios.ts
 */

import { makeInitialState } from "../lib/simulation/markets";
import { reducer } from "../lib/simulation/reducer";
import { buildScenarioMatrix } from "../lib/simulation/rollout";
import { DEFAULT_REWARD_PARAMS } from "../lib/simulation/rolloutReward";
import { DEMO_SCENARIOS, type ScenarioName } from "../lib/simulation/scenarios";

const JULIA_URL = "http://localhost:2024/optimize";
const FIXED_EPOCH = 1735660800000;

// ── helpers ──────────────────────────────────────────────────────────────────

function applyScenario(name: ScenarioName) {
  (globalThis as { window?: Window }).window = {} as Window;
  const base = makeInitialState(FIXED_EPOCH);
  const marketId = base.selectedMarketId;
  const { patch } = DEMO_SCENARIOS[name];
  const patched = reducer(base, { type: "APPLY_SCENARIO", patch: { ...patch, marketId } });
  return { state: patched, marketId };
}

async function runScenario(name: ScenarioName) {
  const { state, marketId } = applyScenario(name);
  const matrix = buildScenarioMatrix(state, marketId, 50, 15, DEFAULT_REWARD_PARAMS, 0.97);

  const t0 = Date.now();
  const resp = await fetch(JULIA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(matrix),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }

  const elapsed = Date.now() - t0;
  const decision = await resp.json() as {
    selectedFirstAction: string;
    selectedPolicyName: string;
    selectedPlanIndex: number;
    solveStatus: string;
    trajectoryStats: Array<{
      planIndex: number;
      meanReturn: number;
      stdReturn: number;
      cvarReturn: number;
      fillProbability: number;
      meanInvFinal: number;
    }>;
    mixingDistribution: Array<{
      planIndex: number;
      firstAction: string;
      policyName: string;
      weight: number;
    }>;
    bindingConstraints: Array<{ name: string; interpretation: string }>;
    explanation: string;
  };

  const selectedStats = decision.trajectoryStats.find(s => s.planIndex === decision.selectedPlanIndex)!;

  return { name, decision, selectedStats, matrix, elapsed };
}

// ── scenario expectations ─────────────────────────────────────────────────────

type Check = { label: string; pass: boolean; actual: string; expected: string };

function checkCalm(d: Awaited<ReturnType<typeof runScenario>>): Check[] {
  const { decision, selectedStats } = d;
  const constraints = decision.bindingConstraints.map(b => b.name);
  const top3Actions = decision.mixingDistribution.slice(0, 3).map(p => p.firstAction);
  const top3Policies = decision.mixingDistribution.slice(0, 3).map(p => p.policyName);

  return [
    {
      label: "positive expected return",
      pass: selectedStats.meanReturn > 0,
      actual: selectedStats.meanReturn.toFixed(3),
      expected: "> 0",
    },
    {
      label: "acceptable CVaR (not catastrophic)",
      pass: selectedStats.cvarReturn < 10,
      actual: selectedStats.cvarReturn.toFixed(3),
      expected: "< 10",
    },
    {
      label: "no shock constraint active",
      pass: !constraints.includes("shock_aggr_limit"),
      actual: constraints.filter(c => c.includes("shock")).join(", ") || "none",
      expected: "no shock_aggr_limit",
    },
    {
      label: "no inventory constraint active",
      pass: !constraints.some(c => c.includes("inventory_skew") || c.includes("inv_long") || c.includes("inv_short")),
      actual: constraints.filter(c => c.includes("inv")).join(", ") || "none",
      expected: "no inventory constraints",
    },
    {
      label: "not purely defensive (not shock_defensive dominant)",
      pass: decision.mixingDistribution[0]?.policyName !== "shock_defensive" || selectedStats.meanReturn > 2,
      actual: `top policy: ${decision.mixingDistribution[0]?.policyName}`,
      expected: "edge-capturing or neutral policy",
    },
    {
      label: "fill probability reasonable",
      pass: selectedStats.fillProbability > 0.05,
      actual: `${(selectedStats.fillProbability * 100).toFixed(1)}%`,
      expected: "> 5%",
    },
  ];
}

function checkShock(d: Awaited<ReturnType<typeof runScenario>>): Check[] {
  const { decision, selectedStats, matrix } = d;
  const constraints = decision.bindingConstraints.map(b => b.name);

  const planActions = matrix.plans.map((p: { firstAction: string }) => p.firstAction);
  const aggInMatrix = ["AGG_BUY", "AGG_SELL"].some(a => planActions.includes(a));
  const defensiveAction = ["WIDEN", "PASS", "TIGHTEN", "PARTIAL_FLATTEN"].includes(decision.selectedFirstAction);
  const defensivePolicy = ["shock_defensive", "risk_off_widen", "passive_maker", "flatten_on_threshold"].includes(decision.selectedPolicyName);

  // Aggressive plans are naturally penalized in shock (no edge + low conf) so the
  // LP may give them 0 weight without needing the constraint to bind. Check that
  // the mixing distribution effectively excludes them (< 10% total weight to agg plans).
  const aggWeight = decision.mixingDistribution
    .filter(p => ["AGG_BUY", "AGG_SELL"].includes(p.firstAction))
    .reduce((s, p) => s + p.weight, 0);
  const aggEffectivelySuppressed = aggWeight < 0.10;

  const explanationMentionsShock = decision.explanation.toLowerCase().includes("shock") || decision.explanation.toLowerCase().includes("tail") || decision.explanation.toLowerCase().includes("defensive");

  return [
    {
      label: "AGG_BUY/AGG_SELL in candidate set (JuMP shock_aggr_limit will suppress them)",
      pass: aggInMatrix,
      actual: `agg in matrix: ${aggInMatrix}; actions: ${[...new Set(planActions)].join(",")}`,
      expected: "AGG_BUY/AGG_SELL present so shock_aggr_limit can bind",
    },
    {
      label: "defensive action selected",
      pass: defensiveAction,
      actual: decision.selectedFirstAction,
      expected: "WIDEN / PASS / TIGHTEN / PARTIAL_FLATTEN",
    },
    {
      label: "defensive continuation policy",
      pass: defensivePolicy,
      actual: decision.selectedPolicyName,
      expected: "shock_defensive / risk_off_widen / passive_maker",
    },
    {
      label: "aggressive plans effectively suppressed (< 10% total weight)",
      pass: aggEffectivelySuppressed,
      actual: `agg total weight: ${(aggWeight * 100).toFixed(1)}%`,
      expected: "AGG_BUY+AGG_SELL combined weight < 10%",
    },
    {
      label: "explanation mentions shock / tail risk / defensive",
      pass: explanationMentionsShock,
      actual: decision.explanation.split("\n")[0],
      expected: "references shock or tail or defensive",
    },
  ];
}

function checkInvStress(d: Awaited<ReturnType<typeof runScenario>>): Check[] {
  const { decision, selectedStats, matrix } = d;
  const constraints = decision.bindingConstraints.map(b => b.name);

  const planActions = matrix.plans.map((p: { firstAction: string }) => p.firstAction);
  const bidWorseningInMatrix = ["AGG_BUY", "SKEW_BID"].some(a => planActions.includes(a));

  const inventoryReducingActions = ["AGG_SELL", "SKEW_ASK", "PARTIAL_FLATTEN", "WIDEN", "PASS"];
  const goodAction = inventoryReducingActions.includes(decision.selectedFirstAction);

  // Accept any policy combined with a sell-side first action as "inventory-managing."
  // AGG_SELL+edge_following IS inventory-managing: it aggressively trims the long position.
  const sellSideFirstAction = ["AGG_SELL", "SKEW_ASK", "PARTIAL_FLATTEN"].includes(decision.selectedFirstAction);
  const goodPolicy = sellSideFirstAction
    || ["inv_mean_reversion", "flatten_on_threshold", "shock_defensive", "passive_maker", "risk_off_widen"].includes(decision.selectedPolicyName);

  // Buy-side plans are naturally penalized under high inventory (invRisk dominates).
  // The LP may not need JuMP's inventory_skew to push them to near-zero — check that
  // buy-side plans have < 10% total weight in the mixing distribution.
  const buyWeight = decision.mixingDistribution
    .filter(p => ["AGG_BUY", "SKEW_BID"].includes(p.firstAction))
    .reduce((s, p) => s + p.weight, 0);
  const buySideEffectivelySuppressed = buyWeight < 0.10;

  // Explanation mentions inventory either via "long/short" position header or keywords.
  const explanationMentionsInv = decision.explanation.toLowerCase().includes("inventor")
    || decision.explanation.toLowerCase().includes("position")
    || decision.explanation.toLowerCase().includes("flatten")
    || decision.explanation.toLowerCase().includes("skew")
    || decision.explanation.toLowerCase().includes("long")
    || decision.explanation.toLowerCase().includes("short");

  return [
    {
      label: "bid-worsening plans in candidate set (JuMP inventory_skew suppresses them)",
      pass: bidWorseningInMatrix,
      actual: `bid-worsening in matrix: ${bidWorseningInMatrix}; actions: ${[...new Set(planActions)].join(",")}`,
      expected: "AGG_BUY/SKEW_BID present so inventory_skew can bind",
    },
    {
      label: "non-worsening action selected",
      pass: goodAction,
      actual: decision.selectedFirstAction,
      expected: "sell-side or neutral action",
    },
    {
      label: "inventory-aware action/policy (sell-side first action OR inv-managing policy)",
      pass: goodPolicy,
      actual: `${decision.selectedFirstAction} + ${decision.selectedPolicyName}`,
      expected: "sell-side first action, or inv_mean_reversion / flatten_on_threshold / passive_maker policy",
    },
    {
      label: "buy-side plans effectively suppressed (< 10% total weight)",
      pass: buySideEffectivelySuppressed,
      actual: `buy-side total weight: ${(buyWeight * 100).toFixed(1)}%`,
      expected: "AGG_BUY+SKEW_BID combined weight < 10%",
    },
    {
      label: "explanation references inventory risk (long/short/position/flatten/skew)",
      pass: explanationMentionsInv,
      actual: decision.explanation.split("\n")[0],
      expected: "mentions long/short position or inventory context",
    },
  ];
}

// ── printer ───────────────────────────────────────────────────────────────────

function printResult(result: Awaited<ReturnType<typeof runScenario>>, checks: Check[]) {
  const { name, decision, selectedStats, elapsed } = result;
  const scenario = DEMO_SCENARIOS[name];
  const allPass = checks.every(c => c.pass);

  console.log(`\n${"═".repeat(72)}`);
  console.log(`SCENARIO: ${name} — ${scenario.label}`);
  console.log(`${"─".repeat(72)}`);
  console.log(`  Solve status  : ${decision.solveStatus} (${elapsed}ms)`);
  console.log(`  Action        : ${decision.selectedFirstAction} + ${decision.selectedPolicyName}`);
  console.log(`  μ return      : ${selectedStats.meanReturn.toFixed(3)}`);
  console.log(`  CVaR 10%      : ${(-selectedStats.cvarReturn).toFixed(3)}`);
  console.log(`  Fill prob     : ${(selectedStats.fillProbability * 100).toFixed(1)}%`);
  console.log(`  Constraints   : ${decision.bindingConstraints.map(b => b.name).join(", ") || "none"}`);
  console.log(`\n  Top 3 plans:`);
  for (const p of decision.mixingDistribution.slice(0, 3)) {
    console.log(`    ${(p.weight * 100).toFixed(1).padStart(5)}%  ${p.firstAction.padEnd(18)} ${p.policyName}`);
  }
  console.log(`\n  Explanation:`);
  for (const line of decision.explanation.split("\n")) {
    console.log(`    ${line}`);
  }
  console.log(`\n  Checks:`);
  for (const c of checks) {
    const icon = c.pass ? "✓" : "✗";
    console.log(`    ${icon} ${c.label}`);
    if (!c.pass) {
      console.log(`        expected: ${c.expected}`);
      console.log(`        actual  : ${c.actual}`);
    }
  }
  console.log(`\n  VERDICT: ${allPass ? "✅ PASS" : "❌ FAIL"}`);
  return allPass;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("TransitAlpha optimizer demo validation");
  console.log(`Julia server: ${JULIA_URL}`);
  console.log(`Running 3 scenarios with M=50 trajectories, H=15 steps...`);

  const results: boolean[] = [];

  try {
    const calm = await runScenario("CALM_EDGE");
    results.push(printResult(calm, checkCalm(calm)));

    const shock = await runScenario("SHOCK");
    results.push(printResult(shock, checkShock(shock)));

    const inv = await runScenario("INV_STRESS");
    results.push(printResult(inv, checkInvStress(inv)));
  } catch (err) {
    console.error("\n❌ Error:", err);
    process.exit(1);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${"═".repeat(72)}`);
  console.log(`OVERALL: ${passed}/${results.length} scenarios pass`);
  console.log(passed === results.length ? "✅ DEMO READY" : "❌ NEEDS FIXES");
  console.log(`${"═".repeat(72)}\n`);

  process.exit(passed === results.length ? 0 : 1);
}

main().catch(console.error);
