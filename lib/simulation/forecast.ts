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

function safeFinite(n: number | undefined, fallback: number): number {
  return Number.isFinite(n) ? (n as number) : fallback;
}

// Kalman-style update of forecastProb toward an externally-provided latent
// truth. Pure except for the Gaussian seed advancement.
export function driftForecast(
  market: Market,
  latentTrueProb: number,
  seed: number,
): { market: Market; seed: number } {
  const conf = safeFinite(market.confidence, 0.55);
  const regime: MarketRegime = market.regimeState?.regime ?? "calm";
  const volEst = safeFinite(market.dynamics?.volatilityEstimate, 0);

  const prevForecast = safeFinite(market.forecastProb, latentTrueProb);
  const trackingGap = Math.abs(latentTrueProb - prevForecast);
  const inCalmDeadband = regime === "calm" && trackingGap < CALM_DEADBAND;

  // Alpha widens with confidence and shock regime; capped at 0.30 so a
  // single tick can't over-learn. Calm deadband freezes the forecast.
  const alpha = inCalmDeadband
    ? 0
    : clamp(
        0.06 + 0.10 * conf + (regime === "shock" ? 0.18 : 0),
        0,
        0.30,
      );

  // Noise tiny in calm; larger in shock/alert. No dependence on volEst —
  // vol shapes confidence, not the noise we add to our own quote.
  const noiseScale = inCalmDeadband
    ? 0
    : regime === "calm"
      ? 0.0006 + 0.001 * (1 - conf)
      : 0.003 + 0.006 * (1 - conf) + (regime === "shock" ? 0.004 : 0);
  const g = gaussian(seed);
  const newForecast = clamp(
    prevForecast + alpha * (latentTrueProb - prevForecast) + g.v * noiseScale,
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
