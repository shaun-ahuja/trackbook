import type { Severity, TransitEvent } from "../types";
import type { RouteAggregate, RouteSeverity } from "./aggregateTripSignals";
import {
  TRIP_ROUTE_TO_LINE,
  TRIP_ROUTE_TO_MARKETS,
} from "./trips/feedGroups";

// Per-severity impact magnitudes for trip-derived signals. Slightly
// below the alert magnitudes (live alert sev2 = 0.07) because these
// signals are smoothed across many trains — less precise than a
// single human-authored alert. Sev-3 still high enough to qualify for
// shock fills against stale resting quotes.
const SEV_IMPACT: Record<1 | 2 | 3, number> = {
  1: 0.04,
  2: 0.08,
  3: 0.12,
};

// Cross-route degradation signal — WX_CITYWIDE_15 catches this. Small,
// because it duplicates the per-route pressure that's already firing.
const WIDESPREAD_IMPACT = 0.06;

// Routes for which an upgrade should land as a SIGNAL rather than a
// DELAY (stalled lines often mean signal trouble). Picked by feel; the
// reducer treats both the same way.
const SIGNAL_PRONE = new Set(["L", "7"]);

function deriveImpacts(routeId: string, signedMag: number): Record<string, number> {
  const markets = TRIP_ROUTE_TO_MARKETS[routeId.toUpperCase()];
  if (!markets) return {};
  const out: Record<string, number> = {};
  for (const m of markets) out[m] = signedMag;
  return out;
}

function summaryText(agg: RouteAggregate, sev: RouteSeverity): string {
  const headway =
    agg.headwaySec !== null
      ? `headway ${Math.round(agg.headwaySec / 60)}m`
      : "headway n/a";
  return `${agg.routeId}: ${agg.pastDueCount} stalled · ${headway} · sev${sev}`;
}

function clearText(agg: RouteAggregate): string {
  return `${agg.routeId}: trip flow normalizing (${agg.pastDueCount} stalled)`;
}

// Produce a TransitEvent for a severity transition on a single route.
// Returns null when the transition shouldn't emit an event (e.g. flat).
export function diffAggregateToEvent(
  agg: RouteAggregate,
  prevSev: RouteSeverity,
  nowMs: number,
): TransitEvent | null {
  if (agg.severity === prevSev) return null;
  const upgrade = agg.severity > prevSev;
  const line = TRIP_ROUTE_TO_LINE[agg.routeId.toUpperCase()];
  if (!line) return null;

  if (upgrade) {
    const sev = agg.severity as 1 | 2 | 3;
    const mag = SEV_IMPACT[sev];
    const impacts = deriveImpacts(agg.routeId, mag);
    if (Object.keys(impacts).length === 0) return null;
    return {
      id: `trip_${agg.routeId}_${nowMs}_up${sev}`,
      ts: nowMs,
      line,
      kind: SIGNAL_PRONE.has(agg.routeId) && sev >= 2 ? "SIGNAL" : "DELAY",
      severity: sev as Severity,
      text: summaryText(agg, sev),
      impacts,
      source: "trip",
      category: "live",
    };
  }

  // Downgrade — drain the prior pressure with a small negative impulse.
  const drainMag = SEV_IMPACT[Math.max(1, prevSev) as 1 | 2 | 3];
  const impacts = deriveImpacts(agg.routeId, -drainMag);
  if (Object.keys(impacts).length === 0) return null;
  return {
    id: `trip_${agg.routeId}_${nowMs}_dn${agg.severity}`,
    ts: nowMs,
    line,
    kind: "CLEAR",
    severity: 1,
    text: clearText(agg),
    impacts,
    source: "trip",
    category: "live",
  };
}

// Build a citywide-degradation event when the count of routes at sev≥2
// crosses the threshold. Mirrors the same threshold-crossing semantics
// as per-route events.
export function widespreadDegradationEvent(
  degradedCount: number,
  nowMs: number,
  becameDegraded: boolean,
): TransitEvent {
  if (becameDegraded) {
    return {
      id: `trip_widespread_${nowMs}_up`,
      ts: nowMs,
      line: "WX",
      kind: "DELAY",
      severity: 2,
      text: `Trip aggregator: widespread degradation across ${degradedCount} routes`,
      impacts: { WX_CITYWIDE_15: WIDESPREAD_IMPACT },
      source: "trip",
      category: "live",
    };
  }
  return {
    id: `trip_widespread_${nowMs}_dn`,
    ts: nowMs,
    line: "WX",
    kind: "CLEAR",
    severity: 1,
    text: `Trip aggregator: citywide trip flow normalizing`,
    impacts: { WX_CITYWIDE_15: -WIDESPREAD_IMPACT },
    source: "trip",
    category: "live",
  };
}
