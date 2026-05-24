"use client";

import TopBar from "./TopBar";
import MarketsList from "./MarketsList";
import MarketDetail from "./MarketDetail";
import OrderBook from "./OrderBook";
import ForecastPanel from "./ForecastPanel";
import DecisionPanel from "./DecisionPanel";
import EventTape from "./EventTape";
import PnLPanel from "./PnLPanel";
import { useTrackBookSimulation } from "@/hooks/useTrackBookSimulation";

export default function Terminal() {
  const {
    state,
    marketsArr,
    selected,
    latestEvent,
    selectMarket,
    togglePause,
    reseed,
    setDataSource,
  } = useTrackBookSimulation();

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#050709]">
      <TopBar
        now={state.now}
        tick={state.tick}
        paused={state.paused}
        dataSource={state.dataSource}
        onTogglePause={togglePause}
        onReseed={reseed}
        onSetDataSource={setDataSource}
      />

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
        <div style={{ gridArea: "markets" }} className="min-h-0">
          <MarketsList
            markets={marketsArr}
            selectedId={state.selectedMarketId}
            onSelect={selectMarket}
            now={state.now}
            latestEvent={latestEvent}
          />
        </div>
        <div style={{ gridArea: "detail" }} className="min-h-0">
          <MarketDetail market={selected} now={state.now} />
        </div>
        <div style={{ gridArea: "decision" }} className="min-h-0">
          <DecisionPanel market={selected} fills={state.fills} />
        </div>
        <div style={{ gridArea: "forecast" }} className="min-h-0">
          <ForecastPanel market={selected} now={state.now} />
        </div>
        <div style={{ gridArea: "eventtape" }} className="min-h-0">
          <EventTape events={state.events} markets={state.markets} />
        </div>
        <div style={{ gridArea: "pnl" }} className="min-h-0">
          <PnLPanel state={state} />
        </div>
        <div style={{ gridArea: "orderbook" }} className="min-h-0">
          <OrderBook market={selected} />
        </div>
      </main>
    </div>
  );
}
