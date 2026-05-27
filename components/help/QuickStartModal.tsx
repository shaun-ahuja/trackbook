"use client";

import { useEffect, useRef } from "react";
import { useHelp } from "@/contexts/HelpContext";
import { QUICK_START_ITEMS } from "@/lib/explainability/explainabilityRegistry";

export default function QuickStartModal() {
  const { quickStartOpen, closeQuickStart } = useHelp();
  const cardRef = useRef<HTMLDivElement>(null);

  // Outside click dismiss
  useEffect(() => {
    if (!quickStartOpen) return;
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        closeQuickStart();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [quickStartOpen, closeQuickStart]);

  // Escape key
  useEffect(() => {
    if (!quickStartOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeQuickStart();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [quickStartOpen, closeQuickStart]);

  if (!quickStartOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[105]"
        style={{ background: "rgba(5,7,9,0.6)" }}
        onClick={closeQuickStart}
      />

      {/* Modal card */}
      <div
        ref={cardRef}
        className="popover-enter fixed left-1/2 top-1/2 z-[106] w-[320px] -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-[var(--color-panel-border)] bg-[#060b10] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-panel-border)] px-4 py-3">
          <div>
            <div className="text-[9px] font-bold uppercase tracking-[0.22em] text-[var(--color-accent)]">
              TransitAlpha in 20 seconds
            </div>
            <div className="mt-0.5 text-[9px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
              nyc transit market-making simulator
            </div>
          </div>
          <button
            onClick={closeQuickStart}
            className="text-[10px] text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          >
            ✕
          </button>
        </div>

        <ol className="space-y-2.5 px-4 py-4">
          {QUICK_START_ITEMS.map((item, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[1px] bg-[rgba(88,228,197,0.08)] text-[9px] font-bold text-[var(--color-accent)]">
                {i + 1}
              </span>
              <span className="text-[12px] leading-[1.5] text-[var(--color-foreground)]">
                {item}
              </span>
            </li>
          ))}
        </ol>

        <div className="border-t border-[var(--color-panel-border)] px-4 py-2.5">
          <p className="text-[9px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
            Use the guided tour for a full walkthrough · Hover ℹ on any panel for details
          </p>
        </div>
      </div>
    </>
  );
}
