"use client";

import clsx from "clsx";
import Panel from "./Panel";
import {
  INVENTORY_LIMIT,
  type Fill,
  type Market,
  type MarketAction,
  type MarketRegime,
  type RiskPosture,
} from "@/lib/types";
import { clockHHMMSS, signed } from "@/lib/format";

type Props = { market: Market; fills: Fill[]; tick: number };

const ACTION_STYLES: Record<
  MarketAction,
  { bg: string; fg: string; border: string; label: string; sub: string }
> = {
  LIFT: {
    bg: "#0e2a1f",
    fg: "#3ddc97",
    border: "#1f4836",
    label: "LIFT OFFER",
    sub: "buying the synthetic ask",
  },
  HIT: {
    bg: "#2d1219",
    fg: "#ff5a78",
    border: "#4a1d29",
    label: "HIT BID",
    sub: "selling the synthetic bid",
  },
  WIDEN: {
    bg: "#221e0d",
    fg: "#f5b042",
    border: "#3a3215",
    label: "WIDEN",
    sub: "passive resting quote",
  },
  FLATTEN: {
    bg: "#241333",
    fg: "#c58cff",
    border: "#3a2050",
    label: "FLATTEN",
    sub: "reducing inventory",
  },
  HOLD: {
    bg: "#101720",
    fg: "#9aa5b5",
    border: "#1f2a38",
    label: "HOLD",
    sub: "maintaining quote",
  },
};

const POSTURE_STYLES: Record<RiskPosture, { bg: string; fg: string; label: string }> = {
  NORMAL: { bg: "#0e1922", fg: "#3ddc97", label: "RISK · NORMAL" },
  CAUTIOUS: { bg: "#221e0d", fg: "#f5b042", label: "RISK · CAUTIOUS" },
  WARNING: { bg: "#2d1219", fg: "#ff5a78", label: "RISK · WARNING" },
};

const REGIME_STYLES: Record<MarketRegime, { bg: string; fg: string }> = {
  calm: { bg: "#101820", fg: "#7d8a99" },
  alert: { bg: "#221e0d", fg: "#f5b042" },
  shock: { bg: "#2d1219", fg: "#ff5a78" },
  recovery: { bg: "#0d2129", fg: "#5fd7e7" },
};

export default function DecisionPanel({ market, fills, tick }: Props) {
  const fair = market.forecastProb * 100;
  const mid = (market.marketBid + market.marketAsk) / 2;
  const edge = fair - mid;
  const action = ACTION_STYLES[market.lastAction];
  const posture = POSTURE_STYLES[market.riskPosture];
  const regime = market.regimeState?.regime ?? "calm";
  const regimeStyle = REGIME_STYLES[regime];
  const ticksInRegime = Math.max(0, tick - (market.regimeState?.enteredTick ?? 0));
  const invPct = Math.abs(market.inventory) / INVENTORY_LIMIT;
  const recentFills = fills.filter((f) => f.marketId === market.id).slice(0, 4);

  return (
    <Panel
      title="Decision Engine"
      subtitle="market maker"
      right={
        <div className="flex items-center gap-1">
          <span
            className="rounded-[1px] px-1.5 py-0.5 text-[9px] font-bold tracking-[0.18em]"
            style={{ background: regimeStyle.bg, color: regimeStyle.fg }}
          >
            {regime.toUpperCase()} · {ticksInRegime}t
          </span>
          <span
            className="rounded-[1px] px-1.5 py-0.5 text-[9px] font-bold tracking-[0.18em]"
            style={{ background: posture.bg, color: posture.fg }}
          >
            {posture.label}
          </span>
        </div>
      }
    >
      <div
        className="rounded-[2px] border px-3 py-2"
        style={{ background: action.bg, borderColor: action.border }}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="text-[18px] font-bold tracking-[0.14em]"
            style={{ color: action.fg }}
          >
            {action.label}
          </span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
            {action.sub}
          </span>
        </div>
        <p className="mt-2 text-[12px] leading-[1.55] text-[var(--color-foreground)]">
          {market.narrative}
        </p>
        {market.flowReason ? (
          <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
            market: {market.flowReason}
          </p>
        ) : null}
      </div>

      <section className="mt-3">
        <SectionLabel>rationale inputs</SectionLabel>
        <div className="mt-1 grid grid-cols-[1fr_auto] gap-y-1 text-[11px]">
          <KV label="fair value" value={`${fair.toFixed(2)}¢`} tone="accent" />
          <KV label="synthetic mid" value={`${mid.toFixed(2)}¢`} />
          <KV
            label="edge"
            value={`${signed(edge, 2)}¢`}
            tone={edge > 0.1 ? "up" : edge < -0.1 ? "down" : "muted"}
          />
          <KV
            label="confidence"
            value={`${(market.confidence * 100).toFixed(0)}%`}
            tone={market.confidence < 0.46 ? "warn" : "default"}
          />
          <KV
            label={`inventory (limit ±${INVENTORY_LIMIT})`}
            value={`${signed(market.inventory, 0)}`}
            tone={
              Math.abs(market.inventory) >= INVENTORY_LIMIT - 1
                ? "warn"
                : market.inventory > 0
                  ? "up"
                  : market.inventory < 0
                    ? "down"
                    : "muted"
            }
          />
        </div>
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-[1px] bg-[#101820]">
          <div
            className="h-full transition-[width] duration-500"
            style={{
              width: `${Math.min(100, invPct * 100)}%`,
              background:
                invPct >= 0.88
                  ? "var(--color-down)"
                  : invPct >= 0.6
                    ? "var(--color-warn)"
                    : "var(--color-up)",
            }}
          />
        </div>
      </section>

      <section className="mt-3">
        <SectionLabel>resting quote</SectionLabel>
        <div className="mt-1 grid grid-cols-2 gap-1.5">
          <QuoteTile side="bid" value={market.ourBid} />
          <QuoteTile side="ask" value={market.ourAsk} />
        </div>
      </section>

      <section className="mt-3">
        <SectionLabel>
          recent fills · {recentFills.length === 0 ? "—" : recentFills.length}
        </SectionLabel>
        {recentFills.length === 0 ? (
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            no fills on this market yet
          </p>
        ) : (
          <ul className="mt-1 divide-y divide-[var(--color-panel-border)]">
            {recentFills.map((f) => (
              <li
                key={f.id}
                className="grid grid-cols-[auto_auto_1fr_auto] items-center gap-2 py-1 text-[11px]"
              >
                <span className="tab-num text-[10px] text-[var(--color-muted)]">
                  {clockHHMMSS(f.ts)}
                </span>
                <span
                  className={clsx(
                    "rounded-[1px] px-1 text-[10px] font-bold tracking-[0.16em]",
                    f.side === "BUY"
                      ? "bg-[#0e2a1f] text-[var(--color-up)]"
                      : "bg-[#2d1219] text-[var(--color-down)]",
                  )}
                >
                  {f.side}
                </span>
                <span className="text-[var(--color-muted)]">×{f.qty}</span>
                <span className="tab-num text-[var(--color-foreground)]">
                  @ {f.price.toFixed(1)}¢
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Panel>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
      {children}
    </div>
  );
}

function KV({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "accent" | "up" | "down" | "muted" | "warn";
}) {
  const cls =
    tone === "accent"
      ? "text-[var(--color-accent)]"
      : tone === "up"
        ? "text-[var(--color-up)]"
        : tone === "down"
          ? "text-[var(--color-down)]"
          : tone === "warn"
            ? "text-[var(--color-warn)]"
            : tone === "muted"
              ? "text-[var(--color-muted)]"
              : "text-[var(--color-foreground)]";
  return (
    <>
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className={clsx("tab-num text-right", cls)}>{value}</span>
    </>
  );
}

function QuoteTile({ side, value }: { side: "bid" | "ask"; value: number }) {
  const color =
    side === "bid" ? "var(--color-up)" : "var(--color-down)";
  return (
    <div className="rounded-[2px] border border-[var(--color-panel-border)] bg-[#0a0f15] px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
        our {side}
      </div>
      <div className="tab-num text-[18px]" style={{ color }}>
        {value.toFixed(1)}¢
      </div>
    </div>
  );
}
