"use client";

import { DEMO_SCENARIOS, type ScenarioName } from "@/lib/simulation/scenarios";

const SCENARIO_NAMES = Object.keys(DEMO_SCENARIOS) as ScenarioName[];

type Props = {
  active: ScenarioName | null;
  onApply: (name: ScenarioName | null) => void;
};

export default function ScenarioBar({ active, onApply }: Props) {
  return (
    <div className="flex items-center gap-2 border-b border-[#12192a] bg-[#04060a] px-3 py-1.5">
      <span className="shrink-0 text-[8px] font-bold uppercase tracking-[0.28em] text-[#2a3850]">
        demo
      </span>
      <div className="h-3 w-px bg-[#12192a]" />
      <div className="flex items-center gap-1.5">
        {SCENARIO_NAMES.map((name) => {
          const s = DEMO_SCENARIOS[name];
          const isActive = active === name;
          return (
            <button
              key={name}
              onClick={() => onApply(isActive ? null : name)}
              className="rounded-[2px] border px-2 py-0.5 text-[9px] font-bold tracking-[0.14em] transition-all duration-100"
              style={{
                borderColor: isActive ? s.color : "#1e2d42",
                color: isActive ? s.color : "#3a4f68",
                background: isActive ? `${s.color}14` : "transparent",
              }}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      {active ? (
        <>
          <div className="h-3 w-px bg-[#12192a]" />
          <span className="truncate text-[9px] text-[#2a3850]">
            {DEMO_SCENARIOS[active].description}
          </span>
          <button
            onClick={() => onApply(null)}
            className="ml-auto shrink-0 text-[9px] text-[#2a3850] transition-colors hover:text-[#4a6888]"
          >
            ✕
          </button>
        </>
      ) : (
        <span className="ml-2 text-[8px] text-[#1e2d42]">
          inject scenario → optimizer responds immediately
        </span>
      )}
    </div>
  );
}
