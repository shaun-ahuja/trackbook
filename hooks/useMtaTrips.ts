"use client";

import { useEffect, useRef } from "react";
import type { DataSourceMode, TransitEvent } from "@/lib/types";
import type { RouteSeverity } from "@/lib/mta/aggregateTripSignals";
import type { TripsResponse } from "@/app/api/mta/trips/route";
import {
  diffAggregateToEvent,
  widespreadDegradationEvent,
} from "@/lib/mta/mapTrainSignalsToTransitEvents";

const POLL_MS = 30_000;
const WIDESPREAD_THRESHOLD = 3; // # of routes at sev>=2 → citywide event

type Options = {
  enabled: boolean;
  mode: DataSourceMode;
  onEvents: (events: TransitEvent[]) => void;
};

// Poll /api/mta/trips on a 30s interval. Tracks the last severity seen
// per route and emits a TransitEvent only on state transitions, so a
// route persistently at sev2 produces exactly one event (the upgrade)
// instead of one per poll.
export function useMtaTrips({ enabled, mode, onEvents }: Options): void {
  const onEventsRef = useRef(onEvents);
  useEffect(() => {
    onEventsRef.current = onEvents;
  }, [onEvents]);

  const prevSevRef = useRef<Map<string, RouteSeverity>>(new Map());
  const prevWidespreadRef = useRef(false);

  useEffect(() => {
    if (!enabled || mode === "synthetic") return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/mta/trips", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as TripsResponse;
        if (cancelled) return;

        const nowMs = body.fetchedAt;
        const events: TransitEvent[] = [];

        for (const agg of body.aggregates) {
          const prev = prevSevRef.current.get(agg.routeId) ?? 0;
          if (agg.severity === prev) continue;
          const ev = diffAggregateToEvent(agg, prev, nowMs);
          if (ev) events.push(ev);
          prevSevRef.current.set(agg.routeId, agg.severity);
        }

        const degradedCount = body.aggregates.filter((a) => a.severity >= 2).length;
        const nowWidespread = degradedCount >= WIDESPREAD_THRESHOLD;
        if (nowWidespread !== prevWidespreadRef.current) {
          events.push(widespreadDegradationEvent(degradedCount, nowMs, nowWidespread));
          prevWidespreadRef.current = nowWidespread;
        }

        if (events.length > 0) onEventsRef.current(events);
      } catch {
        // Network blip — next poll will re-sync. Persistent state stays.
      }
    };

    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, mode]);
}
