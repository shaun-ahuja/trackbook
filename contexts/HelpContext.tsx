"use client";

import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import type { PanelId, SimpleRect } from "@/lib/explainability/types";
import { TOUR_STEPS } from "@/lib/explainability/explainabilityRegistry";

const STORAGE_KEY = "ta.help.v1";

// ── State ──────────────────────────────────────────────────────────────────

type HelpState = {
  tourActive: boolean;
  tourStepIndex: number;
  // true only when user explicitly completes tour or checks "don't show again"
  tourDismissed: boolean;
  activePanelInfoId: PanelId | null;
  activePanelInfoAnchor: SimpleRect | null;
  glossaryOpen: boolean;
  glossaryActiveTerm: string | null;
  quickStartOpen: boolean;
};

// ── Actions ────────────────────────────────────────────────────────────────

type HelpAction =
  | { type: "START_TOUR" }
  | { type: "ADVANCE_TOUR" }
  | { type: "RETREAT_TOUR" }
  | { type: "SKIP_TOUR" }              // session only — no localStorage write
  | { type: "DISMISS_PERMANENTLY" }    // write localStorage
  | { type: "OPEN_PANEL_INFO"; panelId: PanelId; anchor: SimpleRect }
  | { type: "CLOSE_PANEL_INFO" }
  | { type: "OPEN_GLOSSARY"; term?: string }
  | { type: "CLOSE_GLOSSARY" }
  | { type: "OPEN_QUICK_START" }
  | { type: "CLOSE_QUICK_START" };

// ── localStorage helpers ───────────────────────────────────────────────────

function readDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").tourDone === true;
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tourDone: true }));
  } catch {}
}

// ── Reducer ────────────────────────────────────────────────────────────────

function makeInitial(): HelpState {
  return {
    tourActive: false,
    tourStepIndex: 0,
    tourDismissed: readDismissed(),
    activePanelInfoId: null,
    activePanelInfoAnchor: null,
    glossaryOpen: false,
    glossaryActiveTerm: null,
    quickStartOpen: false,
  };
}

function reducer(state: HelpState, action: HelpAction): HelpState {
  switch (action.type) {
    case "START_TOUR":
      return {
        ...state,
        tourActive: true,
        tourStepIndex: 0,
        glossaryOpen: false,
        glossaryActiveTerm: null,
        activePanelInfoId: null,
        activePanelInfoAnchor: null,
        quickStartOpen: false,
      };

    case "ADVANCE_TOUR": {
      const next = state.tourStepIndex + 1;
      if (next >= TOUR_STEPS.length) {
        // Completing the tour persists dismissal
        return { ...state, tourActive: false, tourDismissed: true };
      }
      return { ...state, tourStepIndex: next };
    }

    case "RETREAT_TOUR":
      return { ...state, tourStepIndex: Math.max(0, state.tourStepIndex - 1) };

    case "SKIP_TOUR":
      // Close for session only — tourDismissed unchanged, so tour re-appears on next page load
      return { ...state, tourActive: false };

    case "DISMISS_PERMANENTLY":
      // Explicit "don't show again" or completing the tour
      return { ...state, tourActive: false, tourDismissed: true };

    case "OPEN_PANEL_INFO":
      return {
        ...state,
        activePanelInfoId: action.panelId,
        activePanelInfoAnchor: action.anchor,
        glossaryOpen: false,
        glossaryActiveTerm: null,
      };

    case "CLOSE_PANEL_INFO":
      return { ...state, activePanelInfoId: null, activePanelInfoAnchor: null };

    case "OPEN_GLOSSARY":
      return {
        ...state,
        glossaryOpen: true,
        glossaryActiveTerm: action.term ?? null,
        activePanelInfoId: null,
        activePanelInfoAnchor: null,
      };

    case "CLOSE_GLOSSARY":
      return { ...state, glossaryOpen: false, glossaryActiveTerm: null };

    case "OPEN_QUICK_START":
      return { ...state, quickStartOpen: true };

    case "CLOSE_QUICK_START":
      return { ...state, quickStartOpen: false };

    default:
      return state;
  }
}

// ── Context ────────────────────────────────────────────────────────────────

type HelpContextValue = HelpState & {
  tourStep: (typeof TOUR_STEPS)[number] | null;
  startTour(): void;
  advanceTour(): void;
  retreatTour(): void;
  skipTour(): void;
  dismissPermanently(): void;
  openPanelInfo(id: PanelId, anchor: SimpleRect): void;
  closePanelInfo(): void;
  openGlossary(term?: string): void;
  closeGlossary(): void;
  openQuickStart(): void;
  closeQuickStart(): void;
};

const HelpContext = createContext<HelpContextValue | null>(null);

// ── Provider ───────────────────────────────────────────────────────────────

export function HelpProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, makeInitial);
  const autoStarted = useRef(false);

  // Auto-start tour on first load if not permanently dismissed
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    if (!state.tourDismissed) {
      dispatch({ type: "START_TOUR" });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist dismissal when tourDismissed becomes true
  useEffect(() => {
    if (state.tourDismissed) writeDismissed();
  }, [state.tourDismissed]);

  const value: HelpContextValue = {
    ...state,
    tourStep: state.tourActive ? (TOUR_STEPS[state.tourStepIndex] ?? null) : null,
    startTour: () => dispatch({ type: "START_TOUR" }),
    advanceTour: () => dispatch({ type: "ADVANCE_TOUR" }),
    retreatTour: () => dispatch({ type: "RETREAT_TOUR" }),
    skipTour: () => dispatch({ type: "SKIP_TOUR" }),
    dismissPermanently: () => dispatch({ type: "DISMISS_PERMANENTLY" }),
    openPanelInfo: (id, anchor) => dispatch({ type: "OPEN_PANEL_INFO", panelId: id, anchor }),
    closePanelInfo: () => dispatch({ type: "CLOSE_PANEL_INFO" }),
    openGlossary: (term) => dispatch({ type: "OPEN_GLOSSARY", term }),
    closeGlossary: () => dispatch({ type: "CLOSE_GLOSSARY" }),
    openQuickStart: () => dispatch({ type: "OPEN_QUICK_START" }),
    closeQuickStart: () => dispatch({ type: "CLOSE_QUICK_START" }),
  };

  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useHelp(): HelpContextValue {
  const ctx = useContext(HelpContext);
  if (!ctx) throw new Error("useHelp must be used within HelpProvider");
  return ctx;
}
