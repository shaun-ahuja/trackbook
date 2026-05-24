import type { ParsedTripFeed, TripMini } from "./parseTripUpdates";

// Operational severity classification per route, mirroring the MTA-alert
// severity scale (0 = nominal, 1-3 escalating). Drives the
// threshold-crossing event emission in mapTrainSignalsToTransitEvents.
export type RouteSeverity = 0 | 1 | 2 | 3;

export type RouteAggregate = {
  routeId: string;
  feedTimestampSec: number;
  activeTripCount: number;
  pastDueCount: number;
  // Median seconds between consecutive predicted arrivals at the
  // busiest stop served by this route in the next 30 minutes. null
  // when fewer than 3 arrivals are predicted (insufficient sample).
  headwaySec: number | null;
  expectedHeadwaySec: number;
  busiestStopId: string | null;
  severity: RouteSeverity;
};

// Past-due window. A trip whose earliest predicted arrival is more than
// this many seconds in the past is considered stalled.
const STALL_THRESHOLD_SEC = 180;
// Only consider arrivals predicted within this window when computing
// headway, so a long-tail future schedule doesn't dilute the signal.
const HEADWAY_WINDOW_SEC = 30 * 60;

// Approximate typical headways averaged across the service day (mid-day
// + off-peak weighted, since the desk runs continuously). Loose by
// design — the ratio thresholds below only fire on genuine degradation,
// not on normal late-night frequency drops.
const EXPECTED_HEADWAY_SEC: Record<string, number> = {
  L: 360,
  "4": 420,
  "5": 480,
  "6": 360,
  "7": 360,
  A: 600,
  C: 720,
  E: 480,
  N: 540,
  Q: 540,
  R: 540,
  W: 720,
};

function classifySeverity(
  pastDue: number,
  headwaySec: number | null,
  expectedHeadwaySec: number,
): RouteSeverity {
  const ratio =
    headwaySec !== null && expectedHeadwaySec > 0
      ? headwaySec / expectedHeadwaySec
      : 0;
  if (pastDue >= 10 || ratio >= 4) return 3;
  if (pastDue >= 5 || ratio >= 3) return 2;
  if (pastDue >= 2 || ratio >= 2) return 1;
  return 0;
}

function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid];
}

// For a single route's trips, find the stop with the most predicted
// arrivals in the headway window, then compute the median gap between
// consecutive arrivals at that stop.
function headwayForRoute(
  trips: TripMini[],
  feedTimestampSec: number,
): { headwaySec: number | null; busiestStopId: string | null } {
  const arrivalsByStop = new Map<string, number[]>();
  const horizonEnd = feedTimestampSec + HEADWAY_WINDOW_SEC;

  for (const t of trips) {
    for (const s of t.stops) {
      if (s.arrivalSec < feedTimestampSec || s.arrivalSec > horizonEnd) continue;
      const arr = arrivalsByStop.get(s.stopId) ?? [];
      arr.push(s.arrivalSec);
      arrivalsByStop.set(s.stopId, arr);
    }
  }

  let busiestStopId: string | null = null;
  let busiestArrivals: number[] = [];
  for (const [stopId, arrivals] of arrivalsByStop) {
    if (arrivals.length > busiestArrivals.length) {
      busiestStopId = stopId;
      busiestArrivals = arrivals;
    }
  }

  if (busiestArrivals.length < 3) {
    return { headwaySec: null, busiestStopId };
  }

  busiestArrivals.sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < busiestArrivals.length; i++) {
    gaps.push(busiestArrivals[i] - busiestArrivals[i - 1]);
  }
  gaps.sort((a, b) => a - b);
  return { headwaySec: median(gaps), busiestStopId };
}

// Combine multiple parsed feeds and produce one RouteAggregate per
// route of interest. Feeds the route handler payload directly.
export function aggregateByRoute(
  parsedFeeds: ParsedTripFeed[],
  routesOfInterest: string[],
): RouteAggregate[] {
  const interest = new Set(routesOfInterest);
  // Pick the freshest feed timestamp across all feeds — used uniformly
  // for past-due classification so we don't penalize a route just
  // because its feed was published a few seconds earlier.
  let feedTimestampSec = 0;
  const tripsByRoute = new Map<string, TripMini[]>();
  for (const feed of parsedFeeds) {
    if (feed.feedTimestampSec > feedTimestampSec) {
      feedTimestampSec = feed.feedTimestampSec;
    }
    for (const t of feed.trips) {
      if (!interest.has(t.routeId)) continue;
      const arr = tripsByRoute.get(t.routeId) ?? [];
      arr.push(t);
      tripsByRoute.set(t.routeId, arr);
    }
  }
  if (feedTimestampSec === 0) feedTimestampSec = Math.floor(Date.now() / 1000);

  const out: RouteAggregate[] = [];
  for (const routeId of routesOfInterest) {
    const trips = tripsByRoute.get(routeId) ?? [];
    const activeTripCount = trips.length;
    let pastDueCount = 0;
    for (const t of trips) {
      if (t.nextArrivalSec > 0 && t.nextArrivalSec < feedTimestampSec - STALL_THRESHOLD_SEC) {
        pastDueCount++;
      }
    }
    const { headwaySec, busiestStopId } = headwayForRoute(trips, feedTimestampSec);
    const expectedHeadwaySec = EXPECTED_HEADWAY_SEC[routeId] ?? 360;
    const severity = classifySeverity(pastDueCount, headwaySec, expectedHeadwaySec);

    out.push({
      routeId,
      feedTimestampSec,
      activeTripCount,
      pastDueCount,
      headwaySec,
      expectedHeadwaySec,
      busiestStopId,
      severity,
    });
  }

  return out;
}
