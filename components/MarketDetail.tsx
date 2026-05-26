"use client";

import { memo } from "react";
import clsx from "clsx";
import Panel from "./Panel";
import Sparkline from "./Sparkline";
import type { FlowEvent, Market, TraderArchetype } from "@/lib/types";
import { signed } from "@/lib/format";

const ARCHETYPE_NAME: Record<TraderArchetype, string> = {
  noise: "Noise",
  liquidity_provider: "Liquidity provider",
  event_follower: "Event follower",
  inventory_rebalancer: "Inventory rebalancer",
  momentum: "Momentum",
  mean_reversion: "Mean reversion",
  patient_value: "Patient value",
  informed_transit: "Informed transit",
  latency_arb: "Latency arb",
  panic: "Panic",
  desk_actor: "Desk",
};

const FLOW_LOG_VISIBLE = 6;

// Build the action phrase shown after "<Type> investor". Limit orders are
// always "adding liquidity"; market orders specialise per archetype so
// the commentary reads like a tape narrator (informed buys "disruption
// risk", desk "lifts the offer", panic "panic-sells", etc.).
function actionPhrase(
  archetype: TraderArchetype,
  side: FlowEvent["side"],
): string {
  if (side === "LIMIT_BID") return "is adding bid liquidity";
  if (side === "LIMIT_ASK") return "is adding ask liquidity";
  if (archetype === "desk_actor") {
    return side === "BUY" ? "is lifting the offer" : "is hitting the bid";
  }
  if (archetype === "informed_transit" || archetype === "latency_arb") {
    return side === "BUY"
      ? "is buying disruption risk"
      : "is selling disruption risk";
  }
  if (archetype === "panic") {
    return side === "BUY" ? "is panic-buying" : "is panic-selling";
  }
  if (archetype === "event_follower") {
    return side === "BUY"
      ? "is chasing the headline up"
      : "is chasing the headline down";
  }
  if (archetype === "momentum") {
    return side === "BUY"
      ? "is chasing the trend up"
      : "is chasing the trend down";
  }
  if (archetype === "mean_reversion") {
    return side === "BUY" ? "is fading the dip" : "is fading the rip";
  }
  return side === "BUY" ? "is buying at market" : "is selling at market";
}

function flowSideColor(side: FlowEvent["side"]): string {
  switch (side) {
    case "BUY":
    case "LIMIT_BID":
      return "var(--color-up)";
    case "SELL":
    case "LIMIT_ASK":
      return "var(--color-down)";
  }
}

type Props = { market: Market; now: number };

function MarketDetail({ market, now }: Props) {
  const mid = (market.marketBid + market.marketAsk) / 2;
  const fair = market.forecastProb * 100;
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
          label="tick vol"
          value={market.vol.toFixed(2)}
          tone={market.vol > 0.6 ? "down" : "muted"}
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

      <div className="mt-3 flex items-center justify-between text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
        <span>flow · last {FLOW_LOG_VISIBLE}</span>
        <span className="tab-num">depth ewma {market.lpDepth?.toFixed(1) ?? "—"}</span>
      </div>
      {market.flowLog && market.flowLog.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {market.flowLog.slice(0, FLOW_LOG_VISIBLE).map((e, idx) => (
            <li
              key={`${e.tick}-${idx}-${e.archetype}-${e.side}`}
              className="text-[11px] leading-[1.4]"
            >
              <span
                className="font-semibold text-[var(--color-foreground)]"
                style={{ color: flowSideColor(e.side) }}
              >
                {ARCHETYPE_NAME[e.archetype]}
              </span>
              <span className="text-[var(--color-foreground)]">
                {" "}investor {actionPhrase(e.archetype, e.side)}
              </span>
              <span className="tab-num text-[var(--color-muted)]">
                {" "}· ×{e.qty} @ {e.priceCents.toFixed(1)}¢
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          no archetype activity yet
        </p>
      )}
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

export default memo(MarketDetail);
