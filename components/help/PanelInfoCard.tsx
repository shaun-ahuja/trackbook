"use client";

import { useEffect, useRef } from "react";
import { useHelp } from "@/contexts/HelpContext";
import { PANEL_INFO } from "@/lib/explainability/explainabilityRegistry";

const CARD_WIDTH = 248;
const CARD_APPROX_HEIGHT = 260;
const GAP = 6;

export default function PanelInfoCard() {
  const { activePanelInfoId, activePanelInfoAnchor, closePanelInfo } = useHelp();
  const cardRef = useRef<HTMLDivElement>(null);

  // Outside click dismiss
  useEffect(() => {
    if (!activePanelInfoId) return;
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        closePanelInfo();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [activePanelInfoId, closePanelInfo]);

  // Escape key
  useEffect(() => {
    if (!activePanelInfoId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanelInfo();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activePanelInfoId, closePanelInfo]);

  if (!activePanelInfoId || !activePanelInfoAnchor) return null;

  const info = PANEL_INFO[activePanelInfoId];
  if (!info) return null;

  const anchor = activePanelInfoAnchor;
  const vp = typeof window !== "undefined" ? window.innerHeight : 800;
  const vpw = typeof window !== "undefined" ? window.innerWidth : 1200;

  // Vertical: prefer below anchor, flip above if insufficient space
  const fitsBelow = anchor.bottom + GAP + CARD_APPROX_HEIGHT < vp - 8;
  const top = fitsBelow
    ? anchor.bottom + GAP
    : Math.max(8, anchor.top - CARD_APPROX_HEIGHT - GAP);

  // Horizontal: right-align to anchor, clamp to viewport
  const right = vpw - anchor.right;
  const clampedRight = Math.max(8, Math.min(right, vpw - CARD_WIDTH - 8));

  return (
    <div
      ref={cardRef}
      className="popover-enter fixed z-[104] w-[248px] rounded-[2px] border border-[var(--color-panel-border)] bg-[#060a0f] shadow-lg"
      style={{ top, right: clampedRight }}
    >
      <div className="border-b border-[var(--color-panel-border)] px-3 py-2">
        <div className="text-[9px] font-bold uppercase tracking-[0.22em] text-[var(--color-accent)]">
          {info.title}
        </div>
      </div>
      <div className="space-y-2.5 px-3 py-2.5 text-[11px] leading-[1.5]">
        <Row label="What" value={info.what} />
        <Row label="Why it matters" value={info.why} />
        <Row label="Updates" value={info.howUpdates} />
        <Row label="Reading it" value={info.howInterpret} />
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-0.5 text-[8px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
        {label}
      </div>
      <div className="text-[var(--color-foreground)]">{value}</div>
    </div>
  );
}
