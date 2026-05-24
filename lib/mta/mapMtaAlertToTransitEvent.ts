import type { LineId, Severity, TransitEvent } from "../types";
import type { NormalizedAlert } from "./types";

// Route → markets. Multiple routes can map to the same market (Lex group,
// ACE, NQRW). An alert touching several routes unions their markets.
const ROUTE_TO_MARKETS: Record<string, string[]> = {
  L: ["L_DELAY_10_EVE"],
  "4": ["LEX_MAJOR_PM"],
  "5": ["LEX_MAJOR_PM"],
  "6": ["LEX_MAJOR_PM"],
  A: ["ACE_REROUTE_EXT"],
  C: ["ACE_REROUTE_EXT"],
  E: ["ACE_REROUTE_EXT"],
  "7": ["7_SIGNAL_AM"],
  N: ["NQRW_QUEENS_PM"],
  Q: ["NQRW_QUEENS_PM"],
  R: ["NQRW_QUEENS_PM"],
  W: ["NQRW_QUEENS_PM"],
};

const ROUTE_TO_LINE: Record<string, LineId> = {
  L: "L",
  "4": "456",
  "5": "456",
  "6": "456",
  A: "ACE",
  C: "ACE",
  E: "ACE",
  "7": "7",
  N: "NQRW",
  Q: "NQRW",
  R: "NQRW",
  W: "NQRW",
};

// Mid-of-range magnitudes from the spec. Sev-3 is intentionally below the
// max (0.18) so a single alert doesn't immediately saturate IMPACT_BOUND.
const SEV_IMPACT: Record<Severity, number> = {
  1: 0.03,
  2: 0.07,
  3: 0.14,
};

// Planned-work pressure is small and persistent. It feeds the
// scheduledRisk channel in forecast.ts (capped at ±0.2 per market),
// not the shocky recentImpact channel, so a single alert moves the
// prior by ~1.5pp rather than ~3-15pp for a live event.
const PLANNED_IMPACT = 0.015;

// Tiny secondary bleed from a citywide weather alert into market-specific
// books. Mirrors the WX_CITYWIDE_15 template in events.ts.
const WX_BLEED = 0.02;

const WEATHER_RE = /flood|rain|snow|weather|ice|wind|storm|hurricane/i;
const RECOVERY_RE = /restore|resum|good service|cleared|back to|normal service/i;

function isWeather(alert: NormalizedAlert): boolean {
  if (alert.disruptionKind === "WEATHER") return true;
  return WEATHER_RE.test(alert.headerText);
}

function isRecovery(alert: NormalizedAlert): boolean {
  if (alert.disruptionKind === "CLEAR") return true;
  return RECOVERY_RE.test(alert.headerText);
}

function deriveLine(alert: NormalizedAlert): LineId {
  if (isWeather(alert) || alert.routeIds.length === 0) return "WX";
  for (const r of alert.routeIds) {
    const line = ROUTE_TO_LINE[r.toUpperCase()];
    if (line) return line;
  }
  return "WX";
}

function deriveImpacts(
  alert: NormalizedAlert,
  signedMagnitude: number,
): Record<string, number> {
  const impacts: Record<string, number> = {};

  if (isWeather(alert)) {
    impacts.WX_CITYWIDE_15 = signedMagnitude;
    // Citywide bleed across the rest of the desk's books.
    const bleed = Math.sign(signedMagnitude) * Math.min(WX_BLEED, Math.abs(signedMagnitude));
    if (bleed !== 0) {
      impacts.LEX_MAJOR_PM = bleed;
      impacts.L_DELAY_10_EVE = bleed;
      impacts.ACE_REROUTE_EXT = bleed;
      impacts["7_SIGNAL_AM"] = bleed;
      impacts.NQRW_QUEENS_PM = bleed;
    }
  }

  for (const route of alert.routeIds) {
    const markets = ROUTE_TO_MARKETS[route.toUpperCase()];
    if (!markets) continue;
    for (const m of markets) {
      // Union: keep the largest-magnitude impact if a market is touched twice.
      const prior = impacts[m];
      if (prior === undefined || Math.abs(signedMagnitude) > Math.abs(prior)) {
        impacts[m] = signedMagnitude;
      }
    }
  }

  return impacts;
}

function truncate(s: string, max = 120): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

// Map a live MTA alert to a TransitEvent driving the simulation. Returns
// null if the alert touches none of the markets the desk quotes.
export function mapMtaAlertToTransitEvent(
  alert: NormalizedAlert,
): TransitEvent | null {
  const recovery = isRecovery(alert);
  const baseMag = alert.isPlanned ? PLANNED_IMPACT : SEV_IMPACT[alert.severity];
  const signed = recovery ? -baseMag : baseMag;

  const impacts = deriveImpacts(alert, signed);
  if (Object.keys(impacts).length === 0) return null;

  return {
    id: `mta_${alert.id}`,
    ts: alert.timestampMs || Date.now(),
    line: deriveLine(alert),
    kind: recovery ? "CLEAR" : alert.disruptionKind,
    severity: alert.severity,
    text: truncate(alert.headerText || alert.descriptionText),
    impacts,
    source: "mta",
    category: alert.isPlanned ? "planned" : "live",
  };
}

// Synthesize a CLEAR event for an alert that just disappeared from the
// feed. Magnitude must equal the original injection so the scheduledRisk
// channel drains cleanly when a planned alert ends.
export function makeMtaClearEvent(
  alert: NormalizedAlert,
  nowMs: number,
): TransitEvent | null {
  const baseMag = alert.isPlanned ? PLANNED_IMPACT : SEV_IMPACT[1];
  const impacts = deriveImpacts(alert, -baseMag);
  if (Object.keys(impacts).length === 0) return null;

  return {
    id: `mta_${alert.id}_clear`,
    ts: nowMs,
    line: deriveLine(alert),
    kind: "CLEAR",
    severity: 1,
    text: truncate(`Resolved: ${alert.headerText || alert.descriptionText}`),
    impacts,
    source: "mta",
    category: alert.isPlanned ? "planned" : "live",
  };
}
