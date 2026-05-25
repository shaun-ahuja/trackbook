import type { AgentState, Market, MarketRegime, TraderArchetype } from "../../types";
import { rand } from "../../rng";
import { clamp } from "../../format";
import { TICK_CENTS } from "../orderBookState";
import {
  COOLDOWN_BASE_TICKS,
  CONVICTION_EWMA_ALPHA,
  INFORMED_ALPHA_ROUTE,
  INFORMED_BETA_DELTA,
  INFORMED_DEAD_BAND_CENTS,
  INFORMED_SIZE_STEP_CENTS,
  MOMENTUM_CONVICTION_GAIN,
  MOMENTUM_DECAY_TICKS,
  MOMENTUM_MIN_STRENGTH,
  PASSIVE_BASE_OFFSET,
  PASSIVE_CANCEL_GAIN,
  PASSIVE_FLAVOR_SENS,
  PASSIVE_FLAVOR_SIZE,
  PASSIVE_IMPROVE_SPREAD_MIN,
  PASSIVE_THIN_DEPTH,
  PASSIVE_WIDEN_GAIN,
  REBALANCER_MIN_POSITION,
  REBALANCER_POSITION_CAP,
  REBALANCER_POSITION_DECAY,
  REBALANCER_SIZE_GAIN,
  TAKER_MISPRICING_MIN_CENTS,
  TAKER_PANIC_URGENCY_MIN,
  TAKER_URGENCY_MIN,
} from "./config";
import { isOnCooldown, nextCooldown } from "./agentState";
import {
  adverseSelectionScore,
  bookFeatures,
  mispricingScoreCents,
  momentumScore,
  noisyLatentObservation,
  noisyRouteShockSignal,
  routeShockSignal,
  staleQuoteScan,
  urgencyScore,
} from "./signals";

// A single trader's instruction this tick. "market" crosses the spread;
// "limit" rests at the named price (matched only if it crosses).
export type Intent = {
  kind: "market" | "limit";
  side: "BUY" | "SELL";
  qty: number;
  // For "market": the prevailing touch (informational — actual execution
  // price comes from walking the book in bookMatching.ts).
  // For "limit": the resting price.
  priceCents: number;
  // Optional hint for limit orders: how many ticks before forced expiry.
  // Adapter (orderFlow.ts) supplies a regime-appropriate default when this
  // is unset, so most handlers can ignore it.
  ttlTicks?: number;
};

export type ArchetypeContext = {
  market: Market;
  regime: MarketRegime;
};

// Handlers may decline to emit (returning null intent) — cooldowns, weak
// signals, no stale quote available, etc. Callers must tolerate null and
// still write nextAgent back.
export type ArchetypeOutput = {
  intent: Intent | null;
  nextAgent: AgentState;
  seed: number;
};

type ExternalArchetype = Exclude<TraderArchetype, "desk_actor">;

function midCents(m: Market): number {
  return (m.marketBid + m.marketAsk) / 2;
}

function skipWithCooldown(agent: AgentState, currentTick: number, ticks: number, seed: number): ArchetypeOutput {
  return {
    intent: null,
    nextAgent: { ...agent, cooldownUntilTick: currentTick + ticks },
    seed,
  };
}

// -------- noise --------

function runNoise(ctx: ArchetypeContext, agent: AgentState, seed: number, currentTick: number): ArchetypeOutput {
  if (isOnCooldown(agent, currentTick)) return { intent: null, nextAgent: agent, seed };

  const r1 = rand(seed);
  const r2 = rand(r1.seed);
  const buySide = r2.v < 0.5;
  const side: "BUY" | "SELL" = buySide ? "BUY" : "SELL";
  const mid = midCents(ctx.market);

  // In shock, force market-only: parking resting noise during stress just
  // feeds the informed/taker flow.
  const useLimit = ctx.regime !== "shock" && r1.v >= 0.6;
  const intent: Intent = useLimit
    ? {
        kind: "limit",
        side,
        qty: 1,
        priceCents: clamp(
          buySide ? ctx.market.marketBid + TICK_CENTS : ctx.market.marketAsk - TICK_CENTS,
          1,
          99,
        ),
      }
    : { kind: "market", side, qty: 1, priceCents: mid };

  return {
    intent,
    nextAgent: {
      ...agent,
      cooldownUntilTick: currentTick + 1,
      recentDir: buySide ? 1 : -1,
      conviction: 0.5,
      position: agent.position + (buySide ? 1 : -1),
      lastActedTick: currentTick,
    },
    seed: r2.seed,
  };
}

// -------- passive liquidity (lp / patient_value / mean_reversion) --------

type PassiveFlavor = "lp" | "patient" | "mean_reversion";

function runPassive(
  ctx: ArchetypeContext,
  agent: AgentState,
  seed: number,
  currentTick: number,
  flavor: PassiveFlavor,
): ArchetypeOutput {
  if (isOnCooldown(agent, currentTick)) return { intent: null, nextAgent: agent, seed };

  const features = bookFeatures(ctx.market, PASSIVE_THIN_DEPTH);
  const adverse = adverseSelectionScore(ctx.market, ctx.regime, features);
  const cancelProb = clamp(
    adverse * PASSIVE_CANCEL_GAIN * PASSIVE_FLAVOR_SENS[flavor],
    0,
    0.85,
  );

  const r = rand(seed);
  if (r.v < cancelProb) {
    // Adverse-selection skip — equivalent to pulling the quote rather than
    // resting it. Set a short cooldown so we re-check soon.
    return skipWithCooldown(agent, currentTick, 3, r.seed);
  }

  // Side selection. mean_reversion is contrarian; lp leans against imbalance
  // to post on the thin side; patient is symmetric.
  const r2 = rand(r.seed);
  let buySide: boolean;
  if (flavor === "mean_reversion") {
    const mom = momentumScore(ctx.market.priceHistory);
    buySide = mom.slope < 0;
  } else if (flavor === "lp") {
    if (features.imbalance > 0.15) buySide = false;
    else if (features.imbalance < -0.15) buySide = true;
    else buySide = r2.v < 0.5;
  } else {
    buySide = r2.v < 0.5;
  }
  const side: "BUY" | "SELL" = buySide ? "BUY" : "SELL";

  // ticksFromTouch: positive = improve (inside, closer to mid), 0 = join,
  // negative = deep (further from mid).
  let ticksFromTouch: number;
  if (flavor === "patient") {
    ticksFromTouch = -3;
  } else if (
    features.spreadTicks >= PASSIVE_IMPROVE_SPREAD_MIN &&
    !features.isThin
  ) {
    ticksFromTouch = 1;
  } else if (features.spreadTicks <= 1 || features.isThin) {
    ticksFromTouch = 0;
  } else {
    ticksFromTouch = -(
      PASSIVE_BASE_OFFSET[flavor] + Math.ceil(adverse * PASSIVE_WIDEN_GAIN)
    );
  }
  if (flavor === "mean_reversion" && ticksFromTouch < 1) ticksFromTouch = 1;

  const limitPx = buySide
    ? ctx.market.marketBid + ticksFromTouch * TICK_CENTS
    : ctx.market.marketAsk - ticksFromTouch * TICK_CENTS;
  const size = PASSIVE_FLAVOR_SIZE[flavor];

  return {
    intent: { kind: "limit", side, qty: size, priceCents: clamp(limitPx, 1, 99) },
    nextAgent: {
      ...agent,
      cooldownUntilTick: currentTick + 2,
      recentDir: buySide ? 1 : -1,
      conviction: 0.5,
      position: agent.position + (buySide ? size : -size),
      lastActedTick: currentTick,
    },
    seed: r2.seed,
  };
}

// -------- momentum --------

function runMomentum(ctx: ArchetypeContext, agent: AgentState, seed: number, currentTick: number): ArchetypeOutput {
  if (isOnCooldown(agent, currentTick)) return { intent: null, nextAgent: agent, seed };

  const mom = momentumScore(ctx.market.priceHistory);
  if (mom.strength < MOMENTUM_MIN_STRENGTH) {
    // Signal too weak. Short cooldown — re-check next tick.
    return skipWithCooldown(agent, currentTick, 1, seed);
  }

  const slopeSign: -1 | 1 = mom.slope > 0 ? 1 : -1;
  const mid = midCents(ctx.market);

  // Decay branch: once the run has been one-sided for too long, treat the
  // signal as exhausted. With prob (1 − conviction) book a fade; else skip.
  if (mom.ageTicks > MOMENTUM_DECAY_TICKS) {
    const r = rand(seed);
    if (r.v > agent.conviction) {
      const side: "BUY" | "SELL" = slopeSign > 0 ? "SELL" : "BUY";
      const newDir: -1 | 1 = side === "BUY" ? 1 : -1;
      const conviction = clamp(agent.conviction - 0.2, 0, 1);
      return {
        intent: { kind: "market", side, qty: 1, priceCents: mid },
        nextAgent: {
          ...agent,
          cooldownUntilTick: nextCooldown(currentTick, conviction),
          recentDir: newDir,
          conviction,
          position: agent.position + newDir,
          lastActedTick: currentTick,
        },
        seed: r.seed,
      };
    }
    return {
      intent: null,
      nextAgent: {
        ...agent,
        cooldownUntilTick: currentTick + 3,
        conviction: clamp(agent.conviction - 0.05, 0, 1),
      },
      seed: r.seed,
    };
  }

  // Normal follow branch.
  const side: "BUY" | "SELL" = slopeSign > 0 ? "BUY" : "SELL";
  const newDir: -1 | 1 = side === "BUY" ? 1 : -1;
  const matched = agent.recentDir === newDir;
  const targetConv = matched ? 1 : 0.4;
  const conviction = clamp(
    (1 - CONVICTION_EWMA_ALPHA) * agent.conviction + CONVICTION_EWMA_ALPHA * targetConv,
    0,
    1,
  );
  const sizeRaw = 1 + Math.floor(mom.strength * MOMENTUM_CONVICTION_GAIN * conviction);
  const size = Math.max(1, Math.min(3, sizeRaw));

  return {
    intent: { kind: "market", side, qty: size, priceCents: mid },
    nextAgent: {
      ...agent,
      cooldownUntilTick: nextCooldown(currentTick, conviction),
      recentDir: newDir,
      conviction,
      position: agent.position + newDir * size,
      lastActedTick: currentTick,
    },
    seed,
  };
}

// -------- inventory rebalancer --------

function runRebalancer(ctx: ArchetypeContext, agent: AgentState, seed: number, currentTick: number): ArchetypeOutput {
  if (isOnCooldown(agent, currentTick)) return { intent: null, nextAgent: agent, seed };

  // Slow per-fire decay toward 0 prevents the open-loop counter drifting
  // unboundedly when emits don't actually fill.
  const pos = agent.position * (1 - REBALANCER_POSITION_DECAY);

  if (Math.abs(pos) < REBALANCER_MIN_POSITION) {
    return {
      intent: null,
      nextAgent: { ...agent, position: pos, cooldownUntilTick: currentTick + 2 },
      seed,
    };
  }

  const side: "BUY" | "SELL" = pos > 0 ? "SELL" : "BUY";
  const newDir: -1 | 1 = side === "BUY" ? 1 : -1;
  const sizeRaw = Math.ceil(Math.abs(pos) * REBALANCER_SIZE_GAIN);
  const size = Math.max(1, Math.min(3, sizeRaw));

  // Urgent flattening in shock/recovery — cross the spread instead of resting.
  const urgent = ctx.regime === "shock" || ctx.regime === "recovery";
  const mid = midCents(ctx.market);
  const intent: Intent = urgent
    ? { kind: "market", side, qty: size, priceCents: mid }
    : {
        kind: "limit",
        side,
        qty: size,
        priceCents: side === "BUY" ? ctx.market.marketBid : ctx.market.marketAsk,
      };

  const newPos = clamp(
    pos + newDir * size,
    -REBALANCER_POSITION_CAP,
    REBALANCER_POSITION_CAP,
  );
  const conviction = clamp(Math.abs(pos) / REBALANCER_POSITION_CAP, 0, 1);

  return {
    intent,
    nextAgent: {
      ...agent,
      position: newPos,
      cooldownUntilTick: nextCooldown(currentTick, conviction),
      recentDir: newDir,
      conviction,
      lastActedTick: currentTick,
    },
    seed,
  };
}

// -------- liquidity taker (event_follower / panic / latency_arb) --------

type TakerFlavor = "event_follower" | "panic" | "latency_arb";

function runTaker(
  ctx: ArchetypeContext,
  agent: AgentState,
  seed: number,
  currentTick: number,
  flavor: TakerFlavor,
): ArchetypeOutput {
  if (isOnCooldown(agent, currentTick)) return { intent: null, nextAgent: agent, seed };

  // latency_arb fires only when an actually stale quote is on the book.
  // No synthetic activity when nothing is offside — this is what makes the
  // name accurate (it exploits real staleness).
  if (flavor === "latency_arb") {
    const fair = ctx.market.fairValueCents ?? 50;
    const hit = staleQuoteScan(ctx.market, currentTick, fair);
    if (!hit) return skipWithCooldown(agent, currentTick, 2, seed);
    const side: "BUY" | "SELL" = hit.side === "ASK" ? "BUY" : "SELL";
    const newDir: -1 | 1 = side === "BUY" ? 1 : -1;
    const conviction = clamp(hit.edgeCents / 10, 0.3, 1);
    return {
      intent: { kind: "market", side, qty: 1, priceCents: hit.priceCents },
      nextAgent: {
        ...agent,
        cooldownUntilTick: nextCooldown(currentTick, conviction),
        recentDir: newDir,
        conviction,
        position: agent.position + newDir,
        lastActedTick: currentTick,
      },
      seed,
    };
  }

  const urgency = urgencyScore(ctx.market, ctx.regime);
  const fair = ctx.market.fairValueCents ?? 50;
  const mid = midCents(ctx.market);
  const mispricing = fair - mid;        // takers are unprivileged — use public fair, not latent
  const route = routeShockSignal(ctx.market);

  if (flavor === "panic") {
    // Panic only fires under high urgency AND when net live shock is negative.
    if (urgency < TAKER_PANIC_URGENCY_MIN || route.sign >= 0) {
      return skipWithCooldown(agent, currentTick, 3, seed);
    }
    const conviction = clamp(urgency / 2, 0.3, 1);
    return {
      intent: { kind: "market", side: "SELL", qty: 2, priceCents: mid },
      nextAgent: {
        ...agent,
        cooldownUntilTick: nextCooldown(currentTick, conviction),
        recentDir: -1,
        conviction,
        position: agent.position - 2,
        lastActedTick: currentTick,
      },
      seed,
    };
  }

  // event_follower: gated on urgency or mispricing. Direction prefers route
  // shock sign when present; falls back to mispricing sign.
  if (
    urgency < TAKER_URGENCY_MIN &&
    Math.abs(mispricing) < TAKER_MISPRICING_MIN_CENTS
  ) {
    return skipWithCooldown(agent, currentTick, 2, seed);
  }
  const side: "BUY" | "SELL" =
    route.sign !== 0
      ? route.sign > 0
        ? "BUY"
        : "SELL"
      : mispricing >= 0
        ? "BUY"
        : "SELL";
  const newDir: -1 | 1 = side === "BUY" ? 1 : -1;
  const sizeRaw = 1 + Math.floor(urgency * 0.7);
  const size = Math.max(1, Math.min(3, sizeRaw));
  const conviction = clamp(urgency / 2 + Math.abs(mispricing) / 5, 0.3, 1);

  return {
    intent: { kind: "market", side, qty: size, priceCents: mid },
    nextAgent: {
      ...agent,
      cooldownUntilTick: nextCooldown(currentTick, conviction),
      recentDir: newDir,
      conviction,
      position: agent.position + newDir * size,
      lastActedTick: currentTick,
    },
    seed,
  };
}

// -------- informed transit --------

function runInformed(ctx: ArchetypeContext, agent: AgentState, seed: number, currentTick: number): ArchetypeOutput {
  if (isOnCooldown(agent, currentTick)) return { intent: null, nextAgent: agent, seed };

  // Private noisy observation. Reads latent truth but immediately corrupts
  // with Gaussian noise + EWMA smoothing — informed ≠ omniscient.
  const latentTrue = ctx.market.dynamics?.lastLatentTrueProbability ?? agent.obsLatent;
  const obs = noisyLatentObservation(latentTrue, agent.obsLatent, ctx.regime, seed);
  const obsLatent = obs.obsLatent;
  let nextSeed = obs.seed;

  // Noisy route shocks (informed sees them through a fog too).
  const routed = noisyRouteShockSignal(ctx.market, nextSeed);
  nextSeed = routed.seed;

  // Composite edge in cents. obsLatent − agent.obsLatent captures the change
  // in private belief this tick — proxy for "new info just arrived".
  const mispricing = mispricingScoreCents(ctx.market, obsLatent);
  const routeContribCents = INFORMED_ALPHA_ROUTE * routed.signal.sum * 100;
  const deltaCents = INFORMED_BETA_DELTA * (obsLatent - agent.obsLatent) * 100;
  const edge = mispricing + routeContribCents + deltaCents;

  if (Math.abs(edge) < INFORMED_DEAD_BAND_CENTS) {
    return {
      intent: null,
      nextAgent: { ...agent, obsLatent, cooldownUntilTick: currentTick + 1 },
      seed: nextSeed,
    };
  }

  const side: "BUY" | "SELL" = edge > 0 ? "BUY" : "SELL";
  const newDir: -1 | 1 = side === "BUY" ? 1 : -1;
  const conviction = clamp(
    Math.abs(edge) / (INFORMED_DEAD_BAND_CENTS * 3),
    0.3,
    1,
  );
  const sizeRaw = 1 + Math.floor((Math.abs(edge) / INFORMED_SIZE_STEP_CENTS) * conviction);
  const size = Math.max(1, Math.min(3, sizeRaw));
  const mid = midCents(ctx.market);

  return {
    intent: { kind: "market", side, qty: size, priceCents: mid },
    nextAgent: {
      ...agent,
      obsLatent,
      cooldownUntilTick: nextCooldown(currentTick, conviction),
      recentDir: newDir,
      conviction,
      position: agent.position + newDir * size,
      lastActedTick: currentTick,
    },
    seed: nextSeed,
  };
}

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
  agent: AgentState,
  seed: number,
  currentTick: number,
): ArchetypeOutput {
  switch (archetype) {
    case "noise":
      return runNoise(ctx, agent, seed, currentTick);
    case "liquidity_provider":
      return runPassive(ctx, agent, seed, currentTick, "lp");
    case "patient_value":
      return runPassive(ctx, agent, seed, currentTick, "patient");
    case "mean_reversion":
      return runPassive(ctx, agent, seed, currentTick, "mean_reversion");
    case "momentum":
      return runMomentum(ctx, agent, seed, currentTick);
    case "inventory_rebalancer":
      return runRebalancer(ctx, agent, seed, currentTick);
    case "event_follower":
      return runTaker(ctx, agent, seed, currentTick, "event_follower");
    case "panic":
      return runTaker(ctx, agent, seed, currentTick, "panic");
    case "latency_arb":
      return runTaker(ctx, agent, seed, currentTick, "latency_arb");
    case "informed_transit":
      return runInformed(ctx, agent, seed, currentTick);
  }
}

// Suppress unused-import warning for COOLDOWN_BASE_TICKS — only referenced
// indirectly through nextCooldown.
void COOLDOWN_BASE_TICKS;
