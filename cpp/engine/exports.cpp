#include <algorithm>
#include <cstdlib>
#include <memory>
#include <unordered_map>
#include <vector>

#include "MatchingEngine.hpp"

namespace trackbook::engine {

namespace {

std::unordered_map<int, std::unique_ptr<MatchingEngine>>& engineRegistry() {
  static std::unordered_map<int, std::unique_ptr<MatchingEngine>> registry;
  return registry;
}

int& nextEngineHandle() {
  static int handle = 1;
  return handle;
}

MatchingEngine* lookupEngine(int handle) {
  auto& registry = engineRegistry();
  const auto it = registry.find(handle);
  return it == registry.end() ? nullptr : it->second.get();
}

Owner ownerFromTag(int tag) {
  return static_cast<Owner>(tag);
}

Side sideFromTag(int tag) {
  return static_cast<Side>(tag);
}

FillKind fillKindFromTag(int tag) {
  return static_cast<FillKind>(tag);
}

}  // namespace

}  // namespace trackbook::engine

extern "C" {

int tb_version() {
  return 1;
}

int tb_alloc_bytes(int bytes) {
  void* ptr = std::malloc(static_cast<std::size_t>(bytes));
  return static_cast<int>(reinterpret_cast<std::uintptr_t>(ptr));
}

void tb_free_bytes(int ptr) {
  if (ptr == 0) {
    return;
  }
  std::free(reinterpret_cast<void*>(static_cast<std::uintptr_t>(ptr)));
}

int tb_engine_create() {
  auto engine = std::make_unique<trackbook::engine::MatchingEngine>();
  int handle = trackbook::engine::nextEngineHandle()++;
  trackbook::engine::engineRegistry().emplace(handle, std::move(engine));
  return handle;
}

int tb_engine_reset(int handle) {
  auto* engine = trackbook::engine::lookupEngine(handle);
  if (!engine) {
    return 0;
  }
  engine->reset();
  return 1;
}

int tb_engine_destroy(int handle) {
  auto& registry = trackbook::engine::engineRegistry();
  return registry.erase(handle) > 0 ? 1 : 0;
}

int tb_engine_exec(
  int handle,
  const int* cmd,
  int cmd_len,
  int* out,
  int out_cap,
  double* metrics,
  int metrics_cap
) {
  using namespace trackbook::engine;
  using namespace trackbook::engine::protocol;

  auto* engine = lookupEngine(handle);
  if (!engine || !cmd || !out || !metrics) {
    return -1;
  }
  if (cmd_len % kCommandWords != 0 || metrics_cap < kMetricCount) {
    return -2;
  }

  int commands_processed = 0;
  int last_order_id = 0;
  int queue_ahead = 0;
  int snapshot_depth = 4;

  const int command_count = cmd_len / kCommandWords;
  for (int i = 0; i < command_count; i++) {
    const int base = i * kCommandWords;
    const int opcode = cmd[base + 0];
    const int side_or_buy = cmd[base + 1];
    const int owner = cmd[base + 2];
    const int price_or_order = cmd[base + 3];
    const int qty = cmd[base + 4];
    const int order_id = cmd[base + 5];
    const int logical_time = cmd[base + 6];
    const int aux0 = cmd[base + 7];
    const int aux1 = cmd[base + 8];
    const int flags = cmd[base + 9];
    (void)aux1;

    switch (opcode) {
      case kSubmitLimit: {
        SubmitLimitArgs args;
        args.side = sideFromTag(side_or_buy);
        args.owner = ownerFromTag(owner);
        args.price_ticks = price_or_order;
        args.qty = qty;
        args.logical_time = logical_time;
        args.ttl_ticks = aux0;
        args.desk_fill_kind = fillKindFromTag(flags == 0 ? kAggressive : flags);
        last_order_id = engine->submitLimit(args);
        break;
      }
      case kSubmitMarket: {
        SubmitMarketArgs args;
        args.side = sideFromTag(side_or_buy);
        args.owner = ownerFromTag(owner);
        args.qty = qty;
        args.logical_time = logical_time;
        args.desk_fill_kind = fillKindFromTag(flags == 0 ? kAggressive : flags);
        engine->submitMarket(args);
        break;
      }
      case kCancelOrder: {
        engine->cancelOrder(order_id);
        break;
      }
      case kReplaceOrder: {
        ReplaceOrderArgs args;
        args.order_id = order_id;
        args.new_price_ticks = price_or_order;
        args.new_qty = qty;
        args.logical_time = logical_time;
        args.desk_fill_kind = fillKindFromTag(flags == 0 ? kAggressive : flags);
        last_order_id = engine->replaceOrder(args);
        break;
      }
      case kReadState: {
        snapshot_depth = std::max(1, price_or_order);
        break;
      }
      case kQueryQueueAhead: {
        queue_ahead = engine->queryQueueAhead(order_id);
        break;
      }
      default:
        return -3;
    }

    commands_processed++;
  }

  const EngineSnapshot snap = engine->snapshot(snapshot_depth);
  std::vector<FillRecord> fills = engine->drainFills();
  const int bid_count = static_cast<int>(snap.bid_levels.size());
  const int ask_count = static_cast<int>(snap.ask_levels.size());
  const int fill_count = static_cast<int>(fills.size());
  const int needed_words =
    kSnapshotHeaderWords +
    ((bid_count + ask_count) * kLevelWords) +
    (fill_count * kFillWords);
  if (out_cap < needed_words) {
    return -4;
  }

  out[kStatus] = 0;
  out[kCommandsProcessed] = commands_processed;
  out[kFillCount] = fill_count;
  out[kSnapshotDepth] = snapshot_depth;
  out[kBestBidPriceTicks] = snap.best_bid_price_ticks;
  out[kBestBidQty] = snap.best_bid_qty;
  out[kBestAskPriceTicks] = snap.best_ask_price_ticks;
  out[kBestAskQty] = snap.best_ask_qty;
  out[kLastOrderId] = last_order_id;
  out[kQueueAheadQty] = queue_ahead;
  out[kPositionQty] = snap.position;
  out[kRiskFlagsIndex] = snap.risk_flags;
  out[kDeskBidRef] = snap.desk_bid_ref;
  out[kDeskAskRef] = snap.desk_ask_ref;
  out[kBidLevelsCount] = bid_count;
  out[kAskLevelsCount] = ask_count;
  out[kLastTradePriceTicks] = snap.last_trade_price_ticks;
  out[kActiveOrderCount] = snap.active_order_count;

  int cursor = kSnapshotHeaderWords;
  for (const auto& level : snap.bid_levels) {
    out[cursor++] = level.price_ticks;
    out[cursor++] = level.qty;
    out[cursor++] = level.has_desk;
  }
  for (const auto& level : snap.ask_levels) {
    out[cursor++] = level.price_ticks;
    out[cursor++] = level.qty;
    out[cursor++] = level.has_desk;
  }
  for (const auto& fill : fills) {
    out[cursor++] = fill.desk_side;
    out[cursor++] = fill.qty;
    out[cursor++] = fill.price_ticks;
    out[cursor++] = fill.kind;
    out[cursor++] = fill.logical_time;
    out[cursor++] = fill.maker_order_id;
    out[cursor++] = fill.taker_order_id;
  }

  metrics[kCashTicks] = snap.cash_ticks;
  metrics[kRealizedPnlTicks] = snap.realized_pnl_ticks;
  metrics[kAvgCostTicks] = snap.avg_cost_ticks;
  metrics[kMaxAbsPosition] = snap.max_abs_position;
  return cursor;
}

}  // extern "C"
