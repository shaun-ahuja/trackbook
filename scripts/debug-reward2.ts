/**
 * Debug mark-to-fair reward step by step.
 * Run: node --import tsx scripts/debug-reward2.ts
 */
import { makeInitialState } from "../lib/simulation/markets";
import { reducer } from "../lib/simulation/reducer";
import { DEMO_SCENARIOS } from "../lib/simulation/scenarios";
import { DEFAULT_REWARD_PARAMS, stepReward } from "../lib/simulation/rolloutReward";
import type { Market } from "../lib/types";

(globalThis as { window?: Window }).window = {} as Window;

const FIXED_EPOCH = 1735660800000;
const H = 15;
const params = DEFAULT_REWARD_PARAMS;

function markToFairPnl(m: Market): number {
  const fair = m.forecastProb * 100;
  return m.realizedPnl + m.inventory * (fair - m.avgCost);
}

async function traceScenario(name: keyof typeof DEMO_SCENARIOS, forcedAction: string) {
  const base = makeInitialState(FIXED_EPOCH);
  const marketId = base.selectedMarketId;
  const { patch } = DEMO_SCENARIOS[name];
  let state = reducer(base, { type: "APPLY_SCENARIO", patch: { ...patch, marketId } });

  // Narrow to single market + force action
  state = {
    ...state,
    rngState: patch.rngState ?? 42424242,
    marketOrder: [marketId],
    markets: { [marketId]: state.markets[marketId]! },
    fills: [],
  };
  state = {
    ...state,
    markets: {
      [marketId]: { ...state.markets[marketId]!, lastAction: "HOLD" as const, lastDecisionTick: state.tick },
    },
  };

  const m0 = state.markets[marketId]!;
  console.log(`\n=== ${name} (forced: ${forcedAction}) ===`);
  console.log(`  Initial: inv=${m0.inventory} avgCost=${m0.avgCost} realPnl=${m0.realizedPnl} fairProb=${m0.forecastProb.toFixed(4)} fair=${(m0.forecastProb*100).toFixed(1)}¢`);
  console.log(`  Market: bid=${m0.marketBid} ask=${m0.marketAsk} mid=${((m0.marketBid+m0.marketAsk)/2).toFixed(1)}`);
  console.log(`  Edge: ${(m0.forecastProb*100 - (m0.marketBid+m0.marketAsk)/2).toFixed(2)}¢  conf=${m0.confidence}`);
  console.log(`  M2F initial: ${markToFairPnl(m0).toFixed(4)}`);

  let totalDiscounted = 0;
  let prevM2F = markToFairPnl(m0);

  for (let step = 0; step < H; step++) {
    const prevMarket = state.markets[marketId]!;
    const tickNow = FIXED_EPOCH + (step + 1) * 750;
    state = reducer(state, { type: "TICK", now: tickNow });
    const nextMarket = state.markets[marketId]!;
    const stepFills = state.fills.filter(f => f.marketId === marketId && f.tick === state.tick);

    const reward = stepReward(prevMarket, nextMarket, stepFills, params, prevMarket.lastAction);
    const discount = 0.97 ** step;
    totalDiscounted += discount * reward;

    const m2fNext = markToFairPnl(nextMarket);
    const m2fDelta = m2fNext - markToFairPnl(prevMarket);
    const invRisk = params.λInv * (nextMarket.inventory / params.maxInv) ** 2;

    if (step < 6 || Math.abs(reward) > 5) {
      console.log(
        `  step ${String(step).padStart(2)}: reward=${reward.toFixed(2).padStart(8)}` +
        `  m2fΔ=${m2fDelta.toFixed(2).padStart(8)}` +
        `  invRisk=${invRisk.toFixed(3).padStart(7)}` +
        `  inv=${nextMarket.inventory.toFixed(1).padStart(5)}` +
        `  fair=${(nextMarket.forecastProb*100).toFixed(2).padStart(6)}` +
        `  fills=${stepFills.length}` +
        `  action=${nextMarket.lastAction}`
      );
    }
  }
  console.log(`  Total discounted return: ${totalDiscounted.toFixed(3)}`);
}

async function main() {
  await traceScenario("CALM_EDGE", "HOLD");
  await traceScenario("SHOCK", "WIDEN");
  await traceScenario("INV_STRESS", "HIT");
}
main().catch(console.error);
