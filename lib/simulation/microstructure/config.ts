import type { MarketRegime } from "../../types";

// Tuning constants for the role-based archetype handlers. All scalars; no
// per-regime tables here except where the regime is a first-class input to
// the signal (informed observation noise — wider in shock because the world
// is harder to read during stress).

// --- Momentum ---
export const MOMENTUM_SHORT_WINDOW = 4;
export const MOMENTUM_LONG_WINDOW = 16;
export const MOMENTUM_DECAY_TICKS = 14;
export const MOMENTUM_MIN_STRENGTH = 0.30;
export const MOMENTUM_CONVICTION_GAIN = 1.5;
// Reference cent scale used to convert raw slope into a [0..~3] strength.
export const MOMENTUM_VOL_REF_CENTS = 0.6;

// --- Passive liquidity ---
export const PASSIVE_CANCEL_GAIN = 0.55;
export const PASSIVE_WIDEN_GAIN = 1.8;
export const PASSIVE_FLAVOR_SENS: Record<"lp" | "patient" | "mean_reversion", number> = {
  lp: 1.0,
  patient: 0.4,
  mean_reversion: 0.7,
};
export const PASSIVE_BASE_OFFSET: Record<"lp" | "patient" | "mean_reversion", number> = {
  lp: 0,           // join at touch
  patient: 3,      // rest deep
  mean_reversion: 1,
};
export const PASSIVE_FLAVOR_SIZE: Record<"lp" | "patient" | "mean_reversion", number> = {
  lp: 3,
  patient: 2,
  mean_reversion: 1,
};
export const PASSIVE_THIN_DEPTH = 4;            // top-of-book depth ≤ this counts as thin
export const PASSIVE_IMPROVE_SPREAD_MIN = 2;    // only improve when spread ≥ this many ticks

// --- Liquidity taker ---
export const TAKER_URGENCY_MIN = 0.55;
export const TAKER_MISPRICING_MIN_CENTS = 1.5;
export const TAKER_PANIC_URGENCY_MIN = 1.4;

// --- Informed (noisy observation) ---
// σ of the per-tick Gaussian noise on latent-truth observations, per regime.
// Wider in shock because real-world information is harder to extract during
// stress; recovery noisier than calm because the system is still settling.
export const INFORMED_OBS_SIGMA: Record<MarketRegime, number> = {
  calm: 0.015,
  alert: 0.025,
  shock: 0.045,
  recovery: 0.020,
};
export const INFORMED_OBS_EWMA_GAIN = 0.35;
export const INFORMED_DEAD_BAND_CENTS = 0.8;     // wider than v1 because input is noisy
export const INFORMED_ALPHA_ROUTE = 0.25;
export const INFORMED_BETA_DELTA = 0.6;
export const INFORMED_SIZE_STEP_CENTS = 1.5;
// Multiplicative noise σ on route-shock sums (informed sees noisy shocks).
export const INFORMED_ROUTE_NOISE_MULT_SIGMA = 0.25;

// --- Stale-quote (latency_arb flavor) ---
export const STALENESS_TICKS = 5;
export const STALE_EDGE_THRESHOLD_CENTS = 2.0;

// --- Rebalancer ---
export const REBALANCER_MIN_POSITION = 2;
export const REBALANCER_SIZE_GAIN = 1.0;
export const REBALANCER_POSITION_DECAY = 1 / 60;  // per-emit decay toward 0
export const REBALANCER_POSITION_CAP = 12;

// --- Per-agent ---
export const COOLDOWN_BASE_TICKS = 3;
export const COOLDOWN_CONVICTION_GAIN = 2;        // ticks subtracted per 1.0 conviction
export const COOLDOWN_MIN_TICKS = 1;
export const CONVICTION_EWMA_ALPHA = 0.25;

// --- Urgency / adverse-selection shaping ---
export const URGENCY_VOL_SCALE = 1.0;
export const URGENCY_FRESH_SHOCK_BUMP = 0.4;
export const URGENCY_FRESH_TICKS = 6;
export const ADVERSE_VOL_REGIME_MULT: Record<MarketRegime, number> = {
  calm: 0.6,
  alert: 1.0,
  shock: 2.0,
  recovery: 0.9,
};
export const ADVERSE_IMBALANCE_GAIN = 0.4;
