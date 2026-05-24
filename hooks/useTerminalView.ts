"use client";

import { useCallback, useMemo, useState } from "react";
import { activeMarketIds, deriveViewMode, type ViewMode } from "@/lib/view";

export type UseTerminalView = {
  focusedMarketId: string | null;
  watchlistIds: string[];
  viewMode: ViewMode;
  activeIds: string[];
  handleMarketClick: (id: string, meta: boolean) => void;
  toggleWatch: (id: string) => void;
  exitView: () => void;
};

type Options = {
  currentSelectedId: string;
  onSelectMarket: (id: string) => void;
};

export function useTerminalView({
  currentSelectedId,
  onSelectMarket,
}: Options): UseTerminalView {
  const [focusedMarketId, setFocusedMarketId] = useState<string | null>(null);
  const [watchlistIds, setWatchlistIds] = useState<string[]>([]);

  const viewMode = deriveViewMode(focusedMarketId, watchlistIds);
  const activeIds = useMemo(
    () => activeMarketIds(viewMode, focusedMarketId, watchlistIds),
    [viewMode, focusedMarketId, watchlistIds],
  );

  const handleMarketClick = useCallback(
    (id: string, meta: boolean) => {
      if (meta) {
        setFocusedMarketId(null);
        if (watchlistIds.includes(id)) {
          const next = watchlistIds.filter((x) => x !== id);
          setWatchlistIds(next);
          if (id === currentSelectedId && next.length > 0) {
            onSelectMarket(next[next.length - 1]);
          }
        } else {
          setWatchlistIds([...watchlistIds, id]);
          onSelectMarket(id);
        }
      } else {
        setFocusedMarketId(id);
        onSelectMarket(id);
      }
    },
    [watchlistIds, currentSelectedId, onSelectMarket],
  );

  const toggleWatch = useCallback(
    (id: string) => {
      if (watchlistIds.includes(id)) {
        const next = watchlistIds.filter((x) => x !== id);
        setWatchlistIds(next);
        if (id === currentSelectedId && next.length > 0) {
          onSelectMarket(next[next.length - 1]);
        }
      } else {
        setWatchlistIds([...watchlistIds, id]);
      }
    },
    [watchlistIds, currentSelectedId, onSelectMarket],
  );

  const exitView = useCallback(() => {
    setFocusedMarketId(null);
    setWatchlistIds([]);
  }, []);

  return {
    focusedMarketId,
    watchlistIds,
    viewMode,
    activeIds,
    handleMarketClick,
    toggleWatch,
    exitView,
  };
}
