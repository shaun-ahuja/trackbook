"use client";

import type { ReactNode } from "react";
import { useHelp } from "@/contexts/HelpContext";

type Props = {
  term: string;
  children: ReactNode;
};

export default function GlossaryTrigger({ term, children }: Props) {
  const { openGlossary } = useHelp();
  return (
    <span
      className="glossary-trigger"
      onClick={(e) => {
        e.stopPropagation();
        openGlossary(term);
      }}
    >
      {children}
    </span>
  );
}
