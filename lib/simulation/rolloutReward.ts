import type { Fill, Market } from "../types";
import { INVENTORY_LIMIT } from "../types";

export type RewardParams = {
  λInv: number;
  λAdv: number;
  λChurn: number;
  maxInv: number;
};

export const DEFAULT_REWARD_PARAMS: RewardParams = {
  λInv: 3.0,   // raised so invRisk savings clearly exceed mark-to-fair cost of selling
  λAdv: 0.5,
  λChurn: 0.1,
  maxInv: INVENTORY_LIMIT,
};

// Mark-to-fair P&L for one market state.
// Values inventory at the MODEL's fair price (forecastProb × 100) instead of
// the volatile market bid/ask mid. This eliminates ~10¢/step market-price
// noise (inventory × Δmid) while correctly capturing edge on each fill:
// buying at 33 when fair=39 immediately shows +6 in the reward.
function markToFairPnl(m: Market): number {
  const fair = m.forecastProb * 100;
  return m.realizedPnl + m.inventory * (fair - m.avgCost);
}

// Discounted per-step reward. Combines mark-to-fair P&L delta, inventory
// risk, adverse fill cost, and a churn penalty when the action changes.
export function stepReward(
  prev: Market,
  next: Market,
  stepFills: Fill[],
  params: RewardParams,
  prevAction: string | undefined,
): number {
  const pnlΔ = markToFairPnl(next) - markToFairPnl(prev);
  const invRisk = params.λInv * (next.inventory / params.maxInv) ** 2;
  const adverseCost = params.λAdv * stepFills.filter((f) => f.adverse).length;
  const churnCost =
    prevAction !== undefined && next.lastAction !== prevAction
      ? params.λChurn
      : 0;
  return pnlΔ - invRisk - adverseCost - churnCost;
}

// Terminal penalty added at γ^H — discourages plans that leave large positions.
export function terminalPenalty(market: Market, params: RewardParams): number {
  const invFrac = Math.abs(market.inventory) / params.maxInv;
  return -(params.λInv * invFrac * invFrac);
}
