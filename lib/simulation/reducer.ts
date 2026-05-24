import type { Market, SimAction, SimState, TransitEvent } from "../types";
import { makeInitialState } from "./markets";
import { tickEvents, VOL_SPIKE_MULTIPLIER } from "./events";
import { applyEventToMarket, driftForecast } from "./forecast";
import { decide, moveSyntheticMarket } from "./marketMaker";
import { buildOrderBook } from "./orderBook";
import { applyFill, generateFill, markAdverseSelection } from "./fills";

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

  for (const ev of incoming) {
    if (ev.source === "mta") sawMta = true;
    for (const id of state.marketOrder) {
      if (ev.impacts[id] === undefined) continue;
      newMarkets[id] = applyEventToMarket(newMarkets[id], ev);
    }
    // Rebuild the visible book against the freshly impacted state so the
    // ladder reflects the shock immediately.
  }

  // Refresh order books once per inject batch.
  for (const id of state.marketOrder) {
    const m: Market = newMarkets[id];
    const mid = (m.marketBid + m.marketAsk) / 2;
    newMarkets[id] = {
      ...m,
      unrealizedPnl: m.inventory * (mid - m.avgCost),
      book: buildOrderBook(m, state.tick),
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
  const volMult = newRegime.volSpikeTicksRemaining > 0 ? VOL_SPIKE_MULTIPLIER : 1;

  const events = newEvent
    ? [newEvent, ...state.events].slice(0, MAX_EVENTS)
    : state.events;

  let newFills = [...state.fills];
  const newMarkets: SimState["markets"] = { ...state.markets };

  for (const id of state.marketOrder) {
    // Snapshot — shock fills execute against the pre-shock resting quote.
    const prev = newMarkets[id];
    let m = prev;

    if (newEvent && newEvent.impacts[id] !== undefined) {
      m = applyEventToMarket(m, newEvent);
    }

    const drift = driftForecast(m, seed);
    m = drift.market;
    seed = drift.seed;

    const moved = moveSyntheticMarket(m, seed, volMult);
    m = moved.market;
    seed = moved.seed;

    const dec = decide(m, now, nextTick);
    m = dec.market;

    const fillGen = generateFill({
      prev,
      cur: m,
      action: dec.action,
      event: newEvent,
      now,
      currentTick: nextTick,
      seed,
    });
    seed = fillGen.seed;
    if (fillGen.fill) {
      m = applyFill(m, fillGen.fill);
      m = { ...m, lastFillTick: nextTick };
      newFills.unshift(fillGen.fill);
    }

    // Recompute unrealized PnL after any fill + price move this tick.
    const midNow = (m.marketBid + m.marketAsk) / 2;
    m = { ...m, unrealizedPnl: m.inventory * (midNow - m.avgCost) };

    m = { ...m, book: buildOrderBook(m, nextTick) };
    newMarkets[id] = m;
  }

  // Adverse-selection sweep: flag passive fills whose mark has moved against
  // the desk over the lookback window.
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
