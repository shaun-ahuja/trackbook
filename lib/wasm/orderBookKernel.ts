"use client";

import { pathToFileURL } from "node:url";

import {
  COMMAND_WORDS,
  DEFAULT_SNAPSHOT_DEPTH,
  FILL_WORDS,
  LEVEL_WORDS,
  MatchingEngineFillKindTag,
  MatchingEngineOpcode,
  type MatchingEngineCommand,
  type MatchingEngineExecResult,
  type MatchingEngineFillRecord,
  type MatchingEngineStateSnapshot,
  METRIC_WORDS,
  SNAPSHOT_HEADER_WORDS,
  SnapshotHeaderIndex,
  SnapshotMetricIndex,
} from "./orderBookKernelTypes.ts";

type EmscriptenModule = {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPF64: Float64Array;
  _tb_version: () => number;
  _tb_alloc_bytes: (bytes: number) => number;
  _tb_free_bytes: (ptr: number) => void;
  _tb_engine_create: () => number;
  _tb_engine_reset: (handle: number) => number;
  _tb_engine_destroy: (handle: number) => number;
  _tb_engine_exec: (
    handle: number,
    cmdPtr: number,
    cmdLen: number,
    outPtr: number,
    outCap: number,
    metricsPtr: number,
    metricsCap: number,
  ) => number;
};

type EmscriptenFactory = (opts: { locateFile: (path: string) => string }) => Promise<EmscriptenModule>;

type BufferSlice = {
  ptr: number;
  bytes: number;
};

type RuntimeBuffers = {
  command: BufferSlice;
  output: BufferSlice;
  metrics: BufferSlice;
};

let modulePromise: Promise<EmscriptenModule> | null = null;

async function loadModule(): Promise<EmscriptenModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const isNode =
        typeof process !== "undefined" &&
        typeof process.versions === "object" &&
        Boolean(process.versions?.node);
      const isBrowser = !isNode && typeof window !== "undefined";
      const wasmImportUrl = isBrowser
        ? "/wasm/orderbook/orderbook.mjs"
        : pathToFileURL(
            new URL("../../public/wasm/orderbook/orderbook.mjs", import.meta.url).pathname,
          ).href;
      const mod = await import(/* webpackIgnore: true */ wasmImportUrl);
      const factory = (mod.default ?? mod) as EmscriptenFactory;
      return factory({
        locateFile(path) {
          if (path.endsWith(".wasm")) {
            return isBrowser
              ? "/wasm/orderbook/orderbook.wasm"
              : new URL("../../public/wasm/orderbook/orderbook.wasm", import.meta.url).pathname;
          }
          return path;
        },
      });
    })();
  }
  return modulePromise;
}

function bytesForI32(words: number): number {
  return words * Int32Array.BYTES_PER_ELEMENT;
}

function bytesForF64(words: number): number {
  return words * Float64Array.BYTES_PER_ELEMENT;
}

function writeCommand(target: Int32Array, index: number, command: MatchingEngineCommand): void {
  const base = index * COMMAND_WORDS;
  target.fill(0, base, base + COMMAND_WORDS);

  switch (command.op) {
    case MatchingEngineOpcode.SubmitLimit:
      target[base + 0] = command.op;
      target[base + 1] = command.side;
      target[base + 2] = command.owner;
      target[base + 3] = command.priceTicks;
      target[base + 4] = command.qty;
      target[base + 6] = command.logicalTime;
      target[base + 7] = command.ttlTicks;
      target[base + 9] = command.fillKind ?? MatchingEngineFillKindTag.Aggressive;
      return;
    case MatchingEngineOpcode.SubmitMarket:
      target[base + 0] = command.op;
      target[base + 1] = command.side;
      target[base + 2] = command.owner;
      target[base + 4] = command.qty;
      target[base + 6] = command.logicalTime;
      target[base + 9] = command.fillKind ?? MatchingEngineFillKindTag.Aggressive;
      return;
    case MatchingEngineOpcode.CancelOrder:
      target[base + 0] = command.op;
      target[base + 5] = command.orderId;
      return;
    case MatchingEngineOpcode.ReplaceOrder:
      target[base + 0] = command.op;
      target[base + 3] = command.newPriceTicks;
      target[base + 4] = command.newQty;
      target[base + 5] = command.orderId;
      target[base + 6] = command.logicalTime;
      target[base + 9] = command.fillKind ?? MatchingEngineFillKindTag.Aggressive;
      return;
    case MatchingEngineOpcode.ReadState:
      target[base + 0] = command.op;
      target[base + 3] = command.depth;
      return;
    case MatchingEngineOpcode.QueryQueueAhead:
      target[base + 0] = command.op;
      target[base + 5] = command.orderId;
      return;
  }
}

function decodeFills(words: Int32Array, offset: number, count: number): MatchingEngineFillRecord[] {
  const fills: MatchingEngineFillRecord[] = [];
  for (let i = 0; i < count; i++) {
    const base = offset + (i * FILL_WORDS);
    fills.push({
      deskSide: words[base + 0] === 1 ? "BUY" : "SELL",
      qty: words[base + 1],
      priceTicks: words[base + 2],
      kind: words[base + 3] as MatchingEngineFillKindTag,
      logicalTime: words[base + 4],
      makerOrderId: words[base + 5],
      takerOrderId: words[base + 6],
    });
  }
  return fills;
}

function decodeSnapshot(words: Int32Array, metrics: Float64Array): MatchingEngineStateSnapshot {
  const bidCount = words[SnapshotHeaderIndex.BidLevelsCount];
  const askCount = words[SnapshotHeaderIndex.AskLevelsCount];
  let cursor = SNAPSHOT_HEADER_WORDS;

  const bidLevels: MatchingEngineStateSnapshot["bidLevels"] = [];
  for (let i = 0; i < bidCount; i++) {
    bidLevels.push({
      priceTicks: words[cursor + 0],
      qty: words[cursor + 1],
      hasDesk: words[cursor + 2] === 1,
    });
    cursor += LEVEL_WORDS;
  }

  const askLevels: MatchingEngineStateSnapshot["askLevels"] = [];
  for (let i = 0; i < askCount; i++) {
    askLevels.push({
      priceTicks: words[cursor + 0],
      qty: words[cursor + 1],
      hasDesk: words[cursor + 2] === 1,
    });
    cursor += LEVEL_WORDS;
  }

  return {
    bestBidPriceTicks: words[SnapshotHeaderIndex.BestBidPriceTicks],
    bestBidQty: words[SnapshotHeaderIndex.BestBidQty],
    bestAskPriceTicks: words[SnapshotHeaderIndex.BestAskPriceTicks],
    bestAskQty: words[SnapshotHeaderIndex.BestAskQty],
    lastTradePriceTicks: words[SnapshotHeaderIndex.LastTradePriceTicks],
    activeOrderCount: words[SnapshotHeaderIndex.ActiveOrderCount],
    deskBidRef: words[SnapshotHeaderIndex.DeskBidRef],
    deskAskRef: words[SnapshotHeaderIndex.DeskAskRef],
    positionQty: words[SnapshotHeaderIndex.PositionQty],
    cashTicks: metrics[SnapshotMetricIndex.CashTicks],
    realizedPnlTicks: metrics[SnapshotMetricIndex.RealizedPnlTicks],
    avgCostTicks: metrics[SnapshotMetricIndex.AvgCostTicks],
    maxAbsPosition: metrics[SnapshotMetricIndex.MaxAbsPosition],
    riskFlags: words[SnapshotHeaderIndex.RiskFlags],
    queueAheadQty: words[SnapshotHeaderIndex.QueueAheadQty],
    bidLevels,
    askLevels,
  };
}

export class MatchingEngineKernel {
  private readonly handlesByMarket = new Map<string, number>();
  private buffers: RuntimeBuffers | null = null;
  private readonly mod: EmscriptenModule;

  private constructor(mod: EmscriptenModule) {
    this.mod = mod;
  }

  static async create(): Promise<MatchingEngineKernel> {
    const mod = await loadModule();
    return new MatchingEngineKernel(mod);
  }

  version(): number {
    return this.mod._tb_version();
  }

  createEngine(): number {
    return this.mod._tb_engine_create();
  }

  resetHandle(handle: number): void {
    this.mod._tb_engine_reset(handle);
  }

  destroyHandle(handle: number): void {
    this.mod._tb_engine_destroy(handle);
  }

  executeHandle(
    handle: number,
    commands: MatchingEngineCommand[],
    opts?: { snapshotDepth?: number; fillCapacity?: number },
  ): MatchingEngineExecResult {
    if (!handle) {
      throw new Error("MatchingEngine handle is required.");
    }
    return this.executeInternal(handle, commands, opts);
  }

  ensureEngine(marketId: string): number {
    const existing = this.handlesByMarket.get(marketId);
    if (existing) {
      return existing;
    }
    const handle = this.createEngine();
    this.handlesByMarket.set(marketId, handle);
    return handle;
  }

  resetEngine(marketId: string): void {
    const handle = this.ensureEngine(marketId);
    this.resetHandle(handle);
  }

  destroyEngine(marketId: string): void {
    const handle = this.handlesByMarket.get(marketId);
    if (!handle) {
      return;
    }
    this.destroyHandle(handle);
    this.handlesByMarket.delete(marketId);
  }

  destroyAll(): void {
    for (const marketId of this.handlesByMarket.keys()) {
      this.destroyEngine(marketId);
    }
    if (this.buffers) {
      this.mod._tb_free_bytes(this.buffers.command.ptr);
      this.mod._tb_free_bytes(this.buffers.output.ptr);
      this.mod._tb_free_bytes(this.buffers.metrics.ptr);
      this.buffers = null;
    }
  }

  execute(
    marketId: string,
    commands: MatchingEngineCommand[],
    opts?: { snapshotDepth?: number; fillCapacity?: number },
  ): MatchingEngineExecResult {
    const handle = this.ensureEngine(marketId);
    return this.executeInternal(handle, commands, opts);
  }

  private executeInternal(
    handle: number,
    commands: MatchingEngineCommand[],
    opts?: { snapshotDepth?: number; fillCapacity?: number },
  ): MatchingEngineExecResult {
    const snapshotDepth = opts?.snapshotDepth ?? DEFAULT_SNAPSHOT_DEPTH;
    const readStateCommand: MatchingEngineCommand = {
      op: MatchingEngineOpcode.ReadState,
      depth: snapshotDepth,
    };
    const effectiveCommands = commands.some((command) => command.op === MatchingEngineOpcode.ReadState)
      ? commands
      : [...commands, readStateCommand];

    const fillCapacity = Math.max(opts?.fillCapacity ?? 32, 1);
    const commandWords = effectiveCommands.length * COMMAND_WORDS;
    const outputWords =
      SNAPSHOT_HEADER_WORDS +
      ((snapshotDepth * 2) * LEVEL_WORDS) +
      (fillCapacity * FILL_WORDS);
    this.ensureBuffers(commandWords, outputWords);
    const buffers = this.buffers!;

    const commandView = new Int32Array(
      this.mod.HEAPU8.buffer,
      buffers.command.ptr,
      commandWords,
    );
    for (let i = 0; i < effectiveCommands.length; i++) {
      writeCommand(commandView, i, effectiveCommands[i]);
    }

    const outWords = this.mod._tb_engine_exec(
      handle,
      buffers.command.ptr,
      commandWords,
      buffers.output.ptr,
      outputWords,
      buffers.metrics.ptr,
      METRIC_WORDS,
    );
    if (outWords < 0) {
      throw new Error(`MatchingEngine exec failed with status ${outWords}.`);
    }

    const outputView = new Int32Array(
      this.mod.HEAPU8.buffer,
      buffers.output.ptr,
      outWords,
    );
    const metricView = new Float64Array(
      this.mod.HEAPU8.buffer,
      buffers.metrics.ptr,
      METRIC_WORDS,
    );

    const snapshot = decodeSnapshot(outputView, metricView);
    const fillsOffset =
      SNAPSHOT_HEADER_WORDS +
      ((outputView[SnapshotHeaderIndex.BidLevelsCount] + outputView[SnapshotHeaderIndex.AskLevelsCount]) * LEVEL_WORDS);
    const fills = decodeFills(
      outputView,
      fillsOffset,
      outputView[SnapshotHeaderIndex.FillCount],
    );

    return {
      commandsProcessed: outputView[SnapshotHeaderIndex.CommandsProcessed],
      lastOrderId: outputView[SnapshotHeaderIndex.LastOrderId],
      snapshot,
      fills,
    };
  }

  private ensureBuffers(commandWords: number, outputWords: number): void {
    if (
      this.buffers &&
      this.buffers.command.bytes >= bytesForI32(commandWords) &&
      this.buffers.output.bytes >= bytesForI32(outputWords)
    ) {
      return;
    }

    if (this.buffers) {
      this.mod._tb_free_bytes(this.buffers.command.ptr);
      this.mod._tb_free_bytes(this.buffers.output.ptr);
      this.mod._tb_free_bytes(this.buffers.metrics.ptr);
    }

    this.buffers = {
      command: {
        ptr: this.mod._tb_alloc_bytes(bytesForI32(commandWords)),
        bytes: bytesForI32(commandWords),
      },
      output: {
        ptr: this.mod._tb_alloc_bytes(bytesForI32(outputWords)),
        bytes: bytesForI32(outputWords),
      },
      metrics: {
        ptr: this.mod._tb_alloc_bytes(bytesForF64(METRIC_WORDS)),
        bytes: bytesForF64(METRIC_WORDS),
      },
    };
  }
}
