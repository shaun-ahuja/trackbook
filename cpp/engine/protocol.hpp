#pragma once

namespace trackbook::engine::protocol {

constexpr int kCommandWords = 10;

enum Opcode : int {
  kSubmitLimit = 1,
  kSubmitMarket = 2,
  kCancelOrder = 3,
  kReplaceOrder = 4,
  kReadState = 5,
  kQueryQueueAhead = 6,
};

enum SideTag : int {
  kBidOrBuy = 1,
  kAskOrSell = 2,
};

enum OwnerTag : int {
  kDesk = 1,
  kLp = 2,
  kNoise = 3,
  kInformed = 4,
  kMomentum = 5,
  kRebal = 6,
  kPatient = 7,
  kPanic = 8,
  kEvent = 9,
};

enum FillKindTag : int {
  kPassive = 1,
  kAggressive = 2,
  kFlatten = 3,
  kShock = 4,
};

enum RiskFlags : int {
  kRiskBreachedPositionLimit = 1 << 0,
};

constexpr int kSnapshotHeaderWords = 18;
constexpr int kLevelWords = 3;
constexpr int kFillWords = 7;

enum SnapshotHeaderIndex : int {
  kStatus = 0,
  kCommandsProcessed = 1,
  kFillCount = 2,
  kSnapshotDepth = 3,
  kBestBidPriceTicks = 4,
  kBestBidQty = 5,
  kBestAskPriceTicks = 6,
  kBestAskQty = 7,
  kLastOrderId = 8,
  kQueueAheadQty = 9,
  kPositionQty = 10,
  kRiskFlagsIndex = 11,
  kDeskBidRef = 12,
  kDeskAskRef = 13,
  kBidLevelsCount = 14,
  kAskLevelsCount = 15,
  kLastTradePriceTicks = 16,
  kActiveOrderCount = 17,
};

enum MetricIndex : int {
  kCashTicks = 0,
  kRealizedPnlTicks = 1,
  kAvgCostTicks = 2,
  kMaxAbsPosition = 3,
};

constexpr int kMetricCount = 4;

}  // namespace trackbook::engine::protocol
