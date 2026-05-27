"use client";

import TourOverlay from "./TourOverlay";
import GlossaryDrawer from "./GlossaryDrawer";
import PanelInfoCard from "./PanelInfoCard";
import QuickStartModal from "./QuickStartModal";
import IntroModal from "./IntroModal";

export default function HelpOverlays() {
  return (
    <>
      <IntroModal />
      <TourOverlay />
      <GlossaryDrawer />
      <PanelInfoCard />
      <QuickStartModal />
    </>
  );
}
