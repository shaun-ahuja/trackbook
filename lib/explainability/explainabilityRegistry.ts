import type { GlossaryTerm, PanelId, PanelInfo, TourStep } from "./types";

// ── Tour Steps ─────────────────────────────────────────────────────────────
// Conceptual framing only. Technical depth lives in info cards and glossary.

export const TOUR_STEPS: TourStep[] = [
  {
    id: "step-markets",
    panelId: "markets",
    title: "Markets",
    body: "Each row is a synthetic transit-linked contract with live pricing, forecast edge, and desk state. Choosing a market to inspect shows it's order book, forecast, and decision logic in detail.",
  },
  {
    id: "step-eventtape",
    panelId: "eventtape",
    title: "The Event Tape",
    body: "Transit events — delays, incidents, service changes — are the raw signal. Each event shifts the probability that a contract resolves. Severity determines how large and how lasting that shift is.",
  },
  {
    id: "step-forecast",
    panelId: "forecast",
    title: "The Forecast",
    body: "The model continuously estimates the probability that each contract will resolve YES. This is the desk's estimate of fair value — a running belief updated by events, not a guarantee.",
  },
  {
    id: "step-orderbook",
    panelId: "orderbook",
    title: "The Order Book",
    body: "Synthetic participants place buy and sell orders. The desk's resting quotes are labelled 'ours'. The gap between the best bid and best ask is the spread — wider when risk is elevated.",
  },
  {
    id: "step-decision",
    panelId: "decision",
    title: "The Decision",
    body: "The desk decides whether to quote passively, cross the spread, or reduce inventory. An optimizer evaluates simulated futures and selects the action estimated to have the best risk-adjusted outcome.",
  },
  {
    id: "step-pnl",
    panelId: "pnl",
    title: "Book & P&L",
    body: "Positions build up from fills. Performance is marked to the current mid price each tick. Adverse selection is flagged when a fill is followed by a move against the desk.",
  },
  {
    id: "step-datamode",
    panelId: "controls",
    title: "Data Mode",
    body: "TransitAlpha runs in three modes. Synth is a fully simulated environment — all events are generated stochastically. Hybrid blends synthetic dynamics with live MTA signals. MTA follows live transit data directly.\n\nMode determines where market state comes from. Switch at any time; takes effect immediately.",
  },
  {
    id: "step-scenarios",
    panelId: "controls",
    title: "Scenario Controls",
    body: "Scenario injections stress-test the market maker under specific conditions. Calm resets to stable low-volatility conditions. Shock introduces high-severity disruption risk. Inventory Stress forces the desk into constrained inventory management.\n\nPause freezes the simulation. Reseed restarts it with a fresh stochastic path.",
  },
  {
    id: "step-help",
    panelId: "help",
    title: "Help & Resources",
    body: "All explainability tools live here. Quick Start gives a 20-second overview of the simulation loop. Restart Tour replays this walkthrough at any time. Glossary opens a searchable reference of every term used in the interface.\n\nThat's the tour. Use HELP whenever you need a refresher.",
  },
];

// ── Panel Info Cards ───────────────────────────────────────────────────────

export const PANEL_INFO: Record<PanelId, PanelInfo> = {
  markets: {
    panelId: "markets",
    title: "Markets List",
    what: "All synthetic NYC subway line contracts. Each contract resolves YES if a significant disruption hits the line during the trading window.",
    why: "Shows the cross-market snapshot: which lines are active, how each is priced, and where the desk's estimated edge is largest.",
    howUpdates: "Mid price and edge refresh every tick (750 ms). A row flashes when a new event impacts that market.",
    howInterpret: "Green edge = model estimates the market is underpriced. Red = overpriced. The ⊕ pin adds a market to watchlist for multi-market focus view.",
  },
  detail: {
    panelId: "detail",
    title: "Market Detail",
    what: "Deep view of the selected contract: current prices, spread, volatility, price history, and recent participant activity.",
    why: "The flow log reveals which types of participants are active. Informed flow is a warning — it often precedes adverse selection.",
    howUpdates: "Refreshes with the selected market each tick. The sparkline shows the last 60 ticks of synthetic mid price.",
    howInterpret: "Informed transit and latency-arb buying suggests a disruption may be developing. Noise and liquidity-provider activity is benign. Panic flow during shock often overshoots and reverts.",
  },
  forecast: {
    panelId: "forecast",
    title: "AI Forecast",
    what: "The model's current probability estimate that the selected contract resolves YES, plus a confidence level and market stability state.",
    why: "This is the desk's estimated fair value signal. Edge = (forecast × 100) − mid price. Without edge above the threshold, the desk does not act.",
    howUpdates: "Updated each tick from the probability model. The Δ shows the change from the previous tick.",
    howInterpret: "Low confidence (below ~46%) suppresses aggressive action even when edge is positive. Shock regime further tightens the required edge before the optimizer acts.",
  },
  orderbook: {
    panelId: "orderbook",
    title: "Order Book",
    what: "The synthetic L2 order book for the selected market. Bids at bottom, asks at top. The desk's resting quote is labelled 'ours'.",
    why: "Depth shows where liquidity sits. Thin books mean the desk's quotes fill faster but face larger price impact on adverse moves.",
    howUpdates: "Rebuilt each tick by the matching engine using synthetic participant orders.",
    howInterpret: "Our quotes visible in the book = passive maker exposure. During shock, liquidity providers often pull and the book thins significantly.",
  },
  decision: {
    panelId: "decision",
    title: "Decision Engine",
    what: "The current desk action, the reasoning behind it, and the optimizer's analysis of simulated future outcomes.",
    why: "Shows not just what the desk is doing, but why — edge, confidence, inventory, and risk posture all feed the decision.",
    howUpdates: "The optimizer runs asynchronously after each tick. The stale indicator shows ticks since the last solve.",
    howInterpret: "Binding constraints explain why a conservative plan was chosen despite positive edge. CVaR and μ return show the risk-return profile of the selected approach.",
  },
  pnl: {
    panelId: "pnl",
    title: "Book · P&L",
    what: "The desk's aggregate and per-market position book with realized, unrealized, and total P&L in dollar terms.",
    why: "Tracks the economic outcome of the market-making strategy across the full portfolio.",
    howUpdates: "Realized P&L locks in on each fill. Unrealized marks open positions to mid price each tick.",
    howInterpret: "Persistent unrealized losses may signal adverse selection or a position that failed to flatten. Compare realized vs unrealized to distinguish transient exposure from structural losses.",
  },
  eventtape: {
    panelId: "eventtape",
    title: "Event Tape",
    what: "Chronological feed of all transit events. MTA-badged events are real service alerts. TRIP events come from aggregated train movement data. PLAN events are scheduled maintenance.",
    why: "Events are the primary driver of probability shifts. Severity and source type determine shock size and how long the effect persists.",
    howUpdates: "New events prepend to the top and flash on arrival. In focus or watchlist view, the tape filters to events affecting active markets.",
    howInterpret: "Severity-3 red events trigger network contagion across related lines. Planned events build latent risk slowly over many ticks rather than spiking.",
  },
  controls: {
    panelId: "controls",
    title: "Simulation Controls",
    what: "Data mode selector (Synth / Hybrid / MTA), scenario injections (Calm / Shock / Inventory Stress), and execution controls (Pause / Reseed).",
    why: "Controls let you explore different operating conditions and observe how the desk responds. Scenarios reproduce specific stress conditions with a fixed random seed for reproducibility.",
    howUpdates: "Mode changes take effect immediately. Scenario injections fire the optimizer and pause the simulation to show the initial response before the simulation resumes.",
    howInterpret: "Synth is best for isolated demonstrations. Hybrid and MTA connect to live transit signals. Use scenarios to see CVaR constraints bind, inventory limits stress, or edge-capture under calm conditions.",
  },
  help: {
    panelId: "help",
    title: "Help & Resources",
    what: "Entry point for all explainability tools: Quick Start overview, guided tour walkthrough, and 31-term glossary.",
    why: "All reference material is accessible from one place at any point during the session.",
    howUpdates: "Static — available whenever you need it.",
    howInterpret: "Quick Start for a fast overview. Restart Tour for a step-by-step walkthrough of every panel. Glossary for definitions of any term shown in the interface.",
  },
};

// ── Glossary ───────────────────────────────────────────────────────────────

export const GLOSSARY_TERMS: GlossaryTerm[] = [
  // Core market concepts
  {
    id: "spread",
    label: "Spread",
    definition: "The difference between the lowest ask and highest bid: ask − bid. Tighter spreads mean cheaper round-trips for traders; wider spreads earn more per fill for the market maker but reduce fill frequency. The desk's quote width directly sets its passive spread.",
    seeAlso: ["bid", "ask", "quote-width"],
  },
  {
    id: "mid-price",
    label: "Mid Price",
    definition: "The arithmetic midpoint between best bid and best ask: (bid + ask) / 2. Used to mark unrealized P&L each tick and as the baseline for computing edge. A mid move against a fill is the primary adverse selection signal.",
    seeAlso: ["bid", "ask", "spread"],
  },
  {
    id: "fair-value",
    label: "Fair Value",
    definition: "The desk's model estimate of a contract's true probability in cents (forecastProb × 100). Edge = fair value − synthetic mid. The desk requires positive estimated edge above a minimum threshold before acting.",
    seeAlso: ["mid-price", "latent-probability"],
  },
  {
    id: "bid",
    label: "Bid",
    definition: "The highest price a buyer is currently willing to pay. Bids are sorted highest-first in the L2 book. The desk's passive bid rests here when it is offering to buy.",
    seeAlso: ["ask", "spread", "passive-maker"],
  },
  {
    id: "ask",
    label: "Ask (Offer)",
    definition: "The lowest price a seller is currently willing to accept. Asks are sorted lowest-first. The desk's passive ask rests here when it is offering to sell.",
    seeAlso: ["bid", "spread", "passive-maker"],
  },
  {
    id: "maker-taker",
    label: "Maker / Taker",
    definition: "A maker adds liquidity by resting a limit order that others can fill. A taker removes liquidity by sending a market order that fills against resting orders. The desk is a maker when posting quotes and a taker when executing LIFT or HIT actions aggressively.",
    seeAlso: ["passive-maker", "aggressive-buy", "aggressive-sell"],
  },
  {
    id: "order-flow",
    label: "Order Flow",
    definition: "The stream of buy and sell orders arriving at the book each tick. The mix of participant types — noise, informed, liquidity-providing — determines whether flow is benign or adversarial for the desk.",
    seeAlso: ["informed-flow", "maker-taker"],
  },
  {
    id: "queue-priority",
    label: "Queue Priority",
    definition: "In a price-time priority book, orders at the same price are filled in the order they arrived. The synthetic book uses price priority only — the desk's quotes compete with synthetic participant orders at the same level.",
    seeAlso: ["passive-maker", "order-flow"],
  },
  // Probability model
  {
    id: "latent-probability",
    label: "Latent Probability",
    definition: "The model's internal belief about the true underlying probability — not directly observable. Derived from three layers: a long-run anchor, an adaptive base that mean-reverts toward it, and shock overlays from events and network contagion. The reported forecast probability is a smoothed version of this.",
    seeAlso: ["adaptive-base", "fair-value", "confidence"],
  },
  {
    id: "adaptive-base",
    label: "Adaptive Base",
    definition: "A slow-moving probability estimate that mean-reverts toward the long-run anchor. It drifts when latent risk builds (e.g. from planned maintenance), creating gradual price pressure before a visible event fires.",
    seeAlso: ["latent-probability", "shock-regime"],
  },
  {
    id: "shock-regime",
    label: "Shock Regime",
    definition: "A four-state market stability classification: calm → alert → shock → recovery. Driven by the magnitude of recent forecast changes. Shock regime increases overlay multipliers, suppresses aggressive market-making, and tightens the CVaR constraint in the optimizer.",
    seeAlso: ["volatility-regime", "cvar"],
  },
  {
    id: "confidence",
    label: "Confidence",
    definition: "A 0–1 scalar capturing the model's certainty in its probability estimate — not the likelihood of the contract resolving YES. Low confidence (roughly below 46%) is caused by high volatility or regime uncertainty and suppresses aggressive desk actions. Confidence is a property of the model, not of the outcome.",
    seeAlso: ["latent-probability", "volatility-regime"],
  },
  {
    id: "volatility-regime",
    label: "Volatility Regime",
    definition: "A continuous EWMA estimate of how rapidly the forecast probability has been changing. High volatility leads to lower confidence, wider required edge, and more conservative optimizer plan selection. Shown as the 'market instability' bar in the forecast panel.",
    seeAlso: ["confidence", "shock-regime"],
  },
  // Position & risk
  {
    id: "inventory",
    label: "Inventory",
    definition: "The desk's signed net position in a market. Positive = long (net bought); negative = short (net sold). Bounded by hard limits. High inventory increases exposure to adverse price moves and triggers the optimizer's inventory skew constraint.",
    seeAlso: ["inventory-limits", "flatten", "adverse-selection"],
  },
  {
    id: "inventory-limits",
    label: "Inventory Limits",
    definition: "Hard position caps of ±8 contracts per market. As inventory approaches the limit, the desk widens quotes and may switch to flatten mode. The inventory_skew binding constraint fires in the optimizer when this threshold is approached.",
    seeAlso: ["inventory", "flatten"],
  },
  {
    id: "realized-pnl",
    label: "Realized P&L",
    definition: "Profit or loss locked in by completed fills: (exit price − entry average cost) × quantity. Once realized, it does not change with subsequent market moves.",
    seeAlso: ["unrealized-pnl", "pnl"],
  },
  {
    id: "unrealized-pnl",
    label: "Unrealized P&L",
    definition: "The paper gain or loss on current open inventory, marked to the current mid price each tick: (mid − avg cost) × inventory. Changes with every tick until the position is closed.",
    seeAlso: ["realized-pnl", "pnl", "inventory"],
  },
  {
    id: "pnl",
    label: "P&L (Profit and Loss)",
    definition: "Total P&L = realized + unrealized. Realized is locked from prior fills. Unrealized is the current mark-to-market exposure. Total P&L is the primary performance metric for the desk.",
    seeAlso: ["realized-pnl", "unrealized-pnl"],
  },
  {
    id: "adverse-selection",
    label: "Adverse Selection",
    definition: "The risk that a fill was executed against a counterparty with superior information. Flagged when mid price moves against the desk shortly after a fill — suggesting the other side knew something. Persistent adverse selection erodes P&L even when the quoted spread is theoretically positive.",
    seeAlso: ["informed-flow", "inventory"],
  },
  {
    id: "informed-flow",
    label: "Informed Flow",
    definition: "Orders from participants believed to hold an informational edge — primarily informed transit traders (tracking real MTA signals) and latency arbitrageurs. Filling against informed flow is the primary source of adverse selection.",
    seeAlso: ["adverse-selection", "order-flow"],
  },
  {
    id: "tail-risk",
    label: "Tail Risk",
    definition: "The risk of extreme losses in the low-probability tail of the return distribution. Measured via CVaR. In shock regime, tail risk is elevated because the probability model is less stable and large moves are more likely.",
    seeAlso: ["cvar", "shock-regime"],
  },
  // Desk actions
  {
    id: "quote-width",
    label: "Quote Width",
    definition: "The distance between the desk's bid and ask (ourAsk − ourBid). A wider quote earns more per fill but is hit less often and is less likely to adversely select against informed flow. Shock regime and high inventory both push toward wider quotes.",
    seeAlso: ["spread", "fill-probability", "passive-maker"],
  },
  {
    id: "spread-capture",
    label: "Spread Capture",
    definition: "P&L earned by quoting a two-sided market passively and letting both sides fill over time. If the desk buys at the bid and later the same inventory is sold at the ask, the spread is captured. This is the core P&L mechanism for a passive market maker.",
    seeAlso: ["spread", "passive-maker", "realized-pnl"],
  },
  {
    id: "aggressive-buy",
    label: "Aggressive Buy (LIFT)",
    definition: "A market order that crosses the spread and fills against the synthetic ask — the desk pays the full offer price to ensure a fill. Used when edge is large enough to justify the spread cost. Labelled LIFT OFFER in the Decision Engine.",
    seeAlso: ["aggressive-sell", "spread", "inventory"],
  },
  {
    id: "aggressive-sell",
    label: "Aggressive Sell (HIT)",
    definition: "A market order that fills against the synthetic bid — the desk sells at the bid price. Used when the model is bearish with sufficient edge and confidence. Labelled HIT BID in the Decision Engine.",
    seeAlso: ["aggressive-buy", "spread", "inventory"],
  },
  {
    id: "passive-maker",
    label: "Passive Maker",
    definition: "The desk's default mode: resting a two-sided limit order in the book and waiting for incoming orders to fill against it. HOLD maintains the current quote; WIDEN increases the spread for defensive protection. Earns the spread but carries adverse selection risk.",
    seeAlso: ["fill-probability", "spread", "maker-taker"],
  },
  {
    id: "flatten",
    label: "Flatten",
    definition: "Aggressively reducing inventory toward zero by crossing the spread — selling if long, buying if short. Triggered when inventory approaches the hard limit or when the optimizer determines tail risk from the position outweighs the spread crossing cost.",
    seeAlso: ["inventory", "tail-risk", "aggressive-buy", "aggressive-sell"],
  },
  // Optimizer
  {
    id: "cvar",
    label: "CVaR (Conditional Value at Risk)",
    definition: "The expected loss in the worst 10% of simulated future trajectories — a measure of tail risk. The JuMP optimizer uses CVaR as a hard constraint: plans whose tail risk exceeds the limit are rejected even with positive expected return. The limit tightens in shock regime.",
    seeAlso: ["tail-risk", "expected-return", "jump-optimizer"],
  },
  {
    id: "expected-return",
    label: "Expected Return (μ return)",
    definition: "The mean P&L across all simulated rollout trajectories for a given plan. A plan with high expected return but elevated CVaR may be rejected. The optimizer selects the plan that maximizes expected return subject to risk constraints.",
    seeAlso: ["cvar", "fill-probability", "scenario-rollouts"],
  },
  {
    id: "fill-probability",
    label: "Fill Probability",
    definition: "The fraction of simulated trajectories in which the desk's passive quote gets hit by an incoming order. Tighter quotes increase fill probability but raise adverse selection exposure. The optimizer explicitly trades fill probability against per-fill P&L.",
    seeAlso: ["spread", "passive-maker", "expected-return"],
  },
  {
    id: "scenario-rollouts",
    label: "Scenario Rollouts",
    definition: "For each candidate plan (action + continuation policy), the optimizer simulates 50 stochastic trajectories over a 15-step horizon using the same probability dynamics model as the live simulation. Statistics across these trajectories feed the CVaR LP.",
    seeAlso: ["cvar", "expected-return", "jump-optimizer"],
  },
  {
    id: "jump-optimizer",
    label: "JuMP Optimizer",
    definition: "A Julia-based stochastic linear program solved using the JuMP modelling framework. Each tick, the system builds rollout trajectories for all candidate plans, computes CVaR statistics, and solves a constrained LP that maximizes expected return subject to risk limits. The solution selects the optimal plan.",
    seeAlso: ["cvar", "scenario-rollouts", "expected-return"],
  },
];

// ── Quick Start ────────────────────────────────────────────────────────────

export const QUICK_START_ITEMS = [
  "Markets: each row is a tradable transit contract — select one to drill into its forecast, order book, and decision logic",
  "Events shift disruption probabilities; the model estimates fair value each tick",
  "Synthetic traders generate order flow against the desk's resting quotes",
  "The Decision Engine picks the optimal action using CVaR-constrained rollout optimization",
  "P&L marks positions to mid price; adverse selection is flagged on bad fills",
] as const;

export const QUICK_START_INTERACT_ITEMS = [
  "Synth / Hybrid / MTA — choose your data source (src selector, top left)",
  "Calm / Shock / Inventory Stress — inject scenarios to stress-test the desk",
  "Pause or Reseed to control simulation state",
  "HELP → Quick Start, Restart Tour, Glossary (top right)",
] as const;

// ── Scenario subtitles ─────────────────────────────────────────────────────

export const SCENARIO_SUBTITLES: Record<string, string> = {
  CALM_EDGE: "flat inv · high conf · edge capture",
  SHOCK: "shock regime · CVaR binds · defensive",
  INV_STRESS: "long 7/8 · inventory skew binds",
};
