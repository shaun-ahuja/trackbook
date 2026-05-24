"use client";

import { useEffect, useRef } from "react";
import type { DataSourceMode, TransitEvent } from "@/lib/types";
import type { AlertsResponse, NormalizedAlert } from "@/lib/mta/types";
import {
  makeMtaClearEvent,
  mapMtaAlertToTransitEvent,
} from "@/lib/mta/mapMtaAlertToTransitEvent";

const POLL_MS = 30_000;

type Options = {
  enabled: boolean;
  mode: DataSourceMode;
  onEvents: (events: TransitEvent[]) => void;
};

// Poll /api/mta/alerts on a 30s interval. Diffs the current alert set
// against the previous snapshot: new alerts → injected as TransitEvents,
// disappeared alerts → injected as synthesized CLEAR events.
export function useMtaAlerts({ enabled, mode, onEvents }: Options): void {
  // Stable refs so the polling closure always sees the latest values
  // without restarting the interval on every render.
  const onEventsRef = useRef(onEvents);
  useEffect(() => {
    onEventsRef.current = onEvents;
  }, [onEvents]);
  const seenRef = useRef<Map<string, NormalizedAlert>>(new Map());

  useEffect(() => {
    if (!enabled || mode === "synthetic") return;

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/mta/alerts", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as AlertsResponse;
        if (cancelled) return;

        const next = new Map<string, NormalizedAlert>();
        for (const a of body.alerts) next.set(a.id, a);

        const prev = seenRef.current;
        const events: TransitEvent[] = [];

        for (const [id, alert] of next) {
          if (!prev.has(id)) {
            const ev = mapMtaAlertToTransitEvent(alert);
            if (ev) events.push(ev);
          }
        }

        const nowMs = body.fetchedAt;
        for (const [id, alert] of prev) {
          if (!next.has(id)) {
            const ev = makeMtaClearEvent(alert, nowMs);
            if (ev) events.push(ev);
          }
        }

        seenRef.current = next;
        if (events.length > 0) onEventsRef.current(events);
      } catch {
        // Network blip: keep the previous seen-map; next poll will re-sync.
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
