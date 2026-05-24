import gtfs from "gtfs-realtime-bindings";

const { transit_realtime: rt } = gtfs;

// Minimal per-trip record extracted from a decoded GTFS-RT feed. We
// project away everything the desk doesn't need so downstream
// aggregation stays trivial.
export type TripStop = {
  stopId: string;
  arrivalSec: number; // unix seconds; 0 if unknown
};

export type TripMini = {
  tripId: string;
  routeId: string;
  // Earliest known stop_time_update (future or past). Drives stall
  // detection — a past nextArrivalSec means the train hasn't progressed
  // past its expected stop.
  nextStopId: string;
  nextArrivalSec: number;
  stops: TripStop[];
};

export type ParsedTripFeed = {
  feedTimestampSec: number;
  trips: TripMini[];
};

// Protobufjs returns int64 fields as Long objects by default; this
// coerces both Long and BigInt (and plain number) to a JS number.
// Unix seconds fit safely.
function toSec(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function parseTripUpdates(buf: Uint8Array): ParsedTripFeed {
  const feed = rt.FeedMessage.decode(buf);
  const feedTimestampSec = toSec(feed.header?.timestamp);

  const trips: TripMini[] = [];
  for (const entity of feed.entity ?? []) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    const routeId = (tu.trip?.routeId ?? "").trim();
    const tripId = (tu.trip?.tripId ?? "").trim();
    if (!routeId || !tripId) continue;

    const stus = tu.stopTimeUpdate ?? [];
    if (stus.length === 0) continue;

    const stops: TripStop[] = [];
    let earliestArrival = Number.POSITIVE_INFINITY;
    let earliestStopId = "";
    for (const stu of stus) {
      const stopId = (stu.stopId ?? "").trim();
      if (!stopId) continue;
      // NYCT typically populates `arrival.time`; fall back to departure.time.
      const arrivalSec = toSec(stu.arrival?.time) || toSec(stu.departure?.time);
      if (arrivalSec === 0) continue;
      stops.push({ stopId, arrivalSec });
      if (arrivalSec < earliestArrival) {
        earliestArrival = arrivalSec;
        earliestStopId = stopId;
      }
    }
    if (stops.length === 0) continue;

    trips.push({
      tripId,
      routeId,
      nextStopId: earliestStopId,
      nextArrivalSec: earliestArrival,
      stops,
    });
  }

  return { feedTimestampSec, trips };
}
