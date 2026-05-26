import type { Market, MarketRegime } from "../types";
import { gaussian } from "../rng";
import { clamp } from "../format";
import { DYNAMICS_CONFIG } from "./dynamicsConfig";

// Forecast layer.
//
// The adaptive layer (probabilityDynamics.ts) owns truth: it computes a
// latentTrueProbability each tick from adaptiveBase + shock overlays +
// contagion + network stress. This file is the *desk's noisy estimate*
// of that truth — a Kalman-style smoothing pass.
//
// Splitting them keeps the contract clear:
//   - latent truth = the world as it actually is right now
//   - forecastProb = the desk's lagging belief about latent truth
//
// Confidence is an EWMA of tracking quality (|forecast - latent|), damped
// further when volatilityEstimate is high — uncertainty rises when the
// truth itself is moving around a lot.

const CONF_FLOOR = 0.2;
const CONF_CAP = 0.92;
const TRACKING_ERROR_BAND = 0.2;     // |forecast - latent| past which conf → 0
const CONF_EWMA_ALPHA = 0.1;

// Calm-regime deadband: when |forecast - latent| is inside this band and
// the desk is calm, freeze the forecast for this tick. Shock/alert still
// drift normally so reactive markets can keep up.
const CALM_DEADBAND = 0.004;

// Per-tick delta clamp keeps the displayed forecast smooth in normal
// operation; event shocks get a wider window so real dislocations register.
const MAX_DELTA_NORMAL = 0.0125;    // 1.25pp max per tick in calm/alert
const MAX_DELTA_EVENT_SHOCK = 0.025; // 2.5pp on a real event landing this tick

// Alpha caps. Normal ticks stay in the 0.15–0.20 range; genuine event
// shocks can use a wider learning rate since the clamp prevents overshoot.
const ALPHA_CAP_NORMAL = 0.20;
const ALPHA_CAP_EVENT_SHOCK = 0.50;

function safeFinite(n: number | undefined, fallback: number): number {
  return Number.isFinite(n) ? (n as number) : fallback;
}

// Kalman-style update of forecastProb toward an externally-provided latent
// truth. Pure except for the Gaussian seed advancement.
//
// isEventShock: caller signals that a meaningful event impact landed on this
// market this tick (eventImpactMag >= SHOCK_MIN_IMPACT). Widens both the
// alpha cap and the per-tick delta clamp so real dislocations register fast.
export function driftForecast(
  market: Market,
  latentTrueProb: number,
  seed: number,
  isEventShock = false,
): { market: Market; seed: number } {
  const conf = safeFinite(market.confidence, 0.55);
  const regime: MarketRegime = market.regimeState?.regime ?? "calm";
  const volEst = safeFinite(market.dynamics?.volatilityEstimate, 0);

  const prevForecast = safeFinite(market.forecastProb, latentTrueProb);
  const trackingGap = Math.abs(latentTrueProb - prevForecast);
  const inCalmDeadband = regime === "calm" && trackingGap < CALM_DEADBAND;

  // Alpha widens with confidence; shock regime adds a modest boost.
  // Event shocks bypass the normal cap so the desk can snap to the new fair
  // value — the per-tick delta clamp below still prevents overshoot.
  // Calm deadband freezes the forecast entirely.
  const alphaCap = isEventShock ? ALPHA_CAP_EVENT_SHOCK : ALPHA_CAP_NORMAL;
  const alpha = inCalmDeadband
    ? 0
    : clamp(
        0.04 + 0.08 * conf + (regime === "shock" ? 0.06 : 0),
        0,
        alphaCap,
      );

  // Noise reduced ~3× from prior values. Event shocks don't need extra noise
  // — the delta clamp already allows a clean step.
  const noiseScale = inCalmDeadband
    ? 0
    : regime === "calm"
      ? 0.0003 + 0.0005 * (1 - conf)
      : 0.001 + 0.002 * (1 - conf) + (regime === "shock" ? 0.001 : 0);
  const g = gaussian(seed);

  // Clamp the per-tick move so a single noisy tick can't swing fair value
  // several percentage points. Event shocks get a wider window (2.5pp).
  const maxDelta = isEventShock ? MAX_DELTA_EVENT_SHOCK : MAX_DELTA_NORMAL;
  const rawDelta = alpha * (latentTrueProb - prevForecast) + g.v * noiseScale;
  const newForecast = clamp(
    prevForecast + clamp(rawDelta, -maxDelta, maxDelta),
    0.02,
    0.98,
  );

  // Confidence as EWMA of tracking quality, then damped by volatility.
  // Higher vol → confidence pulled down (proportional to how much the
  // latent truth itself has been swinging recently).
  const trackingErr = Math.min(
    TRACKING_ERROR_BAND,
    Math.abs(newForecast - latentTrueProb),
  );
  const trackQuality = 1 - trackingErr / TRACKING_ERROR_BAND;
  const volPenalty = clamp(volEst * DYNAMICS_CONFIG.volatility.confidenceDamp, 0, 0.5);
  const rawConf = (1 - CONF_EWMA_ALPHA) * conf + CONF_EWMA_ALPHA * trackQuality;
  const newConf = clamp(rawConf - volPenalty * CONF_EWMA_ALPHA, CONF_FLOOR, CONF_CAP);

  return {
    market: {
      ...market,
      prevForecastProb: prevForecast,
      forecastProb: newForecast,
      confidence: newConf,
    },
    seed: g.seed,
  };
}
