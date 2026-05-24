import type { Market, TransitEvent } from "../types";
import { gaussian, randRange } from "../rng";
import { clamp } from "../format";
import { templateTagFor } from "./events";

// Forecast model. Transparent heuristics — no fake ML.
//
//   forecastProb = clamp(baseTrueProb + recentImpact + tiny_drift, 0.02, 0.98)
//
// recentImpact accumulates event deltas and decays geometrically each tick,
// so the prior reasserts itself as time passes without news. Confidence
// rises on consistent evidence and falls on conflicting signals.

const IMPACT_DECAY = 0.92;        // half-life ≈ 8 ticks (≈6s)
const IMPACT_BOUND = 0.5;
const SCHEDULED_RISK_BOUND = 0.2; // planned-work prior is capped tighter
const CONF_FLOOR = 0.5;
const CONF_CAP = 0.92;            // the desk is never "certain"
const CONF_REVERT_RATE = 0.02;    // pull toward CONF_FLOOR each tick

function safeFinite(n: number | undefined, fallback: number): number {
  return Number.isFinite(n) ? (n as number) : fallback;
}

export function applyEventToMarket(
  market: Market,
  event: TransitEvent,
): Market {
  const delta = event.impacts[market.id];
  if (delta === undefined) return market;
  const category = event.category ?? "live";

  // Planned-work alerts feed a slow, persistent channel — no confidence
  // bump (it's a known prior, not new information), no impact decay (the
  // pressure stays while the alert is active and drains on its CLEAR).
  if (category === "planned") {
    return applyPlannedToMarket(market, event, delta);
  }

  // Live news: shocky channel that decays each tick.
  const prevImpact = safeFinite(market.recentImpact, 0);
  const prevScheduled = safeFinite(market.scheduledRisk, 0);
  const consistent = prevImpact === 0 || Math.sign(prevImpact) === Math.sign(delta);

  const newImpact = clamp(prevImpact + delta, -IMPACT_BOUND, IMPACT_BOUND);
  const newProb = clamp(
    market.baseTrueProb + newImpact + prevScheduled,
    0.02,
    0.98,
  );

  // Confidence bump scales with severity and impact magnitude; halved when
  // the event conflicts with the current direction, and gently *reduced*
  // by a fraction of the bump in that case (uncertainty propagation).
  const magBonus = Math.abs(delta) > 0.05 ? 1.0 : 0.6;
  const sevWeight = 0.04 * event.severity * magBonus;
  const confBump = consistent ? sevWeight : -sevWeight * 0.4;
  const newConf = clamp(market.confidence + confBump, 0.2, CONF_CAP);

  const tag = templateTagFor(event);
  const driverNotes = [tag, ...market.driverNotes].slice(0, 3);

  return {
    ...market,
    forecastProb: newProb,
    confidence: newConf,
    recentImpact: newImpact,
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
  const newProb = clamp(
    market.baseTrueProb + prevImpact + newScheduled,
    0.02,
    0.98,
  );

  // Planned alerts only refresh driverNotes when they noticeably move the
  // prior — otherwise they'd evict live signals out of the 3-slot list.
  const driverNotes =
    Math.abs(newScheduled - prevScheduled) >= 0.01
      ? [`${templateTagFor(event)} (planned)`, ...market.driverNotes].slice(0, 3)
      : market.driverNotes;

  return {
    ...market,
    forecastProb: newProb,
    scheduledRisk: newScheduled,
    driverNotes,
  };
}

export function driftForecast(
  market: Market,
  seed: number,
): { market: Market; seed: number } {
  // Self-heal: stale hot-reload state may lack recentImpact / scheduledRisk.
  const prevImpact = safeFinite(market.recentImpact, 0);
  const scheduled = safeFinite(market.scheduledRisk, 0);

  // Decay accumulated impact. Tiny brownian noise on top so the forecast
  // never sits perfectly still even between events. scheduledRisk does NOT
  // decay — it drains only when a planned alert clears.
  const noise = gaussian(seed);
  const newImpact = clamp(
    prevImpact * IMPACT_DECAY + noise.v * 0.004,
    -IMPACT_BOUND,
    IMPACT_BOUND,
  );
  const newProb = clamp(
    market.baseTrueProb + newImpact + scheduled,
    0.02,
    0.98,
  );

  // Confidence reverts toward CONF_FLOOR with tiny noise.
  const confNoise = randRange(noise.seed, -0.004, 0.004);
  const newConf = clamp(
    market.confidence + (CONF_FLOOR - market.confidence) * CONF_REVERT_RATE + confNoise.v,
    0.2,
    CONF_CAP,
  );

  return {
    market: {
      ...market,
      prevForecastProb: market.forecastProb,
      forecastProb: newProb,
      confidence: newConf,
      recentImpact: newImpact,
    },
    seed: confNoise.seed,
  };
}
