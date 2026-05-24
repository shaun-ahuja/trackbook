"use client";

import clsx from "clsx";
import Panel from "./Panel";
import type { Market } from "@/lib/types";
import { signed } from "@/lib/format";

type Props = { market: Market; now: number };

export default function ForecastPanel({ market, now }: Props) {
  const prob = market.forecastProb;
  const conf = market.confidence;
  const delta = prob - market.prevForecastProb;
  const sinceImpact = now - market.lastImpactTs;
  const flash = market.lastImpactTs > 0 && sinceImpact < 1400;

  return (
    <Panel
      title="AI Forecast"
      subtitle="transit-v1 · posterior"
      right={
        <span
          className={clsx(
            "tab-num",
            Math.abs(delta) > 0.005
              ? delta > 0
                ? "text-[var(--color-up)]"
                : "text-[var(--color-down)]"
              : "text-[var(--color-muted)]",
          )}
        >
          Δtick {signed(delta * 100, 2)} pp
        </span>
      }
    >
      <div className={clsx("rounded-[2px]", flash && "row-flash")}>
        <div className="flex items-end justify-between">
          <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            P(contract resolves YES)
          </span>
          <span className="tab-num text-[28px] leading-none text-[var(--color-accent)]">
            {(prob * 100).toFixed(1)}%
          </span>
        </div>
        <ProbBar value={prob} />
      </div>

      <div className="mt-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            model confidence
          </span>
          <span className="tab-num text-[12px] text-[var(--color-foreground)]">
            {(conf * 100).toFixed(0)}%
          </span>
        </div>
        <ConfidenceBar value={conf} />
      </div>

      <div className="mt-3 border-t border-[var(--color-panel-border)] pt-2">
        <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
          top drivers
        </span>
        <ul className="mt-1 space-y-0.5">
          {market.driverNotes.map((note, i) => (
            <li
              key={`${note}-${i}`}
              className="flex items-center gap-2 text-[11px] text-[var(--color-foreground)]"
            >
              <span className="text-[var(--color-accent)]">›</span>
              <span className="truncate">{note}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function ProbBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="mt-2 h-2 w-full overflow-hidden rounded-[1px] bg-[#0e141c]">
      <div
        className="h-full transition-[width] duration-300"
        style={{ width: `${pct}%`, background: "var(--color-accent)" }}
      />
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const segments = 24;
  const filled = Math.round(value * segments);
  return (
    <div className="mt-1.5 flex gap-[2px]">
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className="h-1.5 flex-1 rounded-[1px]"
          style={{
            background:
              i < filled
                ? i > segments * 0.7
                  ? "var(--color-up)"
                  : i > segments * 0.45
                    ? "var(--color-accent)"
                    : "#3a4a5e"
                : "#101820",
          }}
        />
      ))}
    </div>
  );
}
