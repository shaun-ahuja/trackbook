import type {
  EventKind,
  Market,
  NetworkStressContext,
  Severity,
  SimState,
  TransitEvent,
} from "../types";
import { pick, rand, randInt } from "../rng";
import { EVENT_GEN_CONFIG, sigmoid } from "./eventGenerationConfig";
import { neighborsOf } from "./topology";
import { safeDynamicsState } from "./probabilityDynamics";

// Dynamic event generation engine.
//
// Pure, deterministic, seed-threaded. Same `(state, stress, seed, now, tick)`
// → same `(event | null, seed')`. World-state only — no read of forecastProb,
// confidence, or desk posture anywhere in this file. See
// `feedback_world_vs_belief.md`.
//
// Composition pipeline:
//   shouldSpawn         spawn gate (sigmoid + cap on world signals)
//   maybeWeather        exogenous-stress-only systemwide WEATHER event
//   rollRecovery        per-route probabilistic CLEAR roll (replaces deterministic follow-ups)
//   selectOriginRoute   weighted pick by per-route pressure (no belief)
//   selectKind          softmax over per-kind score from world state
//   selectSeverity      softmax over severity scores
//   buildImpacts        topology fan-out from origin
//   formatEventText     templated phrase from kind × severity + structured tokens

const C = EVENT_GEN_CONFIG;

// ── helpers ────────────────────────────────────────────────────────────────

function liveShockMag(m: Market): number {
  const d = safeDynamicsState(m.dynamics, 0);
  let s = 0;
  for (const sm of d.eventMemory) if (sm.category === "live") s += sm.remaining;
  return s;
}

function rectified(x: number): number {
  return x > 0 ? x : 0;
}

function systemSignals(state: SimState): {
  meanVol: number;
  maxVol: number;
  shockedRouteFraction: number;
  systemShockMagnitude: number;
} {
  let sumVol = 0;
  let maxVol = 0;
  let shocked = 0;
  let sumShockMag = 0;
  const n = state.marketOrder.length || 1;
  for (const id of state.marketOrder) {
    const m = state.markets[id];
    if (!m) continue;
    const d = safeDynamicsState(m.dynamics, 0);
    const v = d.volatilityEstimate;
    sumVol += v;
    if (v > maxVol) maxVol = v;
    const mag = Math.abs(liveShockMag(m));
    sumShockMag += mag;
    if (mag > 0.01) shocked++;
  }
  return {
    meanVol: sumVol / n,
    maxVol,
    shockedRouteFraction: shocked / n,
    systemShockMagnitude: sumShockMag,
  };
}

// Softmax over a record; returns the picked key.
function softmaxPick<K extends string>(
  scores: Record<K, number>,
  temperature: number,
  seed: number,
): { v: K; seed: number } {
  const keys = Object.keys(scores) as K[];
  let maxScore = -Infinity;
  for (const k of keys) if (scores[k] > maxScore) maxScore = scores[k];
  const t = Math.max(1e-6, temperature);
  const exps: number[] = [];
  let sum = 0;
  for (const k of keys) {
    const e = Math.exp((scores[k] - maxScore) / t);
    exps.push(e);
    sum += e;
  }
  const r = rand(seed);
  let target = r.v * sum;
  for (let i = 0; i < keys.length; i++) {
    target -= exps[i];
    if (target <= 0) return { v: keys[i], seed: r.seed };
  }
  return { v: keys[keys.length - 1], seed: r.seed };
}

function nextId(seed: number, now: number): { id: string; seed: number } {
  const r = randInt(seed, 0, 0x7fffffff);
  return { id: `e_${now}_${r.v.toString(36)}`, seed: r.seed };
}

// ── spawn gate ─────────────────────────────────────────────────────────────

export function shouldSpawn(
  state: SimState,
  stress: NetworkStressContext,
  seed: number,
): { fire: boolean; seed: number } {
  const sig = systemSignals(state);
  const w = C.spawn.weights;
  const score =
    C.spawn.bias +
    w.networkStressNetBias * stress.netBias +
    w.meanRouteVolatility * sig.meanVol +
    w.maxRouteVolatility * sig.maxVol +
    w.shockedRouteFraction * sig.shockedRouteFraction +
    w.systemShockMagnitude * Math.min(sig.systemShockMagnitude, 1.5);
  const p = Math.min(C.spawn.softMaxRate, sigmoid(score));
  const r = rand(seed);
  return { fire: r.v < p, seed: r.seed };
}

// ── route pressure & origin selection ──────────────────────────────────────

function routePressure(
  market: Market,
  stress: NetworkStressContext,
): number {
  const d = safeDynamicsState(market.dynamics, 0);
  const w = C.routePressure.weights;
  const regime = market.regimeState?.regime ?? "calm";
  const liveMag = Math.abs(liveShockMag(market));
  const latentDev = Math.abs(
    d.lastLatentTrueProbability - d.longRunBaseProbability,
  );
  const score =
    w.volatility * d.volatilityEstimate +
    w.liveShockMagnitude * liveMag +
    (w.regimeBoost[regime] ?? 0) +
    w.latentDeviation * latentDev +
    w.stressBias * rectified(stress.netBias);
  return Math.max(C.routePressure.epsilonFloor, score);
}

function selectOriginRoute(
  state: SimState,
  stress: NetworkStressContext,
  seed: number,
): { route: string; seed: number } {
  const weights: number[] = [];
  let sum = 0;
  for (const id of state.marketOrder) {
    const m = state.markets[id];
    const w = m ? routePressure(m, stress) : C.routePressure.epsilonFloor;
    weights.push(w);
    sum += w;
  }
  const r = rand(seed);
  let target = r.v * sum;
  for (let i = 0; i < state.marketOrder.length; i++) {
    target -= weights[i];
    if (target <= 0) return { route: state.marketOrder[i], seed: r.seed };
  }
  return {
    route: state.marketOrder[state.marketOrder.length - 1],
    seed: r.seed,
  };
}

// ── kind selection (scoring) ───────────────────────────────────────────────

const KINDS_FOR_DISRUPTION: EventKind[] = [
  "DELAY",
  "SIGNAL",
  "SICK_PASSENGER",
  "POLICE",
  "RIDERSHIP",
];

function selectKind(
  market: Market,
  stress: NetworkStressContext,
  seed: number,
): { kind: EventKind; seed: number } {
  const d = safeDynamicsState(market.dynamics, 0);
  const ks = C.kindScoring;
  const scores: Record<string, number> = {};
  for (const k of KINDS_FOR_DISRUPTION) {
    scores[k] =
      ks.baseWeights[k] +
      ks.rushHourIntensity[k] * stress.rushHourIntensity +
      (stress.isLateNight ? ks.lateNight[k] : 0) +
      (stress.isWeekend ? ks.weekend[k] : 0) +
      ks.maintenanceIntensity[k] * stress.maintenanceIntensity +
      ks.routeVolatility[k] * d.volatilityEstimate;
  }
  const picked = softmaxPick(
    scores,
    ks.softmaxTemperature,
    seed,
  );
  return { kind: picked.v as EventKind, seed: picked.seed };
}

// ── severity selection (scoring) ───────────────────────────────────────────

function selectSeverity(
  market: Market,
  stress: NetworkStressContext,
  seed: number,
): { severity: Severity; seed: number } {
  const d = safeDynamicsState(market.dynamics, 0);
  const liveMag = Math.abs(liveShockMag(market));
  const regime = market.regimeState?.regime ?? "calm";
  const ss = C.severityScoring;
  const scores: Record<string, number> = {};
  for (const s of [1, 2, 3] as Severity[]) {
    scores[String(s)] =
      ss.base[s] +
      ss.routeVolatility[s] * d.volatilityEstimate +
      ss.rushHourIntensity[s] * stress.rushHourIntensity +
      ss.liveShockMagnitude[s] * liveMag +
      ss.regime[regime][s];
  }
  const picked = softmaxPick(scores, ss.softmaxTemperature, seed);
  return { severity: Number(picked.v) as Severity, seed: picked.seed };
}

// ── impacts (topology fan-out) ─────────────────────────────────────────────

function buildImpacts(
  originRoute: string,
  signedMagnitude: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  const fanout = C.topologyFanout;
  out[originRoute] = signedMagnitude * fanout.originWeight;

  const ns = neighborsOf(originRoute);
  const entries = Object.entries(ns)
    .filter(([id, w]) => id !== originRoute && w >= fanout.minNeighborWeight)
    .sort((a, b) => b[1] - a[1])
    .slice(0, fanout.maxNeighbors);
  for (const [id, w] of entries) {
    out[id] = signedMagnitude * w;
  }
  return out;
}

// ── text formatting ────────────────────────────────────────────────────────

function formatEventText(
  kind: EventKind,
  severity: Severity,
  lineLabel: string,
  anchor: string | null,
): string {
  const tmpl = C.textPatterns[kind][severity];
  const anchorParen = anchor ? ` (${anchor})` : "";
  return tmpl
    .replace("${line}", lineLabel)
    .replace("${anchorParen}", anchorParen);
}

function pickAnchor(
  routeId: string,
  seed: number,
): { anchor: string | null; seed: number } {
  const anchors = C.routeAnchors[routeId];
  if (!anchors || anchors.length === 0) return { anchor: null, seed };
  const p = pick(seed, anchors);
  return { anchor: p.v, seed: p.seed };
}

// ── recovery (probabilistic, per-tick per-route) ───────────────────────────

type RecoveryCandidate = {
  probability: number;
  magnitude: number;
  liveMag: number;
};

function recoveryCandidate(market: Market): RecoveryCandidate | null {
  const liveSigned = liveShockMag(market);
  const liveMag = Math.abs(liveSigned);
  if (liveMag < C.recovery.minShockMagnitude) return null;

  const ticksSinceShock = market.regimeState?.ticksSinceShock ?? 999;
  const regime = market.regimeState?.regime ?? "calm";
  const w = C.recovery.weights;
  const score =
    C.recovery.bias +
    w.shockMagnitude * liveMag +
    w.ticksSinceShock * Math.min(ticksSinceShock, 60) +
    (w.regimeBoost[regime] ?? 0);
  const probability = Math.min(C.recovery.softMaxRate, sigmoid(score));
  const magnitude =
    -Math.sign(liveSigned) *
    Math.min(C.recovery.maxMagnitude, liveMag * C.recovery.magnitudeShare);
  return { probability, magnitude, liveMag };
}

function rollRecovery(
  state: SimState,
  seed: number,
  now: number,
): { event: TransitEvent | null; seed: number } {
  for (const id of state.marketOrder) {
    const m = state.markets[id];
    if (!m) continue;
    const cand = recoveryCandidate(m);
    if (!cand) continue;

    const r = rand(seed);
    seed = r.seed;
    if (r.v >= cand.probability) continue;

    // Pick severity for the CLEAR text: small magnitude → sev 1, larger → sev 2/3.
    const sev: Severity =
      cand.liveMag > 0.1 ? 3 : cand.liveMag > 0.05 ? 2 : 1;
    const anchorR = pickAnchor(id, seed);
    seed = anchorR.seed;
    const idR = nextId(seed, now);
    seed = idR.seed;

    const lineLabel = m.lineLabel;
    const impacts = buildImpacts(id, cand.magnitude);
    const event: TransitEvent = {
      id: idR.id,
      ts: now,
      line: m.line,
      kind: "CLEAR",
      severity: sev,
      text: formatEventText("CLEAR", sev, lineLabel, anchorR.anchor),
      impacts,
      source: "synthetic",
      category: "live",
    };
    return { event, seed };
  }
  return { event: null, seed };
}

// ── weather (exogenous only) ───────────────────────────────────────────────

function rollWeather(
  state: SimState,
  stress: NetworkStressContext,
  seed: number,
  now: number,
): { event: TransitEvent | null; seed: number } {
  const w = C.weatherGate.weights;
  const score =
    C.weatherGate.bias +
    w.maintenanceIntensity * stress.maintenanceIntensity +
    (stress.isLateNight ? w.lateNight : 0) +
    (stress.isWeekend ? w.weekend : 0);
  const p = Math.min(C.weatherGate.softMaxRate, sigmoid(score));
  const r = rand(seed);
  seed = r.seed;
  if (r.v >= p) return { event: null, seed };

  // Severity from configured weights (softmax pick).
  const sevScores: Record<string, number> = {};
  for (const s of [1, 2, 3] as Severity[]) {
    sevScores[String(s)] = Math.log(Math.max(1e-6, C.weatherGate.severityWeights[s]));
  }
  const sevR = softmaxPick(sevScores, 1, seed);
  seed = sevR.seed;
  const severity = Number(sevR.v) as Severity;

  // Distribute share across every market. Negative is impossible here (live).
  const mag = C.weatherGate.perRouteShare * (severity === 3 ? 1.6 : severity === 2 ? 1.0 : 0.6);
  const impacts: Record<string, number> = {};
  for (const id of state.marketOrder) impacts[id] = mag;

  const idR = nextId(seed, now);
  seed = idR.seed;

  const event: TransitEvent = {
    id: idR.id,
    ts: now,
    line: "WX",
    kind: "WEATHER",
    severity,
    text: formatEventText("WEATHER", severity, "systemwide", null),
    impacts,
    source: "synthetic",
    category: "live",
  };
  return { event, seed };
}

// ── orchestrator ───────────────────────────────────────────────────────────

export function generateEvent(
  state: SimState,
  stress: NetworkStressContext,
  seed: number,
  now: number,
): { event: TransitEvent | null; seed: number } {
  // 1) Weather rolls first — exogenous-only, can fire independently of spawn gate.
  const weather = rollWeather(state, stress, seed, now);
  seed = weather.seed;
  if (weather.event) return { event: weather.event, seed };

  // 2) Recovery rolls — per-route probabilistic CLEAR. Iterates routes in
  //    marketOrder so the first eligible recovery wins this tick. Avoids
  //    multiple CLEARs in a single tick.
  const recovery = rollRecovery(state, seed, now);
  seed = recovery.seed;
  if (recovery.event) return { event: recovery.event, seed };

  // 3) Spawn gate — sigmoid-damped on world-state signals.
  const gate = shouldSpawn(state, stress, seed);
  seed = gate.seed;
  if (!gate.fire) return { event: null, seed };

  // 4) Pick origin route by world-pressure weights.
  const origin = selectOriginRoute(state, stress, seed);
  seed = origin.seed;
  const market = state.markets[origin.route];
  if (!market) return { event: null, seed };

  // 5) Kind + severity from state-conditioned scoring.
  const kindR = selectKind(market, stress, seed);
  seed = kindR.seed;
  const sevR = selectSeverity(market, stress, seed);
  seed = sevR.seed;

  // 6) Magnitude + topology fan-out.
  const signedMag = C.severityImpactMagnitude[sevR.severity];
  const impacts = buildImpacts(origin.route, signedMag);

  // 7) Text from structured tokens.
  const anchorR = pickAnchor(origin.route, seed);
  seed = anchorR.seed;
  const idR = nextId(seed, now);
  seed = idR.seed;

  const event: TransitEvent = {
    id: idR.id,
    ts: now,
    line: market.line,
    kind: kindR.kind,
    severity: sevR.severity,
    text: formatEventText(
      kindR.kind,
      sevR.severity,
      market.lineLabel,
      anchorR.anchor,
    ),
    impacts,
    source: "synthetic",
    category: "live",
  };
  return { event, seed };
}

// ── vol-spike trigger (state-conditioned, sigmoid-damped) ──────────────────

export function rollVolSpikeStart(
  state: SimState,
  seed: number,
): { fire: boolean; seed: number; lengthTicks: number } {
  const sig = systemSignals(state);
  const w = C.volSpike.weights;
  const score =
    C.volSpike.bias +
    w.meanRouteVolatility * sig.meanVol +
    w.shockedRouteFraction * sig.shockedRouteFraction;
  const p = Math.min(C.volSpike.softMaxRate, sigmoid(score));
  const r = rand(seed);
  return {
    fire: r.v < p,
    seed: r.seed,
    lengthTicks: C.volSpike.lengthTicks,
  };
}
