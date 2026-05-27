"use client";

import type { ReactNode } from "react";
import clsx from "clsx";
import Panel from "./Panel";
import InfoIcon from "./help/InfoIcon";
import GlossaryTrigger from "./help/GlossaryTrigger";
import PanelStatusBadge from "./help/PanelStatusBadge";
import type { Market, SimState } from "@/lib/types";
import { signed, signedDollars } from "@/lib/format";
import { totalInventoryNotional, totalPnl } from "@/lib/simulation/pnl";

type Props = {
  state: SimState;
  positionMarkets?: Market[];
  scopeLabel?: string;
};

export default function PnLPanel({ state, positionMarkets, scopeLabel }: Props) {
  const pnl = totalPnl(state);
  const notional = totalInventoryNotional(state);
  const markets: Market[] =
    positionMarkets ?? state.marketOrder.map((id) => state.markets[id]);

  // Adverse selection badge: count markets with recent adverse fills
  const adverseCount = markets.filter(
    (m) => m.inventory !== 0 && m.realizedPnl + m.unrealizedPnl < -50,
  ).length;

  return (
    <Panel
      title="Book · PnL"
      subtitle={scopeLabel ?? "paper"}
      right={
        <div className="flex items-center gap-1">
          {adverseCount > 0 && (
            <PanelStatusBadge label={`ADV SEL · ${adverseCount}`} tone="warn" />
          )}
          <InfoIcon panelId="pnl" />
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-1.5">
        <Stat
          label={<GlossaryTrigger term="pnl">total pnl</GlossaryTrigger>}
          value={signedDollars(pnl.total)}
          tone={tone(pnl.total)}
          big
        />
        <Stat
          label={<GlossaryTrigger term="unrealized-pnl">unrealized</GlossaryTrigger>}
          value={signedDollars(pnl.unrealized)}
          tone={tone(pnl.unrealized)}
        />
        <Stat
          label={<GlossaryTrigger term="realized-pnl">realized</GlossaryTrigger>}
          value={signedDollars(pnl.realized)}
          tone={tone(pnl.realized)}
        />
        <Stat
          label="notional"
          value={`$${(notional / 100).toFixed(2)}`}
          tone="default"
        />
      </div>

      <div className="mt-2 border-t border-[var(--color-panel-border)] pt-1.5">
        <div className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
          positions
        </div>
        <ul className="mt-1 space-y-0.5">
          {markets.map((m) => {
            const noPos = m.inventory === 0;
            return (
              <li
                key={m.id}
                className="grid grid-cols-[28px_auto_1fr_auto] items-center gap-1.5 text-[10px]"
              >
                <span
                  className="inline-block rounded-[1px] px-0.5 text-center text-[9px] font-bold text-black"
                  style={{ background: m.lineColor }}
                >
                  {m.lineLabel}
                </span>
                <span
                  className={clsx("tab-num text-right", invTone(m.inventory))}
                >
                  {noPos ? "0" : signed(m.inventory, 0)}
                </span>
                <span className="text-[var(--color-muted)]">
                  {noPos ? "—" : `@ ${m.avgCost.toFixed(1)}`}
                </span>
                <span
                  className={clsx(
                    "tab-num text-right",
                    tone(m.realizedPnl + m.unrealizedPnl),
                  )}
                >
                  {noPos && m.realizedPnl === 0
                    ? "—"
                    : signed((m.realizedPnl + m.unrealizedPnl) / 100, 2)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}

function Stat({
  label,
  value,
  tone,
  big,
}: {
  label: ReactNode;
  value: string;
  tone: string;
  big?: boolean;
}) {
  return (
    <div className="rounded-[1px] border border-[var(--color-panel-border)] bg-[#0a0f15] px-1.5 py-1">
      <div className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
        {label}
      </div>
      <div className={clsx("tab-num", big ? "text-[14px]" : "text-[12px]", tone)}>
        {value}
      </div>
    </div>
  );
}

function tone(n: number): string {
  if (n > 0.005) return "text-[var(--color-up)]";
  if (n < -0.005) return "text-[var(--color-down)]";
  return "text-[var(--color-muted)]";
}

function invTone(inv: number): string {
  if (Math.abs(inv) >= 7) return "text-[var(--color-warn)]";
  if (inv > 0) return "text-[var(--color-up)]";
  if (inv < 0) return "text-[var(--color-down)]";
  return "text-[var(--color-muted)]";
}
