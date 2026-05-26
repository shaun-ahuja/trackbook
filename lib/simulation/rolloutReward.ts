import type { Fill, Market } from "../types";
import { INVENTORY_LIMIT } from "../types";

export type RewardParams = {
  λInv: number;
  λAdv: number;
  λChurn: number;
  maxInv: number;
};

export const DEFAULT_REWARD_PARAMS: RewardParams = {
  λInv: 1.5,
  λAdv: 0.5,
  λChurn: 0.1,
  maxInv: INVENTORY_LIMIT,
};

// Discounted per-step reward. Combines PnL delta, inventory risk, adverse
// fill cost, and a churn penalty when the action changes vs. the prev step.
export function stepReward(
  prev: Market,
  next: Market,
  stepFills: Fill[],
  params: RewardParams,
  prevAction: string | undefined,
): number {
  const pnlΔ =
    (next.realizedPnl - prev.realizedPnl) +
    (next.unrealizedPnl - prev.unrealizedPnl);
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
