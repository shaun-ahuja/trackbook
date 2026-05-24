"use client";

import clsx from "clsx";
import Panel from "./Panel";
import Sparkline from "./Sparkline";
import type { Market } from "@/lib/types";
import { signed } from "@/lib/format";

type Props = { market: Market; now: number };

export default function MarketDetail({ market, now }: Props) {
  const mid = (market.marketBid + market.marketAsk) / 2;
  const fair = market.forecastProb * 100;
  const edge = fair - mid;
  const spread = market.marketAsk - market.marketBid;
  const last = market.priceHistory[market.priceHistory.length - 1] ?? mid;
  const first = market.priceHistory[0] ?? mid;
  const tickChange = last - first;

  const sinceImpact = now - market.lastImpactTs;
  const flash = market.lastImpactTs > 0 && sinceImpact < 1400;

  return (
    <Panel
      title="Market Detail"
      subtitle={market.id}
      right={
        <span className="uppercase tracking-[0.18em]">expires {market.expiry}</span>
      }
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-flex h-6 min-w-[44px] items-center justify-center rounded-[1px] px-2 text-[11px] font-bold text-black"
            style={{ background: market.lineColor }}
          >
            {market.lineLabel}
          </span>
          <h3 className="truncate text-[13px] text-[var(--color-foreground)]">
            {market.contract}
          </h3>
        </div>
        <div className="flex shrink-0 items-baseline gap-1.5">
          <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            fair value
          </span>
          <span
            className={clsx(
              "tab-num text-[26px] leading-none text-[var(--color-accent)]",
              flash && "row-flash",
            )}
          >
            {fair.toFixed(1)}¢
          </span>
        </div>
      </header>

      <div className="mt-2.5 grid grid-cols-4 gap-2 border-t border-[var(--color-panel-border)] pt-2 text-[11px]">
        <Metric label="market mid" value={`${mid.toFixed(2)}¢`} />
        <Metric label="bid · ask" value={`${market.marketBid.toFixed(1)} / ${market.marketAsk.toFixed(1)}`} />
        <Metric label="spread" value={`${spread.toFixed(2)}¢`} />
        <Metric
          label="edge vs fair"
          value={`${signed(edge, 2)}¢`}
          tone={edge > 0.1 ? "up" : edge < -0.1 ? "down" : "muted"}
        />
      </div>

      <div className="mt-2 flex items-center justify-between text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
        <span>synthetic mid · last 60 ticks</span>
        <span
          className={clsx(
            "tab-num text-[10px]",
            tickChange > 0
              ? "text-[var(--color-up)]"
              : tickChange < 0
                ? "text-[var(--color-down)]"
                : "text-[var(--color-muted)]",
          )}
        >
          Δ {signed(tickChange, 2)}¢
        </span>
      </div>
      <Sparkline values={market.priceHistory} height={80} className="mt-1 w-full" />
    </Panel>
  );
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "up" | "down" | "muted";
}) {
  const cls =
    tone === "up"
      ? "text-[var(--color-up)]"
      : tone === "down"
        ? "text-[var(--color-down)]"
        : tone === "muted"
          ? "text-[var(--color-muted)]"
          : "text-[var(--color-foreground)]";
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
        {label}
      </span>
      <span className={clsx("tab-num text-[14px]", cls)}>{value}</span>
    </div>
  );
}
