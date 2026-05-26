import type { Fill } from "../types";
import { mkFill } from "./fills";
import type { BookSide, BookState, OrderOwner, RestingOrder } from "./orderBookState";
import type { MatchResult } from "./bookMatching";
import { MatchingEngineKernel } from "../wasm/orderBookKernel";
import {
  centsToTicks,
  MatchingEngineFillKindTag,
  MatchingEngineOpcode,
  MatchingEngineOwnerTag,
  MatchingEngineSideTag,
  ticksToCents,
  type MatchingEngineBookLevel,
  type MatchingEngineCommand,
  type MatchingEngineFillRecord,
  type MatchingEngineStateSnapshot,
} from "../wasm/orderBookKernelTypes";

type RegistryEntry = {
  tsId: number;
  nativeId: number | null;
  side: BookSide;
  owner: OrderOwner;
  priceCents: number;
  size: number;
  postedTick: number;
  ttlTicks: number;
};

// Deep snapshot depth: large enough to capture all levels in a typical
// market book. Used so reconciliation can definitively know "WASM has 0 at
// this price" (vs "price beyond snapshot depth").
const DEEP_DEPTH = 64;

type TickCtx = {
  now: number;
  currentTick: number;
  marketId: string;
  markFair: number;
};

function ownerToTag(owner: OrderOwner): MatchingEngineOwnerTag {
  switch (owner) {
    case "desk": return MatchingEngineOwnerTag.Desk;
    case "lp": return MatchingEngineOwnerTag.Lp;
    case "noise": return MatchingEngineOwnerTag.Noise;
    case "informed": return MatchingEngineOwnerTag.Informed;
    case "momentum": return MatchingEngineOwnerTag.Momentum;
    case "rebal": return MatchingEngineOwnerTag.Rebal;
    case "patient": return MatchingEngineOwnerTag.Patient;
    case "panic": return MatchingEngineOwnerTag.Panic;
    case "event": return MatchingEngineOwnerTag.Event;
    default: return MatchingEngineOwnerTag.Lp;
  }
}

function fillKindToTag(kind: "passive" | "aggressive" | "flatten" | "shock"): MatchingEngineFillKindTag {
  switch (kind) {
    case "passive": return MatchingEngineFillKindTag.Passive;
    case "aggressive": return MatchingEngineFillKindTag.Aggressive;
    case "flatten": return MatchingEngineFillKindTag.Flatten;
    case "shock": return MatchingEngineFillKindTag.Shock;
  }
}

function fillTagToKind(tag: MatchingEngineFillKindTag): "passive" | "aggressive" | "flatten" | "shock" {
  switch (tag) {
    case MatchingEngineFillKindTag.Passive: return "passive";
    case MatchingEngineFillKindTag.Aggressive: return "aggressive";
    case MatchingEngineFillKindTag.Flatten: return "flatten";
    case MatchingEngineFillKindTag.Shock: return "shock";
    default: return "passive";
  }
}

// Per-market adapter that routes matching operations through a WASM handle.
// Maintains a TS order registry (for TTL/owner/ID tracking) alongside WASM
// state. TS bookReducer functions use this adapter instead of bookMatching.ts
// functions; WASM is the authoritative execution engine.
export class WasmMarketAdapter {
  private readonly kernel: MatchingEngineKernel;
  readonly handle: number;
  private readonly tsToNative = new Map<number, number>();
  private readonly nativeToTs = new Map<number, number>();
  private registry = new Map<number, RegistryEntry>();
  private nextTsId = 1;
  private accFills: MatchingEngineFillRecord[] = [];
  private lastSnapshot: MatchingEngineStateSnapshot;
  private fillCounter = 0;
  private tickCtx: TickCtx = { now: 0, currentTick: 0, marketId: "", markFair: 50 };

  constructor(kernel: MatchingEngineKernel, handle: number) {
    this.kernel = kernel;
    this.handle = handle;
    this.lastSnapshot = kernel.executeHandle(handle, [], { snapshotDepth: DEEP_DEPTH }).snapshot;
  }

  // Set per-tick context used for TS fill construction. Call at the start
  // of each market's phase processing before any adapter operations.
  beginTick(ctx: TickCtx): void {
    this.tickCtx = ctx;
    this.fillCounter = 0;
    this.accFills = [];
  }

  // Seed from an existing TS bookState. Submits all resting orders to WASM
  // and populates the registry and ID maps.
  seed(bookState: BookState): void {
    this.registry.clear();
    this.tsToNative.clear();
    this.nativeToTs.clear();
    this.nextTsId = bookState.nextOrderId;
    this.accFills = [];
    this.fillCounter = 0;

    for (const order of [...bookState.bids, ...bookState.asks]) {
      const result = this.kernel.executeHandle(this.handle, [{
        op: MatchingEngineOpcode.SubmitLimit,
        side: order.side === "BID" ? MatchingEngineSideTag.BidOrBuy : MatchingEngineSideTag.AskOrSell,
        owner: ownerToTag(order.owner),
        priceTicks: centsToTicks(order.priceCents),
        qty: order.size,
        logicalTime: order.postedTick,
        ttlTicks: order.ttlTicks,
        fillKind: MatchingEngineFillKindTag.Aggressive,
      }], { snapshotDepth: DEEP_DEPTH });
      if (process.env.WASM_ADAPTER_DEBUG === "1" && result.lastOrderId <= 0) {
        console.warn("[adapter:seed] order rejected", {
          orderId: order.id,
          side: order.side,
          priceCents: order.priceCents,
          size: order.size,
          owner: order.owner,
          lastOrderId: result.lastOrderId,
        });
      }
      const entry: RegistryEntry = {
        tsId: order.id,
        nativeId: result.lastOrderId > 0 ? result.lastOrderId : null,
        side: order.side,
        owner: order.owner,
        priceCents: order.priceCents,
        size: order.size,
        postedTick: order.postedTick,
        ttlTicks: order.ttlTicks,
      };
      this.registry.set(order.id, entry);
      if (result.lastOrderId > 0) {
        this.tsToNative.set(order.id, result.lastOrderId);
        this.nativeToTs.set(result.lastOrderId, order.id);
      }
    }
    this.lastSnapshot = this.kernel.executeHandle(this.handle, [], { snapshotDepth: DEEP_DEPTH }).snapshot;
    this.reconcile();
  }

  // Cancel a batch of orders by TS ID. Batched into a single WASM call.
  cancelManyByIds(tsIds: Set<number>): void {
    if (tsIds.size === 0) return;
    const commands: MatchingEngineCommand[] = [];
    for (const tsId of tsIds) {
      const nativeId = this.tsToNative.get(tsId);
      if (nativeId) {
        commands.push({ op: MatchingEngineOpcode.CancelOrder, orderId: nativeId });
        this.tsToNative.delete(tsId);
        this.nativeToTs.delete(nativeId);
      }
      this.registry.delete(tsId);
    }
    if (commands.length > 0) {
      const result = this.kernel.executeHandle(this.handle, commands, { snapshotDepth: DEEP_DEPTH });
      this.lastSnapshot = result.snapshot;
    }
    this.reconcile();
    this.assertConsistent("cancelMany");
  }

  // Submit a limit order to WASM. Returns a MatchResult compatible with
  // bookMatching.insertLimit so callers can swap in the adapter with minimal
  // changes. The book field is a live view of the registry after execution.
  submitLimit(
    side: BookSide,
    priceCents: number,
    size: number,
    owner: OrderOwner,
    postedTick: number,
    ttlTicks: number,
    fillKind: "passive" | "aggressive" | "flatten" | "shock" = "aggressive",
  ): MatchResult {
    const result = this.kernel.executeHandle(this.handle, [{
      op: MatchingEngineOpcode.SubmitLimit,
      side: side === "BID" ? MatchingEngineSideTag.BidOrBuy : MatchingEngineSideTag.AskOrSell,
      owner: ownerToTag(owner),
      priceTicks: centsToTicks(priceCents),
      qty: size,
      logicalTime: postedTick,
      ttlTicks,
      fillKind: fillKindToTag(fillKind),
    }], { snapshotDepth: DEEP_DEPTH });
    this.lastSnapshot = result.snapshot;

    const fills = this.processFills(result.fills);
    this.accFills.push(...result.fills);

    let remaining = size;
    for (const f of result.fills) remaining -= f.qty;

    let restedOrderId: number | undefined;
    if (result.lastOrderId > 0 && remaining > 0) {
      const tsId = this.nextTsId++;
      restedOrderId = tsId;
      const entry: RegistryEntry = {
        tsId,
        nativeId: result.lastOrderId,
        side,
        owner,
        priceCents,
        size: remaining,
        postedTick,
        ttlTicks,
      };
      this.registry.set(tsId, entry);
      if (this.nativeToTs.has(result.lastOrderId) && process.env.WASM_ADAPTER_DEBUG === "1") {
        const prevTsId = this.nativeToTs.get(result.lastOrderId);
        console.warn("[adapter:submitLimit] duplicate native ID", {
          nativeId: result.lastOrderId,
          newTsId: tsId,
          prevTsId,
          tick: this.tickCtx.currentTick,
        });
      }
      this.tsToNative.set(tsId, result.lastOrderId);
      this.nativeToTs.set(result.lastOrderId, tsId);
    } else if (result.lastOrderId === 0 && remaining > 0 && process.env.WASM_ADAPTER_DEBUG === "1") {
      console.warn("[adapter:submitLimit] order rested without native ID", {
        side,
        priceCents,
        size,
        remaining,
        owner,
        tick: this.tickCtx.currentTick,
      });
    }

    const lastTradePriceCents = result.snapshot.lastTradePriceTicks > 0
      ? ticksToCents(result.snapshot.lastTradePriceTicks)
      : null;

    this.reconcile();
    this.assertConsistent("submitLimit");
    return { book: this.snapshotToBookView(), fills, lastTradePriceCents, restedOrderId };
  }

  // Submit a market order to WASM. Returns a MatchResult compatible with
  // bookMatching.executeMarket.
  executeMarket(
    takerSide: "BUY" | "SELL",
    size: number,
    takerOwner: OrderOwner,
    fillKind: "passive" | "aggressive" | "flatten" | "shock" = "passive",
    currentTick?: number,
  ): MatchResult {
    const logicalTime = currentTick ?? this.tickCtx.currentTick;
    const result = this.kernel.executeHandle(this.handle, [{
      op: MatchingEngineOpcode.SubmitMarket,
      side: takerSide === "BUY" ? MatchingEngineSideTag.BidOrBuy : MatchingEngineSideTag.AskOrSell,
      owner: ownerToTag(takerOwner),
      qty: size,
      logicalTime,
      fillKind: fillKindToTag(fillKind),
    }], { snapshotDepth: DEEP_DEPTH });
    this.lastSnapshot = result.snapshot;

    if (process.env.WASM_ADAPTER_DEBUG === "1") {
      console.warn("[adapter:executeMarket] result", {
        takerSide,
        size,
        takerOwner,
        tick: this.tickCtx.currentTick,
        fillsCount: result.fills.length,
        fills: result.fills.map((f) => ({
          maker: f.makerOrderId,
          taker: f.takerOrderId,
          qty: f.qty,
          priceTicks: f.priceTicks,
          deskSide: f.deskSide,
        })),
      });
    }

    const fills = this.processFills(result.fills);
    this.accFills.push(...result.fills);

    const lastTradePriceCents = result.snapshot.lastTradePriceTicks > 0
      ? ticksToCents(result.snapshot.lastTradePriceTicks)
      : null;

    this.reconcile();
    this.assertConsistent("executeMarket");
    return { book: this.snapshotToBookView(), fills, lastTradePriceCents };
  }

  // Return the last WASM snapshot.
  getSnapshot(): MatchingEngineStateSnapshot {
    return this.lastSnapshot;
  }

  // Return and clear accumulated raw WASM fill records.
  drainFills(): MatchingEngineFillRecord[] {
    const f = this.accFills;
    this.accFills = [];
    return f;
  }

  // Build a BookState view from the registry. bids/asks are sorted correctly
  // for bestBidPrice/bestAskPrice; lastTradePriceCents comes from WASM state.
  snapshotToBookView(): BookState {
    const bids: RestingOrder[] = [];
    const asks: RestingOrder[] = [];

    for (const entry of this.registry.values()) {
      const order: RestingOrder = {
        id: entry.tsId,
        side: entry.side,
        priceCents: entry.priceCents,
        size: entry.size,
        owner: entry.owner,
        postedTick: entry.postedTick,
        ttlTicks: entry.ttlTicks,
      };
      if (entry.side === "BID") bids.push(order);
      else asks.push(order);
    }

    bids.sort((a, b) => b.priceCents - a.priceCents);
    asks.sort((a, b) => a.priceCents - b.priceCents);

    return {
      nextOrderId: this.nextTsId,
      bids,
      asks,
      lastTradePriceCents: this.lastSnapshot.lastTradePriceTicks > 0
        ? ticksToCents(this.lastSnapshot.lastTradePriceTicks)
        : undefined,
    };
  }

  // Reconcile registry qty against WASM snapshot. External-vs-external
  // trades consume resting orders silently (no fill record emitted), so we
  // need to detect those by comparing aggregated qty per price. Desk fills
  // are always emitted, so desk entries stay correct via processFills.
  private reconcile(): void {
    this.reconcileSide("BID", this.lastSnapshot.bidLevels);
    this.reconcileSide("ASK", this.lastSnapshot.askLevels);
  }

  private reconcileSide(side: BookSide, wasmLevels: MatchingEngineBookLevel[]): void {
    const wasmByPrice = new Map<number, number>();
    for (const lvl of wasmLevels) wasmByPrice.set(lvl.priceTicks, lvl.qty);

    const regByPrice = new Map<number, RegistryEntry[]>();
    for (const e of this.registry.values()) {
      if (e.side !== side) continue;
      const pt = centsToTicks(e.priceCents);
      const arr = regByPrice.get(pt) ?? [];
      arr.push(e);
      regByPrice.set(pt, arr);
    }

    // We use a deep snapshot (DEEP_DEPTH levels) so any price not in the
    // snapshot is definitively absent in WASM. This lets us drop stale
    // registry entries at prices WASM no longer has.
    for (const [priceTicks, entries] of regByPrice) {
      const wasmQty = wasmByPrice.get(priceTicks) ?? 0;
      const regQty = entries.reduce((s, e) => s + e.size, 0);
      if (regQty <= wasmQty) continue;

      // Silent consumption happened. Remove (regQty - wasmQty) units from
      // FIFO-oldest non-desk orders. Desk orders are protected — desk fills
      // are always emitted, so desk size is already correct.
      entries.sort((a, b) => a.postedTick - b.postedTick || a.tsId - b.tsId);
      let toRemove = regQty - wasmQty;
      for (const e of entries) {
        if (toRemove <= 0) break;
        if (e.owner === "desk") continue;
        if (e.size <= toRemove) {
          toRemove -= e.size;
          this.registry.delete(e.tsId);
          if (e.nativeId) {
            this.tsToNative.delete(e.tsId);
            this.nativeToTs.delete(e.nativeId);
          }
        } else {
          e.size -= toRemove;
          toRemove = 0;
        }
      }
    }
  }

  // Process WASM fill records: update registry (remove consumed makers),
  // build TS Fill[] from desk-side fills.
  private processFills(wasmFills: MatchingEngineFillRecord[]): Fill[] {
    const tsFills: Fill[] = [];
    for (const fill of wasmFills) {
      // Remove consumed maker from registry
      const makerTsId = this.nativeToTs.get(fill.makerOrderId);
      if (makerTsId !== undefined) {
        const entry = this.registry.get(makerTsId);
        if (entry) {
          entry.size -= fill.qty;
          if (entry.size <= 0) {
            this.registry.delete(makerTsId);
            this.tsToNative.delete(makerTsId);
            this.nativeToTs.delete(fill.makerOrderId);
          }
        }
      } else if (process.env.WASM_ADAPTER_DEBUG === "1") {
        console.warn("[adapter] fill with unmapped maker", {
          makerOrderId: fill.makerOrderId,
          takerOrderId: fill.takerOrderId,
          qty: fill.qty,
          priceTicks: fill.priceTicks,
          deskSide: fill.deskSide,
          marketId: this.tickCtx.marketId,
          tick: this.tickCtx.currentTick,
          mapSize: this.nativeToTs.size,
        });
      }
      // Construct TS fill (WASM only emits fills for desk-involved trades)
      tsFills.push(mkFill({
        now: this.tickCtx.now,
        tick: this.tickCtx.currentTick,
        marketId: this.tickCtx.marketId,
        side: fill.deskSide,
        qty: fill.qty,
        price: ticksToCents(fill.priceTicks),
        kind: fillTagToKind(fill.kind),
        markFair: this.tickCtx.markFair,
        rngTag: fill.logicalTime * 100 + this.fillCounter++,
      }));
    }
    return tsFills;
  }

  destroy(): void {
    this.kernel.destroyHandle(this.handle);
  }

  // Debug-only consistency check: registry-derived view must match WASM snapshot.
  assertConsistent(label: string): void {
    if (process.env.WASM_ADAPTER_DEBUG !== "1") return;
    // Verify all registry prices are tick-snapped
    for (const e of this.registry.values()) {
      const expectedPriceCents = centsToTicks(e.priceCents) / 2;
      if (e.priceCents !== expectedPriceCents) {
        console.warn(`[adapter:${label}] non-snapped price in registry`, {
          tsId: e.tsId,
          priceCents: e.priceCents,
          expectedSnapped: expectedPriceCents,
          priceTicks: centsToTicks(e.priceCents),
        });
      }
    }
    const snap = this.lastSnapshot;
    const aggregate = (entries: RegistryEntry[]) => {
      const m = new Map<number, { qty: number; hasDesk: boolean; deskQty: number }>();
      for (const e of entries) {
        const pt = centsToTicks(e.priceCents);
        const prev = m.get(pt) ?? { qty: 0, hasDesk: false, deskQty: 0 };
        m.set(pt, {
          qty: prev.qty + e.size,
          hasDesk: prev.hasDesk || e.owner === "desk",
          deskQty: prev.deskQty + (e.owner === "desk" ? e.size : 0),
        });
      }
      return m;
    };
    const regBids = aggregate([...this.registry.values()].filter((e) => e.side === "BID"));
    const regAsks = aggregate([...this.registry.values()].filter((e) => e.side === "ASK"));
    for (const wl of snap.bidLevels) {
      const r = regBids.get(wl.priceTicks);
      if (!r || r.qty !== wl.qty || r.hasDesk !== wl.hasDesk) {
        console.warn(`[adapter:${label}] BID mismatch @${wl.priceTicks}`, {
          wasm: wl,
          registry: r ?? null,
          tick: this.tickCtx.currentTick,
        });
      }
    }
    for (const wl of snap.askLevels) {
      const r = regAsks.get(wl.priceTicks);
      if (!r || r.qty !== wl.qty || r.hasDesk !== wl.hasDesk) {
        console.warn(`[adapter:${label}] ASK mismatch @${wl.priceTicks}`, {
          wasm: wl,
          registry: r ?? null,
          tick: this.tickCtx.currentTick,
        });
      }
    }
  }
}
