/**
 * Debug script: trace step-by-step rewards for one CALM_EDGE rollout trajectory.
 * Run: node --import tsx scripts/debug-reward.ts
 */
import { makeInitialState } from "../lib/simulation/markets";
import { reducer } from "../lib/simulation/reducer";
import { DEMO_SCENARIOS } from "../lib/simulation/scenarios";
import { DEFAULT_REWARD_PARAMS, stepReward } from "../lib/simulation/rolloutReward";

// ACTION_MAP is internal to rollout.ts; duplicate the relevant subset here
const ACTION_MAP: Record<string, string> = {
  PASS: "HOLD",
  WIDEN: "WIDEN",
  TIGHTEN: "HOLD",
  SKEW_BID: "LIFT",
  SKEW_ASK: "HIT",
  PARTIAL_FLATTEN: "FLATTEN",
  AGG_BUY: "LIFT",
  AGG_SELL: "HIT",
};

(globalThis as { window?: Window }).window = {} as Window;

const FIXED_EPOCH = 1735660800000;
const H = 15;
const base = makeInitialState(FIXED_EPOCH);
const marketId = base.selectedMarketId;
const { patch } = DEMO_SCENARIOS.CALM_EDGE;
let state = reducer(base, { type: "APPLY_SCENARIO", patch: { ...patch, marketId } });

const market = state.markets[marketId]!;
console.log("=== CALM_EDGE Initial Market State ===");
console.log(`  inventory    : ${market.inventory}`);
console.log(`  realizedPnl  : ${market.realizedPnl}`);
console.log(`  unrealizedPnl: ${market.unrealizedPnl}`);
console.log(`  avgCost      : ${market.avgCost}`);
console.log(`  marketBid    : ${market.marketBid}`);
console.log(`  marketAsk    : ${market.marketAsk}`);
console.log(`  confidence   : ${market.confidence}`);
console.log(`  regime       : ${market.regimeState.regime}`);
console.log(`  forecastProb : ${market.forecastProb}`);

// Force PASS action
state = {
  ...state,
  markets: {
    ...state.markets,
    [marketId]: { ...state.markets[marketId]!, lastAction: "HOLD", lastDecisionTick: state.tick },
  },
};
state = { ...state, rngState: 42424242, marketOrder: [marketId], markets: { [marketId]: state.markets[marketId]! }, fills: [] };

console.log("\n=== Step-by-step rewards (PASS + passive_maker) ===");
let totalDiscounted = 0;
const params = DEFAULT_REWARD_PARAMS;

for (let step = 0; step < H; step++) {
  const prevMarket = state.markets[marketId]!;
  const tickNow = FIXED_EPOCH + (step + 1) * 750;
  state = reducer(state, { type: "TICK", now: tickNow });
  const nextMarket = state.markets[marketId]!;
  const stepFills = state.fills.filter(f => f.marketId === marketId && f.tick === state.tick);

  const pnlDelta = (nextMarket.realizedPnl - prevMarket.realizedPnl) + (nextMarket.unrealizedPnl - prevMarket.unrealizedPnl);
  const invRisk = params.λInv * (nextMarket.inventory / params.maxInv) ** 2;
  const adverseCost = params.λAdv * stepFills.filter(f => f.adverse).length;
  const reward = stepReward(prevMarket, nextMarket, stepFills, params, prevMarket.lastAction);
  const discount = 0.97 ** step;
  totalDiscounted += discount * reward;

  console.log(
    `  step ${String(step).padStart(2)}: reward=${reward.toFixed(4).padStart(9)}` +
    `  pnlΔ=${pnlDelta.toFixed(4).padStart(9)}` +
    `  invRisk=${invRisk.toFixed(4).padStart(8)}` +
    `  advCost=${adverseCost.toFixed(2).padStart(5)}` +
    `  inv=${nextMarket.inventory.toFixed(1).padStart(5)}` +
    `  rPnl=${nextMarket.realizedPnl.toFixed(2).padStart(8)}` +
    `  uPnl=${nextMarket.unrealizedPnl.toFixed(2).padStart(8)}` +
    `  fills=${stepFills.length}(${stepFills.filter(f=>f.adverse).length} adv)`
  );
}
console.log(`\n  Total discounted return: ${totalDiscounted.toFixed(4)}`);
