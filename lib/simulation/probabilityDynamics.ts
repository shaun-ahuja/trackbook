import type {
  DriverContribution,
  Market,
  MarketRegime,
  NetworkStressContext,
  ProbabilityDynamicsState,
  ShockMemory,
  TransitEvent,
} from "../types";
import { clamp } from "../format";
import { DYNAMICS_CONFIG, liveHalfLifeFor } from "./dynamicsConfig";
import { neighborsOf } from "./topology";

// -------------------------------------------------------------------------
// Adaptive probability dynamics engine.
//
// Three layers, never collapsed:
//   longRunBaseProbability   immutable per market
//   adaptiveBaseProbability  stored, slow drift
//   latentTrueProbability    derived per tick = adaptiveBase + overlays
//
// Volatility is observational — scales jump caps + confidence, never a
// driving term. Regime is owned by regimeState; consumers dereference.
// All exported functions other than RNG-less helpers are pure / deterministic.
// -------------------------------------------------------------------------

const { bounds, meanReversion, shockDecay, regimeMult, volatility, maxBaseJump, latentRisk: LATENT_BOUNDS, driverListSize } = DYNAMICS_CONFIG;

function clampProb(p: number): number {
  return clamp(p, bounds.min, bounds.max);
}

function safeFinite(n: number | undefined, fallback: number): number {
  return Number.isFinite(n) ? (n as number) : fallback;
}

// -------- initialization --------

export function initializeMarketState(longRunBase: number): ProbabilityDynamicsState {
  const seed = clampProb(longRunBase);
  return {
    longRunBaseProbability: seed,
    adaptiveBaseProbability: seed,
    latentRisk: 0,
    volatilityEstimate: 0,
    eventMemory: [],
    lastUpdatedTick: 0,
    lastLatentTrueProbability: seed,
    prevLatentTrueProbability: seed,
    lastBaseDelta: 0,
    lastLatentDelta: 0,
    lastDrivers: [],
  };
}

// Self-heal stale or partial state (e.g. across hot reloads). Always returns
// a valid struct without throwing.
export function safeDynamicsState(
  d: ProbabilityDynamicsState | undefined,
  fallbackLongRun: number,
): ProbabilityDynamicsState {
  if (!d) return initializeMarketState(fallbackLongRun);
  return {
    longRunBaseProbability: safeFinite(d.longRunBaseProbability, fallbackLongRun),
    adaptiveBaseProbability: clampProb(safeFinite(d.adaptiveBaseProbability, fallbackLongRun)),
    latentRisk: clamp(safeFinite(d.latentRisk, 0), LATENT_BOUNDS.min, LATENT_BOUNDS.max),
    volatilityEstimate: Math.max(0, safeFinite(d.volatilityEstimate, 0)),
    eventMemory: Array.isArray(d.eventMemory) ? d.eventMemory.filter(isValidShock) : [],
    lastUpdatedTick: safeFinite(d.lastUpdatedTick, 0),
    lastLatentTrueProbability: clampProb(safeFinite(d.lastLatentTrueProbability, fallbackLongRun)),
    prevLatentTrueProbability: clampProb(
      safeFinite(d.prevLatentTrueProbability, safeFinite(d.lastLatentTrueProbability, fallbackLongRun)),
    ),
    lastBaseDelta: safeFinite(d.lastBaseDelta, 0),
    lastLatentDelta: safeFinite(d.lastLatentDelta, 0),
    lastDrivers: Array.isArray(d.lastDrivers) ? d.lastDrivers : [],
  };
}

function isValidShock(s: ShockMemory): boolean {
  return (
    typeof s?.id === "string" &&
    Number.isFinite(s.remaining) &&
    Number.isFinite(s.halfLife) &&
    s.halfLife > 0
  );
}

// -------- event ingestion --------

// Append a ShockMemory entry for an event's impact on this market. Half-life
// is derived from category + severity. Same-event re-injection (same id)
// refreshes the existing entry rather than stacking, to keep memory bounded.
export function applyEventShock(
  market: Market,
  event: TransitEvent,
  currentTick: number,
): Market {
  const delta = event.impacts[market.id];
  if (delta === undefined || delta === 0) return market;

  const category = event.category ?? "live";
  const halfLife =
    category === "planned"
      ? shockDecay.plannedHalfLife
      : category === "trip"
        ? shockDecay.tripHalfLife
        : liveHalfLifeFor(event.severity);

  const dynPrev = safeDynamicsState(market.dynamics, market.forecastProb);

  // Planned alerts also nudge the slow latentRisk channel. Live/trip events
  // do not — they live as transient shock overlays only.
  const nextLatentRisk =
    category === "planned"
      ? clamp(
          dynPrev.latentRisk + delta * 0.4,
          LATENT_BOUNDS.min,
          LATENT_BOUNDS.max,
        )
      : dynPrev.latentRisk;

  const existingIdx = dynPrev.eventMemory.findIndex((s) => s.id === event.id);
  const nextMemory: ShockMemory[] = [...dynPrev.eventMemory];
  const entry: ShockMemory = {
    id: event.id,
    originLine: event.line,
    category,
    severity: event.severity,
    kind: event.kind,
    remaining: delta,
    initial: delta,
    halfLife,
    bornTick: currentTick,
  };
  if (existingIdx >= 0) {
    // Refresh same-id event (CLEAR follow-ups or MTA dedupe).
    nextMemory[existingIdx] = entry;
  } else {
    nextMemory.push(entry);
  }

  return {
    ...market,
    dynamics: {
      ...dynPrev,
      eventMemory: nextMemory,
      latentRisk: nextLatentRisk,
    },
    lastImpactTs: event.ts,
    lastImpactMagnitude: delta,
  };
}

// Decay every memory entry by exp(-ln2 / halfLife) per tick, drop expired.
// Pure: returns a fresh array; never mutates input.
export function applyDecay(memory: ShockMemory[]): ShockMemory[] {
  const out: ShockMemory[] = [];
  for (const m of memory) {
    const decayFactor = Math.exp(-Math.LN2 / m.halfLife);
    const next = m.remaining * decayFactor;
    if (Math.abs(next) < shockDecay.expireEps) continue;
    out.push({ ...m, remaining: next });
  }
  return out;
}

function recentShockMagnitude(state: ProbabilityDynamicsState, currentTick: number): number {
  let s = 0;
  for (const m of state.eventMemory) {
    if (currentTick - m.bornTick <= shockDecay.contagionWindow) {
      s += m.remaining;
    }
  }
  return s;
}

// -------- contagion (computed once per tick) --------

// For each market, sum topology-weighted recent shocks from neighbors.
// Order-independent: reads each market's eventMemory at tick start.
export function computeContagion(
  markets: Record<string, Market>,
  marketOrder: readonly string[],
  currentTick: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  // Pre-compute each market's recent shock magnitude once.
  const recent: Record<string, number> = {};
  for (const id of marketOrder) {
    const m = markets[id];
    if (!m) continue;
    recent[id] = recentShockMagnitude(
      safeDynamicsState(m.dynamics, m.forecastProb),
      currentTick,
    );
  }
  for (const id of marketOrder) {
    const ns = neighborsOf(id);
    let sum = 0;
    for (const [neighborId, weight] of Object.entries(ns)) {
      const mag = recent[neighborId] ?? 0;
      sum += weight * mag;
    }
    out[id] = sum;
  }
  return out;
}

// -------- network stress (structured, deterministic) --------

const STRESS = DYNAMICS_CONFIG.networkStress;

function triangularPeak(x: number, peak: number, halfWidth: number): number {
  const d = Math.abs(x - peak);
  if (d >= halfWidth) return 0;
  return 1 - d / halfWidth;
}

export function computeNetworkStress(nowMs: number): NetworkStressContext {
  // Use NYC local time. Date inside V8 honors the system zone; fall back
  // gracefully when nowMs is 0 (e.g. uninitialized state).
  const d = new Date(nowMs || Date.now());
  const hour = d.getHours() + d.getMinutes() / 60;
  const day = d.getDay(); // 0 = Sun, 6 = Sat

  const inAm = hour >= STRESS.amHours[0] && hour < STRESS.amHours[1];
  const inPm = hour >= STRESS.pmHours[0] && hour < STRESS.pmHours[1];
  const isWeekend = STRESS.weekendDays.includes(day);

  // Rush hour only counts on weekdays — weekend AM/PM patterns are different.
  const isRushHour = (inAm || inPm) && !isWeekend;
  const rushHourIntensity = isRushHour
    ? Math.max(
        triangularPeak(hour, STRESS.amPeak, (STRESS.amHours[1] - STRESS.amHours[0]) / 2),
        triangularPeak(hour, STRESS.pmPeak, (STRESS.pmHours[1] - STRESS.pmHours[0]) / 2),
      )
    : 0;

  const isLateNight = hour >= STRESS.lateNightHours[0] && hour < STRESS.lateNightHours[1];

  // Maintenance window: Fri 22:00 → Sun 06:00.
  let inMaintenanceWindow = false;
  if (day === STRESS.maintenanceStartDay && hour >= STRESS.maintenanceStartHour) {
    inMaintenanceWindow = true;
  } else if (day === 6) {
    // All Saturday
    inMaintenanceWindow = true;
  } else if (day === STRESS.maintenanceEndDay && hour < STRESS.maintenanceEndHour) {
    inMaintenanceWindow = true;
  }
  const maintenanceIntensity = inMaintenanceWindow
    ? isLateNight
      ? 1.0
      : 0.5
    : 0;

  const netBias =
    rushHourIntensity * STRESS.rushHourBias +
    (isLateNight ? STRESS.lateNightBias : 0) +
    (isWeekend ? STRESS.weekendBias : 0) +
    maintenanceIntensity * STRESS.maintenanceBias;

  return {
    hourOfDay: hour,
    isRushHour,
    rushHourIntensity,
    isLateNight,
    isWeekend,
    inMaintenanceWindow,
    maintenanceIntensity,
    netBias,
  };
}

// -------- latent truth composition (derived) --------

// Pure derivation of the latent true probability. Returns the value plus
// the contributing drivers (sorted later by updateMarketState for display).
export function computeLatentTrueProbability(
  state: ProbabilityDynamicsState,
  contagionDelta: number,
  stress: NetworkStressContext,
  regime: MarketRegime,
): { value: number; drivers: DriverContribution[] } {
  let shockOverlay = 0;
  let dominantShockLabel = "";
  let dominantShockMag = 0;
  for (const m of state.eventMemory) {
    shockOverlay += m.remaining;
    if (Math.abs(m.remaining) > dominantShockMag) {
      dominantShockMag = Math.abs(m.remaining);
      dominantShockLabel = `${m.kind.toLowerCase()} sev${m.severity}`;
    }
  }

  const shockMult = regimeMult.shockOverlay[regime];
  const contMult = regimeMult.contagion[regime];
  const stressMult = regimeMult.stress[regime];

  const shockContrib = shockMult * shockOverlay;
  const contagionContrib = contMult * contagionDelta;
  const stressContrib = stressMult * stress.netBias;
  const latentRiskContrib = state.latentRisk; // already in pp units, no extra scaling

  const composed =
    state.adaptiveBaseProbability +
    shockContrib +
    contagionContrib +
    stressContrib +
    latentRiskContrib;

  const value = clampProb(composed);

  const drivers: DriverContribution[] = [
    {
      source: "adaptive_base",
      delta: state.adaptiveBaseProbability - state.longRunBaseProbability,
      label: "adaptive base drift",
    },
    {
      source: "shock",
      delta: shockContrib,
      label: dominantShockLabel || "no live shock",
    },
    {
      source: "contagion",
      delta: contagionContrib,
      label: "cross-market spillover",
    },
    {
      source: "network_stress",
      delta: stressContrib,
      label: networkStressLabel(stress),
    },
    {
      source: "latent_risk",
      delta: latentRiskContrib,
      label: "planned/structural risk",
    },
  ];

  return { value, drivers };
}

function networkStressLabel(s: NetworkStressContext): string {
  if (s.isRushHour) return s.rushHourIntensity > 0.7 ? "rush-hour peak" : "rush hour";
  if (s.isLateNight) return "late night";
  if (s.inMaintenanceWindow) return "maintenance window";
  if (s.isWeekend) return "weekend";
  return "off-peak";
}

// -------- per-tick update (drives the BASE; latent recomputed for snapshot) --------

function volJumpScale(volEst: number): number {
  // Map vol roughly onto [jumpScaleMin, jumpScaleMax]. Saturates at vol ≈ 0.05.
  const t = clamp(volEst / 0.05, 0, 1);
  return volatility.jumpScaleMin + t * (volatility.jumpScaleMax - volatility.jumpScaleMin);
}

// One tick of the adaptive update. Pure: deterministic in (market, regime,
// contagionDelta, stress, currentTick). No RNG. Decays shock memory,
// recomputes latent truth, drifts the adaptive base slowly toward its target.
export function updateMarketState(
  market: Market,
  regime: MarketRegime,
  contagionDelta: number,
  stress: NetworkStressContext,
  currentTick: number,
): Market {
  const prev = safeDynamicsState(market.dynamics, market.forecastProb);

  // 1) Decay shock memory.
  const decayedMemory = applyDecay(prev.eventMemory);
  const withDecay: ProbabilityDynamicsState = { ...prev, eventMemory: decayedMemory };

  // 2) Compose latent truth from current adaptive base + overlays.
  const { value: latentTrue, drivers: rawDrivers } = computeLatentTrueProbability(
    withDecay,
    contagionDelta,
    stress,
    regime,
  );

  // 3) Drift the adaptive base toward (longRun + latentRiskCoeff * latentRisk).
  //    Cap the step. Vol widens the cap; it does NOT push the base.
  const target = clampProb(
    prev.longRunBaseProbability + meanReversion.latentRiskCoeff * prev.latentRisk,
  );
  const pull = meanReversion.kappa * (target - prev.adaptiveBaseProbability);
  const cap = maxBaseJump[regime] * volJumpScale(prev.volatilityEstimate);
  const baseStep = clamp(pull, -cap, cap);
  const nextAdaptiveBase = clampProb(prev.adaptiveBaseProbability + baseStep);

  // 4) Volatility EWMA on |Δ latent truth| (measurement of how much truth is moving).
  const latentDelta = latentTrue - prev.lastLatentTrueProbability;
  const nextVol =
    (1 - volatility.alpha) * prev.volatilityEstimate +
    volatility.alpha * Math.abs(latentDelta);

  // 5) Sort drivers by |delta| and keep the top N for the debug surface.
  const drivers = rawDrivers
    .filter((d) => Math.abs(d.delta) > 1e-5)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, driverListSize);

  const nextDynamics: ProbabilityDynamicsState = {
    ...withDecay,
    adaptiveBaseProbability: nextAdaptiveBase,
    volatilityEstimate: nextVol,
    lastUpdatedTick: currentTick,
    lastLatentTrueProbability: latentTrue,
    // Snapshot the prior tick's latent before overwriting — used to seed the
    // informed slot's noisy observation on cold start; never read by handlers
    // directly during normal operation (informed reads its own obsLatent).
    prevLatentTrueProbability: prev.lastLatentTrueProbability,
    lastBaseDelta: nextAdaptiveBase - prev.adaptiveBaseProbability,
    lastLatentDelta: latentDelta,
    lastDrivers: drivers,
  };

  return { ...market, dynamics: nextDynamics };
}

// -------- helpers for consumers --------

// Sign of the *net live shock* this market is currently experiencing. Used
// by archetype handlers that previously read recentImpact's sign.
export function signOfRecentShocks(d: ProbabilityDynamicsState | undefined): number {
  if (!d || !Array.isArray(d.eventMemory)) return 0;
  let s = 0;
  for (const m of d.eventMemory) {
    if (m.category === "live") s += m.remaining;
  }
  if (Math.abs(s) < 1e-6) return 0;
  return s > 0 ? 1 : -1;
}

// -------- validation (dev-only) --------

export function validateDynamicsState(
  market: Market,
  expectedTick: number,
): string[] {
  const issues: string[] = [];
  const d = market.dynamics;
  if (!d) {
    issues.push("dynamics missing");
    return issues;
  }
  const check = (cond: boolean, msg: string) => {
    if (!cond) issues.push(msg);
  };
  check(Number.isFinite(d.longRunBaseProbability), "longRun not finite");
  check(Number.isFinite(d.adaptiveBaseProbability), "adaptive base not finite");
  check(
    d.adaptiveBaseProbability >= bounds.min - 1e-9 &&
      d.adaptiveBaseProbability <= bounds.max + 1e-9,
    `adaptive base out of bounds: ${d.adaptiveBaseProbability}`,
  );
  check(
    d.lastLatentTrueProbability >= bounds.min - 1e-9 &&
      d.lastLatentTrueProbability <= bounds.max + 1e-9,
    `latent truth out of bounds: ${d.lastLatentTrueProbability}`,
  );
  check(d.volatilityEstimate >= 0, "volatility negative");
  check(
    d.latentRisk >= LATENT_BOUNDS.min - 1e-9 &&
      d.latentRisk <= LATENT_BOUNDS.max + 1e-9,
    `latentRisk out of bounds: ${d.latentRisk}`,
  );
  for (const m of d.eventMemory) {
    check(m.halfLife > 0, `shock ${m.id} halfLife ≤ 0`);
    check(
      Math.abs(m.remaining) >= shockDecay.expireEps,
      `shock ${m.id} should have been expired (${m.remaining})`,
    );
  }
  const regime = market.regimeState?.regime ?? "calm";
  const allowedJump = maxBaseJump[regime] * volatility.jumpScaleMax + 1e-9;
  check(
    Math.abs(d.lastBaseDelta) <= allowedJump,
    `base delta ${d.lastBaseDelta} exceeds cap ${allowedJump} in ${regime}`,
  );
  check(d.lastUpdatedTick === expectedTick, `lastUpdatedTick mismatch (${d.lastUpdatedTick} vs ${expectedTick})`);
  return issues;
}
