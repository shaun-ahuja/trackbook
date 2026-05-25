#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>

#include "../MatchingEngine.hpp"

using trackbook::engine::FillKind;
using trackbook::engine::MatchingEngine;
using trackbook::engine::Owner;
using trackbook::engine::ReplaceOrderArgs;
using trackbook::engine::Side;
using trackbook::engine::SubmitLimitArgs;
using trackbook::engine::SubmitMarketArgs;

namespace {

void expect(bool condition, const std::string& message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void expectNear(double actual, double expected, const std::string& label) {
  if (std::abs(actual - expected) > 1e-9) {
    throw std::runtime_error(label + ": expected " + std::to_string(expected) + ", got " + std::to_string(actual));
  }
}

}  // namespace

int main() {
  MatchingEngine engine;

  const int lp1 = engine.submitLimit({
    .side = Side::Bid,
    .price_ticks = 100,
    .qty = 3,
    .owner = Owner::Lp,
    .logical_time = 1,
    .ttl_ticks = 10,
    .desk_fill_kind = FillKind::Aggressive,
  });
  const int lp2 = engine.submitLimit({
    .side = Side::Bid,
    .price_ticks = 100,
    .qty = 2,
    .owner = Owner::Patient,
    .logical_time = 2,
    .ttl_ticks = 10,
    .desk_fill_kind = FillKind::Aggressive,
  });

  expect(lp2 > lp1, "order ids should increase");
  expect(engine.queryQueueAhead(lp2) == 3, "queue ahead should equal resting size before second order");

  engine.submitMarket({
    .side = Side::Ask,
    .qty = 4,
    .owner = Owner::Noise,
    .logical_time = 3,
    .desk_fill_kind = FillKind::Passive,
  });

  auto snap = engine.snapshot(4);
  expect(snap.best_bid_qty == 1, "market order should consume FIFO size first");

  const int deskBid = engine.submitLimit({
    .side = Side::Bid,
    .price_ticks = 99,
    .qty = 2,
    .owner = Owner::Desk,
    .logical_time = 4,
    .ttl_ticks = 999,
    .desk_fill_kind = FillKind::Aggressive,
  });
  expect(engine.snapshot(4).desk_bid_ref == deskBid, "desk ref should point at live desk bid");

  engine.submitMarket({
    .side = Side::Ask,
    .qty = 3,
    .owner = Owner::Panic,
    .logical_time = 5,
    .desk_fill_kind = FillKind::Passive,
  });

  auto fills = engine.drainFills();
  expect(fills.size() == 1, "desk passive fill should be recorded");
  expect(fills[0].desk_side == 1, "desk should have bought on bid fill");
  expect(fills[0].kind == 1, "passive fill kind should be preserved");
  expect(fills[0].qty == 2, "desk fill should only reflect the desk-crossed residual");

  snap = engine.snapshot(4);
  expect(snap.position == 2, "desk position should update on fill");
  expectNear(snap.cash_ticks, -198.0, "cash ticks after passive buy");
  expectNear(snap.avg_cost_ticks, 99.0, "avg cost ticks after passive buy");

  const int askOrder = engine.submitLimit({
    .side = Side::Ask,
    .price_ticks = 104,
    .qty = 2,
    .owner = Owner::Desk,
    .logical_time = 6,
    .ttl_ticks = 999,
    .desk_fill_kind = FillKind::Aggressive,
  });
  expect(engine.snapshot(4).desk_ask_ref == askOrder, "desk ref should point at live desk ask");

  const int replaced = engine.replaceOrder({
    .order_id = askOrder,
    .new_price_ticks = 103,
    .new_qty = 2,
    .logical_time = 7,
    .desk_fill_kind = FillKind::Aggressive,
  });
  expect(replaced != 0 && replaced != askOrder, "replace should issue a new order id");
  expect(engine.snapshot(4).desk_ask_ref == replaced, "desk ask ref should move to replaced order");

  expect(engine.cancelOrder(replaced), "cancel should remove active order");
  expect(engine.snapshot(4).desk_ask_ref == 0, "desk ask ref should clear on cancel");

  std::cout << "matching_engine_smoke: ok\n";
  return 0;
}
