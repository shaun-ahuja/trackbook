import type { Market, MarketRegime, MarketRegimeState } from "../../types";

// Min-dwell ticks per regime — prevents same-tick flip-flop. Sev-3 events
// bypass dwell for shock entry; all other transitions must respect it.
const MIN_DWELL: Record<MarketRegime, number> = {
  calm: 25,
  alert: 18,
  shock: 10,
  recovery: 30,
};

const SHORT_DELTA_ALERT = 0.012;
const LARGE_EVENT_IMPACT = 0.06;
const SHOCK_EVENT_IMPACT = 0.10;
// EWMA α for shortAbsDelta — ~6-tick half-life.
const SHORT_DELTA_ALPHA = 0.18;

export function safeRegimeState(
  s: MarketRegimeState | undefined,
): MarketRegimeState {
  if (!s) {
    return {
      regime: "calm",
      enteredTick: 0,
      shortAbsDelta: 0,
      ticksSinceEvent: 999,
      ticksSinceShock: 999,
    };
  }
  return {
    regime: s.regime ?? "calm",
    enteredTick: Number.isFinite(s.enteredTick) ? s.enteredTick : 0,
    shortAbsDelta: Number.isFinite(s.shortAbsDelta) ? s.shortAbsDelta : 0,
    ticksSinceEvent: Number.isFinite(s.ticksSinceEvent) ? s.ticksSinceEvent : 999,
    ticksSinceShock: Number.isFinite(s.ticksSinceShock) ? s.ticksSinceShock : 999,
  };
}

// Advance the per-market regime. `forecastAbsDelta` is |Δforecast| from
// the prior tick's drift (used to update the activity EWMA). `eventImpact`
// is |impact| if an event hit this market this tick, else 0.
export function stepRegime(
  market: Market,
  forecastAbsDelta: number,
  eventImpact: number,
  currentTick: number,
): MarketRegimeState {
  const prev = safeRegimeState(market.regimeState);
  const shortAbsDelta =
    (1 - SHORT_DELTA_ALPHA) * prev.shortAbsDelta +
    SHORT_DELTA_ALPHA * forecastAbsDelta;
  const hadEvent = eventImpact > 0;
  const ticksSinceEvent = hadEvent ? 0 : prev.ticksSinceEvent + 1;
  const ticksInState = currentTick - prev.enteredTick;
  const dwell = MIN_DWELL[prev.regime];

  let next: MarketRegime = prev.regime;
  const shockTrigger = hadEvent && eventImpact >= SHOCK_EVENT_IMPACT;

  if (prev.regime === "calm") {
    if (shockTrigger) {
      next = "shock";
    } else if (ticksInState >= dwell) {
      if (
        shortAbsDelta > SHORT_DELTA_ALERT ||
        (hadEvent && eventImpact > 0.04)
      ) {
        next = "alert";
      }
    }
  } else if (prev.regime === "alert") {
    if (shockTrigger) {
      next = "shock";
    } else if (ticksInState >= dwell) {
      if (hadEvent && eventImpact > LARGE_EVENT_IMPACT) {
        next = "shock";
      } else if (
        shortAbsDelta < SHORT_DELTA_ALERT / 2 &&
        ticksSinceEvent > 20
      ) {
        next = "calm";
      }
    }
  } else if (prev.regime === "shock") {
    if (ticksInState >= dwell) {
      // ticksInState ≈ ticksSinceShock while in shock — once dwell + the
      // extra calm-down window have passed and activity is low, recover.
      if (ticksInState > 16 && shortAbsDelta < 0.02) {
        next = "recovery";
      }
    }
  } else if (prev.regime === "recovery") {
    if (shockTrigger) {
      next = "shock";
    } else if (ticksInState >= dwell) {
      if (ticksInState > 30 && shortAbsDelta < SHORT_DELTA_ALERT / 2) {
        next = "calm";
      }
    }
  }

  const enteredTick = next === prev.regime ? prev.enteredTick : currentTick;
  // ticksSinceShock resets to 0 when entering shock; otherwise increments.
  const ticksSinceShock =
    next === "shock" && prev.regime !== "shock"
      ? 0
      : prev.ticksSinceShock + 1;

  return {
    regime: next,
    enteredTick,
    shortAbsDelta,
    ticksSinceEvent,
    ticksSinceShock,
  };
}
