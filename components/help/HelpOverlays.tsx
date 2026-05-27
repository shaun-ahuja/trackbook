"use client";

import TourOverlay from "./TourOverlay";
import GlossaryDrawer from "./GlossaryDrawer";
import PanelInfoCard from "./PanelInfoCard";
import QuickStartModal from "./QuickStartModal";

export default function HelpOverlays() {
  return (
    <>
      <TourOverlay />
      <GlossaryDrawer />
      <PanelInfoCard />
      <QuickStartModal />
    </>
  );
}
