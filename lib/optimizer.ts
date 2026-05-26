import type { OptimizerDecision, SimState } from "./types";
import { buildScenarioMatrix } from "./simulation/rollout";
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

// ── Public API ───────────────────────────────────────────────────────────────

// Posts the scenario matrix to the Julia optimizer via the Next.js proxy.
// Returns null if the optimizer is unavailable or the request fails.
//
// prevFirstAction: last action returned by this function (empty string on first call).
// isShock / hardInvBreach / invRiskRatio: used to bypass or calibrate inertia.
export async function fetchOptimizerDecision(
  state: SimState,
  marketId: string,
  prevFirstAction: string = "",
  isShock: boolean = false,
  hardInvBreach: boolean = false,
  invRiskRatio: number = 0,
): Promise<Omit<OptimizerDecision, "computedAtTick"> | null> {
  let matrix;
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
    return null;
  }

  try {
    const res = await fetch("/api/optimizer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(matrix),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as Omit<OptimizerDecision, "computedAtTick">;
    return applySelectionInertia(raw, prevFirstAction, isShock, hardInvBreach, invRiskRatio);
  } catch {
    return null;
  }
}
