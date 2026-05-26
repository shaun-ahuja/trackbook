"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reduceWithShadow } from "@/lib/simulation/reducer";
import { makeInitialState } from "@/lib/simulation/markets";
import { ShadowSimulationRuntime } from "@/lib/simulation/shadowRuntime";
import { WasmMarketAdapter } from "@/lib/simulation/wasmAdapter";
import { MatchingEngineKernel } from "@/lib/wasm/orderBookKernel";
import type { DataSourceMode, Market, TransitEvent } from "@/lib/types";
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
  // Controls.
  selectMarket: (id: string) => void;
  togglePause: () => void;
  reseed: () => void;
  setDataSource: (mode: DataSourceMode) => void;
};

export function useTrackBookSimulation(): UseTrackBookSimulation {
  const [state, setState] = useState(() => makeInitialState(FIXED_EPOCH));
  const stateRef = useRef(state);
  const runtimeRef = useRef<ShadowSimulationRuntime | null>(null);
  const adaptersRef = useRef<Map<string, WasmMarketAdapter> | null>(null);
  const kernelRef = useRef<MatchingEngineKernel | null>(null);

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
      dispatch({ type: "TICK", now: Date.now() });
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

  return {
    state,
    marketsArr,
    selected,
    latestEvent,
    selectMarket,
    togglePause,
    reseed,
    setDataSource,
  };
}
