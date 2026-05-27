"use client";

import { useEffect, useRef } from "react";
import { useHelp } from "@/contexts/HelpContext";

export default function IntroModal() {
  const { introOpen, startTourFromIntro, jumpIn } = useHelp();
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!introOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        startTourFromIntro();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        jumpIn();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [introOpen, startTourFromIntro, jumpIn]);

  if (!introOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[110]"
        style={{ background: "rgba(5,7,9,0.72)" }}
      />

      {/* Modal card */}
      <div
        ref={cardRef}
        className="popover-enter fixed left-1/2 top-1/2 z-[111] w-[340px] -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-[var(--color-panel-border)] bg-[#060b10] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-[var(--color-panel-border)] px-5 py-3">
          <div className="text-[9px] font-bold uppercase tracking-[0.22em] text-[var(--color-accent)]">
            TransitAlpha
          </div>
          <div className="mt-0.5 text-[9px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
            research terminal · v0.1
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <p className="text-[12px] leading-[1.65] text-[var(--color-foreground)]">
            TransitAlpha is a simulated research terminal for pricing transit-linked
            prediction contracts under uncertainty.
          </p>
          <p className="mt-2.5 text-[12px] leading-[1.65] text-[var(--color-foreground)]">
            Synthetic events shift probabilities, simulated traders create order
            flow, and the desk manages inventory and risk.
          </p>
        </div>

        {/* Actions */}
        <div className="border-t border-[var(--color-panel-border)] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <button
              onClick={startTourFromIntro}
              className="flex-1 rounded-[1px] border border-[var(--color-accent)]/40 bg-[rgba(88,228,197,0.07)] py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--color-accent)] hover:bg-[rgba(88,228,197,0.12)]"
            >
              Start Tour
            </button>
            <button
              onClick={jumpIn}
              className="flex-1 rounded-[1px] border border-[var(--color-panel-border)] py-1.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)] hover:border-[var(--color-accent)]/30 hover:text-[var(--color-foreground)]"
            >
              Jump In
            </button>
          </div>
          <div className="mt-2 text-[8px] uppercase tracking-[0.16em] text-[var(--color-muted)]/50">
            Enter = start tour · Esc = jump in
          </div>
        </div>
      </div>
    </>
  );
}
