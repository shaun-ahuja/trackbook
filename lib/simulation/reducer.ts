import type { Fill, Market, SimAction, SimState, TransitEvent } from "../types";
import { makeInitialState } from "./markets";
import { tickEvents } from "./events";
import { applyEventToMarket, driftForecast } from "./forecast";
import { decide } from "./marketMaker";
import { applyFill, markAdverseSelection } from "./fills";
import { stepRegime } from "./microstructure/regimeFsm";
import { flowTick } from "./microstructure/flow";
import {
  ageAndCancel,
  deskAggressiveCross,
  divergenceMagnet,
  replenishIfThin,
  shockSweep,
  syncDeskQuote,
} from "./bookReducer";
import { projectVisibleBook, safeBookState } from "./orderBookState";
import { divergenceContext } from "./orderFlow";

const MAX_EVENTS = 80;
const MAX_FILLS = 40;

// Hybrid gate: how many ticks of MTA silence before the synthetic engine
// resumes spawning. 40 ticks ≈ 30s at the 750ms tick rate, matching the
// MTA poll cadence.
const HYBRID_QUIET_TICKS = 40;

// Magnitude threshold below which a sev-3 impact still doesn't fire a
// shock sweep — matches the prior generateShockFill SHOCK_MIN_IMPACT.
const SHOCK_MIN_IMPACT = 0.06;

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
      book: projectVisibleBook(safeBookState(updated.bookState)),
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
  return state.ticksSinceMtaEvent >= HYBRID_QUIET_TICKS;
}

function tick(state: SimState, now: number): SimState {
  if (state.paused) return state;
  let seed = state.rngState;
  const nextTick = state.tick + 1;

  const spawn = shouldSpawnSynthetic(state);

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
    let m = newMarkets[id];

    // 1) Apply event to truth channels.
    let eventImpactMag = 0;
    if (newEvent && newEvent.impacts[id] !== undefined) {
      eventImpactMag = Math.abs(newEvent.impacts[id]);
      m = applyEventToMarket(m, newEvent);
    }

    // 2) Step per-market regime FSM.
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
    const regime = nextRegimeState.regime;

    // 2.5) Compute fair-value divergence snapshot. Stays fixed for the
    //      rest of the tick — magnet uses what the user is currently
    //      seeing, not an updated mid that moves mid-tick.
    const midSnapshot = (m.marketBid + m.marketAsk) / 2;
    const divCtx = divergenceContext(m.fairValueCents, midSnapshot);

    // 3) Age + soft-cancel non-desk resting orders. Wrong-side liquidity
    //    cancels faster when the magnet is engaged.
    const aged = ageAndCancel(safeBookState(m.bookState), regime, nextTick, seed, divCtx);
    seed = aged.seed;
    m = { ...m, bookState: aged.book };

    // 4) Sync desk's resting quote to last tick's decision. This inserts
    //    desk orders at the prior ourBid/ourAsk — shock sweeps later in
    //    the tick hit these "stale" prices, preserving the got-run-over
    //    feel of the prior implementation.
    const synced = syncDeskQuote(m.bookState, m.ourBid, m.ourAsk, nextTick, regime);
    m = { ...m, bookState: synced.book };

    // 5) External arrivals — applies Poisson-sampled archetype intents
    //    against the book. Updates marketBid/marketAsk/vol/priceHistory
    //    from the post-flow book top.
    const flow = flowTick({
      market: m,
      seed,
      currentTick: nextTick,
      now,
      regime,
      eventImpactMag,
      divCtx,
    });
    m = flow.market;
    seed = flow.seed;
    const tickFills: Fill[] = [...flow.fills];

    // 6) Desk's own aggressive cross — fires once per tick on LIFT/HIT/
    //    FLATTEN postures, gated by cooldown. Uses LAST tick's posture
    //    (decide hasn't run yet); next tick's decide will confirm.
    const ticksSinceFill = nextTick - m.lastFillTick;
    const cross = deskAggressiveCross({
      book: m.bookState,
      posture: m.lastAction,
      inventory: m.inventory,
      ticksSinceFill,
      currentTick: nextTick,
      marketId: m.id,
      fairCents: m.fairValueCents,
      now,
    });
    if (cross.flowEvent) {
      m = {
        ...m,
        bookState: cross.book,
        flowLog: [cross.flowEvent, ...(m.flowLog ?? [])].slice(0, 8),
      };
      tickFills.push(...cross.fills);
    }

    // 7) Drift forecast.
    const drift = driftForecast(m, seed);
    m = drift.market;
    seed = drift.seed;

    // 8) Decide posture + quote for next tick. ourBid/ourAsk set here
    //    are consumed by next tick's syncDeskQuote.
    const dec = decide(m, now, nextTick);
    m = dec.market;

    // 8.5) Fair-value magnet. Runs AFTER decide so this tick's posture
    //      isn't whipsawed by the magnet's prints — the magnet's effect
    //      shows up in next tick's mid (and therefore next tick's decide
    //      edge). divCtx is the snapshot from the start of this tick.
    if (divCtx.mode !== "none") {
      const mag = divergenceMagnet({
        book: m.bookState,
        divergenceCents: divCtx.divergenceCents,
        mode: divCtx.mode,
        currentTick: nextTick,
        marketId: m.id,
        fairCents: m.fairValueCents,
        now,
        seed,
      });
      seed = mag.seed;
      if (mag.fired) {
        m = {
          ...m,
          bookState: mag.book,
          flowLog: [...mag.flowEvents, ...(m.flowLog ?? [])].slice(0, 8),
        };
        tickFills.push(...mag.fills);
      }
    }

    // 9) Shock sweep — sev-3 live event runs an external sweep against
    //    the current book, taking out the desk's resting orders that
    //    syncDeskQuote inserted from last tick's prices.
    if (
      newEvent &&
      newEvent.severity === 3 &&
      (newEvent.category ?? "live") === "live" &&
      newEvent.impacts[id] !== undefined &&
      dec.action !== "FLATTEN"
    ) {
      const impact = newEvent.impacts[id];
      if (Math.abs(impact) >= SHOCK_MIN_IMPACT) {
        const sweep = shockSweep({
          book: m.bookState,
          impactSign: impact > 0 ? 1 : -1,
          qty: 2,
          currentTick: nextTick,
          marketId: m.id,
          fairCents: m.fairValueCents,
          now,
        });
        m = { ...m, bookState: sweep.book };
        tickFills.push(...sweep.fills);
      }
    }

    // 10) Apply all desk fills generated this tick.
    let hadFill = false;
    for (const fill of tickFills) {
      m = applyFill(m, fill);
      hadFill = true;
      newFills.unshift(fill);
    }
    if (hadFill) m = { ...m, lastFillTick: nextTick };

    // 11) Recompute unrealized PnL against the post-flow mid.
    const midNow = (m.marketBid + m.marketAsk) / 2;
    m = { ...m, unrealizedPnl: m.inventory * (midNow - m.avgCost) };

    // 12) Replenish if the visible spread blew out or a side ran thin.
    //     Keeps the ladder populated after shock-driven cancels. When
    //     magnet is engaged, magnet-side LPs post toward fair instead
    //     of one tick inside.
    const repl = replenishIfThin(m.bookState, m.fairValueCents, regime, nextTick, seed, divCtx);
    seed = repl.seed;
    m = { ...m, bookState: repl.book };

    // 13) Project visible book for the UI.
    m = { ...m, book: projectVisibleBook(m.bookState) };

    newMarkets[id] = m;
  }

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
