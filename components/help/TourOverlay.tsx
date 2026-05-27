"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHelp } from "@/contexts/HelpContext";
import { TOUR_STEPS } from "@/lib/explainability/explainabilityRegistry";
import type { SimpleRect } from "@/lib/explainability/types";

const PADDING = 6;
const CARD_WIDTH = 300;
const CARD_HEIGHT_EST = 220;

function getTargetRect(panelId: string): SimpleRect | null {
  const el = document.querySelector(`[data-tour-id="${panelId}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    top: r.top,
    left: r.left,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}

export default function TourOverlay() {
  const {
    tourActive,
    tourStep,
    tourStepIndex,
    skipTour,
    advanceTour,
    retreatTour,
    dismissPermanently,
  } = useHelp();

  const [rect, setRect] = useState<SimpleRect | null>(null);
  const [dontShow, setDontShow] = useState(false);
  const cardKey = useRef(0);

  const totalSteps = TOUR_STEPS.length;
  const isFirst = tourStepIndex === 0;
  const isLast = tourStepIndex === totalSteps - 1;

  // Recalculate spotlight rect when step changes
  useLayoutEffect(() => {
    if (!tourActive || !tourStep) return;
    cardKey.current += 1;
    setRect(getTargetRect(tourStep.panelId));
  }, [tourActive, tourStep?.panelId]);

  // Debounced resize handler
  useEffect(() => {
    if (!tourActive) return;
    let timer: ReturnType<typeof setTimeout>;
    const handler = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (tourStep) setRect(getTargetRect(tourStep.panelId));
      }, 120);
    };
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("resize", handler);
      clearTimeout(timer);
    };
  }, [tourActive, tourStep]);

  // Keyboard navigation
  useEffect(() => {
    if (!tourActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        handleNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        retreatTour();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        skipTour();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [tourActive, isLast, dontShow]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tourActive || !tourStep) return null;

  function handleNext() {
    if (isLast) {
      if (dontShow) {
        dismissPermanently();
      } else {
        advanceTour(); // triggers COMPLETE_TOUR via reducer (next >= total)
      }
    } else {
      advanceTour();
    }
  }

  // Spotlight geometry
  const spotTop = rect ? rect.top - PADDING : 0;
  const spotLeft = rect ? rect.left - PADDING : 0;
  const spotW = rect ? rect.width + PADDING * 2 : 0;
  const spotH = rect ? rect.height + PADDING * 2 : 0;

  // Card position: prefer below spotlight, flip if insufficient space
  const vp = window.innerHeight;
  const vpw = window.innerWidth;
  const fitsBelow = rect ? rect.bottom + PADDING + 12 + CARD_HEIGHT_EST < vp - 8 : false;
  const cardTop = rect
    ? fitsBelow
      ? rect.bottom + PADDING + 12
      : Math.max(8, rect.top - PADDING - CARD_HEIGHT_EST - 12)
    : vp / 2 - CARD_HEIGHT_EST / 2;

  // Horizontal center over spotlight, clamped to viewport
  const cardCenterX = rect ? rect.left + rect.width / 2 : vpw / 2;
  const cardLeft = Math.max(8, Math.min(cardCenterX - CARD_WIDTH / 2, vpw - CARD_WIDTH - 8));

  return (
    <>
      {/* Dark backdrop — captures pointer events to block sim interaction */}
      <div
        className="overlay-enter fixed inset-0 z-[99]"
        style={{ background: "rgba(5,7,9,0.0)", pointerEvents: "all" }}
        onClick={skipTour}
      />

      {/* Spotlight punch-out over target panel */}
      {rect && (
        <div
          className="tour-spotlight fixed z-[100] rounded-[2px] pointer-events-none"
          style={{
            top: spotTop,
            left: spotLeft,
            width: spotW,
            height: spotH,
            boxShadow:
              "0 0 0 9999px rgba(5,7,9,0.82), 0 0 0 1px rgba(88,228,197,0.25)",
          }}
        />
      )}

      {/* Step card */}
      <div
        key={cardKey.current}
        className="tour-card-enter fixed z-[101] rounded-[2px] border border-[var(--color-accent)]/20 bg-[#060b10] shadow-2xl"
        style={{ top: cardTop, left: cardLeft, width: CARD_WIDTH }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[var(--color-panel-border)] px-4 py-2.5">
          <div className="flex items-baseline justify-between">
            <span className="text-[9px] font-bold uppercase tracking-[0.22em] text-[var(--color-accent)]">
              {tourStep.title}
            </span>
            <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
              {tourStepIndex + 1} / {totalSteps}
            </span>
          </div>
        </div>

        <div className="px-4 py-3">
          <p className="text-[12px] leading-[1.6] text-[var(--color-foreground)]">
            {tourStep.body}
          </p>

          {isLast && (
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-[10px] text-[var(--color-muted)]">
              <input
                type="checkbox"
                checked={dontShow}
                onChange={(e) => setDontShow(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              Don&apos;t show again
            </label>
          )}

          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <button
                onClick={retreatTour}
                disabled={isFirst}
                className="rounded-[1px] border border-[var(--color-panel-border)] px-2 py-0.5 text-[9px] uppercase tracking-[0.16em] text-[var(--color-muted)] disabled:opacity-30 enabled:hover:border-[var(--color-accent)]/40 enabled:hover:text-[var(--color-foreground)]"
              >
                ← Prev
              </button>
              <button
                onClick={handleNext}
                className="rounded-[1px] border border-[var(--color-accent)]/30 bg-[rgba(88,228,197,0.06)] px-3 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-[var(--color-accent)] hover:bg-[rgba(88,228,197,0.1)]"
              >
                {isLast ? "Done" : "Next →"}
              </button>
            </div>
            <button
              onClick={skipTour}
              className="text-[9px] uppercase tracking-[0.16em] text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
            >
              Skip
            </button>
          </div>

          <div className="mt-2 text-[8px] uppercase tracking-[0.16em] text-[var(--color-muted)]/50">
            ← → navigate · Esc skip
          </div>
        </div>
      </div>
    </>
  );
}
