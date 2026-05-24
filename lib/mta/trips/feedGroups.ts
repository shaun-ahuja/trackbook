import type { LineId } from "../../types";

// One NYCT GTFS-RT feed covers several route IDs. We fetch every feed
// that backs at least one of the desk's markets.
//
// Numbered feed (the default URL) serves 1/2/3/4/5/6/7 + shuttle
// designators (GS = 42 St, FS = Franklin Av, H = Rockaway Park) which
// all roll up to the single "S" market.
//
// L, ACE, BDFM, G, JZ, NQRW each have their own feed.
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
    routes: ["1", "2", "3", "4", "5", "6", "7", "GS", "FS", "H"],
  },
  {
    id: "ace",
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
    routes: ["A", "C", "E"],
  },
  {
    id: "bdfm",
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
    routes: ["B", "D", "F", "M"],
  },
  {
    id: "g",
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
    routes: ["G"],
  },
  {
    id: "jz",
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
    routes: ["J", "Z"],
  },
  {
    id: "l",
    url: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
    routes: ["L"],
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

// Route → market(s) the trip aggregate should impact. Each route is its
// own market; shuttle designators (GS / FS / H) collapse to "S".
export const TRIP_ROUTE_TO_MARKETS: Record<string, string[]> = {
  "1": ["1"],
  "2": ["2"],
  "3": ["3"],
  "4": ["4"],
  "5": ["5"],
  "6": ["6"],
  "7": ["7"],
  A: ["A"],
  B: ["B"],
  C: ["C"],
  D: ["D"],
  E: ["E"],
  F: ["F"],
  G: ["G"],
  J: ["J"],
  L: ["L"],
  M: ["M"],
  N: ["N"],
  Q: ["Q"],
  R: ["R"],
  GS: ["S"],
  FS: ["S"],
  H: ["S"],
  W: ["W"],
  Z: ["Z"],
};

export const TRIP_ROUTE_TO_LINE: Record<string, LineId> = {
  "1": "123",
  "2": "123",
  "3": "123",
  "4": "456",
  "5": "456",
  "6": "456",
  "7": "7",
  A: "ACE",
  B: "BDFM",
  C: "ACE",
  D: "BDFM",
  E: "ACE",
  F: "BDFM",
  G: "G",
  J: "JZ",
  L: "L",
  M: "BDFM",
  N: "NQRW",
  Q: "NQRW",
  R: "NQRW",
  GS: "S",
  FS: "S",
  H: "S",
  W: "NQRW",
  Z: "JZ",
};
