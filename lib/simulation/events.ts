import type {
  NetworkStressContext,
  Regime,
  SimState,
  TransitEvent,
} from "../types";
import { generateEvent, rollVolSpikeStart } from "./eventGenerator";

// Thin orchestrator over `eventGenerator`. The hardcoded TEMPLATES table
// that used to live here is gone — everything is now generated from world
// state. See `eventGenerator.ts` for the choice points and
// `eventGenerationConfig.ts` for tunable weights.
//
// What stays here:
//   - The `Regime` FSM scratchpad (vol-spike counter, legacy fields).
//   - `safeRegime` self-heal across hot reloads.
//   - The reducer-facing `tickEvents` entry point.

export const VOL_SPIKE_MULTIPLIER = 1.8;

export function emptyRegime(): Regime {
  return {
    activeLine: null,
    ticksRemaining: 0,
    intensity: 0,
    volSpikeTicksRemaining: 0,
    pendingClears: [],
  };
}

// Self-heal: hot-reload may leave `regime` undefined or partial on SimState.
function safeRegime(regime: Regime | undefined): Regime {
  if (!regime) return emptyRegime();
  return {
    activeLine: regime.activeLine ?? null,
    ticksRemaining: Number.isFinite(regime.ticksRemaining)
      ? regime.ticksRemaining
      : 0,
    intensity: Number.isFinite(regime.intensity) ? regime.intensity : 0,
    volSpikeTicksRemaining: Number.isFinite(regime.volSpikeTicksRemaining)
      ? regime.volSpikeTicksRemaining
      : 0,
    pendingClears: Array.isArray(regime.pendingClears)
      ? regime.pendingClears.filter(
          (p): p is { route: string; atTick: number; magnitude: number } =>
            typeof p?.route === "string" &&
            Number.isFinite(p?.atTick) &&
            Number.isFinite(p?.magnitude),
        )
      : [],
  };
}

// Advance the regime state and (maybe) generate an event.
//
// Sequence per tick:
//   1) Decrement counters; clear expired `activeLine`/intensity.
//   2) Flush any pendingClear whose atTick has arrived. (Generator's
//      preferred recovery path is the per-tick probabilistic roll inside
//      `generateEvent`, but we still honor scheduled clears if anything
//      enqueues them — they stay supported, just unused by default.)
//   3) If `spawn`, roll a vol-spike start conditioned on world signals.
//   4) If `spawn`, delegate to `generateEvent`. The generator handles
//      weather, recovery rolls, the spawn gate, and the disruption pick.
//
// When `spawn` is false (MTA-only mode, or hybrid while MTA is fresh),
// counters and pendingClears still advance but no synthetic event fires.
export function tickEvents(
  regimeIn: Regime | undefined,
  state: SimState,
  stress: NetworkStressContext,
  seed: number,
  now: number,
  currentTick: number,
  spawn: boolean = true,
): { event: TransitEvent | null; regime: Regime; seed: number } {
  const r0 = safeRegime(regimeIn);
  let regime: Regime = {
    ...r0,
    ticksRemaining: Math.max(0, r0.ticksRemaining - 1),
    volSpikeTicksRemaining: Math.max(0, r0.volSpikeTicksRemaining - 1),
  };
  if (regime.ticksRemaining === 0 && regime.activeLine) {
    regime = { ...regime, activeLine: null, intensity: 0 };
  }

  // Flush due pendingClears (rare — kept for forward-compat). The first due
  // entry wins this tick; the rest carry over.
  const dueIdx = regime.pendingClears.findIndex((p) => p.atTick <= currentTick);
  if (dueIdx >= 0) {
    const due = regime.pendingClears[dueIdx];
    const remaining = regime.pendingClears.filter((_, i) => i !== dueIdx);
    regime = { ...regime, pendingClears: remaining };
    const market = state.markets[due.route];
    if (market) {
      // Lightweight CLEAR built without the generator's recovery scoring —
      // we already committed to firing this. Use a sev-1 phrasing.
      const idR = Math.floor(seed % 0x7fffffff).toString(36);
      const event: TransitEvent = {
        id: `e_${now}_${idR}`,
        ts: now,
        line: market.line,
        kind: "CLEAR",
        severity: 1,
        text: `${market.lineLabel} delays clearing`,
        impacts: { [due.route]: due.magnitude },
        source: "synthetic",
        category: "live",
      };
      return { event, regime, seed };
    }
  }

  if (!spawn) return { event: null, regime, seed };

  // Vol-spike trigger — state-conditioned, damped.
  if (regime.volSpikeTicksRemaining === 0) {
    const v = rollVolSpikeStart(state, seed);
    seed = v.seed;
    if (v.fire) {
      regime = { ...regime, volSpikeTicksRemaining: v.lengthTicks };
    }
  }

  // Delegate to generator. It owns weather, recovery, spawn gate, and
  // disruption selection — all from world state.
  const gen = generateEvent(state, stress, seed, now);
  seed = gen.seed;

  // Informational: stamp the activeLine field with the most recent origin
  // route's line for debug UI. Not used for selection anywhere.
  if (gen.event && gen.event.source === "synthetic") {
    regime = { ...regime, activeLine: gen.event.line };
  }

  void currentTick;
  return { event: gen.event, regime, seed };
}
