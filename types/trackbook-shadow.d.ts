import type { ShadowMismatch } from "@/lib/simulation/shadowDiff";
import type { ShadowTickReplaySummary } from "@/lib/simulation/shadowDebug";

declare global {
  interface Window {
    __TRACKBOOK_SHADOW__?: {
      enabled: boolean;
      ready: boolean;
      disabledReason?: string;
      handlesByMarket: Record<string, number>;
      lastTickByMarket: Record<string, number>;
      mismatchCounts: Record<string, number>;
      recentMismatches: ShadowMismatch[];
      accountingComparableByMarket: Record<string, boolean>;
      recentTickSummaries: ShadowTickReplaySummary[];
    };
  }
}

export {};
