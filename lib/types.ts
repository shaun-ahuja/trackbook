export type LineId =
  | "123"
  | "456"
  | "7"
  | "ACE"
  | "BDFM"
  | "G"
  | "JZ"
  | "L"
  | "NQRW"
  | "S"
  | "WX";

export type EventKind =
  | "DELAY"
  | "SIGNAL"
  | "SICK_PASSENGER"
  | "WEATHER"
  | "POLICE"
  | "CLEAR"
  | "RIDERSHIP";

export type Severity = 1 | 2 | 3;

export type EventSource = "synthetic" | "mta" | "trip";

// Live news, scheduled maintenance, or aggregated train-movement signal.
// Determines whether the event pops recentImpact (shocky) or scheduledRisk
// (persistent baseline), and gates shock-fill eligibility.
export type EventCategory = "live" | "planned" | "trip";

export type TransitEvent = {
  id: string;
  ts: number;
  line: LineId;
  kind: EventKind;
  severity: Severity;
  text: string;
  impacts: Record<string, number>;
  // Origin of the event. Absent / "synthetic" = produced by the internal
  // regime engine. "mta" = derived from a real MTA service alert.
  // "trip" = derived from aggregated GTFS-RT trip updates.
  source?: EventSource;
  // Defaults to "live" when unset. Planned alerts feed a slow channel and
  // are excluded from shock-fill eligibility.
  category?: EventCategory;
};

export type DataSourceMode = "synthetic" | "mta" | "hybrid";

export type MarketAction =
  | "HOLD"
  | "WIDEN"
  | "LIFT"
  | "HIT"
  | "FLATTEN";

export type RiskPosture = "NORMAL" | "CAUTIOUS" | "WARNING";

export type BookLevel = {
  price: number;
  size: number;
  // True when the desk's resting quote sits at this price.
  isOurs?: boolean;
};

export type OrderBook = {
  // bids: best (highest) price first; asks: best (lowest) price first.
  bids: BookLevel[];
  asks: BookLevel[];
};

export type Market = {
  id: string;
  line: LineId;
  lineLabel: string;
  lineColor: string;
  contract: string;
  expiry: string;
  forecastProb: number;
  prevForecastProb: number;
  confidence: number;
  fairValueCents: number;
  marketBid: number;
  marketAsk: number;
  ourBid: number;
  ourAsk: number;
  inventory: number;
  avgCost: number;
  realizedPnl: number;
  unrealizedPnl: number;
  priceHistory: number[];
  driverNotes: string[];
  lastAction: MarketAction;
  lastActionReason: string;
  narrative: string;
  riskPosture: RiskPosture;
  baseTrueProb: number;
  lastImpactTs: number;
  lastImpactMagnitude: number;
  lastDecisionTick: number;
  lastFillTick: number;
  // EWMA of |Δmid| per tick — drives spread widening and vol-aware posture choice.
  vol: number;
  // Bucketed signature of the rationale. Narrative text only refreshes when this changes.
  narrativeKey: string;
  book: OrderBook;
  // Accumulated event impact on probability, in [-0.5, 0.5]. Decays each tick
  // so the forecast naturally reverts to baseTrueProb when nothing happens.
  recentImpact: number;
  // Slow channel: persistent prior shift from planned-work alerts. Doesn't
  // decay each tick — drains only when the originating alert clears.
  // Bounded ±0.2 so scheduled risk never dominates live news.
  scheduledRisk: number;
  // Hidden ground-truth probability the synthetic counterparties trade against.
  // forecastProb is the desk's noisy lagging estimate; trueProb is the truth
  // only informed/latency-arb archetypes see (with their own noise).
  trueProb: number;
  // Per-market microstructure regime. Persists across many ticks; drives
  // archetype mix and quote-update cadence.
  regimeState: MarketRegimeState;
  // EWMA of liquidity-provider arrivals — feeds order-book depth display
  // and the Kyle-style impact denominator.
  lpDepth: number;
  // Short bucketed string explaining what drove (or didn't drive) market
  // movement this tick. Distinct from lastActionReason (the desk's reason).
  flowReason: string;
  flowReasonKey: string;
  // Tick at which flowReason last refreshed — used for a min-dwell gate
  // so the displayed text doesn't churn every flow bucket transition.
  flowReasonTick: number;
  // Ring buffer of the last few archetype dispatches for this market.
  // Rendered in MarketDetail as a "flow log" — disambiguates emergent moves.
  flowLog: FlowEvent[];
  // Edge/conf snapshots at the last posture flip — used by the evidence-delta
  // hysteresis layer to suppress marginal flips.
  lastEdgeAtFlip: number;
  lastConfAtFlip: number;
};

export type TraderArchetype =
  | "noise"
  | "liquidity_provider"
  | "event_follower"
  | "inventory_rebalancer"
  | "momentum"
  | "mean_reversion"
  | "patient_value"
  | "informed_transit"
  | "latency_arb"
  | "panic"
  | "desk_actor";

export type MarketRegime = "calm" | "alert" | "shock" | "recovery";

export type MarketRegimeState = {
  regime: MarketRegime;
  enteredTick: number;
  // EWMA of |Δforecast| over ~6 ticks. Drives calm→alert and exit thresholds.
  shortAbsDelta: number;
  ticksSinceEvent: number;
  ticksSinceShock: number;
};

export type FlowEvent = {
  tick: number;
  archetype: TraderArchetype;
  side: "BUY" | "SELL" | "LIMIT_BID" | "LIMIT_ASK";
  qty: number;
  priceCents: number;
};

export const INVENTORY_LIMIT = 8;

export type FillKind = "passive" | "aggressive" | "flatten" | "shock";

export type Fill = {
  id: string;
  ts: number;
  tick: number;
  marketId: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  kind: FillKind;
  // Fair value (in cents) at the moment the fill cleared. Used post-hoc to
  // flag adverse selection when the print moves against us.
  markFair: number;
  adverse?: boolean;
};

export type Regime = {
  // Disruption cluster: an active line attracts more events for a stretch.
  activeLine: LineId | null;
  ticksRemaining: number;
  intensity: number;
  // Vol spike: temporarily multiplies synthetic-tape noise across all markets.
  volSpikeTicksRemaining: number;
  // CLEAR events scheduled after sev-3 disruptions so service recovers
  // instead of staying elevated indefinitely.
  pendingClears: { line: LineId; atTick: number }[];
};

export type SimState = {
  tick: number;
  startedAt: number;
  now: number;
  paused: boolean;
  rngState: number;
  selectedMarketId: string;
  markets: Record<string, Market>;
  marketOrder: string[];
  events: TransitEvent[];
  fills: Fill[];
  regime: Regime;
  // Which event source is driving the sim. "hybrid" runs synthetic only
  // when MTA has been quiet — see HYBRID_QUIET_TICKS in the reducer.
  dataSource: DataSourceMode;
  // Ticks since an MTA-sourced event last entered. Drives the hybrid gate.
  ticksSinceMtaEvent: number;
};

export type SimAction =
  | { type: "TICK"; now: number }
  | { type: "SELECT"; marketId: string }
  | { type: "TOGGLE_PAUSE" }
  | { type: "RESEED" }
  | { type: "INJECT_EVENTS"; events: TransitEvent[] }
  | { type: "SET_DATA_SOURCE"; mode: DataSourceMode };
