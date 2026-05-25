import type { AgentSlotKey, AgentState, TraderArchetype } from "../../types";
import {
  COOLDOWN_BASE_TICKS,
  COOLDOWN_CONVICTION_GAIN,
  COOLDOWN_MIN_TICKS,
} from "./config";

// Map an external archetype onto its behavioral role slot. Several archetypes
// share a slot (so they share per-market memory): the three passive variants
// share `passive`; the three takers (event_follower / panic / latency_arb)
// share `taker`.
const ARCHETYPE_SLOT: Record<Exclude<TraderArchetype, "desk_actor">, AgentSlotKey> = {
  noise: "noise",
  liquidity_provider: "passive",
  patient_value: "passive",
  mean_reversion: "passive",
  momentum: "momentum",
  inventory_rebalancer: "rebalancer",
  event_follower: "taker",
  panic: "taker",
  latency_arb: "taker",
  informed_transit: "informed",
};

export function archetypeToSlot(
  archetype: Exclude<TraderArchetype, "desk_actor">,
): AgentSlotKey {
  return ARCHETYPE_SLOT[archetype];
}

export function initialAgentState(seedObsLatent: number): AgentState {
  return {
    cooldownUntilTick: 0,
    recentDir: 0,
    conviction: 0.5,
    position: 0,
    obsLatent: seedObsLatent,
    lastActedTick: -1000,
  };
}

export function initialAgents(seedObsLatent: number): Record<AgentSlotKey, AgentState> {
  return {
    informed: initialAgentState(seedObsLatent),
    momentum: initialAgentState(seedObsLatent),
    noise: initialAgentState(seedObsLatent),
    rebalancer: initialAgentState(seedObsLatent),
    taker: initialAgentState(seedObsLatent),
    passive: initialAgentState(seedObsLatent),
  };
}

// Self-heal hook for hot reloads / persisted state where the agents map may
// be missing or partial. Always returns a fully-populated record.
export function safeAgents(
  agents: Partial<Record<AgentSlotKey, AgentState>> | undefined,
  seedObsLatent: number,
): Record<AgentSlotKey, AgentState> {
  const base = initialAgents(seedObsLatent);
  if (!agents) return base;
  const out: Record<AgentSlotKey, AgentState> = { ...base };
  (Object.keys(base) as AgentSlotKey[]).forEach((k) => {
    const s = agents[k];
    if (s && typeof s === "object") {
      out[k] = {
        cooldownUntilTick: Number.isFinite(s.cooldownUntilTick) ? s.cooldownUntilTick : 0,
        recentDir: (s.recentDir === -1 || s.recentDir === 1 ? s.recentDir : 0) as -1 | 0 | 1,
        conviction: Number.isFinite(s.conviction) ? Math.max(0, Math.min(1, s.conviction)) : 0.5,
        position: Number.isFinite(s.position) ? s.position : 0,
        obsLatent: Number.isFinite(s.obsLatent) ? s.obsLatent : seedObsLatent,
        lastActedTick: Number.isFinite(s.lastActedTick) ? s.lastActedTick : -1000,
      };
    }
  });
  return out;
}

// Compute the next cooldownUntilTick from current tick + conviction. Higher
// conviction shortens cooldown so confident agents can re-fire faster.
export function nextCooldown(currentTick: number, conviction: number): number {
  const ticks = Math.max(
    COOLDOWN_MIN_TICKS,
    Math.round(COOLDOWN_BASE_TICKS - COOLDOWN_CONVICTION_GAIN * conviction),
  );
  return currentTick + ticks;
}

export function isOnCooldown(agent: AgentState, currentTick: number): boolean {
  return currentTick < agent.cooldownUntilTick;
}
