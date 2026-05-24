import {
  INVENTORY_LIMIT,
  type Market,
  type MarketAction,
  type RiskPosture,
} from "../types";
import { clamp } from "../format";

// Decision-engine tuning. Hysteresis + cooldowns so actions persist long
// enough to read and small noise can't flip the posture every tick.
const MIN_HOLD_TICKS = 25;            // ~19s at 750ms tick — postures persist
const FLATTEN_EXIT_INV = INVENTORY_LIMIT - 3; // hysteretic flatten exit (5)

// Edge thresholds in cents. Asymmetric so a posture sticks even as edge
// erodes. Raised vs. v0 so HIT/LIFT need a real dislocation, not a wiggle.
const EDGE_ENTER = 3.5;               // need ≥3.5¢ edge to engage
const EDGE_EXIT = 1.2;                // stay engaged until edge falls below 1.2¢
const CONF_ENTER = 0.62;
const CONF_EXIT = 0.5;
const WIDEN_EDGE_BAND = 1.5;          // |edge| inside which WIDEN is sticky
const CONVICTION_ENTER = 2.4;         // |edge| × conf gate for LIFT/HIT entry
const HIGH_VOL = 0.6;                 // EWMA |Δmid| above which we lean WIDEN

// Evidence-delta hysteresis. Tightened: the desk needs a substantial
// signal shift since the last flip to override the min-hold lockout.
// The explicit early-flip carve-outs below (very large edge, fresh shock,
// inventory breach via FLATTEN) handle the cases where waiting hurts.
const EVIDENCE_DELTA_THRESHOLD = 4.0;
const CONF_DELTA_WEIGHT = 50;

// Carve-outs that allow the posture to flip before MIN_HOLD_TICKS expires.
// Inventory breach is handled separately — it forces candidate=FLATTEN
// and FLATTEN already bypasses the lock.
const VERY_LARGE_EDGE = EDGE_ENTER * 2;        // ≥7¢ dislocation
const VERY_LARGE_EDGE_CONF = 0.65;

type DecisionOut = {
  market: Market;
  action: MarketAction;
};

// Pure decision. Sets posture + quote + narrative + risk. Does NOT apply
// fills — those run as a separate stage in the reducer so we can mix
// passive/aggressive/shock execution cleanly.
export function decide(
  market: Market,
  now: number,
  currentTick: number,
): DecisionOut {
  const fair = clamp(market.forecastProb * 100, 1, 99);
  const mid = (market.marketBid + market.marketAsk) / 2;
  const edge = fair - mid;
  const conf = market.confidence;
  const inv = market.inventory;
  const vol = market.vol;
  const prev = market.lastAction;

  // Inventory skew curves up near the limit — desk pulls quotes away from
  // the side it'd rather not add to.
  const invFrac = Math.abs(inv) / INVENTORY_LIMIT;
  const skew = inv * 0.45 * (1 + invFrac * invFrac);

  // 1) Choose a candidate posture with hysteresis based on previous posture.
  let candidate = candidatePosture(prev, edge, conf, inv, vol);

  // 2) Risk override: hard inventory breach always wins, regardless of lock.
  const breach = inv > INVENTORY_LIMIT || inv < -INVENTORY_LIMIT;
  if (breach) candidate = "FLATTEN";

  // 3) Flip gate. A posture flip is allowed when ANY of:
  //      - min-hold lockout has expired (default path)
  //      - very large edge with strong conf (mispricing too big to wait out)
  //      - a fresh shock landed on this market this tick
  //      - enough evidence has accumulated since the last flip (rare —
  //        threshold raised so this only triggers on big shifts)
  //    FLATTEN can always engage or exit (inventory breach path).
  let action: MarketAction = candidate;
  const ticksSinceDecision = currentTick - market.lastDecisionTick;
  const lastEdge = Number.isFinite(market.lastEdgeAtFlip)
    ? market.lastEdgeAtFlip
    : edge;
  const lastConf = Number.isFinite(market.lastConfAtFlip)
    ? market.lastConfAtFlip
    : conf;
  const evidenceDelta =
    Math.abs(edge - lastEdge) + CONF_DELTA_WEIGHT * Math.abs(conf - lastConf);
  const veryLargeEdge =
    Math.abs(edge) >= VERY_LARGE_EDGE && conf >= VERY_LARGE_EDGE_CONF;
  const freshShock = market.lastImpactTs === now;
  const flipAllowed =
    ticksSinceDecision >= MIN_HOLD_TICKS ||
    evidenceDelta >= EVIDENCE_DELTA_THRESHOLD ||
    veryLargeEdge ||
    freshShock;
  const lockActive =
    !flipAllowed && prev !== "FLATTEN" && candidate !== "FLATTEN";
  if (lockActive && candidate !== prev) {
    action = prev;
  }

  // 4) Quote layout per posture. Inventory-skewed.
  const { ourBid, ourAsk } = quoteFor(action, mid, skew);

  // 5) Narrative stability: rebuild text only when the rationale bucket
  //    actually changes. Includes posture, edge bucket, conf bucket,
  //    inventory bucket, vol bucket, and a fresh-shock flag.
  const newShock = market.lastImpactTs === now;
  const key = narrativeKey(action, edge, conf, inv, vol, newShock);
  let shortReason = market.lastActionReason;
  let narrative = market.narrative;
  if (key !== market.narrativeKey) {
    const built = explain(action, fair, mid, edge, conf, inv, vol);
    shortReason = built.shortReason;
    narrative = built.narrative;
  }

  const riskPosture = computeRiskPosture(inv, conf);

  // 6) Track decision tick + last-flip snapshots. Only update on actual
  //    posture changes — otherwise the lock never expires and the
  //    evidence-delta gate would also stay frozen.
  const postureChanged = action !== prev;
  const lastDecisionTick = postureChanged ? currentTick : market.lastDecisionTick;
  const lastEdgeAtFlip = postureChanged ? edge : lastEdge;
  const lastConfAtFlip = postureChanged ? conf : lastConf;

  const next: Market = {
    ...market,
    ourBid,
    ourAsk,
    fairValueCents: Math.round(fair * 10) / 10,
    lastAction: action,
    lastActionReason: shortReason,
    narrative,
    narrativeKey: key,
    riskPosture,
    lastDecisionTick,
    lastEdgeAtFlip,
    lastConfAtFlip,
  };

  return { market: next, action };
}

// Choose what we'd *want* the posture to be, given the previous posture
// and current signals. Asymmetric thresholds = hysteresis.
function candidatePosture(
  prev: MarketAction,
  edge: number,
  conf: number,
  inv: number,
  vol: number,
): MarketAction {
  // Hysteretic FLATTEN exit: once flattening, keep going until |inv| drops
  // well inside the limit.
  if (prev === "FLATTEN") {
    if (Math.abs(inv) > FLATTEN_EXIT_INV) return "FLATTEN";
    return "HOLD";
  }

  // High realised vol → pull back to a passive market unless we've already
  // committed to an aggressive posture (where the edge-exit hysteresis
  // governs the way out).
  const volSpiking = vol > HIGH_VOL;

  if (prev === "LIFT") {
    if (edge >= EDGE_EXIT && conf >= CONF_EXIT) return "LIFT";
    if (edge <= -EDGE_ENTER && conf >= CONF_ENTER && Math.abs(edge) * conf >= CONVICTION_ENTER)
      return "HIT";
    if (conf < CONF_EXIT || volSpiking) return "WIDEN";
    return "HOLD";
  }
  if (prev === "HIT") {
    if (edge <= -EDGE_EXIT && conf >= CONF_EXIT) return "HIT";
    if (edge >= EDGE_ENTER && conf >= CONF_ENTER && edge * conf >= CONVICTION_ENTER)
      return "LIFT";
    if (conf < CONF_EXIT || volSpiking) return "WIDEN";
    return "HOLD";
  }
  if (prev === "WIDEN") {
    // Sticky WIDEN: needs a strong, calm signal to leave.
    if (conf < CONF_ENTER || volSpiking) return "WIDEN";
    if (Math.abs(edge) < WIDEN_EDGE_BAND) return "WIDEN";
    if (edge >= EDGE_ENTER && edge * conf >= CONVICTION_ENTER) return "LIFT";
    if (edge <= -EDGE_ENTER && Math.abs(edge) * conf >= CONVICTION_ENTER) return "HIT";
    return "HOLD";
  }
  // HOLD — neutral; needs full entry threshold AND conviction to engage.
  if (volSpiking) return "WIDEN";
  if (conf < CONF_ENTER - 0.05) return "WIDEN";
  if (edge >= EDGE_ENTER && conf >= CONF_ENTER && edge * conf >= CONVICTION_ENTER)
    return "LIFT";
  if (edge <= -EDGE_ENTER && conf >= CONF_ENTER && Math.abs(edge) * conf >= CONVICTION_ENTER)
    return "HIT";
  return "HOLD";
}

function quoteFor(action: MarketAction, mid: number, skew: number) {
  // Pull/push the quote around the synthetic mid, skewed by inventory to
  // bias the desk toward unloading risk.
  let bidOff = -1;
  let askOff = 1;
  if (action === "WIDEN") {
    bidOff = -2;
    askOff = 2;
  } else if (action === "LIFT") {
    bidOff = -0.5;
    askOff = 1.5;
  } else if (action === "HIT") {
    bidOff = -1.5;
    askOff = 0.5;
  } else if (action === "FLATTEN") {
    bidOff = -1;
    askOff = 1;
  }
  const ourBid = clamp(mid - skew + bidOff, 1, 98);
  const ourAsk = clamp(mid - skew + askOff, ourBid + 0.5, 99);
  return { ourBid, ourAsk };
}

// Bucketed signature of the rationale. While the same key holds, the
// narrative text on the panel does not re-render — eliminating the per-tick
// "next lift in 3 ticks" churn that made the desk feel jittery.
function narrativeKey(
  action: MarketAction,
  edge: number,
  conf: number,
  inv: number,
  vol: number,
  newShock: boolean,
): string {
  const edgeBucket =
    edge <= -EDGE_ENTER
      ? "e--"
      : edge <= -WIDEN_EDGE_BAND
        ? "e-"
        : edge < WIDEN_EDGE_BAND
          ? "e0"
          : edge < EDGE_ENTER
            ? "e+"
            : "e++";
  const confBucket = conf < CONF_EXIT ? "cL" : conf < CONF_ENTER ? "cM" : "cH";
  const absInv = Math.abs(inv);
  const invBucket =
    absInv === 0
      ? "i0"
      : absInv < INVENTORY_LIMIT / 2
        ? inv > 0
          ? "i+"
          : "i-"
        : inv > 0
          ? "i++"
          : "i--";
  const volBucket = vol > HIGH_VOL ? "vH" : "vN";
  return [action, edgeBucket, confBucket, invBucket, volBucket, newShock ? "S" : ""].join("|");
}

function explain(
  action: MarketAction,
  fair: number,
  mid: number,
  edge: number,
  conf: number,
  inv: number,
  vol: number,
): { shortReason: string; narrative: string } {
  const invStr = fmtInv(inv);
  const confStr = pctInt(conf);
  const volNote = vol > HIGH_VOL ? " Realised vol is elevated — spreads are wider than usual." : "";

  if (action === "FLATTEN") {
    const side = inv > 0 ? "selling into the bid" : "covering on the offer";
    return {
      shortReason: `inventory ${invStr} · risk reduction`,
      narrative:
        `Inventory at ${invStr} has crossed the ±${INVENTORY_LIMIT} risk limit. ` +
        `The desk is ${side} regardless of edge until exposure drops below ${FLATTEN_EXIT_INV}.`,
    };
  }

  if (action === "LIFT") {
    return {
      shortReason: `fair > mid by ${edge.toFixed(1)}¢ · long bias`,
      narrative:
        `Model places fair value above the synthetic mid with ${confStr} confidence. ` +
        `Inventory ${invStr} (limit ±${INVENTORY_LIMIT}). Working a buy on the offer until the edge fades.${volNote}`,
    };
  }

  if (action === "HIT") {
    return {
      shortReason: `mid > fair by ${(-edge).toFixed(1)}¢ · short bias`,
      narrative:
        `Synthetic mid trades above our fair value with ${confStr} confidence. ` +
        `Inventory ${invStr}. Working a sell on the bid while the dislocation persists.${volNote}`,
    };
  }

  if (action === "WIDEN") {
    if (vol > HIGH_VOL) {
      return {
        shortReason: `vol elevated — passive`,
        narrative:
          `Realised volatility on the synthetic tape has spiked. Pulling the quote wider and ` +
          `letting the print stabilise before reassessing edge. Confidence ${confStr}, inventory ${invStr}.`,
      };
    }
    if (conf < CONF_ENTER) {
      return {
        shortReason: `confidence ${confStr} — passive`,
        narrative:
          `Model confidence has fallen to ${confStr}; recent transit signals are mixed or stale. ` +
          `Showing a passive market while the desk reads the tape. Inventory ${invStr}.`,
      };
    }
    return {
      shortReason: `edge inside threshold`,
      narrative:
        `Synthetic mid (${mid.toFixed(1)}¢) sits within ${WIDEN_EDGE_BAND.toFixed(1)}¢ of our ${fair.toFixed(1)}¢ fair value. ` +
        `No exploitable edge — holding a passive resting quote and waiting for a dislocation.`,
    };
  }

  // HOLD
  return {
    shortReason: `edge ${edge >= 0 ? "+" : ""}${edge.toFixed(1)}¢ — neutral`,
    narrative:
      `Fair (${fair.toFixed(1)}¢) and synthetic mid (${mid.toFixed(1)}¢) are aligned at ${confStr} confidence. ` +
      `Desk is maintaining its resting quote and waiting for the next event.${volNote}`,
  };
}

function computeRiskPosture(inv: number, conf: number): RiskPosture {
  const absInv = Math.abs(inv);
  if (absInv >= INVENTORY_LIMIT - 1) return "WARNING";
  if (absInv >= INVENTORY_LIMIT - 3 || conf < 0.45) return "CAUTIOUS";
  return "NORMAL";
}

function fmtInv(inv: number): string {
  if (inv > 0) return `+${inv}`;
  if (inv < 0) return `${inv}`;
  return "0";
}

function pctInt(p: number): string {
  return `${Math.round(p * 100)}%`;
}
