import type { EventKind, Severity } from "../types";
import type {
  MtaRouteDetail,
  MtaServiceStatusFeed,
  MtaStatusDetail,
  NormalizedAlert,
} from "./types";

// Only subway routes drive the desk's markets. Bus/rail come through the
// same feed but get filtered out here.
const SUBWAY_MODE = "subway";

const SEV3_RE = /suspend|no service|emergency|severe|major disruption|stranded/i;
const SEV2_RE = /delay|reroute|bypass|skip|stand by|running with delays|express to local|local to express/i;
const SEV1_RE = /planned|reminder|notice|station|inspection|maintenance|advisory|info/i;

const SIGNAL_RE = /signal|switch|track work/i;
const SICK_RE = /sick|medical|passenger/i;
const POLICE_RE = /police|investigation|nypd|crime/i;
const WEATHER_RE = /flood|rain|snow|weather|ice|wind|storm|hurricane/i;
const CLEAR_RE = /restore|resum|good service|cleared|back to|normal service/i;

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDateMs(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function inferSeverity(summary: string): Severity {
  // Inferred from the short summary only — the long HTML description often
  // contains incidental phrases ("if weather permits", "delays may occur")
  // that would otherwise inflate severity for every planned-work blurb.
  if (SEV3_RE.test(summary)) return 3;
  if (SEV2_RE.test(summary)) return 2;
  if (SEV1_RE.test(summary)) return 1;
  return 1;
}

function inferKind(summary: string): EventKind {
  if (CLEAR_RE.test(summary)) return "CLEAR";
  if (SIGNAL_RE.test(summary)) return "SIGNAL";
  if (SICK_RE.test(summary)) return "SICK_PASSENGER";
  if (POLICE_RE.test(summary)) return "POLICE";
  if (WEATHER_RE.test(summary)) return "WEATHER";
  return "DELAY";
}

function isActiveNow(
  detail: MtaStatusDetail,
  feedTimestampMs: number,
): boolean {
  const start = parseDateMs(detail.startDate);
  const end = parseDateMs(detail.endDate);
  // No date envelope → treat as active.
  if (start === null && end === null) return true;
  if (start !== null && start > feedTimestampMs + 60_000) return false;
  if (end !== null && end < feedTimestampMs - 60_000) return false;
  return true;
}

// Multiple routeDetails can share the same alert id (e.g. a Lex-line alert
// shows up under both 4, 5, and 6). We accumulate by id and union the
// affected routes.
type Accum = {
  alert: NormalizedAlert;
  routes: Set<string>;
};

export function parseMtaAlerts(raw: unknown): NormalizedAlert[] {
  if (!raw || typeof raw !== "object") return [];
  const feed = raw as MtaServiceStatusFeed;
  const feedTimestampMs = parseDateMs(feed.lastUpdated) ?? Date.now();
  const routes = Array.isArray(feed.routeDetails) ? feed.routeDetails : [];

  const byId = new Map<string, Accum>();

  for (const route of routes) {
    if (!isSubway(route)) continue;
    const routeName = (route.route ?? "").trim();
    if (!routeName) continue;
    const details = Array.isArray(route.statusDetails) ? route.statusDetails : [];

    for (const detail of details) {
      if (!detail.id) continue;
      if (!isActiveNow(detail, feedTimestampMs)) continue;

      const summary = (detail.statusSummary ?? "").trim();
      const description = stripHtml(detail.statusDescription ?? "");
      if (!summary && !description) continue;

      // Planned-work entries are scheduled reminders, not live disruptions —
      // cap them at sev1 even if the summary mentions things like "express
      // to local" that would otherwise trip the sev2 regex.
      const isPlanned = detail.id.includes("planned_work");
      const severity: Severity = isPlanned ? 1 : inferSeverity(summary);
      const disruptionKind = inferKind(summary);

      const existing = byId.get(detail.id);
      if (existing) {
        existing.routes.add(routeName);
        continue;
      }

      const headerText = summary || description.slice(0, 100);
      byId.set(detail.id, {
        routes: new Set([routeName]),
        alert: {
          id: detail.id,
          timestampMs: feedTimestampMs,
          routeIds: [],
          headerText,
          descriptionText: description,
          activePeriodStartMs: parseDateMs(detail.startDate),
          activePeriodEndMs: parseDateMs(detail.endDate),
          severity,
          disruptionKind,
          isPlanned,
        },
      });
    }
  }

  const out: NormalizedAlert[] = [];
  for (const { alert, routes: routeSet } of byId.values()) {
    out.push({ ...alert, routeIds: Array.from(routeSet) });
  }
  return out;
}

function isSubway(route: MtaRouteDetail): boolean {
  return (route.mode ?? "").toLowerCase() === SUBWAY_MODE;
}
