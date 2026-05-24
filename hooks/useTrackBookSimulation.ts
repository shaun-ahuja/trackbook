"use client";

import { useCallback, useEffect, useMemo, useReducer } from "react";
import { reducer } from "@/lib/simulation/reducer";
import { makeInitialState } from "@/lib/simulation/markets";
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
  const [state, dispatch] = useReducer(reducer, FIXED_EPOCH, makeInitialState);

  useEffect(() => {
    if (state.paused) return;
    const id = setInterval(() => {
      dispatch({ type: "TICK", now: Date.now() });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [state.paused]);

  const onMtaEvents = useCallback((events: TransitEvent[]) => {
    if (events.length === 0) return;
    dispatch({ type: "INJECT_EVENTS", events });
  }, []);

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
    [],
  );
  const togglePause = useCallback(
    () => dispatch({ type: "TOGGLE_PAUSE" }),
    [],
  );
  const reseed = useCallback(() => dispatch({ type: "RESEED" }), []);
  const setDataSource = useCallback(
    (mode: DataSourceMode) => dispatch({ type: "SET_DATA_SOURCE", mode }),
    [],
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
