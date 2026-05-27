import type { OptimizerDecision, OptimizerTrajectoryStats, SimState } from "./types";
import { buildScenarioMatrix, type ScenarioMatrix } from "./simulation/rollout";
import { DEFAULT_REWARD_PARAMS } from "./simulation/rolloutReward";

// ── Action family classification ─────────────────────────────────────────────

const BUY_ACTIONS  = new Set(["SKEW_BID", "AGG_BUY"]);
const SELL_ACTIONS = new Set(["SKEW_ASK", "AGG_SELL"]);
const RISK_ACTIONS = new Set(["PARTIAL_FLATTEN", "FLATTEN"]);

function actionFamily(a: string): "BUY" | "SELL" | "RISK" | "QUOTE" {
  if (BUY_ACTIONS.has(a))  return "BUY";
  if (SELL_ACTIONS.has(a)) return "SELL";
  if (RISK_ACTIONS.has(a)) return "RISK";
  return "QUOTE";
}

// ── Post-selection inertia ───────────────────────────────────────────────────
//
// Re-ranks Julia's plan selection using a switching cost applied to each
// plan's meanReturn. R[][] is never touched — Julia's trajectory economics
// remain honest. Only selectedPlanIndex / selectedFirstAction / selectedPolicyName
// may be overridden when a cheaper incumbent family plan beats the raw winner.
//
// Switching costs:
//   same action               → 0
//   same family, diff action  → 0.5
//   cross-family (non-RISK)   → 2.0
//   cross-family into RISK    → 2.0 if noise (suppressed), 0 if real risk
//
// RISK is "real" when: invRiskRatio >= 0.65 OR the best same-family plan has
// cvarReturn > 2.0 (i.e., staying put already has bad tail risk).

function applySelectionInertia(
  result: Omit<OptimizerDecision, "computedAtTick">,
  prevFirstAction: string,
  isShock: boolean,
  hardInvBreach: boolean,
  invRiskRatio: number,
): Omit<OptimizerDecision, "computedAtTick"> {
  if (!prevFirstAction || isShock || hardInvBreach) return result;
  if (result.trajectoryStats.length === 0) return result;

  const prevFam = actionFamily(prevFirstAction);

  // CVaR of the best plan staying in the current family — used to decide
  // whether RISK actions are genuinely needed.
  const sameFamStats = result.trajectoryStats.filter(
    (s) => actionFamily(s.firstAction) === prevFam,
  );
  const bestSameFamCVar = sameFamStats.length > 0
    ? Math.min(...sameFamStats.map((s) => s.cvarReturn))
    : 0;

  const riskIsReal = invRiskRatio >= 0.65 || bestSameFamCVar > 2.0;

  const adjusted = result.trajectoryStats.map((s) => {
    const rawFam = actionFamily(s.firstAction);
    let cost = 0;
    if (s.firstAction === prevFirstAction) {
      cost = 0;
    } else if (rawFam === prevFam) {
      cost = 0.5;
    } else if (rawFam === "RISK") {
      cost = riskIsReal ? 0 : 2.0;
    } else {
      cost = 2.0;
    }
    return { planIndex: s.planIndex, firstAction: s.firstAction, policyName: s.policyName, adjustedReturn: s.meanReturn - cost };
  });

  const winner = adjusted.reduce((best, s) =>
    s.adjustedReturn > best.adjustedReturn ? s : best,
  );

  if (winner.planIndex === result.selectedPlanIndex) return result;

  return {
    ...result,
    selectedPlanIndex: winner.planIndex,
    selectedFirstAction: winner.firstAction,
    selectedPolicyName: winner.policyName,
  };
}

// ── TypeScript greedy fallback helpers ───────────────────────────────────────

function computeStd(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

function computeCVar(returns: number[], alpha = 0.1): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const cutoff = Math.max(1, Math.floor(sorted.length * alpha));
  return sorted.slice(0, cutoff).reduce((s, v) => s + v, 0) / cutoff;
}

// Greedy selection from a pre-built scenario matrix. Called with the same
// matrix sent to Julia — no extra build cost. Returns TS_GREEDY_FALLBACK
// when Julia is unavailable or has not yet responded.
export function computeLocalDecision(
  matrix: ScenarioMatrix,
  prevFirstAction: string,
  isShock: boolean,
  hardInvBreach: boolean,
  invRiskRatio: number,
): Omit<OptimizerDecision, "computedAtTick"> | null {
  if (matrix.N === 0) return null;

  const trajectoryStats: OptimizerTrajectoryStats[] = matrix.plans.map((plan, n) => {
    const returns = matrix.R[n];
    return {
      planIndex: n,
      firstAction: plan.firstAction,
      policyName: plan.policyName,
      meanReturn: returns.reduce((s, v) => s + v, 0) / returns.length,
      stdReturn: computeStd(returns),
      cvarReturn: computeCVar(returns),
      fillProbability: 0,
      meanInvFinal: matrix.invFinal[n].reduce((s, v) => s + v, 0) / matrix.M,
    };
  });

  const winner = trajectoryStats.reduce((best, s) =>
    s.meanReturn > best.meanReturn ? s : best,
  );

  const result: Omit<OptimizerDecision, "computedAtTick"> = {
    selectedPlanIndex: winner.planIndex,
    selectedFirstAction: winner.firstAction,
    selectedPolicyName: winner.policyName,
    mixingDistribution: [
      {
        planIndex: winner.planIndex,
        firstAction: winner.firstAction,
        policyName: winner.policyName,
        weight: 1.0,
      },
    ],
    trajectoryStats,
    bindingConstraints: [],
    explanation: "TypeScript greedy fallback — Julia optimizer pending.",
    solveStatus: "TS_GREEDY_FALLBACK",
    solveDurationMs: 0,
  };

  return applySelectionInertia(result, prevFirstAction, isShock, hardInvBreach, invRiskRatio);
}

// Absolute last resort when matrix build fails. PASS is the safest
// possible market-maker posture — no directional exposure.
export const SAFE_PASS_POLICY: Omit<OptimizerDecision, "computedAtTick"> = {
  selectedPlanIndex: 0,
  selectedFirstAction: "PASS",
  selectedPolicyName: "passive_maker",
  mixingDistribution: [{ planIndex: 0, firstAction: "PASS", policyName: "passive_maker", weight: 1.0 }],
  trajectoryStats: [],
  bindingConstraints: [],
  explanation: "Safe startup policy — waiting for optimizer, showing PASS.",
  solveStatus: "SAFE_DEFAULT",
  solveDurationMs: 0,
};

// ── Public API ───────────────────────────────────────────────────────────────

// Posts the scenario matrix to the Julia optimizer via the Next.js proxy.
// Returns the local TypeScript greedy fallback if Julia is unavailable or
// the request fails — never returns null once the matrix is built.
//
// juliaTimeoutMs: the startup call passes 750 for fast initial render;
// steady-state TICK calls use the default 10s to allow valid long solves.
export async function fetchOptimizerDecision(
  state: SimState,
  marketId: string,
  prevFirstAction: string = "",
  isShock: boolean = false,
  hardInvBreach: boolean = false,
  invRiskRatio: number = 0,
  juliaTimeoutMs: number = 10_000,
): Promise<Omit<OptimizerDecision, "computedAtTick"> | null> {
  const t0 = performance.now();

  let matrix: ScenarioMatrix;
  try {
    matrix = buildScenarioMatrix(
      state,
      marketId,
      50,   // M: trajectories per plan
      15,   // H: horizon steps
      DEFAULT_REWARD_PARAMS,
      0.97, // gamma: discount factor
    );
  } catch {
    console.log(`[optimizer] matrix build failed tick=${state.tick}`);
    return null;
  }
  const matrixBuildMs = Math.round(performance.now() - t0);

  // Compute local fallback from the already-built matrix — reused for Julia payload,
  // so there is no extra matrix construction cost.
  const localFallback = computeLocalDecision(matrix, prevFirstAction, isShock, hardInvBreach, invRiskRatio);

  console.log(`[optimizer] request started tick=${state.tick} matrixBuild=${matrixBuildMs}ms`);
  const t1 = performance.now();

  try {
    const res = await fetch("/api/optimizer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(matrix),
      signal: AbortSignal.timeout(juliaTimeoutMs),
    });
    const networkMs = Math.round(performance.now() - t1);

    if (!res.ok) {
      console.log(`[optimizer] julia error tick=${state.tick} status=${res.status} network=${networkMs}ms → fallback`);
      return localFallback;
    }

    const raw = (await res.json()) as Omit<OptimizerDecision, "computedAtTick">;
    console.log(`[optimizer] julia ok tick=${state.tick} network=${networkMs}ms julia=${raw.solveDurationMs}ms`);
    return applySelectionInertia(raw, prevFirstAction, isShock, hardInvBreach, invRiskRatio);
  } catch (err) {
    const networkMs = Math.round(performance.now() - t1);
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    console.log(
      `[optimizer] julia ${isTimeout ? "timeout" : "error"} tick=${state.tick} network=${networkMs}ms → fallback`,
    );
    return localFallback;
  }
}
