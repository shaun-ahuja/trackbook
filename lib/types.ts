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
// Determines which decay channel the shock lands in (live half-lives are
// short; planned half-lives are long), and gates shock-fill eligibility.
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
  lastAction: MarketAction;
  lastActionReason: string;
  narrative: string;
  riskPosture: RiskPosture;
  lastImpactTs: number;
  lastImpactMagnitude: number;
  lastDecisionTick: number;
  lastFillTick: number;
  // EWMA of |Δmid| per tick — drives spread widening and vol-aware posture choice.
  vol: number;
  // Bucketed signature of the rationale. Narrative text only refreshes when this changes.
  narrativeKey: string;
  book: OrderBook;
  // Adaptive probability dynamics state. Owns the three-layer probability
  // model (longRunBase / adaptiveBase / latentTrue) plus per-shock decay,
  // latent risk channel, and volatility estimate. See probabilityDynamics.ts.
  dynamics: ProbabilityDynamicsState;
  // Per-market microstructure regime. Persists across many ticks; drives
  // archetype mix and quote-update cadence.
  regimeState: MarketRegimeState;
  // EWMA of liquidity-provider arrivals — feeds order-book depth display
  // and the Kyle-style impact denominator.
  lpDepth: number;
  // Persistent matching-engine state. Sources marketBid/marketAsk/mid and
  // the visible `book` projection every tick. Initialised with a small
  // LP seed in makeInitialMarket so the first render is populated.
  bookState: import("./simulation/orderBookState").BookState;
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
  // Per-role persistent agent state. One slot per AgentSlotKey; archetypes
  // that share a role share a slot. Seeded in makeInitialMarket.
  agents: Record<AgentSlotKey, AgentState>;
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

// Behavioral role that an archetype maps onto. Multiple archetypes can share
// one slot (e.g. liquidity_provider / patient_value / mean_reversion all use
// `passive`); they share per-market persistent state at that slot.
export type AgentSlotKey =
  | "informed"
  | "momentum"
  | "noise"
  | "rebalancer"
  | "taker"
  | "passive";

// Per-market persistent state for one role slot. Survives across ticks so
// agents are not pure tick-local samples: cooldown gates re-fires, conviction
// scales size + cooldown, recentDir lets momentum detect reversals, position
// is an open-loop signed counter (incremented on emit) that the rebalancer
// flattens, and obsLatent is the informed slot's private noisy smoother of
// the latent truth (no archetype reads lastLatentTrueProbability directly).
export type AgentState = {
  cooldownUntilTick: number;
  recentDir: -1 | 0 | 1;
  conviction: number;       // [0,1]
  position: number;         // signed lots
  obsLatent: number;        // [0,1], probability units
  lastActedTick: number;
};

export type MarketRegime = "calm" | "alert" | "shock" | "recovery";

// Per-shock decay tracking. Each event that hits a market appends an entry
// (signed remaining magnitude, half-life per category/severity). Entries
// decay every tick and are dropped when |remaining| falls below expireEps.
export type ShockMemory = {
  id: string;             // source event id
  originLine: LineId;
  category: EventCategory;
  severity: Severity;
  kind: EventKind;
  remaining: number;      // signed, current effect on latent truth
  initial: number;        // signed magnitude at birth
  halfLife: number;       // ticks
  bornTick: number;
};

// One contribution to the latent-truth composition. Sorted by |delta| and
// surfaced through the ForecastPanel debug strip.
export type DriverContribution = {
  source:
    | "adaptive_base"
    | "shock"
    | "contagion"
    | "network_stress"
    | "latent_risk";
  delta: number;          // signed pp contribution to latent truth this tick
  label: string;          // short human tag
};

// Structured environmental pressure on the network. Derived purely from
// state.now (wall clock) — no random component.
export type NetworkStressContext = {
  hourOfDay: number;              // 0..24
  isRushHour: boolean;
  rushHourIntensity: number;      // 0..1, triangular around AM/PM peaks
  isLateNight: boolean;
  isWeekend: boolean;
  inMaintenanceWindow: boolean;
  maintenanceIntensity: number;   // 0..1
  // Signed net adjustment (in probability units) to apply to latent truth.
  // Composed from the booleans + intensities + configured biases.
  netBias: number;
};

// Adaptive probability dynamics state per market.
//
//   longRunBaseProbability   immutable anchor — copy of MarketSpec.baseTrueProb
//   adaptiveBaseProbability  stored, mean-reverts toward (longRun + latentRisk*coeff)
//   latentTrueProbability    NOT a stored field — derived per tick from
//                            adaptiveBase + shock overlays + contagion + stress
//
// Volatility is a *measurement* (EWMA of |Δlatent|) — it scales jump caps,
// confidence, and spreads. It does NOT appear as a driving term in the
// latent-truth equation.
//
// Regime is NOT mirrored here — read from market.regimeState.regime.
export type ProbabilityDynamicsState = {
  longRunBaseProbability: number;
  adaptiveBaseProbability: number;
  // Slow planned/structural risk channel. Bounded ±0.2. Integrates planned
  // events with a long half-life and biases the adaptiveBase drift target.
  latentRisk: number;
  // EWMA of |Δ latentTrueProbability|.
  volatilityEstimate: number;
  // Per-shock decay entries — overlay on top of adaptiveBase to form latent.
  eventMemory: ShockMemory[];
  lastUpdatedTick: number;

  // Debug surface (read-only consumers, not used in the update equations).
  lastLatentTrueProbability: number;
  // Prior tick's latent truth. Seeded equal to lastLatentTrueProbability on
  // init; archetypes never read it directly (informed reads its own private
  // noisy smoother), but the noisy-observation signal uses it to bootstrap.
  prevLatentTrueProbability: number;
  lastBaseDelta: number;
  lastLatentDelta: number;
  lastDrivers: DriverContribution[];
};

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
  // Disruption cluster: legacy fields, retained on the type so persisted
  // state still parses. The dynamic generator no longer drives selection
  // off `activeLine` — selection comes from per-market world state. Kept
  // here as informational fields the generator may write for debug.
  activeLine: LineId | null;
  ticksRemaining: number;
  intensity: number;
  // Vol spike: temporarily multiplies synthetic-tape noise across all markets.
  volSpikeTicksRemaining: number;
  // Reserved for short-horizon scheduled recoveries the generator may emit
  // (e.g. an immediate same-tick CLEAR companion). The generator's preferred
  // path is a per-tick probabilistic recovery roll, not a deterministic
  // promise — this list usually stays empty.
  pendingClears: { route: string; atTick: number; magnitude: number }[];
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
