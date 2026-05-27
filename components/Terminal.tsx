"use client";

import { useEffect, useMemo } from "react";
import TopBar from "./TopBar";
import MarketsList from "./MarketsList";
import MarketDetail from "./MarketDetail";
import OrderBook from "./OrderBook";
import ForecastPanel from "./ForecastPanel";
import DecisionPanel from "./DecisionPanel";
import EventTape from "./EventTape";
import PnLPanel from "./PnLPanel";
import ScenarioBar from "./ScenarioBar";
import { useTrackBookSimulation } from "@/hooks/useTrackBookSimulation";
import { useTerminalView } from "@/hooks/useTerminalView";
import { visibleEvents, visiblePositionMarkets } from "@/lib/view";
import { useHelp } from "@/contexts/HelpContext";

export default function Terminal() {
  const {
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
  } = useTrackBookSimulation();

  const {
    focusedMarketId,
    watchlistIds,
    viewMode,
    activeIds,
    handleMarketClick,
    toggleWatch,
    exitView,
  } = useTerminalView({
    currentSelectedId: state.selectedMarketId,
    onSelectMarket: selectMarket,
  });

  const { tourActive, introOpen } = useHelp();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // IntroModal and TourOverlay own Escape when active
        if (introOpen || tourActive) return;
        exitView();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exitView, introOpen, tourActive]);

  const filteredEvents = useMemo(
    () => visibleEvents(state.events, viewMode, activeIds),
    [state.events, viewMode, activeIds],
  );
  const positionMarkets = useMemo(
    () => visiblePositionMarkets(state, viewMode, activeIds),
    [state, viewMode, activeIds],
  );

  const focusLabel =
    viewMode === "focus" && focusedMarketId
      ? (state.markets[focusedMarketId]?.lineLabel ?? null)
      : null;
  const tapeScope =
    viewMode === "focus" && focusLabel
      ? `focus · ${focusLabel}`
      : viewMode === "watchlist"
        ? `watchlist · ${watchlistIds.length}`
        : undefined;
  const pnlScope =
    viewMode === "watchlist" ? `watchlist · ${watchlistIds.length}` : undefined;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#050709]">
      <div data-tour-id="controls">
        <TopBar
          tick={state.tick}
          paused={state.paused}
          dataSource={state.dataSource}
          onTogglePause={togglePause}
          onReseed={reseed}
          onSetDataSource={setDataSource}
          viewMode={viewMode}
          focusLabel={focusLabel}
          watchlistCount={watchlistIds.length}
          onExitView={exitView}
        />
        <ScenarioBar active={activeScenario} onApply={applyScenario} />
      </div>

      <main
        className="grid min-h-0 flex-1 gap-1.5 p-1.5"
        style={{
          gridTemplateColumns: "224px minmax(0,1fr) 360px",
          gridTemplateRows: "minmax(280px, 1.05fr) minmax(220px, 0.9fr) minmax(180px, 0.85fr)",
          gridTemplateAreas: `
            "markets detail   decision"
            "markets forecast decision"
            "pnl     eventtape orderbook"
          `,
        }}
      >
        <div data-tour-id="markets" style={{ gridArea: "markets" }} className="min-h-0">
          <MarketsList
            markets={marketsArr}
            selectedId={state.selectedMarketId}
            onSelect={handleMarketClick}
            onToggleWatch={toggleWatch}
            now={state.now}
            latestEvent={latestEvent}
            watchlistIds={watchlistIds}
          />
        </div>
        <div data-tour-id="detail" style={{ gridArea: "detail" }} className="min-h-0">
          <MarketDetail market={selected} now={state.now} />
        </div>
        <div data-tour-id="decision" style={{ gridArea: "decision" }} className="min-h-0">
          <DecisionPanel market={selected} fills={state.fills} tick={state.tick} optimizerDecision={optimizerDecision} />
        </div>
        <div data-tour-id="forecast" style={{ gridArea: "forecast" }} className="min-h-0">
          <ForecastPanel market={selected} now={state.now} />
        </div>
        <div data-tour-id="eventtape" style={{ gridArea: "eventtape" }} className="min-h-0">
          <EventTape
            events={filteredEvents}
            markets={state.markets}
            scopeLabel={tapeScope}
          />
        </div>
        <div data-tour-id="pnl" style={{ gridArea: "pnl" }} className="min-h-0">
          <PnLPanel
            state={state}
            positionMarkets={positionMarkets}
            scopeLabel={pnlScope}
          />
        </div>
        <div data-tour-id="orderbook" style={{ gridArea: "orderbook" }} className="min-h-0">
          <OrderBook market={selected} />
        </div>
      </main>
    </div>
  );
}
