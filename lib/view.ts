import type { Fill, Market, SimState, TransitEvent } from "./types";

export type ViewMode = "desk" | "focus" | "watchlist";

export function deriveViewMode(
  focusedMarketId: string | null,
  watchlistIds: readonly string[],
): ViewMode {
  if (watchlistIds.length >= 2) return "watchlist";
  if (focusedMarketId != null) return "focus";
  return "desk";
}

export function activeMarketIds(
  mode: ViewMode,
  focusedMarketId: string | null,
  watchlistIds: readonly string[],
): string[] {
  if (mode === "watchlist") return [...watchlistIds];
  if (mode === "focus" && focusedMarketId) return [focusedMarketId];
  return [];
}

export function visibleEvents(
  events: TransitEvent[],
  mode: ViewMode,
  ids: readonly string[],
): TransitEvent[] {
  if (mode === "desk" || ids.length === 0) return events;
  return events.filter((e) => ids.some((id) => e.impacts[id] !== undefined));
}

export function visibleFills(
  fills: Fill[],
  mode: ViewMode,
  ids: readonly string[],
): Fill[] {
  if (mode === "desk" || ids.length === 0) return fills;
  const set = new Set(ids);
  return fills.filter((f) => set.has(f.marketId));
}

export function visiblePositionMarkets(
  state: SimState,
  mode: ViewMode,
  ids: readonly string[],
): Market[] {
  if (mode === "watchlist" && ids.length > 0) {
    return ids
      .map((id) => state.markets[id])
      .filter((m): m is Market => m !== undefined);
  }
  return state.marketOrder.map((id) => state.markets[id]);
}
