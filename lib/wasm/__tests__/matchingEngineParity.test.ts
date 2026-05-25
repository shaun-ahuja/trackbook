import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wasmModulePath = fileURLToPath(
  new URL("../../../public/wasm/orderbook/orderbook.mjs", import.meta.url),
);

function skipIfWasmMissing(): boolean {
  return !existsSync(wasmModulePath);
}

function normalizeLevels(book: {
  bids: Array<{ price: number; size: number; isOurs?: boolean }>;
  asks: Array<{ price: number; size: number; isOurs?: boolean }>;
}, centsToTicks: (priceCents: number) => number) {
  return {
    bids: book.bids.map((level) => ({
      priceTicks: centsToTicks(level.price),
      qty: level.size,
      hasDesk: Boolean(level.isOurs),
    })),
    asks: book.asks.map((level) => ({
      priceTicks: centsToTicks(level.price),
      qty: level.size,
      hasDesk: Boolean(level.isOurs),
    })),
  };
}

function fillSummary(
  fills: { side: "BUY" | "SELL"; qty: number; price: number; kind: string }[],
  centsToTicks: (priceCents: number) => number,
) {
  return fills.map((fill) => ({
    side: fill.side,
    qty: fill.qty,
    priceTicks: centsToTicks(fill.price),
    kind: fill.kind,
  }));
}

test("matching engine parity: limit FIFO and market fill", { skip: skipIfWasmMissing() }, async () => {
  const { MatchingEngineKernel } = await import("../orderBookKernel.ts");
  const {
    centsToTicks,
    MatchingEngineFillKindTag,
    MatchingEngineOpcode,
    MatchingEngineOwnerTag,
    MatchingEngineSideTag,
  } = await import("../orderBookKernelTypes.ts");
  const { executeMarket, insertLimit } = await import("../../simulation/bookMatching.ts");
  const { emptyBookState, projectVisibleBook } = await import("../../simulation/orderBookState.ts");
  const kernel = await MatchingEngineKernel.create();
  const marketId = "parity_fifo";
  try {
    let book = emptyBookState();
    let result = insertLimit(
      book,
      "BID",
      50,
      3,
      "lp",
      1,
      10,
      { now: 1, currentTick: 1, marketId, markFair: 50, deskFillKind: "aggressive", rngTag: 1 },
    );
    book = result.book;
    result = insertLimit(
      book,
      "BID",
      50,
      2,
      "patient",
      2,
      10,
      { now: 2, currentTick: 2, marketId, markFair: 50, deskFillKind: "aggressive", rngTag: 2 },
    );
    book = result.book;
    result = executeMarket(
      book,
      "SELL",
      4,
      "noise",
      { now: 3, currentTick: 3, marketId, markFair: 50, deskFillKind: "passive", rngTag: 3 },
    );
    book = result.book;

    kernel.execute(marketId, [
      {
        op: MatchingEngineOpcode.SubmitLimit,
        side: MatchingEngineSideTag.BidOrBuy,
        owner: MatchingEngineOwnerTag.Lp,
        priceTicks: centsToTicks(50),
        qty: 3,
        logicalTime: 1,
        ttlTicks: 10,
      },
      {
        op: MatchingEngineOpcode.SubmitLimit,
        side: MatchingEngineSideTag.BidOrBuy,
        owner: MatchingEngineOwnerTag.Patient,
        priceTicks: centsToTicks(50),
        qty: 2,
        logicalTime: 2,
        ttlTicks: 10,
      },
      {
        op: MatchingEngineOpcode.SubmitMarket,
        side: MatchingEngineSideTag.AskOrSell,
        owner: MatchingEngineOwnerTag.Noise,
        qty: 4,
        logicalTime: 3,
        fillKind: MatchingEngineFillKindTag.Passive,
      },
    ]);

    const native = kernel.execute(marketId, []);
    const reference = normalizeLevels(projectVisibleBook(book), centsToTicks);
    assert.deepEqual(native.snapshot.bidLevels, reference.bids);
    assert.deepEqual(native.snapshot.askLevels, reference.asks);
  } finally {
    kernel.destroyAll();
  }
});

test("matching engine parity: cancel, replace, and desk accounting", { skip: skipIfWasmMissing() }, async () => {
  const { MatchingEngineKernel } = await import("../orderBookKernel.ts");
  const {
    centsToTicks,
    MatchingEngineFillKindTag,
    MatchingEngineOpcode,
    MatchingEngineOwnerTag,
    MatchingEngineSideTag,
    ticksToCents,
  } = await import("../orderBookKernelTypes.ts");
  const { executeMarket, insertLimit, cancelById } = await import("../../simulation/bookMatching.ts");
  const { emptyBookState, projectVisibleBook } = await import("../../simulation/orderBookState.ts");
  const kernel = await MatchingEngineKernel.create();
  const marketId = "parity_replace";
  try {
    let book = emptyBookState();
    let referenceDeskOrderId = 0;

    let insert = insertLimit(
      book,
      "BID",
      49.5,
      2,
      "desk",
      10,
      999,
      { now: 10, currentTick: 10, marketId, markFair: 50, deskFillKind: "aggressive", rngTag: 1 },
    );
    book = insert.book;
    referenceDeskOrderId = book.bids.find((order) => order.owner === "desk")?.id ?? 0;

    const nativeInsert = kernel.execute(marketId, [
      {
        op: MatchingEngineOpcode.SubmitLimit,
        side: MatchingEngineSideTag.BidOrBuy,
        owner: MatchingEngineOwnerTag.Desk,
        priceTicks: centsToTicks(49.5),
        qty: 2,
        logicalTime: 10,
        ttlTicks: 999,
      },
      {
        op: MatchingEngineOpcode.QueryQueueAhead,
        orderId: 1,
      },
    ]);
    assert.equal(nativeInsert.snapshot.deskBidRef > 0, true);

    book = cancelById(book, referenceDeskOrderId);
    insert = insertLimit(
      book,
      "BID",
      49,
      2,
      "desk",
      11,
      999,
      { now: 11, currentTick: 11, marketId, markFair: 50, deskFillKind: "aggressive", rngTag: 2 },
    );
    book = insert.book;

    const replaced = kernel.execute(marketId, [
      {
        op: MatchingEngineOpcode.ReplaceOrder,
        orderId: nativeInsert.snapshot.deskBidRef,
        newPriceTicks: centsToTicks(49),
        newQty: 2,
        logicalTime: 11,
      },
    ]);
    assert.equal(replaced.snapshot.deskBidRef > 0, true);

    const passive = executeMarket(
      book,
      "SELL",
      1,
      "panic",
      { now: 12, currentTick: 12, marketId, markFair: 50, deskFillKind: "passive", rngTag: 3 },
    );
    book = passive.book;
    const nativePassive = kernel.execute(marketId, [
      {
        op: MatchingEngineOpcode.SubmitMarket,
        side: MatchingEngineSideTag.AskOrSell,
        owner: MatchingEngineOwnerTag.Panic,
        qty: 1,
        logicalTime: 12,
        fillKind: MatchingEngineFillKindTag.Passive,
      },
    ]);

    assert.deepEqual(
      nativePassive.fills.map((fill) => ({
        side: fill.deskSide,
        qty: fill.qty,
        priceTicks: fill.priceTicks,
        kind: fill.kind,
      })),
      fillSummary(passive.fills, centsToTicks).map((fill) => ({
        side: fill.side,
        qty: fill.qty,
        priceTicks: fill.priceTicks,
        kind: fill.kind === "passive" ? MatchingEngineFillKindTag.Passive : MatchingEngineFillKindTag.Aggressive,
      })),
    );

    const referenceBook = normalizeLevels(projectVisibleBook(book), centsToTicks);
    assert.deepEqual(nativePassive.snapshot.bidLevels, referenceBook.bids);
    assert.deepEqual(nativePassive.snapshot.askLevels, referenceBook.asks);
    assert.equal(ticksToCents(nativePassive.snapshot.cashTicks), -49);
  } finally {
    kernel.destroyAll();
  }
});

test("matching engine parity: one module, many engine instances", { skip: skipIfWasmMissing() }, async () => {
  const { MatchingEngineKernel } = await import("../orderBookKernel.ts");
  const {
    centsToTicks,
    MatchingEngineOpcode,
    MatchingEngineOwnerTag,
    MatchingEngineSideTag,
  } = await import("../orderBookKernelTypes.ts");
  const kernel = await MatchingEngineKernel.create();
  try {
    const a = kernel.execute("A", [
      {
        op: MatchingEngineOpcode.SubmitLimit,
        side: MatchingEngineSideTag.BidOrBuy,
        owner: MatchingEngineOwnerTag.Lp,
        priceTicks: centsToTicks(40),
        qty: 1,
        logicalTime: 1,
        ttlTicks: 10,
      },
    ]);
    const b = kernel.execute("B", [
      {
        op: MatchingEngineOpcode.SubmitLimit,
        side: MatchingEngineSideTag.AskOrSell,
        owner: MatchingEngineOwnerTag.Lp,
        priceTicks: centsToTicks(60),
        qty: 2,
        logicalTime: 1,
        ttlTicks: 10,
      },
    ]);
    assert.notEqual(a.snapshot.bestBidPriceTicks, b.snapshot.bestBidPriceTicks);
    assert.equal(kernel.execute("A", []).snapshot.bestAskPriceTicks, 0);
    assert.equal(kernel.execute("B", []).snapshot.bestBidPriceTicks, 0);
  } finally {
    kernel.destroyAll();
  }
});
