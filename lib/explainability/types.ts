export const PANEL_IDS = [
  "markets",
  "detail",
  "decision",
  "forecast",
  "eventtape",
  "pnl",
  "orderbook",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

export type TourStep = {
  id: string;
  panelId: PanelId;
  title: string;
  body: string;
};

export type PanelInfo = {
  panelId: PanelId;
  title: string;
  what: string;
  why: string;
  howUpdates: string;
  howInterpret: string;
};

export type GlossaryTerm = {
  id: string;
  label: string;
  definition: string;
  seeAlso?: string[];
};

export type SimpleRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};
