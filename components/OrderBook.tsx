"use client";

import clsx from "clsx";
import Panel from "./Panel";
import type { BookLevel, Market } from "@/lib/types";

type Props = { market: Market };

export default function OrderBook({ market }: Props) {
  const mid = (market.marketBid + market.marketAsk) / 2;
  const { bids, asks } = market.book;

  const maxSize = Math.max(
    1,
    ...asks.map((l) => l.size),
    ...bids.map((l) => l.size),
  );

  // Display asks descending so the inside is closest to the mid bar.
  const asksDesc = [...asks].reverse();

  return (
    <Panel title="Order Book" subtitle="synth · L2">
      <div className="grid grid-cols-[1fr_56px_44px] gap-x-2 text-[10px]">
        {asksDesc.map((l) => (
          <Row key={`a${l.price}`} side="ask" level={l} ratio={l.size / maxSize} />
        ))}

        <div className="col-span-3 my-1 flex items-center justify-between border-y border-dashed border-[var(--color-panel-border)] py-0.5 text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
          <span>mid</span>
          <span className="tab-num text-[10px] text-[var(--color-accent)]">
            {mid.toFixed(2)}¢
          </span>
        </div>

        {bids.map((l) => (
          <Row key={`b${l.price}`} side="bid" level={l} ratio={l.size / maxSize} />
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-[var(--color-panel-border)] pt-1 text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
        <span>our quote</span>
        <span className="tab-num text-[10px]">
          <span className="text-[var(--color-up)]">
            {market.ourBid.toFixed(1)}
          </span>
          {" / "}
          <span className="text-[var(--color-down)]">
            {market.ourAsk.toFixed(1)}
          </span>
        </span>
      </div>
    </Panel>
  );
}

function Row({
  side,
  level,
  ratio,
}: {
  side: "bid" | "ask";
  level: BookLevel;
  ratio: number;
}) {
  const barColor =
    side === "ask" ? "rgba(255,90,120,0.12)" : "rgba(61,220,151,0.12)";
  const priceColor =
    side === "ask" ? "text-[var(--color-down)]" : "text-[var(--color-up)]";

  return (
    <>
      <div className="relative h-4">
        <div
          className="absolute inset-y-0 left-0 rounded-[1px]"
          style={{ width: `${ratio * 100}%`, background: barColor }}
        />
        {level.isOurs && (
          <span className="absolute inset-y-0 left-1 flex items-center text-[8px] uppercase tracking-[0.18em] text-[var(--color-accent)]">
            ours
          </span>
        )}
      </div>
      <div className={clsx("tab-num text-right", priceColor)}>
        {level.price.toFixed(1)}
      </div>
      <div
        className={clsx(
          "tab-num text-right",
          level.isOurs
            ? "text-[var(--color-accent)]"
            : "text-[var(--color-muted)]",
        )}
      >
        {level.size}
      </div>
    </>
  );
}
