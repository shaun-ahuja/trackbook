import type { DataSourceMode, Market, SimState } from "../types";
import { emptyBook } from "./orderBook";

export const INITIAL_SEED = 0x1ac7;

type MarketSpec = Pick<
  Market,
  "id" | "line" | "lineLabel" | "lineColor" | "contract" | "expiry" | "baseTrueProb"
>;

// Per-route markets. Each NYC subway route quoted on the desk is its own
// independent contract. Trunk line + color are visual metadata only —
// 4·5·6 share a green chip, A·C·E share blue, etc. — but selection,
// inventory, PnL, and forecasts all operate per route.
const MARKET_SPECS: MarketSpec[] = [
  {
    id: "L",
    line: "L",
    lineLabel: "L",
    lineColor: "#A7A9AC",
    contract: "L >10min delay 6–9pm",
    expiry: "21:00 ET",
    baseTrueProb: 0.42,
  },
  {
    id: "4",
    line: "456",
    lineLabel: "4",
    lineColor: "#00933C",
    contract: "4 major delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.55,
  },
  {
    id: "5",
    line: "456",
    lineLabel: "5",
    lineColor: "#00933C",
    contract: "5 major delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.50,
  },
  {
    id: "6",
    line: "456",
    lineLabel: "6",
    lineColor: "#00933C",
    contract: "6 major delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.46,
  },
  {
    id: "A",
    line: "ACE",
    lineLabel: "A",
    lineColor: "#0039A6",
    contract: "A reroute extended",
    expiry: "23:59 ET",
    baseTrueProb: 0.30,
  },
  {
    id: "C",
    line: "ACE",
    lineLabel: "C",
    lineColor: "#0039A6",
    contract: "C signal trouble before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.26,
  },
  {
    id: "E",
    line: "ACE",
    lineLabel: "E",
    lineColor: "#0039A6",
    contract: "E reroute via F",
    expiry: "23:59 ET",
    baseTrueProb: 0.28,
  },
  {
    id: "7",
    line: "7",
    lineLabel: "7",
    lineColor: "#B933AD",
    contract: "7 signal incident before noon",
    expiry: "12:00 ET",
    baseTrueProb: 0.34,
  },
  {
    id: "N",
    line: "NQRW",
    lineLabel: "N",
    lineColor: "#FCCC0A",
    contract: "N Queens delay before 7:30pm",
    expiry: "19:30 ET",
    baseTrueProb: 0.48,
  },
  {
    id: "Q",
    line: "NQRW",
    lineLabel: "Q",
    lineColor: "#FCCC0A",
    contract: "Q Manhattan delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.40,
  },
  {
    id: "R",
    line: "NQRW",
    lineLabel: "R",
    lineColor: "#FCCC0A",
    contract: "R local delay before 7:30pm",
    expiry: "19:30 ET",
    baseTrueProb: 0.44,
  },
  {
    id: "W",
    line: "NQRW",
    lineLabel: "W",
    lineColor: "#FCCC0A",
    contract: "W Astoria delay before 7:30pm",
    expiry: "19:30 ET",
    baseTrueProb: 0.38,
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
