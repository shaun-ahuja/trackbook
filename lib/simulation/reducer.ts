import type { Fill, Market, SimAction, SimState, TransitEvent } from "../types";
import type { OrderBook } from "../types";
import { makeInitialState } from "./markets";
import { tickEvents } from "./events";
import { driftForecast } from "./forecast";
import {
  applyEventShock,
  computeContagion,
  computeNetworkStress,
  updateMarketState,
  validateDynamicsState,
} from "./probabilityDynamics";
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
import { WasmMarketAdapter } from "./wasmAdapter";
import { ticksToCents } from "../wasm/orderBookKernelTypes";
import { divergenceContext } from "./orderFlow";
import {
  bookStateTraceSignature,
  captureExpectedBook,
  normalizeExpectedFills,
  type ShadowCommand,
  type ShadowMarketTrace,
  type ShadowPhaseVisit,
  type ShadowStepLabel,
  type ShadowTickTrace,
  type ShadowTraceStep,
} from "./shadowTrace";

const MAX_EVENTS = 80;
const MAX_FILLS = 40;

// Hybrid gate: how many ticks of MTA silence before the synthetic engine
// resumes spawning. 40 ticks ≈ 30s at the 750ms tick rate, matching the
// MTA poll cadence.
const HYBRID_QUIET_TICKS = 40;

// Magnitude threshold below which a sev-3 impact still doesn't fire a
// shock sweep — matches the prior generateShockFill SHOCK_MIN_IMPACT.
const SHOCK_MIN_IMPACT = 0.06;

// Set NEXT_PUBLIC_DEBUG_DEMO=1 in .env.local to enable per-tick QA traces
// for the selected market in the browser console.
const DEBUG_DEMO = process.env.NEXT_PUBLIC_DEBUG_DEMO === "1";

export function reducer(state: SimState, action: SimAction): SimState {
  return reduceWithShadow(state, action).nextState;
}

export function reduceWithShadow(
  state: SimState,
  action: SimAction,
  adapters?: Map<string, WasmMarketAdapter>,
): {
  nextState: SimState;
  shadowTrace: ShadowTickTrace | null;
} {
  switch (action.type) {
    case "TICK":
      return tick(state, action.now, adapters);
    case "SELECT":
      if (!state.markets[action.marketId]) return { nextState: state, shadowTrace: null };
      return { nextState: { ...state, selectedMarketId: action.marketId }, shadowTrace: null };
    case "TOGGLE_PAUSE":
      return { nextState: { ...state, paused: !state.paused }, shadowTrace: null };
    case "RESEED":
      return { nextState: makeInitialState(Date.now(), state.dataSource), shadowTrace: null };
    case "INJECT_EVENTS":
      return { nextState: injectEvents(state, action.events), shadowTrace: null };
    case "SET_DATA_SOURCE":
      if (state.dataSource === action.mode) return { nextState: state, shadowTrace: null };
      return {
        nextState: { ...state, dataSource: action.mode, ticksSinceMtaEvent: 0 },
        shadowTrace: null,
      };
    case "APPLY_SCENARIO":
      return { nextState: applyScenario(state, action.patch), shadowTrace: null };
    default:
      return { nextState: state, shadowTrace: null };
  }
}

function pushShadowStep(
  steps: ShadowTraceStep[],
  phaseVisits: ShadowPhaseVisit[],
  label: ShadowStepLabel,
  commands: ShadowCommand[],
  beforeBookState: Market["bookState"],
  bookState: Market["bookState"],
  fills: Fill[],
  accounting?: {
    inventory: number;
    avgCost: number;
    realizedPnl: number;
  },
) {
  const traceEmitted = commands.length > 0 || fills.length > 0 || Boolean(accounting);
  const phaseIndex = phaseVisits.length;
  const stepIndex = steps.length;
  phaseVisits.push({
    label,
    phaseIndex,
    stepIndex: traceEmitted ? stepIndex : null,
    bookChanged:
      bookStateTraceSignature(beforeBookState) !== bookStateTraceSignature(bookState),
    commandCount: commands.length,
    fillCount: fills.length,
    accountingIncluded: Boolean(accounting),
    traceEmitted,
  });
  if (!traceEmitted) return;
  steps.push({
    label,
    phaseIndex,
    stepIndex,
    commands,
    expectedBook: captureExpectedBook(bookState),
    expectedFills: normalizeExpectedFills(fills),
    expectedAccounting: accounting,
  });
}

function applyScenario(state: SimState, patch: import("../types").ScenarioPatch): SimState {
  const marketId = patch.marketId ?? state.selectedMarketId;
  const m = state.markets[marketId];
  if (!m) return state;

  const mid = (m.marketBid + m.marketAsk) / 2;

  // Compute new edge after applying forecastProb patch (used to reset evidenceDelta).
  const newForecastProb = patch.forecastProb ?? m.forecastProb;
  const newConf = patch.confidence ?? m.confidence;
  const newFair = newForecastProb * 100;
  const newEdge = newFair - mid;

  // Build a single dynamics patch combining all scenario fields. The forecastProb
  // alignment MUST be merged with the vol update in one spread — two separate
  // `dynamics: { ...m.dynamics, ... }` spreads would have the later one win,
  // silently dropping the earlier changes.
  const dynamicsPatch: Partial<typeof m.dynamics> = {};
  if (patch.forecastProb !== undefined) {
    // Align the dynamics baseline to the patched forecast so the simulator
    // doesn't mean-revert forecastProb back to the old market-equilibrium
    // during rollouts. Without this, adaptiveBase stays at ~market-mid while
    // forecastProb is patched higher, creating a systematic pull in every
    // rollout step that overwhelms the P&L signal.
    dynamicsPatch.adaptiveBaseProbability = patch.forecastProb;
    dynamicsPatch.longRunBaseProbability = patch.forecastProb;
    dynamicsPatch.lastLatentTrueProbability = patch.forecastProb;
    dynamicsPatch.prevLatentTrueProbability = patch.forecastProb;
  }
  if (patch.vol !== undefined) {
    dynamicsPatch.volatilityEstimate = patch.vol;
  }
  const hasDynamicsPatch = patch.forecastProb !== undefined || patch.vol !== undefined;

  const patchedMarket: Market = {
    ...m,
    ...(patch.inventory !== undefined
      ? {
          inventory: patch.inventory,
          // Reset avgCost to mid so unrealizedPnl starts at 0 rather than a
          // stale value computed from the old fill price.
          avgCost: patch.inventory !== 0 ? mid : 0,
          unrealizedPnl: 0,
        }
      : {}),
    ...(patch.regime !== undefined
      ? {
          regimeState: {
            ...m.regimeState,
            regime: patch.regime,
            enteredTick: state.tick,
            ticksSinceEvent: 0,
            ticksSinceShock: patch.regime === "shock" ? 0 : m.regimeState.ticksSinceShock,
          },
        }
      : {}),
    ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
    ...(patch.forecastProb !== undefined
      ? {
          forecastProb: patch.forecastProb,
          fairValueCents: Math.round(patch.forecastProb * 1000) / 10,
        }
      : {}),
    ...(patch.vol !== undefined ? { vol: patch.vol } : {}),
    ...(hasDynamicsPatch ? { dynamics: { ...m.dynamics, ...dynamicsPatch } } : {}),
    // Reset hysteresis evidence baseline so the patched scenario starts with a
    // clean lock. Without this, a stale lastEdgeAtFlip from before the patch
    // (e.g. edge=20¢) causes evidenceDelta >> EVIDENCE_DELTA_THRESHOLD and the
    // market maker immediately overrides forced rollout actions.
    lastEdgeAtFlip: newEdge,
    lastConfAtFlip: newConf,
    lastDecisionTick: state.tick,
  };

  return {
    ...state,
    ...(patch.rngState !== undefined ? { rngState: patch.rngState } : {}),
    markets: { ...state.markets, [marketId]: patchedMarket },
  };
}

function injectEvents(state: SimState, incoming: TransitEvent[]): SimState {
  if (incoming.length === 0) return state;

  const newMarkets: SimState["markets"] = { ...state.markets };
  let sawMta = false;
  const maxImpactByMarket: Record<string, number> = {};
  const touched = new Set<string>();

  for (const ev of incoming) {
    if (ev.source === "mta") sawMta = true;
    for (const id of state.marketOrder) {
      const delta = ev.impacts[id];
      if (delta === undefined) continue;
      newMarkets[id] = applyEventShock(newMarkets[id], ev, state.tick);
      touched.add(id);
      const mag = Math.abs(delta);
      if (mag > (maxImpactByMarket[id] ?? 0)) {
        maxImpactByMarket[id] = mag;
      }
    }
  }

  // Refresh regime + latent truth for touched markets so subscribers see
  // the new state immediately rather than waiting for the next tick.
  const stress = computeNetworkStress(state.now);
  const contagion = computeContagion(newMarkets, state.marketOrder, state.tick);

  for (const id of touched) {
    const m: Market = newMarkets[id];
    const impactMag = maxImpactByMarket[id] ?? 0;
    const forecastAbsDelta = Math.abs(
      (m.forecastProb ?? 0) - (m.prevForecastProb ?? m.forecastProb ?? 0),
    );
    const nextRegime = stepRegime(m, forecastAbsDelta, impactMag, state.tick);
    const withRegime: Market = { ...m, regimeState: nextRegime };
    const updated = updateMarketState(
      withRegime,
      nextRegime.regime,
      contagion[id] ?? 0,
      stress,
      state.tick,
    );
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

function tick(
  state: SimState,
  now: number,
  adapters?: Map<string, WasmMarketAdapter>,
): { nextState: SimState; shadowTrace: ShadowTickTrace | null } {
  if (state.paused) return { nextState: state, shadowTrace: null };
  let seed = state.rngState;
  const nextTick = state.tick + 1;

  const spawn = shouldSpawnSynthetic(state);

  // Compute network stress + cross-market contagion ONCE per tick, before
  // the event generator and per-market loop. Both use the state at tick
  // start — they are order-independent across markets.
  const stress = computeNetworkStress(now);
  const contagion = computeContagion(state.markets, state.marketOrder, nextTick);

  const evGen =
    state.dataSource === "mta"
      ? { event: null, regime: state.regime, seed }
      : tickEvents(state.regime, state, stress, seed, now, nextTick, spawn);
  seed = evGen.seed;
  const newEvent = evGen.event;
  const newRegime = evGen.regime;

  const events = newEvent
    ? [newEvent, ...state.events].slice(0, MAX_EVENTS)
    : state.events;

  let newFills = [...state.fills];
  const newMarkets: SimState["markets"] = { ...state.markets };
  const shadowMarkets: ShadowMarketTrace[] = [];

  for (const id of state.marketOrder) {
    let m = newMarkets[id];
    const adapter = adapters?.get(id);
    if (adapter) {
      adapter.beginTick({
        now,
        currentTick: nextTick,
        marketId: id,
        markFair: m.fairValueCents,
      });
    }
    const shadowSteps: ShadowTraceStep[] = [];
    const phaseVisits: ShadowPhaseVisit[] = [];

    // 1) Apply event shock — appends to ShockMemory; no direct probability mutation.
    let eventImpactMag = 0;
    if (newEvent && newEvent.impacts[id] !== undefined) {
      eventImpactMag = Math.abs(newEvent.impacts[id]);
      m = applyEventShock(m, newEvent, nextTick);
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

    // 2.5) Adaptive probability dynamics — decays shock memory, drifts
    //      adaptiveBase, recomputes latentTrueProbability + drivers + vol.
    m = updateMarketState(m, regime, contagion[id] ?? 0, stress, nextTick);
    const latentTrueProb = m.dynamics.lastLatentTrueProbability;

    // 2.6) Fair-value divergence snapshot. Fixed for the rest of the tick.
    const midSnapshot = (m.marketBid + m.marketAsk) / 2;
    const divCtx = divergenceContext(m.fairValueCents, midSnapshot);

    // 3) Age + soft-cancel non-desk resting orders.
    const bookBeforeAge = m.bookState;
    const aged = ageAndCancel(safeBookState(m.bookState), regime, nextTick, seed, divCtx, adapter);
    seed = aged.seed;
    m = { ...m, bookState: aged.book };
    pushShadowStep(
      shadowSteps,
      phaseVisits,
      "age_cancel",
      [
        ...aged.expiredOrderIds.map((tsOrderId) => ({ kind: "cancel", tsOrderId }) as const),
        ...aged.softCancelOrderIds.map((tsOrderId) => ({ kind: "cancel", tsOrderId }) as const),
      ],
      bookBeforeAge,
      m.bookState,
      [],
    );

    // 4) Sync desk's resting quote to last tick's decision.
    const bookBeforeSync = m.bookState;
    const synced = syncDeskQuote(m.bookState, m.ourBid, m.ourAsk, nextTick, regime, adapter);
    m = { ...m, bookState: synced.book };
    pushShadowStep(
      shadowSteps,
      phaseVisits,
      "sync_desk",
      [
        ...synced.canceledDeskOrderIds.map((tsOrderId) => ({ kind: "cancel", tsOrderId }) as const),
        ...synced.postedDeskOrders.map((order) => ({
          kind: "submit_limit" as const,
          side: order.side,
          owner: order.owner,
          priceCents: order.priceCents,
          qty: order.size,
          ttlTicks: order.ttlTicks,
          logicalTime: order.postedTick,
          fillKind: "aggressive" as const,
          expectedTsOrderId: order.id,
        })),
      ],
      bookBeforeSync,
      m.bookState,
      [],
    );

    // 5) External arrivals.
    const flow = flowTick({
      market: m,
      seed,
      currentTick: nextTick,
      now,
      regime,
      eventImpactMag,
      divCtx,
      adapter,
    });
    const bookBeforeFlow = m.bookState;
    m = flow.market;
    seed = flow.seed;
    const tickFills: Fill[] = [...flow.fills];
    pushShadowStep(
      shadowSteps,
      phaseVisits,
      "apply_intents",
      flow.shadowTraceCommands ?? [],
      bookBeforeFlow,
      m.bookState,
      flow.fills,
    );

    // 6) Desk's own aggressive cross.
    const bookBeforeCross = m.bookState;
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
      adapter,
    });
    if (cross.flowEvent) {
      m = {
        ...m,
        bookState: cross.book,
        flowLog: [cross.flowEvent, ...(m.flowLog ?? [])].slice(0, 8),
      };
      tickFills.push(...cross.fills);
    }
    pushShadowStep(
      shadowSteps,
      phaseVisits,
      "desk_cross",
      cross.shadowCommand
        ? [{
            kind: "submit_market" as const,
            side: cross.shadowCommand.side,
            owner: "desk",
            qty: cross.shadowCommand.qty,
            logicalTime: cross.shadowCommand.logicalTime,
            fillKind: cross.shadowCommand.fillKind,
          }]
        : [],
      bookBeforeCross,
      m.bookState,
      cross.fills,
    );

    // 7) Drift forecast against the freshly-computed latent truth.
    // isEventShock: meaningful impact on this market this tick — widens the
    // per-tick delta clamp so real dislocations register immediately.
    const isEventShock = eventImpactMag >= SHOCK_MIN_IMPACT;
    const drift = driftForecast(m, latentTrueProb, seed, isEventShock);
    m = drift.market;
    seed = drift.seed;

    // 8) Decide posture + quote for next tick.
    const dec = decide(m, now, nextTick);
    m = dec.market;

    // QA trace for the selected market. Enable with NEXT_PUBLIC_DEBUG_DEMO=1.
    // Throttled to every 5 ticks to avoid console pressure.
    if (DEBUG_DEMO && id === state.selectedMarketId && nextTick % 5 === 0) {
      console.log("[demo-qa]", {
        tick: nextTick, market: id,
        forecastRaw: +latentTrueProb.toFixed(4),
        forecastSmoothed: +m.forecastProb.toFixed(4),
        fairValue: m.fairValueCents,
        syntheticMid: +midSnapshot.toFixed(2),
        actionFinal: dec.action,
        inventory: m.inventory,
        eventShockFlag: isEventShock,
        reason: m.lastActionReason,
      });
    }

    // 8.5) Fair-value magnet.
    if (divCtx.mode !== "none") {
      const bookBeforeMagnet = m.bookState;
      const mag = divergenceMagnet({
        book: m.bookState,
        divergenceCents: divCtx.divergenceCents,
        mode: divCtx.mode,
        currentTick: nextTick,
        marketId: m.id,
        fairCents: m.fairValueCents,
        now,
        seed,
        adapter,
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
      pushShadowStep(
        shadowSteps,
        phaseVisits,
        "divergence_magnet",
        mag.shadowCommands.map((command) => ({
          kind: "submit_market" as const,
          side: command.side,
          owner: command.owner,
          qty: command.qty,
          logicalTime: command.logicalTime,
          fillKind: command.fillKind,
        })),
        bookBeforeMagnet,
        m.bookState,
        mag.fills,
      );
    }

    // 9) Shock sweep — sev-3 live event takes out stale desk quotes.
    if (
      newEvent &&
      newEvent.severity === 3 &&
      (newEvent.category ?? "live") === "live" &&
      newEvent.impacts[id] !== undefined &&
      dec.action !== "FLATTEN"
    ) {
      const impact = newEvent.impacts[id];
      if (Math.abs(impact) >= SHOCK_MIN_IMPACT) {
        const bookBeforeShock = m.bookState;
        const sweep = shockSweep({
          book: m.bookState,
          impactSign: impact > 0 ? 1 : -1,
          qty: 2,
          currentTick: nextTick,
          marketId: m.id,
          fairCents: m.fairValueCents,
          now,
          adapter,
        });
        m = { ...m, bookState: sweep.book };
        tickFills.push(...sweep.fills);
        pushShadowStep(
          shadowSteps,
          phaseVisits,
          "shock_sweep",
          sweep.shadowCommand
            ? [{
                kind: "submit_market" as const,
                side: sweep.shadowCommand.side,
                owner: sweep.shadowCommand.owner,
                qty: sweep.shadowCommand.qty,
                logicalTime: sweep.shadowCommand.logicalTime,
                fillKind: sweep.shadowCommand.fillKind,
              }]
            : [],
          bookBeforeShock,
          m.bookState,
          sweep.fills,
        );
      }
    }

    // 10) Apply all desk fills generated this tick.
    for (const fill of tickFills) {
      newFills.unshift(fill);
    }
    if (adapter) {
      // WASM-authoritative accounting: read directly from WASM snapshot.
      const snapshot = adapter.getSnapshot();
      const avgCost = ticksToCents(snapshot.avgCostTicks);
      m = {
        ...m,
        inventory: snapshot.positionQty,
        avgCost,
        realizedPnl: ticksToCents(snapshot.realizedPnlTicks),
        lastFillTick: tickFills.length > 0 ? nextTick : m.lastFillTick,
      };
    } else {
      // TS fallback: apply fills manually.
      let hadFill = false;
      for (const fill of tickFills) {
        m = applyFill(m, fill);
        hadFill = true;
      }
      if (hadFill) m = { ...m, lastFillTick: nextTick };
    }
    pushShadowStep(
      shadowSteps,
      phaseVisits,
      "post_fills",
      [],
      m.bookState,
      m.bookState,
      [],
      {
        inventory: m.inventory,
        avgCost: m.avgCost,
        realizedPnl: m.realizedPnl,
      },
    );

    // 11) Recompute unrealized PnL against the post-flow mid.
    const midNow = (m.marketBid + m.marketAsk) / 2;
    m = { ...m, unrealizedPnl: m.inventory * (midNow - m.avgCost) };

    // 12) Replenish if the visible spread blew out.
    const bookBeforeReplenish = m.bookState;
    const repl = replenishIfThin(m.bookState, m.fairValueCents, regime, nextTick, seed, divCtx, adapter);
    seed = repl.seed;
    m = { ...m, bookState: repl.book };
    pushShadowStep(
      shadowSteps,
      phaseVisits,
      "replenish",
      repl.postedOrders.map((order) => ({
        kind: "submit_limit" as const,
        side: order.side,
        owner: order.owner,
        priceCents: order.priceCents,
        qty: order.size,
        ttlTicks: order.ttlTicks,
        logicalTime: order.postedTick,
        fillKind: "aggressive" as const,
        expectedTsOrderId: order.id,
      })),
      bookBeforeReplenish,
      m.bookState,
      [],
    );

    // 13) Project visible book for the UI.
    if (adapter) {
      const snapshot = adapter.getSnapshot();
      const book: OrderBook = {
        bids: snapshot.bidLevels.map((l) => ({
          price: ticksToCents(l.priceTicks),
          size: l.qty,
          isOurs: l.hasDesk || undefined,
        })),
        asks: snapshot.askLevels.map((l) => ({
          price: ticksToCents(l.priceTicks),
          size: l.qty,
          isOurs: l.hasDesk || undefined,
        })),
      };
      m = { ...m, book };
    } else {
      m = { ...m, book: projectVisibleBook(m.bookState) };
    }

    newMarkets[id] = m;
    shadowMarkets.push({
      marketId: id,
      marketIndex: shadowMarkets.length,
      tick: nextTick,
      phaseVisits,
      steps: shadowSteps,
    });
  }

  newFills = markAdverseSelection(newFills, newMarkets, nextTick);
  const fills = newFills.slice(0, MAX_FILLS);

  if (process.env.NODE_ENV !== "production") {
    for (const id of state.marketOrder) {
      const issues = validateDynamicsState(newMarkets[id], nextTick);
      if (issues.length > 0) {
        console.error(`[dynamics] market=${id} tick=${nextTick}:`, issues);
      }
    }
  }

  return {
    nextState: {
      ...state,
      tick: nextTick,
      now,
      rngState: seed,
      events,
      fills,
      regime: newRegime,
      markets: newMarkets,
      ticksSinceMtaEvent: state.ticksSinceMtaEvent + 1,
    },
    shadowTrace: {
      kind: "tick",
      tick: nextTick,
      now,
      markets: shadowMarkets,
    },
  };
}
