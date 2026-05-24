import { fetchTripFeed } from "@/lib/mta/fetchTripUpdates";
import { parseTripUpdates } from "@/lib/mta/parseTripUpdates";
import {
  aggregateByRoute,
  type RouteAggregate,
} from "@/lib/mta/aggregateTripSignals";
import {
  TRIP_FEED_GROUPS,
  TRIP_MONITORED_ROUTES,
} from "@/lib/mta/trips/feedGroups";

export const dynamic = "force-dynamic";

export type TripsResponse = {
  aggregates: RouteAggregate[];
  fetchedAt: number;
  feedErrors: string[];
};

export async function GET(): Promise<Response> {
  const settled = await Promise.allSettled(
    TRIP_FEED_GROUPS.map((g) => fetchTripFeed(g.url)),
  );

  const feedErrors: string[] = [];
  const parsedFeeds = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      try {
        parsedFeeds.push(parseTripUpdates(r.value));
      } catch (err) {
        feedErrors.push(
          `${TRIP_FEED_GROUPS[i].id}: decode failed (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    } else {
      feedErrors.push(
        `${TRIP_FEED_GROUPS[i].id}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
    }
  }

  const aggregates = aggregateByRoute(parsedFeeds, TRIP_MONITORED_ROUTES);
  const body: TripsResponse = {
    aggregates,
    fetchedAt: Date.now(),
    feedErrors,
  };
  return Response.json(body);
}
