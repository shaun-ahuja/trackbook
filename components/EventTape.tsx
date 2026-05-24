"use client";

import clsx from "clsx";
import Panel from "./Panel";
import type { Market, TransitEvent } from "@/lib/types";
import { clockHHMMSS } from "@/lib/format";

type Props = {
  events: TransitEvent[];
  markets: Record<string, Market>;
  scopeLabel?: string;
};

const KIND_LABEL: Record<TransitEvent["kind"], string> = {
  DELAY: "DELAY",
  SIGNAL: "SIG",
  SICK_PASSENGER: "PAX",
  WEATHER: "WX",
  POLICE: "PD",
  CLEAR: "CLR",
  RIDERSHIP: "RIDE",
};

const SEV_COLOR = {
  1: "#3a4a5e",
  2: "#f5b042",
  3: "#ff5a78",
} as const;

const LINE_COLORS: Record<string, string> = {
  "123": "#EE352E",
  "456": "#00933C",
  "7": "#B933AD",
  ACE: "#0039A6",
  BDFM: "#FF6319",
  G: "#6CBE45",
  JZ: "#996633",
  L: "#A7A9AC",
  NQRW: "#FCCC0A",
  S: "#808183",
  WX: "#FCCC0A",
};

export default function EventTape({ events, markets, scopeLabel }: Props) {
  const subtitle = scopeLabel
    ? `${events.length} · ${scopeLabel}`
    : `${events.length} events`;
  return (
    <Panel
      title="Event Tape"
      subtitle={subtitle}
      bodyClassName="p-0"
    >
      {events.length === 0 ? (
        <div className="px-3 py-4 text-[11px] text-[var(--color-muted)]">
          Waiting for first event…
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-panel-border)]">
          {events.map((ev, i) => {
            const lineColor = LINE_COLORS[ev.line] ?? "#6a7585";
            const sevColor = SEV_COLOR[ev.severity];
            const impacted = Object.entries(ev.impacts)
              .map(([id, delta]) => ({
                label: markets[id]?.lineLabel ?? id,
                delta,
              }))
              .slice(0, 4);

            const isMta = ev.source === "mta";
            const isTrip = ev.source === "trip";
            const isPlanned = ev.category === "planned";
            return (
              <li
                key={ev.id}
                className={clsx(
                  "grid items-start gap-2 px-3 py-1.5 text-[11px]",
                  i === 0 && "row-flash",
                )}
                style={{
                  gridTemplateColumns:
                    "3px 56px 36px 60px minmax(0,1fr) auto",
                }}
              >
                <span
                  className="h-full w-[3px] rounded-[1px]"
                  style={{ background: sevColor }}
                />
                <span className="tab-num text-[var(--color-muted)]">
                  {clockHHMMSS(ev.ts)}
                </span>
                <span
                  className="inline-flex h-4 items-center justify-center rounded-[1px] px-1 text-[10px] font-bold text-black"
                  style={{ background: lineColor }}
                >
                  {ev.line}
                </span>
                <span
                  className="text-[9px] uppercase tracking-[0.18em]"
                  style={{ color: sevColor }}
                >
                  {KIND_LABEL[ev.kind]} · sev{ev.severity}
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                  {isMta && (
                    <span
                      className="inline-flex h-3.5 shrink-0 items-center rounded-[1px] border border-[var(--color-accent)] px-1 text-[9px] font-bold uppercase tracking-[0.18em] text-[var(--color-accent)]"
                      title="Real MTA service alert"
                    >
                      MTA
                    </span>
                  )}
                  {isTrip && (
                    <span
                      className="inline-flex h-3.5 shrink-0 items-center rounded-[1px] border border-[var(--color-up)] px-1 text-[9px] font-bold uppercase tracking-[0.18em] text-[var(--color-up)]"
                      title="Aggregated GTFS-RT trip-update signal"
                    >
                      TRIP
                    </span>
                  )}
                  {isPlanned && (
                    <span
                      className="inline-flex h-3.5 shrink-0 items-center rounded-[1px] border border-[var(--color-muted)] px-1 text-[9px] font-bold uppercase tracking-[0.18em] text-[var(--color-muted)]"
                      title="Planned/scheduled work — slow baseline pressure, not a live shock"
                    >
                      PLAN
                    </span>
                  )}
                  <span
                    className={clsx(
                      "min-w-0 truncate",
                      isPlanned
                        ? "text-[var(--color-muted)]"
                        : "text-[var(--color-foreground)]",
                    )}
                  >
                    {ev.text}
                  </span>
                </span>
                <span className="hidden shrink-0 items-center gap-1 md:flex">
                  {impacted.map((imp, j) => (
                    <span
                      key={j}
                      className={clsx(
                        "tab-num rounded-[1px] px-1 py-0.5 text-[9px] uppercase tracking-[0.14em]",
                        imp.delta > 0
                          ? "bg-[#0e2a1f] text-[var(--color-up)]"
                          : "bg-[#2d1219] text-[var(--color-down)]",
                      )}
                    >
                      {imp.label} {imp.delta > 0 ? "+" : ""}
                      {(imp.delta * 100).toFixed(1)}pp
                    </span>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
