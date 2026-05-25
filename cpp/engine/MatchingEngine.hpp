#pragma once

#include <cstdint>
#include <list>
#include <map>
#include <optional>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "protocol.hpp"

namespace trackbook::engine {

enum class Side : int {
  Bid = protocol::kBidOrBuy,
  Ask = protocol::kAskOrSell,
};

enum class Owner : int {
  Desk = protocol::kDesk,
  Lp = protocol::kLp,
  Noise = protocol::kNoise,
  Informed = protocol::kInformed,
  Momentum = protocol::kMomentum,
  Rebal = protocol::kRebal,
  Patient = protocol::kPatient,
  Panic = protocol::kPanic,
  Event = protocol::kEvent,
};

enum class FillKind : int {
  Passive = protocol::kPassive,
  Aggressive = protocol::kAggressive,
  Flatten = protocol::kFlatten,
  Shock = protocol::kShock,
};

struct FillRecord {
  int desk_side = 0;
  int qty = 0;
  int price_ticks = 0;
  int kind = 0;
  int logical_time = 0;
  int maker_order_id = 0;
  int taker_order_id = 0;
};

struct BookLevelSnapshot {
  int price_ticks = 0;
  int qty = 0;
  int has_desk = 0;
};

struct EngineSnapshot {
  int best_bid_price_ticks = 0;
  int best_bid_qty = 0;
  int best_ask_price_ticks = 0;
  int best_ask_qty = 0;
  int last_trade_price_ticks = 0;
  int active_order_count = 0;
  int desk_bid_ref = 0;
  int desk_ask_ref = 0;
  int position = 0;
  int risk_flags = 0;
  std::vector<BookLevelSnapshot> bid_levels;
  std::vector<BookLevelSnapshot> ask_levels;
  double cash_ticks = 0.0;
  double realized_pnl_ticks = 0.0;
  double avg_cost_ticks = 0.0;
  double max_abs_position = 0.0;
};

struct SubmitLimitArgs {
  Side side = Side::Bid;
  int price_ticks = 0;
  int qty = 0;
  Owner owner = Owner::Lp;
  int logical_time = 0;
  int ttl_ticks = 0;
  FillKind desk_fill_kind = FillKind::Aggressive;
};

struct SubmitMarketArgs {
  Side side = Side::Bid;
  int qty = 0;
  Owner owner = Owner::Lp;
  int logical_time = 0;
  FillKind desk_fill_kind = FillKind::Aggressive;
};

struct ReplaceOrderArgs {
  int order_id = 0;
  int new_price_ticks = 0;
  int new_qty = 0;
  int logical_time = 0;
  FillKind desk_fill_kind = FillKind::Aggressive;
};

class MatchingEngine {
 public:
  MatchingEngine();

  void reset();

  int submitLimit(const SubmitLimitArgs& args);
  void submitMarket(const SubmitMarketArgs& args);
  bool cancelOrder(int order_id);
  int replaceOrder(const ReplaceOrderArgs& args);

  int queryQueueAhead(int order_id) const;
  EngineSnapshot snapshot(int depth) const;
  std::vector<FillRecord> drainFills();

 private:
  struct Level {
    int total_qty = 0;
    std::list<int> order_ids;
  };

  struct Order {
    int id = 0;
    Side side = Side::Bid;
    int price_ticks = 0;
    int open_qty = 0;
    int original_qty = 0;
    Owner owner = Owner::Lp;
    int logical_time = 0;
    int ttl_ticks = 0;
    std::uint64_t sequence = 0;
    std::list<int>::iterator queue_it;
  };

  using BidBook = std::map<int, Level, std::greater<int>>;
  using AskBook = std::map<int, Level, std::less<int>>;

  template <typename Book>
  typename Book::iterator ensureLevel(Book& book, int price_ticks);

  void insertRestingOrder(const SubmitLimitArgs& args, int order_id);
  void matchIncomingLimit(const SubmitLimitArgs& args, int taker_order_id, int& remaining_qty);
  void matchIncomingMarket(const SubmitMarketArgs& args, int taker_order_id, int& remaining_qty);
  void consumeTopOrder(
    Side taker_side,
    Owner taker_owner,
    int taker_order_id,
    FillKind desk_fill_kind,
    int logical_time,
    int& remaining_qty
  );
  void eraseOrder(Order& order);
  void clearDeskRefFor(int order_id, Side side);
  void rebuildDeskRef(Side side);
  void recordDeskFill(
    bool desk_is_maker,
    Side maker_side,
    Side taker_side,
    Owner taker_owner,
    int taker_order_id,
    const Order& maker_order,
    int trade_qty,
    int logical_time,
    FillKind desk_fill_kind
  );
  void applyDeskAccounting(int desk_side, int qty, int price_ticks);
  std::vector<BookLevelSnapshot> collectLevels(const BidBook& book, int depth) const;
  std::vector<BookLevelSnapshot> collectLevels(const AskBook& book, int depth) const;

  BidBook bids_;
  AskBook asks_;
  std::unordered_map<int, Order> orders_;
  std::unordered_set<int> desk_orders_;
  std::vector<FillRecord> fills_;

  int next_order_id_ = 1;
  int last_trade_price_ticks_ = 0;
  int desk_bid_ref_ = 0;
  int desk_ask_ref_ = 0;

  int position_ = 0;
  double cash_ticks_ = 0.0;
  double realized_pnl_ticks_ = 0.0;
  double avg_cost_ticks_ = 0.0;
  int position_limit_ = 8;
  int max_abs_position_ = 0;

  std::uint64_t next_sequence_ = 1;
};

}  // namespace trackbook::engine
