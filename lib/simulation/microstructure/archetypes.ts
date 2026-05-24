import type { Market, MarketRegime, TraderArchetype } from "../../types";
import { rand } from "../../rng";
import { clamp } from "../../format";

// A single trader's instruction this tick. "market" crosses the spread;
// "limit" adds depth at a price.
export type Intent = {
  kind: "market" | "limit";
  side: "BUY" | "SELL";
  qty: number;
  // For "market": the prevailing touch (informational only — the actual
  // execution price for the desk is set by walk-the-desk in flow.ts).
  // For "limit": the resting price.
  priceCents: number;
};

export type ArchetypeContext = {
  market: Market;
  regime: MarketRegime;
};

export type ArchetypeOutput = { intent: Intent; seed: number };

type ExternalArchetype = Exclude<TraderArchetype, "desk_actor">;
type Handler = (ctx: ArchetypeContext, seed: number) => ArchetypeOutput;

function midCents(m: Market): number {
  return (m.marketBid + m.marketAsk) / 2;
}

const HANDLERS: Record<ExternalArchetype, Handler> = {
  noise: (ctx, seed) => {
    const r = rand(seed);
    return {
      intent: {
        kind: "market",
        side: r.v < 0.5 ? "BUY" : "SELL",
        qty: 1,
        priceCents: midCents(ctx.market),
      },
      seed: r.seed,
    };
  },

  liquidity_provider: (ctx, seed) => {
    const r = rand(seed);
    const buySide = r.v < 0.5;
    return {
      intent: {
        kind: "limit",
        side: buySide ? "BUY" : "SELL",
        qty: 3,
        priceCents: buySide ? ctx.market.marketBid : ctx.market.marketAsk,
      },
      seed: r.seed,
    };
  },

  event_follower: (ctx, seed) => {
    // Trades with the sign of recent impact (live news direction).
    const side: "BUY" | "SELL" =
      ctx.market.recentImpact >= 0 ? "BUY" : "SELL";
    return {
      intent: { kind: "market", side, qty: 1, priceCents: midCents(ctx.market) },
      seed,
    };
  },

  inventory_rebalancer: (ctx, seed) => {
    // Synthetic counterparty with its own book: ~30% sell, ~30% buy,
    // ~40% top up a passive bid. Mostly two-sided so flow doesn't
    // skew in calm.
    const r = rand(seed);
    if (r.v < 0.3) {
      return {
        intent: {
          kind: "market",
          side: "SELL",
          qty: 1,
          priceCents: midCents(ctx.market),
        },
        seed: r.seed,
      };
    }
    if (r.v < 0.6) {
      return {
        intent: {
          kind: "market",
          side: "BUY",
          qty: 1,
          priceCents: midCents(ctx.market),
        },
        seed: r.seed,
      };
    }
    return {
      intent: {
        kind: "limit",
        side: "BUY",
        qty: 1,
        priceCents: ctx.market.marketBid,
      },
      seed: r.seed,
    };
  },

  momentum: (ctx, seed) => {
    // Chases recent drift.
    const h = ctx.market.priceHistory;
    const last = h[h.length - 1] ?? midCents(ctx.market);
    const prior = h[h.length - 4] ?? last;
    const side: "BUY" | "SELL" = last >= prior ? "BUY" : "SELL";
    return {
      intent: { kind: "market", side, qty: 1, priceCents: midCents(ctx.market) },
      seed,
    };
  },

  mean_reversion: (ctx, seed) => {
    // Fades recent drift.
    const h = ctx.market.priceHistory;
    const last = h[h.length - 1] ?? midCents(ctx.market);
    const prior = h[h.length - 4] ?? last;
    const side: "BUY" | "SELL" = last >= prior ? "SELL" : "BUY";
    return {
      intent: { kind: "market", side, qty: 1, priceCents: midCents(ctx.market) },
      seed,
    };
  },

  patient_value: (ctx, seed) => {
    // Posts limits well inside the touch — slow, deep value flow.
    const r = rand(seed);
    const buySide = r.v < 0.5;
    const offset = 1.5;
    const price = buySide
      ? ctx.market.marketBid - offset
      : ctx.market.marketAsk + offset;
    return {
      intent: {
        kind: "limit",
        side: buySide ? "BUY" : "SELL",
        qty: 2,
        priceCents: clamp(price, 1, 99),
      },
      seed: r.seed,
    };
  },

  informed_transit: (ctx, seed) => {
    // Sees trueProb with low noise; trades the signed truth edge.
    const mid = midCents(ctx.market);
    const truthCents = ctx.market.trueProb * 100;
    const edge = truthCents - mid;
    if (Math.abs(edge) < 0.5) {
      const r = rand(seed);
      return {
        intent: {
          kind: "market",
          side: r.v < 0.5 ? "BUY" : "SELL",
          qty: 1,
          priceCents: mid,
        },
        seed: r.seed,
      };
    }
    return {
      intent: {
        kind: "market",
        side: edge > 0 ? "BUY" : "SELL",
        qty: 2,
        priceCents: mid,
      },
      seed,
    };
  },

  latency_arb: (ctx, seed) => {
    // Smaller, faster version of informed — takes 1 lot on any signed edge.
    const mid = midCents(ctx.market);
    const truthCents = ctx.market.trueProb * 100;
    const edge = truthCents - mid;
    return {
      intent: {
        kind: "market",
        side: edge >= 0 ? "BUY" : "SELL",
        qty: 1,
        priceCents: mid,
      },
      seed,
    };
  },

  panic: (ctx, seed) => {
    // Sells aggressively when recent impact is negative; otherwise
    // ~50/50 market order. Weighted heavily only in shock regime.
    const r = rand(seed);
    if (ctx.market.recentImpact < 0 || r.v < 0.5) {
      return {
        intent: {
          kind: "market",
          side: "SELL",
          qty: 2,
          priceCents: midCents(ctx.market),
        },
        seed: r.seed,
      };
    }
    return {
      intent: {
        kind: "market",
        side: "BUY",
        qty: 2,
        priceCents: midCents(ctx.market),
      },
      seed: r.seed,
    };
  },
};

// Poisson sampling never picks desk_actor — it's appended once per tick
// in flow.ts. All weights below are for the external pool only.
export const WEIGHTS: Record<MarketRegime, Record<ExternalArchetype, number>> = {
  calm: {
    noise: 6,
    liquidity_provider: 7,
    event_follower: 0,
    inventory_rebalancer: 2,
    momentum: 1,
    mean_reversion: 2,
    patient_value: 4,
    informed_transit: 1,
    latency_arb: 0,
    panic: 0,
  },
  alert: {
    noise: 4,
    liquidity_provider: 4,
    event_follower: 3,
    inventory_rebalancer: 2,
    momentum: 3,
    mean_reversion: 2,
    patient_value: 2,
    informed_transit: 3,
    latency_arb: 1,
    panic: 0,
  },
  shock: {
    noise: 2,
    liquidity_provider: 1,
    event_follower: 6,
    inventory_rebalancer: 1,
    momentum: 5,
    mean_reversion: 1,
    patient_value: 1,
    informed_transit: 5,
    latency_arb: 4,
    panic: 3,
  },
  recovery: {
    noise: 4,
    liquidity_provider: 6,
    event_follower: 1,
    inventory_rebalancer: 3,
    momentum: 1,
    mean_reversion: 4,
    patient_value: 3,
    informed_transit: 2,
    latency_arb: 1,
    panic: 0,
  },
};

// Expected trader arrivals per tick by regime.
export const LAMBDA: Record<MarketRegime, number> = {
  calm: 1.2,
  alert: 2.0,
  shock: 3.5,
  recovery: 1.6,
};

// Kyle impact multiplier — scales (imbalance / depth) into cents.
export const IMPACT_K: Record<MarketRegime, number> = {
  calm: 1.0,
  alert: 1.0,
  shock: 2.2,
  recovery: 0.8,
};

export function runArchetype(
  archetype: ExternalArchetype,
  ctx: ArchetypeContext,
  seed: number,
): ArchetypeOutput {
  return HANDLERS[archetype](ctx, seed);
}
