import type { EventKind, Severity } from "../types";

// Central configuration for the dynamic event generator. Mirrors the style of
// `dynamicsConfig.ts` — frozen-as-const so consumers get literal types.
//
// Design rules baked into this config:
//   - World state only. No coefficient here multiplies forecastProb /
//     confidence / posture — those are desk belief, not world inputs.
//   - Spawn rate is composed from state signals and then squashed through
//     a sigmoid + hard cap so the loop can't self-excite.
//   - Kind selection is a scoring sum (state * weight). Tables stay tiny
//     and only carry per-kind base weights; everything else multiplies in.
//   - Recovery is a probability rolled every tick on every shocked route,
//     not a deterministic follow-up promise.
//   - WEATHER is driven exclusively by exogenous stress signals — never
//     by any single route's pressure.

export const EVENT_GEN_CONFIG = {
  // ── Spawn gate ─────────────────────────────────────────────────────────
  // Composed score → sigmoid → clamped probability. `bias` sets the rate
  // when every input is zero; `softMaxRate` caps the post-sigmoid output.
  spawn: {
    bias: -2.4,                  // sigmoid(-2.4) ≈ 0.083 baseline
    softMaxRate: 0.28,           // hard ceiling on per-tick spawn probability
    weights: {
      // Each weight is the score contribution per unit input. All inputs are
      // bounded so the unsquashed score also stays bounded — no runaway.
      networkStressNetBias: 6.0,        // stress.netBias ∈ ~[-0.03, 0.04]
      meanRouteVolatility: 14.0,        // mean volatilityEstimate ∈ [0, ~0.05]
      maxRouteVolatility: 8.0,
      shockedRouteFraction: 1.8,        // fraction of routes with any live shock
      systemShockMagnitude: 4.5,        // Σ |live shock remaining| across all markets
    },
  },

  // ── Route pressure (used to choose origin route) ────────────────────────
  // Weighted sum of *world* signals. No forecastProb. Floor ensures every
  // route has nonzero pick probability.
  routePressure: {
    weights: {
      volatility: 12.0,                 // volatilityEstimate
      liveShockMagnitude: 6.0,          // |Σ live eventMemory.remaining|
      regimeBoost: { calm: 0.0, alert: 0.6, shock: 1.4, recovery: 0.2 },
      latentDeviation: 3.5,             // |latentTrueProbability - longRunBase|
      stressBias: 1.4,                  // stress.netBias rectified (≥ 0)
    },
    epsilonFloor: 0.05,
  },

  // ── Recovery probability (per-route, rolled every tick) ─────────────────
  // Replaces the old deterministic pendingClears scheduler. A route with
  // active live shock gets a small chance each tick to emit a CLEAR. The
  // chance grows with shock load and shrinks while regime is still "shock"
  // (recoveries don't happen mid-crisis).
  recovery: {
    minShockMagnitude: 0.03,            // below this, no CLEAR rolls
    bias: -3.0,                          // sigmoid(-3) ≈ 0.047 idle floor
    softMaxRate: 0.22,
    weights: {
      shockMagnitude: 9.0,              // |live shock| on the candidate route
      ticksSinceShock: 0.012,           // age (per tick)
      regimeBoost: { calm: 0.6, alert: 0.5, shock: -0.4, recovery: 1.2 },
    },
    // Magnitude returned in the CLEAR event. Tracks (a fraction of) the
    // current shock load so the recovery is calibrated, not arbitrary.
    magnitudeShare: 0.55,
    maxMagnitude: 0.14,
  },

  // ── Kind selection (scoring) ────────────────────────────────────────────
  // Score per non-CLEAR kind = baseWeight + Σ (state * stateWeight). The
  // top score, with softmax temperature, gets picked. Tables are tiny and
  // only carry per-kind feature responses, not per-context priors.
  kindScoring: {
    baseWeights: {
      DELAY: 1.4,
      SIGNAL: 1.2,
      SICK_PASSENGER: 1.0,
      POLICE: 0.4,
      RIDERSHIP: 0.6,
      WEATHER: 0.0,                     // gated separately (see weatherGate)
      CLEAR: 0.0,                       // handled by the recovery loop
    } satisfies Record<EventKind, number>,
    // Each feature has a per-kind sensitivity. Positive → that feature
    // makes the kind more likely; negative → less.
    rushHourIntensity: {
      DELAY: 0.9, SIGNAL: 1.1, SICK_PASSENGER: 0.8,
      POLICE: 0.2, RIDERSHIP: 1.6, WEATHER: 0.0, CLEAR: 0.0,
    } satisfies Record<EventKind, number>,
    lateNight: {
      DELAY: -0.2, SIGNAL: -0.1, SICK_PASSENGER: 0.4,
      POLICE: 0.7, RIDERSHIP: -1.2, WEATHER: 0.0, CLEAR: 0.0,
    } satisfies Record<EventKind, number>,
    weekend: {
      DELAY: -0.1, SIGNAL: -0.05, SICK_PASSENGER: 0.0,
      POLICE: 0.3, RIDERSHIP: -0.4, WEATHER: 0.0, CLEAR: 0.0,
    } satisfies Record<EventKind, number>,
    maintenanceIntensity: {
      DELAY: 0.8, SIGNAL: 0.9, SICK_PASSENGER: -0.1,
      POLICE: 0.0, RIDERSHIP: -0.6, WEATHER: 0.0, CLEAR: 0.0,
    } satisfies Record<EventKind, number>,
    routeVolatility: {
      // High vol pushes toward harder disruption kinds.
      DELAY: 8.0, SIGNAL: 7.0, SICK_PASSENGER: 2.0,
      POLICE: 1.0, RIDERSHIP: 0.0, WEATHER: 0.0, CLEAR: 0.0,
    } satisfies Record<EventKind, number>,
    softmaxTemperature: 0.9,            // <1 sharpens, >1 flattens
  },

  // ── Severity scoring ────────────────────────────────────────────────────
  // Score per severity (1/2/3) from state. Softmax pick. CLEAR overrides.
  severityScoring: {
    base: { 1: 1.4, 2: 1.0, 3: 0.2 } satisfies Record<Severity, number>,
    // Higher vol shifts mass toward sev-2/3.
    routeVolatility: { 1: -8.0, 2: 4.0, 3: 18.0 } satisfies Record<Severity, number>,
    rushHourIntensity: { 1: -0.2, 2: 0.4, 3: 0.5 } satisfies Record<Severity, number>,
    liveShockMagnitude: { 1: -3.0, 2: 1.5, 3: 5.0 } satisfies Record<Severity, number>,
    regime: {
      calm: { 1: 0.4, 2: -0.2, 3: -0.6 } satisfies Record<Severity, number>,
      alert: { 1: 0.0, 2: 0.4, 3: 0.1 } satisfies Record<Severity, number>,
      shock: { 1: -0.4, 2: 0.5, 3: 0.9 } satisfies Record<Severity, number>,
      recovery: { 1: 0.6, 2: 0.0, 3: -0.5 } satisfies Record<Severity, number>,
    },
    softmaxTemperature: 0.85,
  },

  // ── Impact magnitudes ───────────────────────────────────────────────────
  // Magnitude of the disruption applied to the origin route, signed.
  // Topology weights fan it out to neighbors with attenuation.
  severityImpactMagnitude: { 1: 0.04, 2: 0.08, 3: 0.15 } satisfies Record<Severity, number>,

  topologyFanout: {
    originWeight: 1.0,
    minNeighborWeight: 0.05,
    maxNeighbors: 6,
  },

  // ── Weather gate (exogenous only) ───────────────────────────────────────
  // Per-tick probability of a systemwide WEATHER event. Conditioned ONLY
  // on stress.netBias (already exogenous: hour / day / maintenance), never
  // on route-local pressure. Capped low so it's a rare event.
  weatherGate: {
    bias: -6.0,                          // sigmoid(-6) ≈ 0.0025
    softMaxRate: 0.012,
    weights: {
      // Weather risk index built from stress signals only. The reducer
      // can be extended later to feed real precip; for now we use a
      // proxy from rush+maintenance windows. All inputs deterministic.
      maintenanceIntensity: 0.6,
      lateNight: 0.3,
      weekend: 0.2,
    },
    perRouteShare: 0.03,
    severityWeights: { 1: 1.0, 2: 0.7, 3: 0.25 } satisfies Record<Severity, number>,
  },

  // ── Vol-spike trigger ───────────────────────────────────────────────────
  // Probability of starting a vol-spike, conditioned on world state. Linear
  // start with sigmoid + cap, same as spawn.
  volSpike: {
    bias: -5.6,
    softMaxRate: 0.012,
    weights: {
      meanRouteVolatility: 18.0,
      shockedRouteFraction: 1.4,
    },
    lengthTicks: 22,
  },

  // ── Route anchors (structured tokens, NOT scenarios) ────────────────────
  // 1–3 station/area nouns per route. Picked by seeded pick() in the text
  // formatter. Empty array means "no anchor" — text falls back to lineLabel.
  routeAnchors: {
    "1": ["96 St", "Times Sq", "Chambers"],
    "2": ["Penn Sta", "Chambers", "Wall St"],
    "3": ["Chambers", "Times Sq"],
    "4": ["86 St", "Grand Central", "Union Sq"],
    "5": ["Grand Central", "Union Sq", "Atlantic Av"],
    "6": ["Hunts Pt", "Grand Central", "33 St"],
    "7": ["Queensboro Plaza", "Flushing-Main St", "Court Sq"],
    A: ["W 4 St", "Jay St", "Broadway Junction"],
    B: ["34 St", "W 4 St"],
    C: ["Jay St", "W 4 St"],
    D: ["Atlantic Av", "34 St"],
    E: ["WTC", "Jay St", "Queens Plaza"],
    F: ["W 4 St", "Jay St", "Roosevelt Av"],
    G: ["Court Sq", "Bedford-Nostrand", "Hoyt-Schermerhorn"],
    J: ["Marcy Av", "Broadway Junction"],
    Z: ["Marcy Av", "Broadway Junction"],
    L: ["Bedford Av", "Union Sq", "8 Av"],
    M: ["Myrtle-Wyckoff", "W 4 St"],
    N: ["Queensboro Plaza", "Canal St", "Atlantic Av"],
    Q: ["57 St", "Times Sq", "Atlantic Av"],
    R: ["Bay Ridge", "Canal St", "Atlantic Av"],
    W: ["Astoria", "Queensboro Plaza"],
    S: ["42 St Shuttle", "Franklin Av"],
  } as Record<string, readonly string[]>,

  // ── Text patterns (per kind × severity) ─────────────────────────────────
  // Templated phrases with kind-specific verbs and severity adjectives.
  // Slots: ${line} (lineLabel), ${anchor} (optional). Composed by the
  // generator's formatEventText — no narrative tables.
  textPatterns: {
    DELAY: {
      1: "Minor delay · ${line}${anchorParen}",
      2: "Delay · ${line}${anchorParen}",
      3: "Major delay · ${line}${anchorParen}",
    },
    SIGNAL: {
      1: "Brief signal trouble · ${line}${anchorParen}",
      2: "Signal trouble · ${line}${anchorParen}",
      3: "Severe signal failure · ${line}${anchorParen}",
    },
    SICK_PASSENGER: {
      1: "Minor sick-passenger delay · ${line}${anchorParen}",
      2: "Sick passenger holding train · ${line}${anchorParen}",
      3: "Medical hold extended · ${line}${anchorParen}",
    },
    POLICE: {
      1: "NYPD activity · ${line}${anchorParen}",
      2: "Police investigation · ${line}${anchorParen}",
      3: "NYPD investigation extended · ${line}${anchorParen}",
    },
    RIDERSHIP: {
      1: "Heavier crowding · ${line}${anchorParen}",
      2: "Platform overflow · ${line}${anchorParen}",
      3: "Crowd surge · ${line}${anchorParen}",
    },
    WEATHER: {
      1: "Rain advisory · systemwide impact",
      2: "Heavy rain · systemwide impact",
      3: "Flood watch · systemwide impact",
    },
    CLEAR: {
      1: "${line} delays clearing${anchorParen}",
      2: "${line} service resuming${anchorParen}",
      3: "${line} service restored${anchorParen}",
    },
  } satisfies Record<EventKind, Record<Severity, string>>,
} as const;

export type EventGenConfig = typeof EVENT_GEN_CONFIG;

export function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}
