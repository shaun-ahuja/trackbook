export const COMMAND_WORDS = 10;
export const SNAPSHOT_HEADER_WORDS = 18;
export const LEVEL_WORDS = 3;
export const FILL_WORDS = 7;
export const METRIC_WORDS = 4;

export const MatchingEngineOpcode = {
  SubmitLimit: 1,
  SubmitMarket: 2,
  CancelOrder: 3,
  ReplaceOrder: 4,
  ReadState: 5,
  QueryQueueAhead: 6,
} as const;

export type MatchingEngineOpcode =
  (typeof MatchingEngineOpcode)[keyof typeof MatchingEngineOpcode];

export const MatchingEngineSideTag = {
  BidOrBuy: 1,
  AskOrSell: 2,
} as const;

export type MatchingEngineSideTag =
  (typeof MatchingEngineSideTag)[keyof typeof MatchingEngineSideTag];

export const MatchingEngineOwnerTag = {
  Desk: 1,
  Lp: 2,
  Noise: 3,
  Informed: 4,
  Momentum: 5,
  Rebal: 6,
  Patient: 7,
  Panic: 8,
  Event: 9,
} as const;

export type MatchingEngineOwnerTag =
  (typeof MatchingEngineOwnerTag)[keyof typeof MatchingEngineOwnerTag];

export const MatchingEngineFillKindTag = {
  Passive: 1,
  Aggressive: 2,
  Flatten: 3,
  Shock: 4,
} as const;

export type MatchingEngineFillKindTag =
  (typeof MatchingEngineFillKindTag)[keyof typeof MatchingEngineFillKindTag];

export const SnapshotHeaderIndex = {
  Status: 0,
  CommandsProcessed: 1,
  FillCount: 2,
  SnapshotDepth: 3,
  BestBidPriceTicks: 4,
  BestBidQty: 5,
  BestAskPriceTicks: 6,
  BestAskQty: 7,
  LastOrderId: 8,
  QueueAheadQty: 9,
  PositionQty: 10,
  RiskFlags: 11,
  DeskBidRef: 12,
  DeskAskRef: 13,
  BidLevelsCount: 14,
  AskLevelsCount: 15,
  LastTradePriceTicks: 16,
  ActiveOrderCount: 17,
} as const;

export type SnapshotHeaderIndex =
  (typeof SnapshotHeaderIndex)[keyof typeof SnapshotHeaderIndex];

export const SnapshotMetricIndex = {
  CashTicks: 0,
  RealizedPnlTicks: 1,
  AvgCostTicks: 2,
  MaxAbsPosition: 3,
} as const;

export type SnapshotMetricIndex =
  (typeof SnapshotMetricIndex)[keyof typeof SnapshotMetricIndex];

export type MatchingEngineBookLevel = {
  priceTicks: number;
  qty: number;
  hasDesk: boolean;
};

export type MatchingEngineFillRecord = {
  deskSide: "BUY" | "SELL";
  qty: number;
  priceTicks: number;
  kind: MatchingEngineFillKindTag;
  logicalTime: number;
  makerOrderId: number;
  takerOrderId: number;
};

export type MatchingEngineStateSnapshot = {
  bestBidPriceTicks: number;
  bestBidQty: number;
  bestAskPriceTicks: number;
  bestAskQty: number;
  lastTradePriceTicks: number;
  activeOrderCount: number;
  deskBidRef: number;
  deskAskRef: number;
  positionQty: number;
  cashTicks: number;
  realizedPnlTicks: number;
  avgCostTicks: number;
  maxAbsPosition: number;
  riskFlags: number;
  queueAheadQty: number;
  bidLevels: MatchingEngineBookLevel[];
  askLevels: MatchingEngineBookLevel[];
};

export type MatchingEngineExecResult = {
  commandsProcessed: number;
  lastOrderId: number;
  snapshot: MatchingEngineStateSnapshot;
  fills: MatchingEngineFillRecord[];
};

export type MatchingEngineCommand =
  | {
      op: typeof MatchingEngineOpcode.SubmitLimit;
      side: MatchingEngineSideTag;
      owner: MatchingEngineOwnerTag;
      priceTicks: number;
      qty: number;
      logicalTime: number;
      ttlTicks: number;
      fillKind?: MatchingEngineFillKindTag;
    }
  | {
      op: typeof MatchingEngineOpcode.SubmitMarket;
      side: MatchingEngineSideTag;
      owner: MatchingEngineOwnerTag;
      qty: number;
      logicalTime: number;
      fillKind?: MatchingEngineFillKindTag;
    }
  | {
      op: typeof MatchingEngineOpcode.CancelOrder;
      orderId: number;
    }
  | {
      op: typeof MatchingEngineOpcode.ReplaceOrder;
      orderId: number;
      newPriceTicks: number;
      newQty: number;
      logicalTime: number;
      fillKind?: MatchingEngineFillKindTag;
    }
  | {
      op: typeof MatchingEngineOpcode.ReadState;
      depth: number;
    }
  | {
      op: typeof MatchingEngineOpcode.QueryQueueAhead;
      orderId: number;
    };

export const DEFAULT_SNAPSHOT_DEPTH = 4;

export function centsToTicks(priceCents: number): number {
  return Math.round(priceCents * 2);
}

export function ticksToCents(priceTicks: number): number {
  return priceTicks / 2;
}
