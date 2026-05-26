import type { ScenarioPatch } from "../types";

export type ScenarioName = "CALM_EDGE" | "SHOCK" | "INV_STRESS";

export type ScenarioDef = {
  label: string;
  description: string;
  color: string;
  patch: Omit<ScenarioPatch, "marketId">;
  expectedBehavior: string;
};

// Three deterministic demo scenarios with fixed rngState seeds so rollout
// tensors are reproducible across runs. Each patch targets the fields that
// the optimizer reads: regime, confidence, inventory, forecastProb, vol.
//
// forecastProb × 100 = fair value in cents. The initial selected market has
// mid ≈ 34¢ (bid=32, ask=36). Edge = fair - mid must be:
//   • Above EDGE_ENTER=3.5 to trigger action (CALM, INV_STRESS)
//   • Below VERY_LARGE_EDGE=7 so the hysteresis lock holds and forced actions
//     in rollouts don't get overridden by the market maker's carve-outs
//
//   CALM_EDGE:  forecastProb=0.39 → fair=39¢ → edge=5¢ (in 3.5–7 window)
//   SHOCK:      forecastProb=0.36 → fair=36¢ → edge=2¢ (below EDGE_ENTER, low conf blocks action)
//   INV_STRESS: forecastProb=0.39 → fair=39¢ → edge=5¢ (same as calm, blocked by inventory limit)
export const DEMO_SCENARIOS: Record<ScenarioName, ScenarioDef> = {
  CALM_EDGE: {
    label: "Calm · Edge",
    description: "Flat inventory, 5¢ edge, high confidence — expect edge capture",
    color: "#3ddc97",
    patch: {
      regime: "calm",
      inventory: 0,
      confidence: 0.78,
      forecastProb: 0.39,
      vol: 0.15,
      rngState: 42_424_242,
    },
    expectedBehavior:
      "Edge-capturing plans dominate. No risk constraints bind. Positive expected return.",
  },
  SHOCK: {
    label: "Shock",
    description: "Shock regime, low confidence — expect defensive selection, constraints bind",
    color: "#ff5a78",
    patch: {
      regime: "shock",
      inventory: 2,
      confidence: 0.32,
      forecastProb: 0.36,
      vol: 0.82,
      rngState: 99_887_766,
    },
    expectedBehavior:
      "AGG_BUY/SELL filtered. WIDEN or shock_defensive dominates. shock_aggr_limit and/or cvar_risk_limit bind.",
  },
  INV_STRESS: {
    label: "Inv Stress",
    description: "Long 7 / 8 contracts, 5¢ edge — expect buy-side suppressed, flatten/sell preferred",
    color: "#f5b042",
    patch: {
      regime: "calm",
      inventory: 7,
      confidence: 0.71,
      forecastProb: 0.39,
      vol: 0.22,
      rngState: 55_443_322,
    },
    expectedBehavior:
      "AGG_BUY/SKEW_BID filtered. inventory_skew constraint binds in JuMP. Flatten/sell plans preferred.",
  },
};
