#include "MatchingEngine.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>

namespace trackbook::engine {

namespace {

double absPosition(int position) {
  return static_cast<double>(std::abs(position));
}

bool isDesk(Owner owner) {
  return owner == Owner::Desk;
}

int sideToDeskTradeSide(Side side) {
  return side == Side::Bid ? protocol::kBidOrBuy : protocol::kAskOrSell;
}

}  // namespace

MatchingEngine::MatchingEngine() = default;

void MatchingEngine::reset() {
  bids_.clear();
  asks_.clear();
  orders_.clear();
  desk_orders_.clear();
  fills_.clear();

  next_order_id_ = 1;
  last_trade_price_ticks_ = 0;
  desk_bid_ref_ = 0;
  desk_ask_ref_ = 0;

  position_ = 0;
  cash_ticks_ = 0.0;
  realized_pnl_ticks_ = 0.0;
  avg_cost_ticks_ = 0.0;
  max_abs_position_ = 0;
  next_sequence_ = 1;
}

template <typename Book>
typename Book::iterator MatchingEngine::ensureLevel(Book& book, int price_ticks) {
  auto it = book.find(price_ticks);
  if (it != book.end()) {
    return it;
  }
  return book.emplace(price_ticks, Level{}).first;
}

int MatchingEngine::submitLimit(const SubmitLimitArgs& args) {
  int remaining_qty = std::max(0, args.qty);
  if (remaining_qty == 0) {
    return 0;
  }

  matchIncomingLimit(args, 0, remaining_qty);

  if (remaining_qty > 0) {
    SubmitLimitArgs resting = args;
    resting.qty = remaining_qty;
    const int order_id = next_order_id_++;
    insertRestingOrder(resting, order_id);
    return order_id;
  }

  return 0;
}

void MatchingEngine::submitMarket(const SubmitMarketArgs& args) {
  int remaining_qty = std::max(0, args.qty);
  if (remaining_qty == 0) {
    return;
  }

  matchIncomingMarket(args, 0, remaining_qty);
}

bool MatchingEngine::cancelOrder(int order_id) {
  auto it = orders_.find(order_id);
  if (it == orders_.end()) {
    return false;
  }

  eraseOrder(it->second);
  return true;
}

int MatchingEngine::replaceOrder(const ReplaceOrderArgs& args) {
  auto it = orders_.find(args.order_id);
  if (it == orders_.end()) {
    return 0;
  }

  const Side side = it->second.side;
  const Owner owner = it->second.owner;
  const int ttl_ticks = it->second.ttl_ticks;
  eraseOrder(it->second);

  SubmitLimitArgs next;
  next.side = side;
  next.price_ticks = args.new_price_ticks;
  next.qty = args.new_qty;
  next.owner = owner;
  next.logical_time = args.logical_time;
  next.ttl_ticks = ttl_ticks;
  next.desk_fill_kind = args.desk_fill_kind;
  return submitLimit(next);
}

void MatchingEngine::insertRestingOrder(const SubmitLimitArgs& args, int order_id) {
  if (args.qty <= 0) {
    return;
  }

  Order order;
  order.id = order_id;
  order.side = args.side;
  order.price_ticks = args.price_ticks;
  order.open_qty = args.qty;
  order.original_qty = args.qty;
  order.owner = args.owner;
  order.logical_time = args.logical_time;
  order.ttl_ticks = args.ttl_ticks;
  order.sequence = next_sequence_++;

  if (args.side == Side::Bid) {
    auto level_it = ensureLevel(bids_, args.price_ticks);
    level_it->second.total_qty += args.qty;
    level_it->second.order_ids.push_back(order_id);
    order.queue_it = std::prev(level_it->second.order_ids.end());
  } else {
    auto level_it = ensureLevel(asks_, args.price_ticks);
    level_it->second.total_qty += args.qty;
    level_it->second.order_ids.push_back(order_id);
    order.queue_it = std::prev(level_it->second.order_ids.end());
  }

  orders_.emplace(order_id, order);

  if (isDesk(args.owner)) {
    desk_orders_.insert(order_id);
    if (args.side == Side::Bid) {
      desk_bid_ref_ = order_id;
    } else {
      desk_ask_ref_ = order_id;
    }
  }
}

void MatchingEngine::matchIncomingLimit(
  const SubmitLimitArgs& args,
  int taker_order_id,
  int& remaining_qty
) {
  while (remaining_qty > 0) {
    if (args.side == Side::Bid) {
      if (asks_.empty()) {
        break;
      }
      const int best_ask = asks_.begin()->first;
      if (args.price_ticks < best_ask) {
        break;
      }
    } else {
      if (bids_.empty()) {
        break;
      }
      const int best_bid = bids_.begin()->first;
      if (args.price_ticks > best_bid) {
        break;
      }
    }

    consumeTopOrder(
      args.side,
      args.owner,
      taker_order_id,
      args.desk_fill_kind,
      args.logical_time,
      remaining_qty
    );
  }
}

void MatchingEngine::matchIncomingMarket(
  const SubmitMarketArgs& args,
  int taker_order_id,
  int& remaining_qty
) {
  while (remaining_qty > 0) {
    const bool no_liquidity =
      (args.side == Side::Bid && asks_.empty()) ||
      (args.side == Side::Ask && bids_.empty());
    if (no_liquidity) {
      break;
    }

    consumeTopOrder(
      args.side,
      args.owner,
      taker_order_id,
      args.desk_fill_kind,
      args.logical_time,
      remaining_qty
    );
  }
}

void MatchingEngine::consumeTopOrder(
  Side taker_side,
  Owner taker_owner,
  int taker_order_id,
  FillKind desk_fill_kind,
  int logical_time,
  int& remaining_qty
) {
  if (remaining_qty <= 0) {
    return;
  }

  if (taker_side == Side::Bid) {
    auto level_it = asks_.begin();
    const int maker_order_id = level_it->second.order_ids.front();
    auto maker_it = orders_.find(maker_order_id);
    Order& maker = maker_it->second;
    const int trade_qty = std::min(remaining_qty, maker.open_qty);

    level_it->second.total_qty -= trade_qty;
    maker.open_qty -= trade_qty;
    remaining_qty -= trade_qty;
    last_trade_price_ticks_ = maker.price_ticks;

    recordDeskFill(
      isDesk(maker.owner),
      maker.side,
      taker_side,
      taker_owner,
      taker_order_id,
      maker,
      trade_qty,
      logical_time,
      desk_fill_kind
    );

    if (maker.open_qty == 0) {
      eraseOrder(maker);
    }
  } else {
    auto level_it = bids_.begin();
    const int maker_order_id = level_it->second.order_ids.front();
    auto maker_it = orders_.find(maker_order_id);
    Order& maker = maker_it->second;
    const int trade_qty = std::min(remaining_qty, maker.open_qty);

    level_it->second.total_qty -= trade_qty;
    maker.open_qty -= trade_qty;
    remaining_qty -= trade_qty;
    last_trade_price_ticks_ = maker.price_ticks;

    recordDeskFill(
      isDesk(maker.owner),
      maker.side,
      taker_side,
      taker_owner,
      taker_order_id,
      maker,
      trade_qty,
      logical_time,
      desk_fill_kind
    );

    if (maker.open_qty == 0) {
      eraseOrder(maker);
    }
  }
}

void MatchingEngine::eraseOrder(Order& order) {
  if (order.side == Side::Bid) {
    auto level_it = bids_.find(order.price_ticks);
    if (level_it != bids_.end()) {
      level_it->second.total_qty -= order.open_qty;
      level_it->second.order_ids.erase(order.queue_it);
      if (level_it->second.order_ids.empty()) {
        bids_.erase(level_it);
      }
    }
  } else {
    auto level_it = asks_.find(order.price_ticks);
    if (level_it != asks_.end()) {
      level_it->second.total_qty -= order.open_qty;
      level_it->second.order_ids.erase(order.queue_it);
      if (level_it->second.order_ids.empty()) {
        asks_.erase(level_it);
      }
    }
  }

  if (isDesk(order.owner)) {
    desk_orders_.erase(order.id);
    clearDeskRefFor(order.id, order.side);
  }

  orders_.erase(order.id);
}

void MatchingEngine::clearDeskRefFor(int order_id, Side side) {
  if (side == Side::Bid && desk_bid_ref_ == order_id) {
    desk_bid_ref_ = 0;
    rebuildDeskRef(Side::Bid);
    return;
  }

  if (side == Side::Ask && desk_ask_ref_ == order_id) {
    desk_ask_ref_ = 0;
    rebuildDeskRef(Side::Ask);
  }
}

void MatchingEngine::rebuildDeskRef(Side side) {
  if (side == Side::Bid) {
    for (const auto& [_, level] : bids_) {
      for (const int order_id : level.order_ids) {
        const auto it = orders_.find(order_id);
        if (it != orders_.end() && isDesk(it->second.owner)) {
          desk_bid_ref_ = order_id;
          return;
        }
      }
    }
    desk_bid_ref_ = 0;
    return;
  }

  for (const auto& [_, level] : asks_) {
    for (const int order_id : level.order_ids) {
      const auto it = orders_.find(order_id);
      if (it != orders_.end() && isDesk(it->second.owner)) {
        desk_ask_ref_ = order_id;
        return;
      }
    }
  }
  desk_ask_ref_ = 0;
}

void MatchingEngine::recordDeskFill(
  bool desk_is_maker,
  Side maker_side,
  Side taker_side,
  Owner taker_owner,
  int taker_order_id,
  const Order& maker_order,
  int trade_qty,
  int logical_time,
  FillKind desk_fill_kind
) {
  const bool desk_is_taker = isDesk(taker_owner);
  if (desk_is_maker == desk_is_taker) {
    return;
  }

  const int desk_trade_side = desk_is_maker
    ? sideToDeskTradeSide(maker_side)
    : sideToDeskTradeSide(taker_side);
  FillKind final_kind = desk_is_maker ? FillKind::Passive : desk_fill_kind;
  if (desk_fill_kind == FillKind::Shock && desk_is_maker) {
    final_kind = FillKind::Shock;
  }

  fills_.push_back(FillRecord{
    .desk_side = desk_trade_side,
    .qty = trade_qty,
    .price_ticks = maker_order.price_ticks,
    .kind = static_cast<int>(final_kind),
    .logical_time = logical_time,
    .maker_order_id = maker_order.id,
    .taker_order_id = taker_order_id,
  });

  applyDeskAccounting(desk_trade_side, trade_qty, maker_order.price_ticks);
}

void MatchingEngine::applyDeskAccounting(int desk_side, int qty, int price_ticks) {
  const int signed_qty = desk_side == protocol::kBidOrBuy ? qty : -qty;
  const int old_position = position_;
  const int new_position = old_position + signed_qty;

  if (old_position == 0 || ((old_position > 0) == (signed_qty > 0))) {
    const double denom = absPosition(old_position) + static_cast<double>(qty);
    if (denom > 0.0) {
      avg_cost_ticks_ =
        ((absPosition(old_position) * avg_cost_ticks_) + (static_cast<double>(qty) * price_ticks)) /
        denom;
    }
  } else {
    const int closing_qty = std::min(std::abs(old_position), qty);
    if (old_position > 0) {
      realized_pnl_ticks_ += (price_ticks - avg_cost_ticks_) * closing_qty;
    } else {
      realized_pnl_ticks_ += (avg_cost_ticks_ - price_ticks) * closing_qty;
    }

    const int remaining_qty = qty - closing_qty;
    if (remaining_qty > 0) {
      avg_cost_ticks_ = price_ticks;
    } else if (new_position == 0) {
      avg_cost_ticks_ = 0.0;
    }
  }

  position_ = new_position;
  cash_ticks_ += desk_side == protocol::kBidOrBuy
    ? -static_cast<double>(qty) * price_ticks
    : static_cast<double>(qty) * price_ticks;
  max_abs_position_ = std::max(max_abs_position_, std::abs(position_));
}

int MatchingEngine::queryQueueAhead(int order_id) const {
  const auto it = orders_.find(order_id);
  if (it == orders_.end()) {
    return 0;
  }

  const Order& target = it->second;
  int ahead = 0;
  if (target.side == Side::Bid) {
    const auto level_it = bids_.find(target.price_ticks);
    if (level_it == bids_.end()) {
      return 0;
    }
    for (const int queued_id : level_it->second.order_ids) {
      if (queued_id == order_id) {
        break;
      }
      const auto queued = orders_.find(queued_id);
      if (queued != orders_.end()) {
        ahead += queued->second.open_qty;
      }
    }
    return ahead;
  }

  const auto level_it = asks_.find(target.price_ticks);
  if (level_it == asks_.end()) {
    return 0;
  }
  for (const int queued_id : level_it->second.order_ids) {
    if (queued_id == order_id) {
      break;
    }
    const auto queued = orders_.find(queued_id);
    if (queued != orders_.end()) {
      ahead += queued->second.open_qty;
    }
  }
  return ahead;
}

std::vector<BookLevelSnapshot> MatchingEngine::collectLevels(const BidBook& book, int depth) const {
  std::vector<BookLevelSnapshot> out;
  out.reserve(depth);

  for (const auto& [price_ticks, level] : book) {
    int has_desk = 0;
    for (const int order_id : level.order_ids) {
      const auto order_it = orders_.find(order_id);
      if (order_it != orders_.end() && isDesk(order_it->second.owner)) {
        has_desk = 1;
        break;
      }
    }
    out.push_back(BookLevelSnapshot{
      .price_ticks = price_ticks,
      .qty = level.total_qty,
      .has_desk = has_desk,
    });
    if (static_cast<int>(out.size()) >= depth) {
      break;
    }
  }

  return out;
}

std::vector<BookLevelSnapshot> MatchingEngine::collectLevels(const AskBook& book, int depth) const {
  std::vector<BookLevelSnapshot> out;
  out.reserve(depth);

  for (const auto& [price_ticks, level] : book) {
    int has_desk = 0;
    for (const int order_id : level.order_ids) {
      const auto order_it = orders_.find(order_id);
      if (order_it != orders_.end() && isDesk(order_it->second.owner)) {
        has_desk = 1;
        break;
      }
    }
    out.push_back(BookLevelSnapshot{
      .price_ticks = price_ticks,
      .qty = level.total_qty,
      .has_desk = has_desk,
    });
    if (static_cast<int>(out.size()) >= depth) {
      break;
    }
  }

  return out;
}

EngineSnapshot MatchingEngine::snapshot(int depth) const {
  EngineSnapshot snap;
  snap.best_bid_price_ticks = bids_.empty() ? 0 : bids_.begin()->first;
  snap.best_bid_qty = bids_.empty() ? 0 : bids_.begin()->second.total_qty;
  snap.best_ask_price_ticks = asks_.empty() ? 0 : asks_.begin()->first;
  snap.best_ask_qty = asks_.empty() ? 0 : asks_.begin()->second.total_qty;
  snap.last_trade_price_ticks = last_trade_price_ticks_;
  snap.active_order_count = static_cast<int>(orders_.size());
  snap.desk_bid_ref = desk_bid_ref_;
  snap.desk_ask_ref = desk_ask_ref_;
  snap.position = position_;
  snap.cash_ticks = cash_ticks_;
  snap.realized_pnl_ticks = realized_pnl_ticks_;
  snap.avg_cost_ticks = avg_cost_ticks_;
  snap.max_abs_position = static_cast<double>(max_abs_position_);
  if (std::abs(position_) > position_limit_) {
    snap.risk_flags |= protocol::kRiskBreachedPositionLimit;
  }
  snap.bid_levels = collectLevels(bids_, depth);
  snap.ask_levels = collectLevels(asks_, depth);
  return snap;
}

std::vector<FillRecord> MatchingEngine::drainFills() {
  std::vector<FillRecord> out;
  out.swap(fills_);
  return out;
}

}  // namespace trackbook::engine
