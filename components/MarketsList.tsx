"use client";

import clsx from "clsx";
import Panel from "./Panel";
import type { Market, TransitEvent } from "@/lib/types";
import { signed } from "@/lib/format";

type Props = {
  markets: Market[];
  selectedId: string;
  onSelect: (id: string) => void;
  now: number;
  latestEvent?: TransitEvent;
};

export default function MarketsList({
  markets,
  selectedId,
  onSelect,
  now,
  latestEvent,
}: Props) {
  return (
    <Panel
      title="Markets"
      subtitle={`${markets.length}`}
      bodyClassName="p-0"
    >
      <ul className="divide-y divide-[var(--color-panel-border)]">
        {markets.map((m) => {
          const mid = (m.marketBid + m.marketAsk) / 2;
          const fair = m.forecastProb * 100;
          const edge = fair - mid;
          const selected = m.id === selectedId;
          const sinceImpact = now - m.lastImpactTs;
          const flash = m.lastImpactTs > 0 && sinceImpact < 1400;
          const impactedByLatest =
            latestEvent && latestEvent.impacts[m.id] !== undefined;
          const impactDelta = impactedByLatest
            ? latestEvent.impacts[m.id]
            : 0;

          return (
            <li
              key={m.id}
              onClick={() => onSelect(m.id)}
              className={clsx(
                "cursor-pointer px-2.5 py-1.5 transition-colors",
                selected
                  ? "border-l-2 border-[var(--color-accent)] bg-[#0f1722]"
                  : "border-l-2 border-transparent hover:bg-[#0e141c]",
                flash && "row-flash",
              )}
            >
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="inline-flex h-[14px] min-w-[30px] items-center justify-center rounded-[1px] px-1 text-[9px] font-bold text-black"
                    style={{ background: m.lineColor }}
                  >
                    {m.lineLabel}
                  </span>
                  <span className="tab-num text-[12px] text-[var(--color-foreground)]">
                    {mid.toFixed(1)}
                  </span>
                </div>
                <span
                  className={clsx(
                    "tab-num text-[10px]",
                    edge > 0.1
                      ? "text-[var(--color-up)]"
                      : edge < -0.1
                        ? "text-[var(--color-down)]"
                        : "text-[var(--color-muted)]",
                  )}
                >
                  {signed(edge, 1)}¢
                </span>
              </div>
              <div className="mt-0.5 truncate text-[10px] text-[var(--color-muted)]">
                {m.contract}
              </div>
              {impactedByLatest && (
                <div
                  className={clsx(
                    "mt-0.5 inline-block rounded-[1px] px-1 py-px text-[9px] uppercase tracking-[0.14em]",
                    impactDelta > 0
                      ? "bg-[#0e2a1f] text-[var(--color-up)]"
                      : "bg-[#2d1219] text-[var(--color-down)]",
                  )}
                >
                  shock {impactDelta > 0 ? "+" : ""}
                  {(impactDelta * 100).toFixed(1)}pp
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
