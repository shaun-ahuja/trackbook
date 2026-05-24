import type { BookLevel, Market, OrderBook } from "../types";

const LEVELS = 4;
// How many ticks a level's "true" size persists before regenerating. Keeps
// the ladder visually stable instead of flickering every 750ms.
const SIZE_EPOCH_TICKS = 6;
// Notional size the desk shows alongside a venue level when our quote lands
// on it. Visible "we are here" footprint without overstating depth.
const OUR_CLIP_SIZE = 5;

export function emptyBook(mid: number): OrderBook {
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  for (let i = 0; i < LEVELS; i++) {
    bids.push({ price: Math.max(1, Math.floor(mid - 1 - i)), size: 10 + i * 4 });
    asks.push({ price: Math.min(99, Math.ceil(mid + 1 + i)), size: 10 + i * 4 });
  }
  return { bids, asks };
}

// Deterministic per-(marketId, side, level, epoch) size with a touch-favoring
// gradient. The epoch index changes every SIZE_EPOCH_TICKS so the ladder
// shifts in chunks, not every tick.
function levelSize(
  marketId: string,
  side: "bid" | "ask",
  lvl: number,
  epoch: number,
): number {
  const seed =
    marketId.split("").reduce((a, c) => a + c.charCodeAt(0), 0) +
    (side === "bid" ? 17 : 53) +
    lvl * 31 +
    epoch * 7;
  // Cheap deterministic hash in [0,1).
  const x = Math.sin(seed) * 10000;
  const r = x - Math.floor(x);
  // Size grows away from the touch — the inside is thin, the back is fat.
  const base = 8 + lvl * 5;
  return Math.max(3, Math.floor(base + r * 14));
}

export function buildOrderBook(market: Market, currentTick: number): OrderBook {
  const epoch = Math.floor(currentTick / SIZE_EPOCH_TICKS);
  const askTouch = Math.max(2, Math.ceil(market.marketAsk));
  const bidTouch = Math.min(98, Math.floor(market.marketBid));

  const asks: BookLevel[] = [];
  const bids: BookLevel[] = [];
  for (let i = 0; i < LEVELS; i++) {
    asks.push({
      price: Math.min(99, askTouch + i),
      size: levelSize(market.id, "ask", i, epoch),
    });
    bids.push({
      price: Math.max(1, bidTouch - i),
      size: levelSize(market.id, "bid", i, epoch),
    });
  }

  // Merge our quote: if the desk's resting price lines up with a venue
  // level (within 0.5¢), add our clip and tag the level as ours so the UI
  // can show the desk's footprint inline.
  const ourBidPrice = Math.round(market.ourBid);
  const ourAskPrice = Math.round(market.ourAsk);
  for (const lvl of bids) {
    if (Math.abs(lvl.price - ourBidPrice) <= 0.5) {
      lvl.size += OUR_CLIP_SIZE;
      lvl.isOurs = true;
      break;
    }
  }
  for (const lvl of asks) {
    if (Math.abs(lvl.price - ourAskPrice) <= 0.5) {
      lvl.size += OUR_CLIP_SIZE;
      lvl.isOurs = true;
      break;
    }
  }

  return { bids, asks };
}
