import type { LineId, Regime, Severity, TransitEvent } from "../types";
import { pick, rand, randInt } from "../rng";

export type EventTemplate = {
  line: LineId;
  kind: TransitEvent["kind"];
  severity: Severity;
  text: string;
  impacts: Record<string, number>;
  driverTag: string;
};

export const TEMPLATES: EventTemplate[] = [
  {
    line: "L",
    kind: "SIGNAL",
    severity: 2,
    text: "Signal problem at Bedford Av · northbound L holding",
    impacts: { L_DELAY_10_EVE: 0.09 },
    driverTag: "Bedford sig",
  },
  {
    line: "L",
    kind: "SICK_PASSENGER",
    severity: 1,
    text: "Sick passenger at Union Sq · L delays minor",
    impacts: { L_DELAY_10_EVE: 0.04 },
    driverTag: "Union Sq sick pax",
  },
  {
    line: "L",
    kind: "CLEAR",
    severity: 1,
    text: "Bedford incident clearing · L resuming",
    impacts: { L_DELAY_10_EVE: -0.07 },
    driverTag: "L clearing",
  },
  {
    line: "456",
    kind: "DELAY",
    severity: 3,
    text: "Major delay 4·5·6 · disabled train at 86 St",
    impacts: { LEX_MAJOR_PM: 0.14, "7_SIGNAL_AM": 0.02 },
    driverTag: "86 St disabled",
  },
  {
    line: "456",
    kind: "POLICE",
    severity: 2,
    text: "NYPD activity at Grand Central · 4·5 single-tracking",
    impacts: { LEX_MAJOR_PM: 0.08 },
    driverTag: "GCT police",
  },
  {
    line: "456",
    kind: "CLEAR",
    severity: 1,
    text: "Lex Ave service resuming with residual delays",
    impacts: { LEX_MAJOR_PM: -0.06 },
    driverTag: "Lex resuming",
  },
  {
    line: "ACE",
    kind: "DELAY",
    severity: 2,
    text: "A train reroute via F line extended through Sunday",
    impacts: { ACE_REROUTE_EXT: 0.11 },
    driverTag: "A→F reroute",
  },
  {
    line: "ACE",
    kind: "SIGNAL",
    severity: 2,
    text: "Signal trouble at Jay St · C/E rerouting",
    impacts: { ACE_REROUTE_EXT: 0.06 },
    driverTag: "Jay St sig",
  },
  {
    line: "7",
    kind: "SIGNAL",
    severity: 3,
    text: "Signal failure at Queensboro Plaza · 7 service suspended",
    impacts: { "7_SIGNAL_AM": 0.18 },
    driverTag: "QBP signal fail",
  },
  {
    line: "7",
    kind: "RIDERSHIP",
    severity: 1,
    text: "Heavy 7 ridership · Mets game getting out",
    impacts: { "7_SIGNAL_AM": 0.03 },
    driverTag: "Mets crowd",
  },
  {
    line: "WX",
    kind: "WEATHER",
    severity: 3,
    text: "NWS flash flood warning · subway systemwide impact possible",
    impacts: {
      WX_CITYWIDE_15: 0.16,
      LEX_MAJOR_PM: 0.04,
      "7_SIGNAL_AM": 0.03,
      L_DELAY_10_EVE: 0.03,
    },
    driverTag: "flash flood",
  },
  {
    line: "WX",
    kind: "WEATHER",
    severity: 2,
    text: "Heavy rain over Manhattan · station flooding reports",
    impacts: { WX_CITYWIDE_15: 0.08 },
    driverTag: "heavy rain",
  },
  {
    line: "WX",
    kind: "CLEAR",
    severity: 1,
    text: "Rain easing · MTA downgrades weather advisory",
    impacts: { WX_CITYWIDE_15: -0.06 },
    driverTag: "rain easing",
  },
  {
    line: "NQRW",
    kind: "DELAY",
    severity: 2,
    text: "N/W delays · switch problem at Queensboro Plaza",
    impacts: { NQRW_QUEENS_PM: 0.1 },
    driverTag: "QBP switch",
  },
  {
    line: "NQRW",
    kind: "SICK_PASSENGER",
    severity: 1,
    text: "Sick passenger on Q train at 57 St · holding",
    impacts: { NQRW_QUEENS_PM: 0.04 },
    driverTag: "57 St sick pax",
  },
  {
    line: "NQRW",
    kind: "CLEAR",
    severity: 1,
    text: "Queensboro switch resolved · N/W normalizing",
    impacts: { NQRW_QUEENS_PM: -0.07 },
    driverTag: "QBP normal",
  },
];

const LINES_FOR_REGIME: LineId[] = ["L", "456", "ACE", "7", "WX", "NQRW"];

// Regime tuning. Lower-frequency baseline so events feel deliberate; once a
// regime takes hold, the disrupted line gets a much higher spawn rate.
const BASELINE_EVENT_CHANCE = 0.09;
const REGIME_EVENT_CHANCE = 0.26;
const REGIME_START_CHANCE = 0.014;     // ~once every 70 ticks when idle
const VOL_SPIKE_START_CHANCE = 0.005;
const REGIME_MIN_LEN = 30;
const REGIME_MAX_LEN = 80;
const VOL_SPIKE_LEN = 22;
const REGIME_LINE_BIAS = 0.7;           // chance event picks from the active line
const CLEAR_DUE_MIN = 6;
const CLEAR_DUE_MAX = 15;

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

// Self-heal: hot-reload may leave `regime` undefined on SimState.
function safeRegime(regime: Regime | undefined): Regime {
  if (!regime) return emptyRegime();
  return {
    activeLine: regime.activeLine ?? null,
    ticksRemaining: Number.isFinite(regime.ticksRemaining) ? regime.ticksRemaining : 0,
    intensity: Number.isFinite(regime.intensity) ? regime.intensity : 0,
    volSpikeTicksRemaining: Number.isFinite(regime.volSpikeTicksRemaining)
      ? regime.volSpikeTicksRemaining
      : 0,
    pendingClears: Array.isArray(regime.pendingClears) ? regime.pendingClears : [],
  };
}

function buildEvent(
  tpl: EventTemplate,
  seed: number,
  now: number,
): { event: TransitEvent; seed: number } {
  const idR = randInt(seed, 0, 0x7fffffff);
  return {
    event: {
      id: `e_${now}_${idR.v.toString(36)}`,
      ts: now,
      line: tpl.line,
      kind: tpl.kind,
      severity: tpl.severity,
      text: tpl.text,
      impacts: { ...tpl.impacts },
    },
    seed: idR.seed,
  };
}

// Advance the regime state and (maybe) generate an event.
//
// Sequence: tick down counters → maybe start a new disruption regime or
// vol spike → fire any pending CLEAR that's due → roll for a fresh event,
// biased toward the active line if a regime is running → if the event is
// sev-3, schedule a CLEAR for the same line 6–15 ticks out.
//
// When `spawn` is false (MTA-only mode, or hybrid while MTA is fresh),
// regime counters and pending CLEARs still advance but no synthetic
// event or new regime is produced.
export function tickEvents(
  regimeIn: Regime | undefined,
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

  // Maybe start a new disruption regime.
  if (spawn && !regime.activeLine) {
    const roll = rand(seed);
    seed = roll.seed;
    if (roll.v < REGIME_START_CHANCE) {
      const lineR = pick(seed, LINES_FOR_REGIME);
      seed = lineR.seed;
      const lenR = randInt(seed, REGIME_MIN_LEN, REGIME_MAX_LEN);
      seed = lenR.seed;
      regime = {
        ...regime,
        activeLine: lineR.v,
        ticksRemaining: lenR.v,
        intensity: 0.7 + (lenR.v - REGIME_MIN_LEN) / (REGIME_MAX_LEN - REGIME_MIN_LEN) * 0.3,
      };
    }
  }

  // Maybe start a vol spike (independent of disruption regime).
  if (spawn && regime.volSpikeTicksRemaining === 0) {
    const roll = rand(seed);
    seed = roll.seed;
    if (roll.v < VOL_SPIKE_START_CHANCE) {
      regime = { ...regime, volSpikeTicksRemaining: VOL_SPIKE_LEN };
    }
  }

  // Fire any due pending CLEAR.
  const dueIdx = regime.pendingClears.findIndex((p) => p.atTick <= currentTick);
  if (dueIdx >= 0) {
    const due = regime.pendingClears[dueIdx];
    const remaining = regime.pendingClears.filter((_, i) => i !== dueIdx);
    regime = { ...regime, pendingClears: remaining };
    const clearTpl = TEMPLATES.find((t) => t.line === due.line && t.kind === "CLEAR");
    if (clearTpl) {
      const built = buildEvent(clearTpl, seed, now);
      return { event: built.event, regime, seed: built.seed };
    }
  }

  // Roll for a fresh event spawn.
  if (!spawn) return { event: null, regime, seed };
  const baseRate = regime.activeLine ? REGIME_EVENT_CHANCE : BASELINE_EVENT_CHANCE;
  const fireR = rand(seed);
  seed = fireR.seed;
  if (fireR.v > baseRate) return { event: null, regime, seed };

  // Pick a template, biased toward the active line if any.
  let tpl: EventTemplate;
  if (regime.activeLine) {
    const biasR = rand(seed);
    seed = biasR.seed;
    if (biasR.v < REGIME_LINE_BIAS) {
      const lineTpls = TEMPLATES.filter((t) => t.line === regime.activeLine);
      const p = pick(seed, lineTpls);
      seed = p.seed;
      tpl = p.v;
    } else {
      const p = pick(seed, TEMPLATES);
      seed = p.seed;
      tpl = p.v;
    }
  } else {
    const p = pick(seed, TEMPLATES);
    seed = p.seed;
    tpl = p.v;
  }

  // Sev-3 disruption: schedule a CLEAR for the same line 6–15 ticks ahead.
  if (tpl.severity === 3) {
    const dueR = randInt(seed, CLEAR_DUE_MIN, CLEAR_DUE_MAX);
    seed = dueR.seed;
    regime = {
      ...regime,
      pendingClears: [
        ...regime.pendingClears,
        { line: tpl.line, atTick: currentTick + dueR.v },
      ],
    };
  }

  const built = buildEvent(tpl, seed, now);
  return { event: built.event, regime, seed: built.seed };
}

export function templateTagFor(event: TransitEvent): string {
  const tpl = TEMPLATES.find((t) => t.text === event.text);
  if (tpl) return `${tpl.driverTag} · sev${event.severity}`;
  const prefix =
    event.source === "mta"
      ? "MTA"
      : event.source === "trip"
        ? "TRIP"
        : event.kind.toLowerCase();
  return `${prefix} · sev${event.severity}`;
}
