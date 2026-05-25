import type { MarketRegime, Severity } from "../types";

// Single source of truth for adaptive probability dynamics parameters.
// Frozen-as-const so consumers get literal types and the model can't drift
// silently when a stray edit lands.
//
// Layering convention (do not collapse):
//   longRunBaseProbability      static anchor (per market spec)
//   adaptiveBaseProbability     stored, drifts slowly
//   latentTrueProbability       derived = base + shock overlays + contagion + stress
//   forecastProb                desk's noisy Kalman-smoothed estimate

export const DYNAMICS_CONFIG = {
  bounds: { min: 0.01, max: 0.99 },

  meanReversion: {
    // Per-tick pull of adaptiveBaseProbability toward its drift target.
    // Conservative: a 0.1 gap closes ~30% over 100 ticks (half-life ~170t).
    kappa: 0.004,
    // How much latentRisk biases the drift target away from the long-run anchor.
    // latentRisk lives in [-0.2, 0.2]; coeff 0.6 means a saturated planned-work
    // alert pulls the base by up to ~12pp at equilibrium.
    latentRiskCoeff: 0.6,
  },

  shockDecay: {
    // Live event half-lives in ticks. Severity 3 lingers ~55t (~40s @ 750ms).
    severityHalfLives: { 1: 10, 2: 22, 3: 55 } as Record<Severity, number>,
    // Planned-work alerts persist for hours of game-time.
    plannedHalfLife: 240,
    // GTFS-RT trip aggregations have a short shelf life.
    tripHalfLife: 18,
    // Below this magnitude, drop the entry — keeps eventMemory bounded.
    expireEps: 0.0008,
    // Only shocks born within this window contribute to contagion.
    contagionWindow: 8,
  },

  // Multipliers applied to the *overlay* contributions when assembling
  // latentTrueProbability. The adaptiveBase itself is never multiplied here —
  // regime only modulates how loudly transients ride on top of the base.
  regimeMult: {
    shockOverlay: { calm: 1.0, alert: 1.2, shock: 1.6, recovery: 0.7 } as Record<MarketRegime, number>,
    contagion:    { calm: 1.0, alert: 1.1, shock: 1.4, recovery: 0.8 } as Record<MarketRegime, number>,
    stress:       { calm: 1.0, alert: 1.1, shock: 1.3, recovery: 0.9 } as Record<MarketRegime, number>,
  },

  contagion: {
    sameTrunk: 0.55,
    transferHub: 0.18,
    systemwide: 0.015,
  },

  // Structured network stress. Hours are NYC local. Rush hours peak at AM/PM
  // peaks; intensity falls off linearly toward the window edges.
  networkStress: {
    amHours: [7, 10] as readonly [number, number],
    amPeak: 8.5,
    pmHours: [16, 20] as readonly [number, number],
    pmPeak: 17.5,
    lateNightHours: [0, 5] as readonly [number, number],
    weekendDays: [0, 6] as readonly number[], // Sun, Sat
    // Maintenance window: Fri 22:00 → Sun 06:00 (overnight track work).
    maintenanceStartDay: 5, // Friday
    maintenanceEndDay: 0,   // Sunday
    maintenanceStartHour: 22,
    maintenanceEndHour: 6,

    rushHourBias: 0.025,
    lateNightBias: -0.015,
    weekendBias: -0.008,
    maintenanceBias: 0.012,
  },

  volatility: {
    // EWMA α on |Δ latent truth|. Drives confidence damping + jump caps.
    alpha: 0.12,
    // Maps volatilityEstimate ∈ [0, ~0.05] onto a jump-cap multiplier.
    jumpScaleMin: 0.6,
    jumpScaleMax: 1.8,
    // High vol drags confidence down in driftForecast.
    confidenceDamp: 1.4,
  },

  // Per-tick clamp on |Δ adaptiveBaseProbability|. Shock regime widens it so
  // sustained shocks can actually move the base; calm/recovery keep it tight.
  // Vol scales these further (see jumpScale).
  maxBaseJump: { calm: 0.004, alert: 0.008, shock: 0.025, recovery: 0.006 } as Record<MarketRegime, number>,

  // latentRisk channel bounds.
  latentRisk: {
    min: -0.2,
    max: 0.2,
  },

  // Driver list shown in debug surface — top N contributions by |delta|.
  driverListSize: 4,
} as const;

export type DynamicsConfig = typeof DYNAMICS_CONFIG;

// Map an event severity to its live-channel half-life. Helper so callers
// don't index the const directly.
export function liveHalfLifeFor(severity: Severity): number {
  return DYNAMICS_CONFIG.shockDecay.severityHalfLives[severity];
}
