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
// shifts in chunks, not every tick. `lpScale` multiplies the size so
// LP-heavy regimes show fatter ladders and LP-thin shocks show wisps.
function levelSize(
  marketId: string,
  side: "bid" | "ask",
  lvl: number,
  epoch: number,
  lpScale: number,
): number {
  const seed =
    marketId.split("").reduce((a, c) => a + c.charCodeAt(0), 0) +
    (side === "bid" ? 17 : 53) +
    lvl * 31 +
    epoch * 7;
  const x = Math.sin(seed) * 10000;
  const r = x - Math.floor(x);
  const base = 8 + lvl * 5;
  return Math.max(2, Math.floor((base + r * 14) * lpScale));
}

export function buildOrderBook(market: Market, currentTick: number): OrderBook {
  const epoch = Math.floor(currentTick / SIZE_EPOCH_TICKS);
  const askTouch = Math.max(2, Math.ceil(market.marketAsk));
  const bidTouch = Math.min(98, Math.floor(market.marketBid));
  // LP depth EWMA is centered around ~5–10 baseline; clamp scaling into
  // [0.3, 1.8] so even an empty book shows a couple of contracts and a
  // very deep one doesn't dwarf the panel.
  const rawLp = Number.isFinite(market.lpDepth) ? market.lpDepth : 5;
  const lpScale = Math.min(1.8, Math.max(0.3, rawLp / 8));

  const asks: BookLevel[] = [];
  const bids: BookLevel[] = [];
  for (let i = 0; i < LEVELS; i++) {
    asks.push({
      price: Math.min(99, askTouch + i),
      size: levelSize(market.id, "ask", i, epoch, lpScale),
    });
    bids.push({
      price: Math.max(1, bidTouch - i),
      size: levelSize(market.id, "bid", i, epoch, lpScale),
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
