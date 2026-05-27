"use client";

import { useRef } from "react";
import { useHelp } from "@/contexts/HelpContext";
import type { PanelId, SimpleRect } from "@/lib/explainability/types";

type Props = { panelId: PanelId };

export default function InfoIcon({ panelId }: Props) {
  const { openPanelInfo, activePanelInfoId, closePanelInfo } = useHelp();
  const btnRef = useRef<HTMLButtonElement>(null);
  const isOpen = activePanelInfoId === panelId;

  function handleClick() {
    if (isOpen) {
      closePanelInfo();
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchor: SimpleRect = {
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
    openPanelInfo(panelId, anchor);
  }

  return (
    <button
      ref={btnRef}
      onClick={handleClick}
      className="ml-1 flex h-4 w-4 items-center justify-center rounded-[1px] text-[9px] leading-none transition-colors"
      style={{
        color: isOpen ? "var(--color-accent)" : "var(--color-muted)",
        background: isOpen ? "rgba(88,228,197,0.08)" : "transparent",
        border: `1px solid ${isOpen ? "rgba(88,228,197,0.25)" : "transparent"}`,
      }}
      title={isOpen ? "Close panel info" : "About this panel"}
    >
      ℹ
    </button>
  );
}
