import type { LineId } from "../../types";

// One NYCT GTFS-RT feed covers several route IDs. We only fetch the
// feeds whose routes back at least one of our markets.
//
// Numbered feed (the default URL) serves 1/2/3/4/5/6/7/S. We pull it
// for the 4/5/6 (LEX_MAJOR_PM) and 7 (7_SIGNAL_AM) markets.
//
// L, ACE, NQRW each have their own feed.
export type TripFeedGroup = {
  // Stable id used in the route handler payload.
  id: string;
  url: string;
  // Subway route designators present in this feed that we care about.
  routes: string[];
};

export const TRIP_FEED_GROUPS: TripFeedGroup[] = [
  {
    id: "numbered",
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
    routes: ["4", "5", "6", "7"],
  },
  {
    id: "l",
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
    routes: ["L"],
  },
  {
    id: "ace",
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
    routes: ["A", "C", "E"],
  },
  {
    id: "nqrw",
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
    routes: ["N", "Q", "R", "W"],
  },
];

// All routes the trip layer monitors.
export const TRIP_MONITORED_ROUTES: string[] = TRIP_FEED_GROUPS.flatMap(
  (g) => g.routes,
);

// Route → market(s) the trip aggregate should impact. Mirrors the
// ROUTE_TO_MARKETS map in mapMtaAlertToTransitEvent.ts but kept local so
// the trip layer can evolve independently.
export const TRIP_ROUTE_TO_MARKETS: Record<string, string[]> = {
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

export const TRIP_ROUTE_TO_LINE: Record<string, LineId> = {
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
