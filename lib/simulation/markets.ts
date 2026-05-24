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
const TRUNK_COLOR: Record<string, string> = {
  "123": "#EE352E",
  "456": "#00933C",
  "7": "#B933AD",
  ACE: "#0039A6",
  BDFM: "#FF6319",
  G: "#6CBE45",
  JZ: "#996633",
  L: "#A7A9AC",
  NQRW: "#FCCC0A",
  S: "#808183",
};

// Declaration order is the desk's left-rail order. Trunks are grouped by
// color so related instruments sit next to each other: red → green →
// purple → blue → orange → light green → brown → gray → yellow.
const MARKET_SPECS: MarketSpec[] = [
  // Red — 7 Avenue
  {
    id: "1",
    line: "123",
    lineLabel: "1",
    lineColor: TRUNK_COLOR["123"],
    contract: "1 west side delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.34,
  },
  {
    id: "2",
    line: "123",
    lineLabel: "2",
    lineColor: TRUNK_COLOR["123"],
    contract: "2 7 Av express delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.40,
  },
  {
    id: "3",
    line: "123",
    lineLabel: "3",
    lineColor: TRUNK_COLOR["123"],
    contract: "3 7 Av express delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.38,
  },
  // Green — Lexington Avenue
  {
    id: "4",
    line: "456",
    lineLabel: "4",
    lineColor: TRUNK_COLOR["456"],
    contract: "4 major delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.55,
  },
  {
    id: "5",
    line: "456",
    lineLabel: "5",
    lineColor: TRUNK_COLOR["456"],
    contract: "5 major delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.50,
  },
  {
    id: "6",
    line: "456",
    lineLabel: "6",
    lineColor: TRUNK_COLOR["456"],
    contract: "6 major delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.46,
  },
  // Purple — Flushing
  {
    id: "7",
    line: "7",
    lineLabel: "7",
    lineColor: TRUNK_COLOR["7"],
    contract: "7 signal incident before noon",
    expiry: "12:00 ET",
    baseTrueProb: 0.34,
  },
  // Blue — 8 Avenue
  {
    id: "A",
    line: "ACE",
    lineLabel: "A",
    lineColor: TRUNK_COLOR.ACE,
    contract: "A reroute extended",
    expiry: "23:59 ET",
    baseTrueProb: 0.30,
  },
  {
    id: "C",
    line: "ACE",
    lineLabel: "C",
    lineColor: TRUNK_COLOR.ACE,
    contract: "C signal trouble before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.26,
  },
  {
    id: "E",
    line: "ACE",
    lineLabel: "E",
    lineColor: TRUNK_COLOR.ACE,
    contract: "E reroute via F",
    expiry: "23:59 ET",
    baseTrueProb: 0.28,
  },
  // Orange — 6 Avenue
  {
    id: "B",
    line: "BDFM",
    lineLabel: "B",
    lineColor: TRUNK_COLOR.BDFM,
    contract: "B 6 Av delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.32,
  },
  {
    id: "D",
    line: "BDFM",
    lineLabel: "D",
    lineColor: TRUNK_COLOR.BDFM,
    contract: "D 6 Av express delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.38,
  },
  {
    id: "F",
    line: "BDFM",
    lineLabel: "F",
    lineColor: TRUNK_COLOR.BDFM,
    contract: "F 6 Av local delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.40,
  },
  {
    id: "M",
    line: "BDFM",
    lineLabel: "M",
    lineColor: TRUNK_COLOR.BDFM,
    contract: "M Myrtle delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.34,
  },
  // Light Green — Crosstown
  {
    id: "G",
    line: "G",
    lineLabel: "G",
    lineColor: TRUNK_COLOR.G,
    contract: "G crosstown delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.36,
  },
  // Brown — Nassau Street
  {
    id: "J",
    line: "JZ",
    lineLabel: "J",
    lineColor: TRUNK_COLOR.JZ,
    contract: "J Nassau delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.30,
  },
  {
    id: "Z",
    line: "JZ",
    lineLabel: "Z",
    lineColor: TRUNK_COLOR.JZ,
    contract: "Z Nassau skip-stop delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.28,
  },
  // Gray — Canarsie + Shuttles
  {
    id: "L",
    line: "L",
    lineLabel: "L",
    lineColor: TRUNK_COLOR.L,
    contract: "L >10min delay 6–9pm",
    expiry: "21:00 ET",
    baseTrueProb: 0.42,
  },
  {
    id: "S",
    line: "S",
    lineLabel: "S",
    lineColor: TRUNK_COLOR.S,
    contract: "S shuttle service gap",
    expiry: "23:59 ET",
    baseTrueProb: 0.22,
  },
  // Yellow — Broadway
  {
    id: "N",
    line: "NQRW",
    lineLabel: "N",
    lineColor: TRUNK_COLOR.NQRW,
    contract: "N Queens delay before 7:30pm",
    expiry: "19:30 ET",
    baseTrueProb: 0.48,
  },
  {
    id: "Q",
    line: "NQRW",
    lineLabel: "Q",
    lineColor: TRUNK_COLOR.NQRW,
    contract: "Q Manhattan delay before 8pm",
    expiry: "20:00 ET",
    baseTrueProb: 0.40,
  },
  {
    id: "R",
    line: "NQRW",
    lineLabel: "R",
    lineColor: TRUNK_COLOR.NQRW,
    contract: "R local delay before 7:30pm",
    expiry: "19:30 ET",
    baseTrueProb: 0.44,
  },
  {
    id: "W",
    line: "NQRW",
    lineLabel: "W",
    lineColor: TRUNK_COLOR.NQRW,
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
    trueProb: prob,
    regimeState: {
      regime: "calm",
      enteredTick: 0,
      shortAbsDelta: 0,
      ticksSinceEvent: 999,
      ticksSinceShock: 999,
    },
    lpDepth: 5,
    flowReason: "",
    flowReasonKey: "",
    flowReasonTick: 0,
    flowLog: [],
    lastEdgeAtFlip: 0,
    lastConfAtFlip: 0.55,
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
