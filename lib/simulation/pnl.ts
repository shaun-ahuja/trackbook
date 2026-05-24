import type { SimState } from "../types";

export function totalPnl(state: SimState): {
  realized: number;
  unrealized: number;
  total: number;
} {
  let r = 0;
  let u = 0;
  for (const id of state.marketOrder) {
    const m = state.markets[id];
    r += m.realizedPnl;
    u += m.unrealizedPnl;
  }
  return { realized: r, unrealized: u, total: r + u };
}

export function totalInventoryNotional(state: SimState): number {
  let n = 0;
  for (const id of state.marketOrder) {
    const m = state.markets[id];
    const mid = (m.marketBid + m.marketAsk) / 2;
    n += Math.abs(m.inventory) * mid;
  }
  return n;
}
