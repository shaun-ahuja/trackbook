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
// forecastProb × 100 = fair value in cents. With market mid ≈ 50¢:
//   CALM_EDGE: fair ≈ 54.5¢ → edge ≈ 4.5¢ (above EDGE_ENTER=3.5)
//   SHOCK:     fair ≈ 51.0¢ → edge ≈ 1¢   (irrelevant — low conf dominates)
//   INV_STRESS: fair ≈ 55¢  → edge ≈ 5¢   (but long 7/8 → buy-side suppressed)
export const DEMO_SCENARIOS: Record<ScenarioName, ScenarioDef> = {
  CALM_EDGE: {
    label: "Calm · Edge",
    description: "Flat inventory, decent edge, high confidence — expect edge capture",
    color: "#3ddc97",
    patch: {
      regime: "calm",
      inventory: 0,
      confidence: 0.78,
      forecastProb: 0.545,
      vol: 0.15,
      rngState: 42_424_242,
    },
    expectedBehavior:
      "Aggressive/edge-following plans dominate. No risk constraints bind. CVaR positive.",
  },
  SHOCK: {
    label: "Shock",
    description: "Shock regime, low confidence — expect defensive selection, constraints bind",
    color: "#ff5a78",
    patch: {
      regime: "shock",
      inventory: 2,
      confidence: 0.32,
      forecastProb: 0.51,
      vol: 0.82,
      rngState: 99_887_766,
    },
    expectedBehavior:
      "AGG_BUY/SELL filtered. WIDEN or shock_defensive dominates. shock_aggr_limit and/or cvar_risk_limit bind.",
  },
  INV_STRESS: {
    label: "Inv Stress",
    description: "Long 7 / 8 contracts — expect buy-side suppressed, flatten skew",
    color: "#f5b042",
    patch: {
      regime: "calm",
      inventory: 7,
      confidence: 0.71,
      forecastProb: 0.55,
      vol: 0.22,
      rngState: 55_443_322,
    },
    expectedBehavior:
      "AGG_BUY/SKEW_BID filtered. inventory_skew constraint binds in JuMP. Flatten/sell plans preferred.",
  },
};
