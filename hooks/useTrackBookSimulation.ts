"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reduceWithShadow } from "@/lib/simulation/reducer";
import { makeInitialState } from "@/lib/simulation/markets";
import { ShadowSimulationRuntime } from "@/lib/simulation/shadowRuntime";
import { WasmMarketAdapter } from "@/lib/simulation/wasmAdapter";
import { MatchingEngineKernel } from "@/lib/wasm/orderBookKernel";
import { INVENTORY_LIMIT } from "@/lib/types";
import type { DataSourceMode, Market, OptimizerDecision, TransitEvent } from "@/lib/types";
import { fetchOptimizerDecision } from "@/lib/optimizer";
import { DEMO_SCENARIOS, type ScenarioName } from "@/lib/simulation/scenarios";
import { useMtaAlerts } from "@/hooks/useMtaAlerts";
import { useMtaTrips } from "@/hooks/useMtaTrips";

const TICK_MS = 750;
const FIXED_EPOCH = 1735660800000;

export type UseTrackBookSimulation = {
  // Raw state — components that need the full picture (PnL totals) read this.
  state: ReturnType<typeof makeInitialState>;
  // Convenience selectors so panels don't recompute on every render.
  marketsArr: Market[];
  selected: Market;
  latestEvent: TransitEvent | undefined;
  // Julia / JuMP optimizer decision — null when unavailable or computing.
  optimizerDecision: OptimizerDecision | null;
  // Active demo scenario name, or null for live mode.
  activeScenario: ScenarioName | null;
  // Controls.
  selectMarket: (id: string) => void;
  togglePause: () => void;
  reseed: () => void;
  setDataSource: (mode: DataSourceMode) => void;
  // Injects a deterministic scenario patch and immediately fires the optimizer.
  // Pass null to clear the scenario (does not auto-resume — call togglePause to resume).
  applyScenario: (name: ScenarioName | null) => void;
};

export function useTrackBookSimulation(): UseTrackBookSimulation {
  const [state, setState] = useState(() => makeInitialState(FIXED_EPOCH));
  const [optimizerDecision, setOptimizerDecision] = useState<OptimizerDecision | null>(null);
  const [activeScenario, setActiveScenario] = useState<ScenarioName | null>(null);
  const stateRef = useRef(state);
  const runtimeRef = useRef<ShadowSimulationRuntime | null>(null);
  const adaptersRef = useRef<Map<string, WasmMarketAdapter> | null>(null);
  const kernelRef = useRef<MatchingEngineKernel | null>(null);
  // Track in-flight optimizer requests to avoid stale updates
  const optimizerTickRef = useRef<number>(0);
  // Wall time of the last tick dispatch — used to skip catch-up bursts when
  // the browser falls behind (tab backgrounded, heavy render, etc.).
  const lastTickWallRef = useRef<number>(0);
  // Last action returned by fetchOptimizerDecision; passed back as inertia anchor.
  const lastOptimizerActionRef = useRef<string>("");

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!ShadowSimulationRuntime.enabled()) return;
    let cancelled = false;
    void ShadowSimulationRuntime.create()
      .then((runtime) => {
        if (cancelled) return;
        runtime.initializeFromState(stateRef.current);
        runtimeRef.current = runtime;
      })
      .catch((error) => {
        console.error("[shadow] failed to initialize runtime", error);
      });
    return () => {
      cancelled = true;
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void MatchingEngineKernel.create()
      .then((kernel) => {
        if (cancelled) return;
        kernelRef.current = kernel;
        const adapterMap = new Map<string, WasmMarketAdapter>();
        const initial = stateRef.current;
        for (const id of initial.marketOrder) {
          const market = initial.markets[id];
          if (!market) continue;
          const handle = kernel.createEngine();
          const adapter = new WasmMarketAdapter(kernel, handle);
          adapter.seed(market.bookState);
          adapterMap.set(id, adapter);
        }
        adaptersRef.current = adapterMap;
      })
      .catch((error) => {
        console.error("[wasm-adapter] failed to initialize", error);
      });
    return () => {
      cancelled = true;
      adaptersRef.current = null;
    };
  }, []);

  const dispatch = useCallback((action: Parameters<typeof reduceWithShadow>[1]) => {
    const adapters = adaptersRef.current ?? undefined;
    const { nextState, shadowTrace } = reduceWithShadow(stateRef.current, action, adapters);
    stateRef.current = nextState;
    setState(nextState);

    // Fire async optimizer request after each tick. Non-blocking — the
    // previous tick's decision stays displayed until the new one arrives.
    if (action.type === "TICK") {
      const marketId = nextState.selectedMarketId;
      const thisTick = nextState.tick;
      optimizerTickRef.current = thisTick;
      const prevFirstAction = lastOptimizerActionRef.current;
      const mkt = nextState.markets[marketId];
      const isShock = mkt?.regimeState?.regime === "shock";
      const hardInvBreach = Math.abs(mkt?.inventory ?? 0) >= INVENTORY_LIMIT - 1;
      const invRiskRatio = Math.abs(mkt?.inventory ?? 0) / INVENTORY_LIMIT;
      void fetchOptimizerDecision(nextState, marketId, prevFirstAction, isShock, hardInvBreach, invRiskRatio).then((result) => {
        // Discard stale results if a newer tick has already fired
        if (result && optimizerTickRef.current === thisTick) {
          lastOptimizerActionRef.current = result.selectedFirstAction;
          setOptimizerDecision({ ...result, computedAtTick: thisTick });
        }
      });
    }

    if (action.type === "RESEED") {
      const kernel = kernelRef.current;
      if (kernel && adaptersRef.current) {
        for (const adapter of adaptersRef.current.values()) {
          adapter.destroy();
        }
        const newAdapters = new Map<string, WasmMarketAdapter>();
        for (const id of nextState.marketOrder) {
          const market = nextState.markets[id];
          if (!market) continue;
          const handle = kernel.createEngine();
          const adapter = new WasmMarketAdapter(kernel, handle);
          adapter.seed(market.bookState);
          newAdapters.set(id, adapter);
        }
        adaptersRef.current = newAdapters;
      }
      runtimeRef.current?.initializeFromState(nextState);
      return;
    }

    if (shadowTrace) {
      runtimeRef.current?.replayTick(shadowTrace);
    }
  }, []);

  useEffect(() => {
    if (state.paused) return;
    const id = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastTickWallRef.current;
      // Catch-up guard: skip if the interval fired too soon after the last tick
      // (browser stall / tab resume burst).
      if (elapsed < TICK_MS * 0.75) return;
      // Drift correction: advance the expected-tick baseline by exactly one
      // period so small jitter averages out. If very late (>2× period), reset
      // to now so we don't accumulate a debt of missed ticks.
      lastTickWallRef.current = elapsed > TICK_MS * 2 ? now : lastTickWallRef.current + TICK_MS;
      dispatch({ type: "TICK", now });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [dispatch, state.paused]);

  const onMtaEvents = useCallback((events: TransitEvent[]) => {
    if (events.length === 0) return;
    dispatch({ type: "INJECT_EVENTS", events });
  }, [dispatch]);

  useMtaAlerts({
    enabled: !state.paused,
    mode: state.dataSource,
    onEvents: onMtaEvents,
  });

  useMtaTrips({
    enabled: !state.paused,
    mode: state.dataSource,
    onEvents: onMtaEvents,
  });

  const marketsArr = useMemo(
    () => state.marketOrder.map((id) => state.markets[id]),
    [state.markets, state.marketOrder],
  );

  const selected = state.markets[state.selectedMarketId];
  const latestEvent = state.events[0];

  const selectMarket = useCallback(
    (id: string) => dispatch({ type: "SELECT", marketId: id }),
    [dispatch],
  );
  const togglePause = useCallback(
    () => dispatch({ type: "TOGGLE_PAUSE" }),
    [dispatch],
  );
  const reseed = useCallback(() => dispatch({ type: "RESEED" }), [dispatch]);
  const setDataSource = useCallback(
    (mode: DataSourceMode) => dispatch({ type: "SET_DATA_SOURCE", mode }),
    [dispatch],
  );

  const applyScenario = useCallback(
    (name: ScenarioName | null) => {
      setActiveScenario(name);
      if (name === null) return;

      const { patch } = DEMO_SCENARIOS[name];
      const marketId = stateRef.current.selectedMarketId;

      // Pause the simulation so the next tick doesn't overwrite the patch
      // before the optimizer fires. User can un-pause after reviewing results.
      if (!stateRef.current.paused) {
        dispatch({ type: "TOGGLE_PAUSE" });
      }

      dispatch({ type: "APPLY_SCENARIO", patch: { ...patch, marketId } });

      // Fire the optimizer immediately with the patched state (stateRef.current
      // is already updated synchronously by dispatch).
      // Reset inertia anchor — scenario is an intentional state jump, bypass penalty.
      lastOptimizerActionRef.current = "";
      const thisTick = stateRef.current.tick;
      optimizerTickRef.current = thisTick;
      void fetchOptimizerDecision(stateRef.current, marketId, "", true, false, 0).then((result) => {
        if (result) {
          lastOptimizerActionRef.current = result.selectedFirstAction;
          setOptimizerDecision({ ...result, computedAtTick: thisTick });
        }
      });
    },
    [dispatch],
  );

  return {
    state,
    marketsArr,
    selected,
    latestEvent,
    optimizerDecision,
    activeScenario,
    selectMarket,
    togglePause,
    reseed,
    setDataSource,
    applyScenario,
  };
}
