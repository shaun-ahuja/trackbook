import type { MarketAction, MarketRegime } from "../../types";

export type FlowStats = {
  lpCount: number;
  marketCount: number;
  informedCount: number;
  panicCount: number;
  imbalanceMag: number;
  imbalanceSign: -1 | 0 | 1;
  regime: MarketRegime;
  ourPosture: MarketAction;
  totalArrivals: number;
};

// Coarse dominant-force bucket. We collapse fine-grained tallies into one
// of seven categories so the displayed reason rotates slowly and reads
// like a market commentary, not a debug printout.
type DominantForce =
  | "quiet"          // no arrivals at all
  | "lp_only"        // arrivals but no market orders crossed
  | "two_sided"      // market orders balanced — mid stable
  | "buying"         // net buy imbalance, no special archetype dominant
  | "selling"        // net sell imbalance, no special archetype dominant
  | "informed"       // informed/latency-arb traders pressing one side
  | "panic";         // panic traders dumping during shock

function classify(stats: FlowStats): DominantForce {
  if (stats.totalArrivals === 0) return "quiet";
  if (stats.marketCount === 0) return "lp_only";
  if (stats.panicCount >= 2) return "panic";
  if (stats.informedCount >= 2) return "informed";
  if (stats.imbalanceMag <= 1) return "two_sided";
  return stats.imbalanceSign > 0 ? "buying" : "selling";
}

// Bucket the per-tick flow tally into a short, stable string. The reason
// only refreshes when the key changes AND the per-market dwell gate
// (5 ticks, in flow.ts) has elapsed.
export function buildFlowReason(stats: FlowStats): { reason: string; key: string } {
  const force = classify(stats);
  const key = `${stats.regime}|${force}`;

  let reason: string;
  switch (key) {
    case "calm|quiet":
      reason = "no trader arrivals — quote idle";
      break;
    case "calm|lp_only":
      reason = "liquidity providers posting passively";
      break;
    case "calm|two_sided":
      reason = "two-sided flow, mid stable";
      break;
    case "calm|buying":
      reason = "light bid pressure on the tape";
      break;
    case "calm|selling":
      reason = "light offer pressure on the tape";
      break;
    case "calm|informed":
      reason = "informed flow building underneath calm";
      break;
    case "calm|panic":
      reason = "isolated panic flow during calm";
      break;

    case "alert|quiet":
      reason = "alert regime — tape quiet for now";
      break;
    case "alert|lp_only":
      reason = "alert regime — only liquidity providers active";
      break;
    case "alert|two_sided":
      reason = "alert regime — two-sided flow";
      break;
    case "alert|buying":
      reason = "buy-side pressure building";
      break;
    case "alert|selling":
      reason = "sell-side pressure building";
      break;
    case "alert|informed":
      reason = "informed flow front-running the move";
      break;
    case "alert|panic":
      reason = "panic flow starting to bleed into the tape";
      break;

    case "shock|quiet":
      reason = "shock regime — tape briefly quiet";
      break;
    case "shock|lp_only":
      reason = "liquidity pulled during shock regime";
      break;
    case "shock|two_sided":
      reason = "shock regime — both sides slugging it out";
      break;
    case "shock|buying":
      reason = "shock regime — buy-side dominant";
      break;
    case "shock|selling":
      reason = "shock regime — sell-side dominant";
      break;
    case "shock|informed":
      reason = "informed flow active during shock";
      break;
    case "shock|panic":
      reason = "panic flow dumping during shock";
      break;

    case "recovery|quiet":
      reason = "recovery — tape settling";
      break;
    case "recovery|lp_only":
      reason = "recovery — liquidity refilling the book";
      break;
    case "recovery|two_sided":
      reason = "mean reversion flow after overshoot";
      break;
    case "recovery|buying":
      reason = "buyers rebuilding inventory in recovery";
      break;
    case "recovery|selling":
      reason = "sellers unwinding in recovery";
      break;
    case "recovery|informed":
      reason = "informed flow chasing residual mispricing";
      break;
    case "recovery|panic":
      reason = "late panic flow in recovery";
      break;

    default:
      reason = "flow tally unmapped";
  }

  return { reason, key };
}
