"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reduceWithShadow } from "@/lib/simulation/reducer";
import { makeInitialState } from "@/lib/simulation/markets";
import { ShadowSimulationRuntime } from "@/lib/simulation/shadowRuntime";
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

  const dispatch = useCallback((action: Parameters<typeof reduceWithShadow>[1]) => {
    const { nextState, shadowTrace } = reduceWithShadow(stateRef.current, action);
    stateRef.current = nextState;
    setState(nextState);

    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (action.type === "RESEED") {
      runtime.initializeFromState(nextState);
      return;
    }
    if (shadowTrace) {
      runtime.replayTick(shadowTrace);
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
