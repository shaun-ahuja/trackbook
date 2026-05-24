import type { EventKind, Severity } from "../types";

// Subset of the MTA service-status JSON we consume. The real payload has
// many more fields per route/status — we extract only what drives the sim.
export type MtaStatusDetail = {
  id?: string;
  statusSummary?: string;
  statusDescription?: string;
  priority?: number;
  creationDate?: string;
  startDate?: string;
  endDate?: string;
};

export type MtaRouteDetail = {
  route?: string;
  mode?: string;
  agency?: string;
  routeId?: string;
  inService?: boolean;
  statusDetails?: MtaStatusDetail[];
};

export type MtaServiceStatusFeed = {
  lastUpdated?: string;
  routeDetails?: MtaRouteDetail[];
};

// Normalized internal shape consumed by mapMtaAlertToTransitEvent.
export type NormalizedAlert = {
  id: string;
  timestampMs: number;
  routeIds: string[];      // subway route designators, e.g. ["L"], ["4","5","6"]
  headerText: string;      // short summary
  descriptionText: string; // long text (HTML stripped)
  activePeriodStartMs: number | null;
  activePeriodEndMs: number | null;
  severity: Severity;
  disruptionKind: EventKind;
  // planned_work entries vs live disruptions. Drives the slow vs shocky
  // forecast channel in the simulation.
  isPlanned: boolean;
};

export type AlertsResponse = {
  alerts: NormalizedAlert[];
  fetchedAt: number;
  error?: string;
};
