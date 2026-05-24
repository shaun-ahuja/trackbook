import type { Fill, Market, SimAction, SimState, TransitEvent } from "../types";
import { makeInitialState } from "./markets";
import { tickEvents } from "./events";
import { applyEventToMarket, driftForecast } from "./forecast";
import { decide } from "./marketMaker";
import { buildOrderBook } from "./orderBook";
import { applyFill, generateShockFill, markAdverseSelection } from "./fills";
import { stepRegime } from "./microstructure/regimeFsm";
import { flowTick } from "./microstructure/flow";

const MAX_EVENTS = 80;
const MAX_FILLS = 40;

// Hybrid gate: how many ticks of MTA silence before the synthetic engine
// resumes spawning. 40 ticks ≈ 30s at the 750ms tick rate, matching the
// MTA poll cadence.
const HYBRID_QUIET_TICKS = 40;

export function reducer(state: SimState, action: SimAction): SimState {
  switch (action.type) {
    case "TICK":
      return tick(state, action.now);
    case "SELECT":
      if (!state.markets[action.marketId]) return state;
      return { ...state, selectedMarketId: action.marketId };
    case "TOGGLE_PAUSE":
      return { ...state, paused: !state.paused };
    case "RESEED":
      return makeInitialState(Date.now(), state.dataSource);
    case "INJECT_EVENTS":
      return injectEvents(state, action.events);
    case "SET_DATA_SOURCE":
      if (state.dataSource === action.mode) return state;
      return { ...state, dataSource: action.mode, ticksSinceMtaEvent: 0 };
    default:
      return state;
  }
}

function injectEvents(state: SimState, incoming: TransitEvent[]): SimState {
  if (incoming.length === 0) return state;

  const newMarkets: SimState["markets"] = { ...state.markets };
  let sawMta = false;
  // Track the largest |impact| any event in this batch placed on each
  // market, so we can step the regime FSM with the right magnitude
  // (a sev-3 INF arriving via injection must still trigger shock).
  const maxImpactByMarket: Record<string, number> = {};

  for (const ev of incoming) {
    if (ev.source === "mta") sawMta = true;
    for (const id of state.marketOrder) {
      const delta = ev.impacts[id];
      if (delta === undefined) continue;
      newMarkets[id] = applyEventToMarket(newMarkets[id], ev);
      const mag = Math.abs(delta);
      if (mag > (maxImpactByMarket[id] ?? 0)) {
        maxImpactByMarket[id] = mag;
      }
    }
  }

  // Step regime + refresh derived fields once per inject batch.
  for (const id of state.marketOrder) {
    const m: Market = newMarkets[id];
    const impactMag = maxImpactByMarket[id] ?? 0;
    let updated = m;
    if (impactMag > 0) {
      const forecastAbsDelta = Math.abs(
        (m.forecastProb ?? 0) - (m.prevForecastProb ?? m.forecastProb ?? 0),
      );
      updated = {
        ...m,
        regimeState: stepRegime(m, forecastAbsDelta, impactMag, state.tick),
      };
    }
    const mid = (updated.marketBid + updated.marketAsk) / 2;
    newMarkets[id] = {
      ...updated,
      unrealizedPnl: updated.inventory * (mid - updated.avgCost),
      book: buildOrderBook(updated, state.tick),
    };
  }

  const events = [...incoming, ...state.events].slice(0, MAX_EVENTS);

  return {
    ...state,
    events,
    markets: newMarkets,
    ticksSinceMtaEvent: sawMta ? 0 : state.ticksSinceMtaEvent,
  };
}

function shouldSpawnSynthetic(state: SimState): boolean {
  if (state.dataSource === "synthetic") return true;
  if (state.dataSource === "mta") return false;
  // hybrid: spawn only after MTA has been quiet for a while.
  return state.ticksSinceMtaEvent >= HYBRID_QUIET_TICKS;
}

function tick(state: SimState, now: number): SimState {
  if (state.paused) return state;
  let seed = state.rngState;
  const nextTick = state.tick + 1;

  const spawn = shouldSpawnSynthetic(state);

  // Advance regime + maybe spawn an event. In MTA-only mode the regime
  // machinery is fully idle (no tick-down churn). In hybrid we keep
  // ticking so pending CLEARs from prior synthetic sev-3s still fire.
  const evGen =
    state.dataSource === "mta"
      ? { event: null, regime: state.regime, seed }
      : tickEvents(state.regime, seed, now, nextTick, spawn);
  seed = evGen.seed;
  const newEvent = evGen.event;
  const newRegime = evGen.regime;

  const events = newEvent
    ? [newEvent, ...state.events].slice(0, MAX_EVENTS)
    : state.events;

  let newFills = [...state.fills];
  const newMarkets: SimState["markets"] = { ...state.markets };

  for (const id of state.marketOrder) {
    // Snapshot — shock fills execute against the pre-flow resting quote.
    const prev = newMarkets[id];
    let m = prev;

    // 1) Apply event to truth channels (recentImpact / scheduledRisk /
    //    trueProb). forecastProb is NOT bumped here — it catches up via
    //    driftForecast's Kalman step.
    let eventImpactMag = 0;
    if (newEvent && newEvent.impacts[id] !== undefined) {
      eventImpactMag = Math.abs(newEvent.impacts[id]);
      m = applyEventToMarket(m, newEvent);
    }

    // 2) Step per-market regime FSM. Uses last tick's |Δforecast| (the
    //    forecast hasn't drifted yet this tick, so prevForecastProb is
    //    still the previous-tick value).
    const forecastAbsDelta = Math.abs(
      (m.forecastProb ?? 0) - (m.prevForecastProb ?? m.forecastProb ?? 0),
    );
    const nextRegimeState = stepRegime(
      m,
      forecastAbsDelta,
      eventImpactMag,
      nextTick,
    );
    m = { ...m, regimeState: nextRegimeState };

    // 3) Run trader flow against the resting book. Mutates bid/ask via
    //    Kyle impact, emits fills (passive via walk-the-desk, aggressive/
    //    flatten via desk_actor), refreshes flowLog + flowReason, updates
    //    vol and priceHistory. Uses LAST tick's decision posture — decide
    //    runs after flow to update the posture for the next tick.
    const flow = flowTick({
      market: m,
      seed,
      currentTick: nextTick,
      now,
      regime: m.regimeState.regime,
      decision: m.lastAction,
      eventImpactMag,
    });
    m = flow.market;
    seed = flow.seed;
    const tickFills: Fill[] = [...flow.fills];

    // 4) Drift forecast. With new regime in hand, Kalman α widens in
    //    shock to keep up. Updates confidence as a tracking-error EWMA.
    const drift = driftForecast(m, seed);
    m = drift.market;
    seed = drift.seed;

    // 5) Decide posture + quote based on the freshly-drifted forecast
    //    against the freshly-moved synthetic mid.
    const dec = decide(m, now, nextTick);
    m = dec.market;

    // 6) Shock fill check — preserved standalone branch so a sev-3 live
    //    event executes against the stale pre-flow quote.
    const shockGen = generateShockFill({
      prev,
      cur: m,
      action: dec.action,
      event: newEvent,
      now,
      currentTick: nextTick,
      seed,
    });
    seed = shockGen.seed;
    if (shockGen.fill) tickFills.push(shockGen.fill);

    // 7) Apply all fills generated this tick (flow fills first, then
    //    shock). lastFillTick advances only if at least one cleared.
    let hadFill = false;
    for (const fill of tickFills) {
      m = applyFill(m, fill);
      hadFill = true;
      newFills.unshift(fill);
    }
    if (hadFill) m = { ...m, lastFillTick: nextTick };

    // 8) Recompute unrealized PnL against the post-flow mid.
    const midNow = (m.marketBid + m.marketAsk) / 2;
    m = { ...m, unrealizedPnl: m.inventory * (midNow - m.avgCost) };

    // 9) Refresh visible order book — sizes now scale off m.lpDepth.
    m = { ...m, book: buildOrderBook(m, nextTick) };
    newMarkets[id] = m;
  }

  // Adverse-selection sweep: flag passive fills whose mark has moved
  // against the desk over the lookback window.
  newFills = markAdverseSelection(newFills, newMarkets, nextTick);
  const fills = newFills.slice(0, MAX_FILLS);

  return {
    ...state,
    tick: nextTick,
    now,
    rngState: seed,
    events,
    fills,
    regime: newRegime,
    markets: newMarkets,
    ticksSinceMtaEvent: state.ticksSinceMtaEvent + 1,
  };
}
