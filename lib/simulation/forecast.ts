import type { Market, MarketRegime, TransitEvent } from "../types";
import { gaussian } from "../rng";
import { clamp } from "../format";
import { templateTagFor } from "./events";

// Forecast model (Phase 1 microstructure).
//
//   trueProb     = clamp(baseTrueProb + recentImpact + scheduledRisk + regimeBias, …)
//   forecastProb = Kalman-style smoothed estimate of trueProb
//   confidence   = EWMA of (1 − tracking-error/0.2)
//
// applyEventToMarket updates the *hidden* trueProb only — forecastProb
// catches up over a few ticks via driftForecast. This is what makes the
// market feel like the desk is reading a noisy signal instead of warping
// to the answer instantly.

const IMPACT_DECAY = 0.92;
const IMPACT_BOUND = 0.5;
const SCHEDULED_RISK_BOUND = 0.2;
const CONF_FLOOR = 0.2;
const CONF_CAP = 0.92;
const TRACKING_ERROR_BAND = 0.2;     // |forecast - trueProb| past which conf → 0
const CONF_EWMA_ALPHA = 0.1;

// Calm-regime deadband: when |forecast - trueProb| is inside this band and
// the desk is calm, freeze the forecast for this tick. Shock/alert still
// drift normally so reactive markets can keep up.
const CALM_DEADBAND = 0.004;

function safeFinite(n: number | undefined, fallback: number): number {
  return Number.isFinite(n) ? (n as number) : fallback;
}

function regimeBias(regime: MarketRegime): number {
  return regime === "shock" ? 0.01 : 0;
}

function computeTrueProb(market: Market, recentImpact: number, scheduled: number): number {
  const regime = market.regimeState?.regime ?? "calm";
  return clamp(
    market.baseTrueProb + recentImpact + scheduled + regimeBias(regime),
    0.02,
    0.98,
  );
}

export function applyEventToMarket(
  market: Market,
  event: TransitEvent,
): Market {
  const delta = event.impacts[market.id];
  if (delta === undefined) return market;
  const category = event.category ?? "live";

  if (category === "planned") {
    return applyPlannedToMarket(market, event, delta);
  }

  // Live news: push the live channel (recentImpact). trueProb is
  // recomputed from the new total. We deliberately do NOT bump
  // forecastProb here — forecastProb catches up via driftForecast's
  // Kalman step. Confidence likewise no longer jumps on event direction;
  // it now tracks |forecast - trueProb| through driftForecast.
  const prevImpact = safeFinite(market.recentImpact, 0);
  const prevScheduled = safeFinite(market.scheduledRisk, 0);
  const newImpact = clamp(prevImpact + delta, -IMPACT_BOUND, IMPACT_BOUND);
  const newTrueProb = computeTrueProb(market, newImpact, prevScheduled);

  const tag = templateTagFor(event);
  const driverNotes = [tag, ...market.driverNotes].slice(0, 3);

  return {
    ...market,
    recentImpact: newImpact,
    trueProb: newTrueProb,
    driverNotes,
    lastImpactTs: event.ts,
    lastImpactMagnitude: delta,
  };
}

function applyPlannedToMarket(
  market: Market,
  event: TransitEvent,
  delta: number,
): Market {
  const prevImpact = safeFinite(market.recentImpact, 0);
  const prevScheduled = safeFinite(market.scheduledRisk, 0);
  const newScheduled = clamp(
    prevScheduled + delta,
    -SCHEDULED_RISK_BOUND,
    SCHEDULED_RISK_BOUND,
  );
  const newTrueProb = computeTrueProb(market, prevImpact, newScheduled);

  // Planned alerts only refresh driverNotes when they noticeably move the
  // prior — otherwise they'd evict live signals out of the 3-slot list.
  const driverNotes =
    Math.abs(newScheduled - prevScheduled) >= 0.01
      ? [`${templateTagFor(event)} (planned)`, ...market.driverNotes].slice(0, 3)
      : market.driverNotes;

  return {
    ...market,
    scheduledRisk: newScheduled,
    trueProb: newTrueProb,
    driverNotes,
  };
}

export function driftForecast(
  market: Market,
  seed: number,
): { market: Market; seed: number } {
  const prevImpact = safeFinite(market.recentImpact, 0);
  const scheduled = safeFinite(market.scheduledRisk, 0);
  const conf = safeFinite(market.confidence, 0.55);
  const regime = market.regimeState?.regime ?? "calm";

  // Decay live impact and recompute trueProb. scheduledRisk does NOT decay
  // each tick — it drains only when a planned alert clears.
  const newImpact = clamp(
    prevImpact * IMPACT_DECAY,
    -IMPACT_BOUND,
    IMPACT_BOUND,
  );
  const newTrueProb = computeTrueProb(market, newImpact, scheduled);

  // Kalman-style update: forecast moves α-fraction toward trueProb plus
  // a small Gaussian. α is wider in shock and at high confidence so the
  // desk keeps up; capped at 0.30 to prevent same-tick over-learning.
  // In calm + inside the deadband, freeze the forecast entirely — the
  // displayed fair value stays put for stretches when nothing material is
  // happening (no event, no tracking gap).
  const prevForecast = safeFinite(market.forecastProb, market.baseTrueProb);
  const trackingGap = Math.abs(newTrueProb - prevForecast);
  const inCalmDeadband = regime === "calm" && trackingGap < CALM_DEADBAND;
  const alpha = inCalmDeadband
    ? 0
    : clamp(
        0.06 + 0.10 * conf + (regime === "shock" ? 0.18 : 0),
        0,
        0.30,
      );
  // Noise is now tiny in calm (was 0.003 baseline); shock/alert keep the
  // larger noise so reactive markets stay lively.
  const noiseScale = inCalmDeadband
    ? 0
    : regime === "calm"
      ? 0.0006 + 0.001 * (1 - conf)
      : 0.003 + 0.006 * (1 - conf) + (regime === "shock" ? 0.004 : 0);
  const g = gaussian(seed);
  const newForecast = clamp(
    prevForecast + alpha * (newTrueProb - prevForecast) + g.v * noiseScale,
    0.02,
    0.98,
  );

  // Confidence as EWMA of tracking quality. 1 when forecast hugs trueProb;
  // 0 when off by ≥0.20. Floored at 0.2, capped at 0.92.
  const trackingErr = Math.min(
    TRACKING_ERROR_BAND,
    Math.abs(newForecast - newTrueProb),
  );
  const trackQuality = 1 - trackingErr / TRACKING_ERROR_BAND;
  const newConf = clamp(
    (1 - CONF_EWMA_ALPHA) * conf + CONF_EWMA_ALPHA * trackQuality,
    CONF_FLOOR,
    CONF_CAP,
  );

  return {
    market: {
      ...market,
      prevForecastProb: prevForecast,
      forecastProb: newForecast,
      confidence: newConf,
      recentImpact: newImpact,
      trueProb: newTrueProb,
    },
    seed: g.seed,
  };
}
