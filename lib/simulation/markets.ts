import type { DataSourceMode, Market, SimState } from "../types";
import { emptyBook } from "./orderBook";

export const INITIAL_SEED = 0x1ac7;

type MarketSpec = Pick<
  Market,
  "id" | "line" | "lineLabel" | "lineColor" | "contract" | "expiry" | "baseTrueProb"
>;

const MARKET_SPECS: MarketSpec[] = [
  {
    id: "L_DELAY_10_EVE",
    line: "L",
    lineLabel: "L",
    lineColor: "#A7A9AC",
    contract: ">10min delay 6–9pm",
    expiry: "21:00 ET",
    baseTrueProb: 0.42,
  },
  {
    id: "LEX_MAJOR_PM",
    line: "456",
    lineLabel: "4·5·6",
    lineColor: "#00933C",
    contract: "Any major delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.55,
  },
  {
    id: "ACE_REROUTE_EXT",
    line: "ACE",
    lineLabel: "A·C·E",
    lineColor: "#0039A6",
    contract: "Weekend reroute extended",
    expiry: "23:59 ET",
    baseTrueProb: 0.28,
  },
  {
    id: "7_SIGNAL_AM",
    line: "7",
    lineLabel: "7",
    lineColor: "#B933AD",
    contract: "Signal incident before noon",
    expiry: "12:00 ET",
    baseTrueProb: 0.34,
  },
  {
    id: "WX_CITYWIDE_15",
    line: "WX",
    lineLabel: "WX",
    lineColor: "#FCCC0A",
    contract: "Citywide weather delay >15min",
    expiry: "23:59 ET",
    baseTrueProb: 0.22,
  },
  {
    id: "NQRW_QUEENS_PM",
    line: "NQRW",
    lineLabel: "N·Q·R·W",
    lineColor: "#FCCC0A",
    contract: "Queens-bound delay before rush close",
    expiry: "19:30 ET",
    baseTrueProb: 0.48,
  },
];

function makeInitialMarket(spec: MarketSpec): Market {
  const prob = spec.baseTrueProb;
  const mid = Math.round(prob * 100);
  return {
    ...spec,
    forecastProb: prob,
    prevForecastProb: prob,
    confidence: 0.55,
    fairValueCents: mid,
    marketBid: Math.max(1, mid - 2),
    marketAsk: Math.min(99, mid + 2),
    ourBid: Math.max(1, mid - 1),
    ourAsk: Math.min(99, mid + 1),
    inventory: 0,
    avgCost: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    priceHistory: new Array(60).fill(mid),
    driverNotes: ["baseline prior", "no live events yet"],
    lastAction: "WIDEN",
    lastActionReason: "warming up — low confidence",
    narrative:
      "Desk is initializing. No live events yet — quoting a passive market around the prior probability.",
    riskPosture: "CAUTIOUS",
    lastImpactTs: 0,
    lastImpactMagnitude: 0,
    lastDecisionTick: 0,
    lastFillTick: -10,
    vol: 0.5,
    narrativeKey: "",
    book: emptyBook(mid),
    recentImpact: 0,
    scheduledRisk: 0,
  };
}

export function makeInitialState(
  now: number,
  dataSource: DataSourceMode = "hybrid",
): SimState {
  const markets: Record<string, Market> = {};
  const order: string[] = [];
  for (const spec of MARKET_SPECS) {
    const m = makeInitialMarket(spec);
    markets[m.id] = m;
    order.push(m.id);
  }
  return {
    tick: 0,
    startedAt: now,
    now,
    paused: false,
    rngState: INITIAL_SEED,
    selectedMarketId: order[0],
    markets,
    marketOrder: order,
    events: [],
    fills: [],
    regime: {
      activeLine: null,
      ticksRemaining: 0,
      intensity: 0,
      volSpikeTicksRemaining: 0,
      pendingClears: [],
    },
    dataSource,
    // Start past the quiet threshold so synthetic events can kick in
    // immediately on cold start if MTA is empty or slow.
    ticksSinceMtaEvent: 1_000_000,
  };
}
