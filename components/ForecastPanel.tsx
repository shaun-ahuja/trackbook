"use client";

import { memo } from "react";
import clsx from "clsx";
import Panel from "./Panel";
import type { DriverContribution, Market, MarketRegime } from "@/lib/types";
import { signed } from "@/lib/format";

type Props = { market: Market; now: number };

const REGIME_STYLES: Record<MarketRegime, { bg: string; fg: string }> = {
  calm: { bg: "#101820", fg: "#7d8a99" },
  alert: { bg: "#221e0d", fg: "#f5b042" },
  shock: { bg: "#2d1219", fg: "#ff5a78" },
  recovery: { bg: "#0d2129", fg: "#5fd7e7" },
};

const DRIVER_LABEL: Record<DriverContribution["source"], string> = {
  adaptive_base: "base",
  shock: "shock",
  contagion: "spillover",
  network_stress: "network",
  latent_risk: "latent",
};

const DRIVER_COLOR: Record<DriverContribution["source"], string> = {
  adaptive_base: "#7d8a99",
  shock: "#ff5a78",
  contagion: "#c58cff",
  network_stress: "#f5b042",
  latent_risk: "#5fd7e7",
};

function ForecastPanel({ market, now }: Props) {
  const prob = market.forecastProb;
  const conf = market.confidence;
  const delta = prob - market.prevForecastProb;
  const sinceImpact = now - market.lastImpactTs;
  const flash = market.lastImpactTs > 0 && sinceImpact < 1400;

  const dyn = market.dynamics;
  const regime: MarketRegime = market.regimeState?.regime ?? "calm";
  const regimeStyle = REGIME_STYLES[regime];
  const drivers = dyn?.lastDrivers ?? [];
  const volEst = dyn?.volatilityEstimate ?? 0;
  // Render vol on a 0..1 scale capped at vol=0.05 (saturation point).
  const volPct = Math.min(1, volEst / 0.05);

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
        {dyn ? (
          <div className="mt-1.5 grid grid-cols-2 text-[10px] tab-num text-[var(--color-muted)]">
            <span>
              base{" "}
              <span className="text-[var(--color-foreground)]">
                {(dyn.adaptiveBaseProbability * 100).toFixed(1)}%
              </span>
            </span>
            <span className="text-right">
              long-run{" "}
              <span className="text-[var(--color-foreground)]">
                {(dyn.longRunBaseProbability * 100).toFixed(1)}%
              </span>
            </span>
          </div>
        ) : null}
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
        <div className="flex items-center justify-between gap-2">
          <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            market instability
          </span>
          <span
            className="rounded-[1px] px-1.5 py-0.5 text-[9px] font-bold tracking-[0.18em]"
            style={{ background: regimeStyle.bg, color: regimeStyle.fg }}
          >
            {regime.toUpperCase()}
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
            instability
          </span>
          <div className="h-1 flex-1 overflow-hidden rounded-[1px] bg-[#101820]">
            <div
              className="h-full transition-[width] duration-300"
              style={{
                width: `${volPct * 100}%`,
                background:
                  volPct > 0.6
                    ? "var(--color-down)"
                    : volPct > 0.3
                      ? "var(--color-warn)"
                      : "var(--color-accent)",
              }}
            />
          </div>
          <span className="tab-num text-[10px] text-[var(--color-foreground)]">
            {(volEst * 100).toFixed(2)}
          </span>
        </div>
      </div>

      <div className="mt-3 border-t border-[var(--color-panel-border)] pt-2">
        <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
          top drivers
        </span>
        {drivers.length === 0 ? (
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            no drivers yet — warming up
          </p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {drivers.map((d, i) => (
              <li
                key={`${d.source}-${i}`}
                className="flex items-center gap-2 text-[11px] text-[var(--color-foreground)]"
              >
                <span style={{ color: DRIVER_COLOR[d.source] }}>›</span>
                <span className="truncate">
                  <span className="text-[var(--color-muted)]">
                    {DRIVER_LABEL[d.source]}
                  </span>{" "}
                  {d.label}
                </span>
                <span
                  className={clsx(
                    "ml-auto tab-num text-[10px]",
                    Math.abs(d.delta) > 0.001
                      ? d.delta > 0
                        ? "text-[var(--color-up)]"
                        : "text-[var(--color-down)]"
                      : "text-[var(--color-muted)]",
                  )}
                >
                  {signed(d.delta * 100, 2)} pp
                </span>
              </li>
            ))}
          </ul>
        )}
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

export default memo(ForecastPanel);
