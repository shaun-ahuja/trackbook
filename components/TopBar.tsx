"use client";

import clsx from "clsx";
import { clockHHMMSS } from "@/lib/format";
import type { DataSourceMode } from "@/lib/types";
import type { ViewMode } from "@/lib/view";

type Props = {
  now: number;
  tick: number;
  paused: boolean;
  dataSource: DataSourceMode;
  onTogglePause: () => void;
  onReseed: () => void;
  onSetDataSource: (mode: DataSourceMode) => void;
  viewMode: ViewMode;
  focusLabel: string | null;
  watchlistCount: number;
  onExitView: () => void;
};

const MODE_LABEL: Record<DataSourceMode, string> = {
  synthetic: "Synth",
  hybrid: "Hybrid",
  mta: "MTA",
};

const MODE_ORDER: DataSourceMode[] = ["synthetic", "hybrid", "mta"];

export default function TopBar({
  now,
  tick,
  paused,
  dataSource,
  onTogglePause,
  onReseed,
  onSetDataSource,
  viewMode,
  focusLabel,
  watchlistCount,
  onExitView,
}: Props) {
  const viewChip =
    viewMode === "desk"
      ? "DESK"
      : viewMode === "focus"
        ? `FOCUS · ${focusLabel ?? ""}`.trim()
        : `WATCHLIST · ${watchlistCount} MKTS`;
  const viewTone =
    viewMode === "desk"
      ? "text-[var(--color-muted)]"
      : viewMode === "focus"
        ? "text-[var(--color-accent)]"
        : "text-[var(--color-warn)]";
  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--color-panel-border)] bg-[#080b10] px-3">
      <div className="flex items-center gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-bold tracking-[0.32em] text-[var(--color-accent)]">
            TRANSITALPHA
          </span>
          <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            nyc transit · mm desk
          </span>
        </div>
        <div className="flex items-center gap-1.5 rounded-[1px] border border-[var(--color-panel-border)] bg-[var(--color-panel)] px-1.5 py-0.5">
          <span
            className={clsx(
              "h-1.5 w-1.5 rounded-full",
              paused
                ? "bg-[var(--color-warn)]"
                : "pulse-dot bg-[var(--color-up)]",
            )}
          />
          <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            {paused ? "paused" : "live"}
          </span>
        </div>
        <div
          role="radiogroup"
          aria-label="Event source"
          className="flex items-center overflow-hidden rounded-[1px] border border-[var(--color-panel-border)] bg-[var(--color-panel)]"
        >
          <span className="px-1.5 py-0.5 text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            src
          </span>
          {MODE_ORDER.map((mode) => {
            const active = mode === dataSource;
            return (
              <button
                key={mode}
                role="radio"
                aria-checked={active}
                onClick={() => onSetDataSource(mode)}
                className={clsx(
                  "border-l border-[var(--color-panel-border)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.22em]",
                  active
                    ? "bg-[var(--color-accent)] text-black"
                    : "text-[var(--color-foreground)] hover:text-[var(--color-accent)]",
                )}
              >
                {MODE_LABEL[mode]}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5 rounded-[1px] border border-[var(--color-panel-border)] bg-[var(--color-panel)] px-1.5 py-0.5">
          <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            view
          </span>
          <span
            className={clsx(
              "text-[9px] font-bold uppercase tracking-[0.22em]",
              viewTone,
            )}
          >
            {viewChip}
          </span>
          {viewMode !== "desk" && (
            <button
              onClick={onExitView}
              className="ml-0.5 rounded-[1px] border border-[var(--color-panel-border)] px-1 py-px text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              title={
                viewMode === "watchlist"
                  ? "Clear watchlist and return to desk (Esc)"
                  : "Return to desk view (Esc)"
              }
            >
              {viewMode === "watchlist" ? "Clear watchlist" : "Desk"}
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4 text-[10px] text-[var(--color-muted)]">
        <Stat label="tick" value={tick.toString()} />
        <Stat label="clock" value={clockHHMMSS(now)} mono />
        <div className="flex items-center gap-1">
          <button
            onClick={onTogglePause}
            className="rounded-[1px] border border-[var(--color-panel-border)] bg-[var(--color-panel)] px-2 py-0.5 text-[9px] uppercase tracking-[0.22em] text-[var(--color-foreground)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            onClick={onReseed}
            className="rounded-[1px] border border-[var(--color-panel-border)] bg-[var(--color-panel)] px-2 py-0.5 text-[9px] uppercase tracking-[0.22em] text-[var(--color-foreground)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Reseed
          </button>
        </div>
      </div>
    </header>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
        {label}
      </span>
      <span
        className={clsx(
          "text-[11px] text-[var(--color-foreground)]",
          mono && "tab-num",
        )}
      >
        {value}
      </span>
    </div>
  );
}
