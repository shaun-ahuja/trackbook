"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useHelp } from "@/contexts/HelpContext";
import { GLOSSARY_TERMS } from "@/lib/explainability/explainabilityRegistry";
import type { GlossaryTerm } from "@/lib/explainability/types";

export default function GlossaryDrawer() {
  const { glossaryOpen, glossaryActiveTerm, closeGlossary, openGlossary } = useHelp();
  const [query, setQuery] = useState("");
  const activeRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = query.trim()
    ? GLOSSARY_TERMS.filter(
        (t) =>
          t.label.toLowerCase().includes(query.toLowerCase()) ||
          t.definition.toLowerCase().includes(query.toLowerCase()),
      )
    : GLOSSARY_TERMS;

  // Scroll to active term when drawer opens or term changes
  useEffect(() => {
    if (glossaryOpen && activeRef.current) {
      setTimeout(() => {
        activeRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      }, 200);
    }
  }, [glossaryOpen, glossaryActiveTerm]);

  // Focus search input when opened
  useEffect(() => {
    if (glossaryOpen) {
      setTimeout(() => inputRef.current?.focus(), 200);
    } else {
      setQuery("");
    }
  }, [glossaryOpen]);

  // Escape key
  useEffect(() => {
    if (!glossaryOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeGlossary();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [glossaryOpen, closeGlossary]);

  return (
    <div
      className={clsx(
        "fixed right-0 top-0 z-[100] flex h-full w-[320px] flex-col",
        "border-l border-[var(--color-panel-border)] bg-[var(--color-panel)]",
        "transition-transform duration-[180ms] ease-out",
        glossaryOpen ? "translate-x-0" : "translate-x-full",
      )}
    >
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--color-panel-border)] bg-[var(--color-panel-header)] px-3">
        <span className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-accent)]">
          Glossary
        </span>
        <button
          onClick={closeGlossary}
          className="text-[10px] text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
        >
          ✕
        </button>
      </div>

      {/* Search */}
      <div className="shrink-0 border-b border-[var(--color-panel-border)] px-3 py-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search terms…"
          className="w-full rounded-[1px] border border-[var(--color-panel-border)] bg-[#060a0f] px-2 py-1 font-mono text-[11px] text-[var(--color-foreground)] placeholder-[var(--color-muted)] outline-none focus:border-[var(--color-accent)]/40"
        />
      </div>

      {/* Term list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-[var(--color-muted)]">No matches.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-panel-border)]">
            {filtered.map((term) => (
              <TermEntry
                key={term.id}
                term={term}
                isActive={glossaryActiveTerm === term.id}
                ref={glossaryActiveTerm === term.id ? activeRef : undefined}
                onSeeAlso={openGlossary}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TermEntry({
  term,
  isActive,
  ref,
  onSeeAlso,
}: {
  term: GlossaryTerm;
  isActive: boolean;
  ref?: React.RefObject<HTMLDivElement | null>;
  onSeeAlso: (id: string) => void;
}) {
  return (
    <div
      ref={ref}
      className={clsx(
        "px-3 py-2.5",
        isActive && "bg-[rgba(88,228,197,0.04)]",
      )}
    >
      <div
        className={clsx(
          "mb-1 text-[9px] font-bold uppercase tracking-[0.22em]",
          isActive ? "text-[var(--color-accent)]" : "text-[var(--color-foreground)]",
        )}
      >
        {term.label}
      </div>
      <p className="text-[11px] leading-[1.55] text-[var(--color-muted)]">
        {term.definition}
      </p>
      {term.seeAlso && term.seeAlso.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          <span className="text-[9px] text-[var(--color-muted)]">see also:</span>
          {term.seeAlso.map((id) => {
            const linked = GLOSSARY_TERMS.find((t) => t.id === id);
            if (!linked) return null;
            return (
              <button
                key={id}
                onClick={() => onSeeAlso(id)}
                className="text-[9px] text-[var(--color-muted)] underline decoration-dotted hover:text-[var(--color-accent)]"
              >
                {linked.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
