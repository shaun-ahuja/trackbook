import type { Market, MarketAction, SimState } from "../types";
import { reducer } from "./reducer";
import type { RewardParams } from "./rolloutReward";
import { DEFAULT_REWARD_PARAMS, stepReward, terminalPenalty } from "./rolloutReward";

export type RolloutAction =
  | "PASS"
  | "WIDEN"
  | "TIGHTEN"
  | "SKEW_BID"
  | "SKEW_ASK"
  | "PARTIAL_FLATTEN"
  | "AGG_BUY"
  | "AGG_SELL";

// Maps optimizer-level action names to the MarketAction hysteresis lock target.
// SKEW_BID / AGG_BUY → LIFT (buy bias); SKEW_ASK / AGG_SELL → HIT (sell bias).
const ACTION_MAP: Record<RolloutAction, MarketAction> = {
  PASS: "HOLD",
  WIDEN: "WIDEN",
  TIGHTEN: "HOLD",
  SKEW_BID: "LIFT",
  SKEW_ASK: "HIT",
  PARTIAL_FLATTEN: "FLATTEN",
  AGG_BUY: "LIFT",
  AGG_SELL: "HIT",
};

export type ActionParams = { marketAction: MarketAction };

export type ContinuationPolicy = {
  name: string;
  decide: (market: Market, tick: number, params: RewardParams) => ActionParams;
};

// Six named continuation policies — each represents a distinct risk philosophy.
// Thresholds mirror marketMaker.ts constants so policies are coherent with the
// live decision system.
export const CONTINUATION_POLICIES: readonly ContinuationPolicy[] = [
  {
    name: "passive_maker",
    decide: () => ({ marketAction: "HOLD" }),
  },
  {
    name: "risk_off_widen",
    decide: () => ({ marketAction: "WIDEN" }),
  },
  {
    name: "inv_mean_reversion",
    decide: (m, _tick, p) => {
      const threshold = 0.5 * p.maxInv;
      if (m.inventory > threshold) return { marketAction: "HIT" };
      if (m.inventory < -threshold) return { marketAction: "LIFT" };
      return { marketAction: "HOLD" };
    },
  },
  {
    name: "edge_following",
    decide: (m) => {
      const fair = m.forecastProb * 100;
      const mid = (m.marketBid + m.marketAsk) / 2;
      const edge = fair - mid;
      if (edge >= 3.5 && m.confidence >= 0.62) return { marketAction: "LIFT" };
      if (edge <= -3.5 && m.confidence >= 0.62) return { marketAction: "HIT" };
      return { marketAction: "HOLD" };
    },
  },
  {
    name: "shock_defensive",
    decide: (m, _tick, p) => {
      if (Math.abs(m.inventory) > 0.6 * p.maxInv) return { marketAction: "FLATTEN" };
      return { marketAction: "WIDEN" };
    },
  },
  {
    name: "flatten_on_threshold",
    decide: (m, _tick, p) => {
      if (Math.abs(m.inventory) > 0.7 * p.maxInv) return { marketAction: "FLATTEN" };
      return { marketAction: "HOLD" };
    },
  },
] as const;

export const ROLLOUT_ACTIONS: readonly RolloutAction[] = [
  "PASS",
  "WIDEN",
  "TIGHTEN",
  "SKEW_BID",
  "SKEW_ASK",
  "PARTIAL_FLATTEN",
  "AGG_BUY",
  "AGG_SELL",
] as const;

export type RolloutResult = {
  discountedReturn: number;
  invFinal: number;
  maxAbsInv: number;
  maxDrawdown: number;
};

export type PlanDescriptor = {
  firstAction: RolloutAction;
  policyName: string;
  firstActionIndex: number;
  policyIndex: number;
};

export type ScenarioContext = {
  currentInventory: number;
  maxInventory: number;
  regime: string;
  forecastConfidence: number;
  adverseSelectionScore: number;
  bestBidTicks: number;
  bestAskTicks: number;
};

export type ScenarioMatrix = {
  N: number;
  M: number;
  H: number;
  gamma: number;
  R: number[][];
  invFinal: number[][];
  maxAbsInv: number[][];
  maxDrawdown: number[][];
  plans: PlanDescriptor[];
  context: ScenarioContext;
};

// Aggressive actions are infeasible when near the inventory limit or in a
// shock regime with low confidence — excludes them before rollout runs.
function isFeasible(action: RolloutAction, market: Market, params: RewardParams): boolean {
  const inv = market.inventory;
  const maxInv = params.maxInv;
  const regime = market.regimeState.regime;
  const conf = market.confidence;
  if ((action === "AGG_BUY" || action === "SKEW_BID") && inv >= maxInv - 2) return false;
  if ((action === "AGG_SELL" || action === "SKEW_ASK") && inv <= -(maxInv - 2)) return false;
  if ((action === "AGG_BUY" || action === "AGG_SELL") && regime === "shock" && conf < 0.5)
    return false;
  return true;
}

// Deterministic seed derivation for trajectory diversity — each (plan, trajectory)
// pair gets a unique seed so rollouts are reproducible but statistically independent.
function deriveRolloutSeed(baseRng: number, planIndex: number, trajectoryIndex: number): number {
  let h = ((baseRng ^ (planIndex * 2654435761)) >>> 0);
  h = ((h ^ (trajectoryIndex * 2246822519)) >>> 0);
  h ^= h >>> 13;
  h = (Math.imul(h, 0x9e3779b9) >>> 0);
  h ^= h >>> 17;
  return h >>> 0;
}

// Patches state so that on the next tick, decide() in marketMaker.ts locks to
// `marketAction` via the MIN_HOLD_TICKS hysteresis. Setting lastDecisionTick =
// state.tick means ticksSinceDecision = 1 inside the tick (< 25), activating
// the lock and preserving the forced action unless a very large edge / fresh
// shock overrides it.
function forceMarketAction(state: SimState, marketId: string, marketAction: MarketAction): SimState {
  const m = state.markets[marketId];
  if (!m) return state;
  return {
    ...state,
    markets: {
      ...state.markets,
      [marketId]: { ...m, lastAction: marketAction, lastDecisionTick: state.tick },
    },
  };
}

// Runs one rollout trajectory for a single (firstAction, policy, seed) triple.
// Operates on a snapshot of `baseState` — never advances the live simulation's
// rngState or market state. The state is narrowed to `marketId` only.
export function runPlanRollout(
  baseState: SimState,
  marketId: string,
  firstAction: RolloutAction,
  policy: ContinuationPolicy,
  H: number,
  seed: number,
  params: RewardParams,
  gamma: number,
): RolloutResult {
  let state: SimState = { ...baseState, rngState: seed };
  state = forceMarketAction(state, marketId, ACTION_MAP[firstAction]);

  let discountedReturn = 0;
  let maxAbsInv = 0;
  let maxDrawdown = 0;
  let cumulativePnl = 0;
  let peakPnl = 0;
  let prevAction: string | undefined = undefined;
  const baseNow = baseState.now;

  for (let step = 0; step < H; step++) {
    const prevMarket = state.markets[marketId];
    if (!prevMarket) break;

    const tickNow = baseNow + (step + 1) * 750;
    state = reducer(state, { type: "TICK", now: tickNow });

    const nextMarket = state.markets[marketId];
    if (!nextMarket) break;

    const stepTick = state.tick;
    const stepFills = state.fills.filter(
      (f) => f.marketId === marketId && f.tick === stepTick,
    );

    const reward = stepReward(prevMarket, nextMarket, stepFills, params, prevAction);
    discountedReturn += gamma ** step * reward;

    const absInv = Math.abs(nextMarket.inventory);
    if (absInv > maxAbsInv) maxAbsInv = absInv;

    cumulativePnl += nextMarket.realizedPnl - prevMarket.realizedPnl;
    if (cumulativePnl > peakPnl) peakPnl = cumulativePnl;
    const drawdown = peakPnl - cumulativePnl;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    prevAction = nextMarket.lastAction;

    if (step < H - 1) {
      const { marketAction } = policy.decide(nextMarket, stepTick, params);
      state = forceMarketAction(state, marketId, marketAction);
    }
  }

  const finalMarket = state.markets[marketId];
  if (finalMarket) {
    discountedReturn += gamma ** H * terminalPenalty(finalMarket, params);
  }

  return {
    discountedReturn,
    invFinal: finalMarket?.inventory ?? 0,
    maxAbsInv,
    maxDrawdown,
  };
}

// Builds the full scenario matrix for the JuMP optimizer.
// Narrows state to `marketId` for rollout efficiency — cross-market contagion
// is a secondary effect; per-plan trajectory diversity comes from RNG seeding.
export function buildScenarioMatrix(
  state: SimState,
  marketId: string,
  M = 50,
  H = 15,
  params: RewardParams = DEFAULT_REWARD_PARAMS,
  gamma = 0.97,
): ScenarioMatrix {
  const market = state.markets[marketId];
  if (!market) throw new Error(`buildScenarioMatrix: market ${marketId} not found`);

  const rolloutState: SimState = {
    ...state,
    selectedMarketId: marketId,
    marketOrder: [marketId],
    markets: { [marketId]: market },
    fills: [],
  };

  const plans: PlanDescriptor[] = [];
  for (let ai = 0; ai < ROLLOUT_ACTIONS.length; ai++) {
    const action = ROLLOUT_ACTIONS[ai];
    if (!isFeasible(action, market, params)) continue;
    for (let pi = 0; pi < CONTINUATION_POLICIES.length; pi++) {
      plans.push({
        firstAction: action,
        policyName: CONTINUATION_POLICIES[pi].name,
        firstActionIndex: ai,
        policyIndex: pi,
      });
    }
  }

  const N = plans.length;
  const R: number[][] = Array.from({ length: N }, () => []);
  const invFinal: number[][] = Array.from({ length: N }, () => []);
  const maxAbsInv: number[][] = Array.from({ length: N }, () => []);
  const maxDrawdown: number[][] = Array.from({ length: N }, () => []);

  for (let n = 0; n < N; n++) {
    const { firstAction, policyIndex } = plans[n];
    const policy = CONTINUATION_POLICIES[policyIndex];
    for (let m = 0; m < M; m++) {
      const seed = deriveRolloutSeed(state.rngState, n, m);
      const result = runPlanRollout(rolloutState, marketId, firstAction, policy, H, seed, params, gamma);
      R[n].push(result.discountedReturn);
      invFinal[n].push(result.invFinal);
      maxAbsInv[n].push(result.maxAbsInv);
      maxDrawdown[n].push(result.maxDrawdown);
    }
  }

  const recentFills = state.fills.filter(
    (f) => f.marketId === marketId && f.tick > state.tick - 5,
  );
  const adverseCount = recentFills.filter((f) => f.adverse).length;
  const adverseSelectionScore = recentFills.length > 0 ? adverseCount / recentFills.length : 0;

  const context: ScenarioContext = {
    currentInventory: market.inventory,
    maxInventory: params.maxInv,
    regime: market.regimeState.regime,
    forecastConfidence: market.confidence,
    adverseSelectionScore,
    bestBidTicks: market.marketBid,
    bestAskTicks: market.marketAsk,
  };

  return { N, M, H, gamma, R, invFinal, maxAbsInv, maxDrawdown, plans, context };
}
