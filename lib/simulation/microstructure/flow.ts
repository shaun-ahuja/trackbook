import type {
  AgentSlotKey,
  AgentState,
  Fill,
  FlowEvent,
  Market,
  MarketRegime,
  TraderArchetype,
} from "../../types";
import { applyIntents, topOfBook } from "../bookReducer";
import type { WasmMarketAdapter } from "../wasmAdapter";
import { safeBookState } from "../orderBookState";
import {
  divergenceFlowReason,
  divergenceFlowReasonKey,
  route,
  type DivergenceContext,
  type RoutedIntent,
} from "../orderFlow";
import { buildFlowReason } from "./explain";
import { poisson, weightedPick } from "./rng-helpers";
import { safeRegimeState } from "./regimeFsm";
import {
  LAMBDA,
  WEIGHTS,
  runArchetype,
  type ArchetypeOutput,
} from "./archetypes";
import { archetypeToSlot, safeAgents } from "./agentState";
import { REBALANCER_POSITION_CAP } from "./config";
import { clamp } from "../../format";

// EWMA tuning for the lpDepth signal. Baseline keeps the denominator from
// collapsing in markets with no LP arrivals for a long stretch.
const LP_DEPTH_BASELINE = 5;
const LP_DEPTH_ALPHA = 0.18;

const HISTORY_LEN = 60;
const FLOW_LOG_MAX = 8;
const VOL_ALPHA = 0.12;

// Minimum ticks between flowReason refreshes when the bucket key changes.
// Regime transitions and major event impacts bypass this so commentary
// stays in step with real news.
const FLOW_REASON_DWELL = 5;
const FLOW_REASON_MAJOR_IMPACT = 0.08;

function safeNum(n: number | undefined, fallback: number): number {
  return Number.isFinite(n) ? (n as number) : fallback;
}

export type FlowOutput = {
  market: Market;
  fills: Fill[];
  seed: number;
  shadowTraceCommands: ReturnType<typeof applyIntents>["shadowOps"];
};

export function flowTick(args: {
  market: Market;
  seed: number;
  currentTick: number;
  now: number;
  regime: MarketRegime;
  eventImpactMag: number;
  divCtx?: DivergenceContext;
  adapter?: WasmMarketAdapter;
}): FlowOutput {
  const { market, currentTick, now, regime, eventImpactMag, divCtx } = args;
  let seed = args.seed;

  const book = safeBookState(market.bookState);
  const fair = safeNum(market.fairValueCents, market.forecastProb * 100);
  const oldBid = safeNum(market.marketBid, fair - 2);
  const oldAsk = safeNum(market.marketAsk, fair + 2);
  const oldMid = (oldBid + oldAsk) / 2;
  const lpDepthPrev = safeNum(market.lpDepth, LP_DEPTH_BASELINE);
  const volPrev = safeNum(market.vol, 0.5);
  const flowLogPrev: FlowEvent[] = Array.isArray(market.flowLog)
    ? market.flowLog
    : [];

  // 1) Poisson sample external arrivals for this regime.
  const lambda = LAMBDA[regime];
  const pois = poisson(seed, lambda);
  seed = pois.seed;

  // Per-role persistent agent state. Hot-reload safe via safeAgents.
  const seedObs = market.dynamics?.lastLatentTrueProbability ?? market.forecastProb;
  const agents: Record<AgentSlotKey, AgentState> = safeAgents(market.agents, seedObs);

  const routed: RoutedIntent[] = [];
  const archetypePicks: { archetype: TraderArchetype; out: ArchetypeOutput }[] = [];
  for (let i = 0; i < pois.v; i++) {
    const picked = weightedPick(seed, WEIGHTS[regime]);
    seed = picked.seed;
    const slot = archetypeToSlot(picked.v);
    const out = runArchetype(picked.v, { market, regime }, agents[slot], seed, currentTick);
    seed = out.seed;
    agents[slot] = out.nextAgent;
    archetypePicks.push({ archetype: picked.v, out });
    // Null intent = skip (cooldown, weak signal, no stale quote, adverse-sel cancel)
    if (out.intent === null) continue;
    routed.push(route(picked.v, out.intent, regime));
  }

  // Rebalancer's position accumulates from net market-order flow generated
  // by OTHER agents — it's the institutional counterparty that absorbs the
  // bias the rest of the market is generating. Sign convention: when others
  // BUY, the rebalancer absorbs a SHORT (position -=); when others SELL, it
  // absorbs a LONG (position +=). Subsequent ticks see this position and
  // flatten it through the rebalancer handler.
  let externalNetFlow = 0;
  for (const r of routed) {
    if (r.intent.kind !== "market") continue;
    if (r.archetype === "desk_actor") continue;  // flow.ts never routes desk
    if (archetypeToSlot(r.archetype) === "rebalancer") continue;
    externalNetFlow += r.intent.side === "BUY" ? r.intent.qty : -r.intent.qty;
  }
  if (externalNetFlow !== 0) {
    agents.rebalancer = {
      ...agents.rebalancer,
      position: clamp(
        agents.rebalancer.position - externalNetFlow,
        -REBALANCER_POSITION_CAP,
        REBALANCER_POSITION_CAP,
      ),
    };
  }

  // 2) Apply routed intents against the (post-sync) book. Returns desk-
  //    perspective fills + updated book + per-intent flow events.
  const applied = applyIntents({
    book,
    intents: routed,
    currentTick,
    marketId: market.id,
    fairCents: fair,
    now,
    adapter: args.adapter,
  });

  // 3) Derived signals.
  const top = topOfBook(applied.book, oldBid, oldAsk);
  const newBid = top.bid;
  const newAsk = top.ask;
  const newMid = top.mid;

  // lpDepth EWMA — count limit-side arrivals. Aggregates qty not arrivals
  // so a single big LP layer has the same denominator boost as several
  // small ones.
  let lpQtyTick = 0;
  for (const r of routed) {
    if (r.intent.kind === "limit") lpQtyTick += r.intent.qty;
  }
  const lpDepthNew =
    (1 - LP_DEPTH_ALPHA) * lpDepthPrev +
    LP_DEPTH_ALPHA * (lpQtyTick + LP_DEPTH_BASELINE);

  // Vol EWMA from displayed mid drift. Calm ticks with no movement decay
  // the EWMA naturally.
  const newVol = (1 - VOL_ALPHA) * volPrev + VOL_ALPHA * Math.abs(newMid - oldMid);
  const priceHistory = [...market.priceHistory, newMid].slice(-HISTORY_LEN);

  // 4) Flow reason — bucketed for narrative stability.
  let imbalance = 0;
  let informedCount = 0;
  let panicCount = 0;
  for (const r of routed) {
    if (r.intent.kind !== "market") continue;
    imbalance += r.intent.side === "BUY" ? r.intent.qty : -r.intent.qty;
    if (r.archetype === "informed_transit" || r.archetype === "latency_arb") {
      informedCount++;
    }
    if (r.archetype === "panic") panicCount++;
  }
  const imbalanceSign: -1 | 0 | 1 =
    imbalance === 0 ? 0 : imbalance > 0 ? 1 : -1;
  const { reason, key } = buildFlowReason({
    lpCount: applied.limitCount,
    marketCount: applied.marketCount,
    informedCount,
    panicCount,
    imbalanceMag: Math.abs(imbalance),
    imbalanceSign,
    regime,
    ourPosture: market.lastAction,
    totalArrivals: routed.length,
  });
  const prevKey = market.flowReasonKey ?? "";
  const prevRegime = prevKey.split("|")[0];
  const regimeChanged = prevRegime !== "" && prevRegime !== regime;
  const reasonTickPrev = Number.isFinite(market.flowReasonTick)
    ? market.flowReasonTick
    : 0;
  const dwellElapsed = currentTick - reasonTickPrev >= FLOW_REASON_DWELL;
  const majorImpact = eventImpactMag >= FLOW_REASON_MAJOR_IMPACT;

  // Magnet annotation: when divergence is mild/strong the panel needs to
  // explain why extra informed flow is showing up. Bypasses dwell so the
  // message appears (and disappears) immediately on threshold crossing.
  const magnetReason = divCtx ? divergenceFlowReason(divCtx) : null;
  const magnetKey = divCtx ? divergenceFlowReasonKey(divCtx) : "";
  const magnetActive = magnetReason !== null;

  const shouldRefresh = magnetActive
    ? magnetKey !== prevKey
    : key !== prevKey && (regimeChanged || dwellElapsed || majorImpact);
  const flowReason = shouldRefresh
    ? (magnetActive ? (magnetReason as string) : reason)
    : market.flowReason;
  const flowReasonKey = shouldRefresh
    ? (magnetActive ? magnetKey : key)
    : market.flowReasonKey;
  const flowReasonTick = shouldRefresh ? currentTick : reasonTickPrev;

  const flowLog = [...applied.flowEvents, ...flowLogPrev].slice(0, FLOW_LOG_MAX);

  // Suppress unused-warning lint on archetypePicks — kept around in case
  // future narrative work wants the raw archetype tally.
  void archetypePicks;

  return {
    market: {
      ...market,
      bookState: applied.book,
      marketBid: newBid,
      marketAsk: newAsk,
      priceHistory,
      vol: newVol,
      lpDepth: lpDepthNew,
      flowLog,
      flowReason,
      flowReasonKey,
      flowReasonTick,
      regimeState: safeRegimeState(market.regimeState),
      agents,
    },
    fills: applied.fills,
    seed,
    shadowTraceCommands: applied.shadowOps,
  };
}
