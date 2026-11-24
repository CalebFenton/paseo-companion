import type { PluginClientContext } from "@getpaseo/plugin/client";
import { type Range, type SystemRequest, type SystemView, systemFeed } from "../shared/system";
import { createLiveStore, type LiveState, type LiveStore } from "./live-store";

interface SystemExtra {
  range: Range;
  /** Bars per chart each open screen wants; the daemon side sends bars only while one is open. */
  screens: number[];
}

export interface SystemStore extends LiveStore<LiveState<SystemView, SystemExtra>> {
  /** A screen opened, wanting `bars` bars per chart; returns its closing. */
  watch(bars: number): () => void;
  setRange(range: Range): void;
}

/** The daemon side pushes every sample; what it pushes widens to charts while a screen is open. */
export function createSystemStore(client: PluginClientContext): SystemStore {
  const live = createLiveStore<SystemView, SystemRequest, SystemExtra>({
    extra: { range: "1h", screens: [] },
    input: ({ range, screens }) => ({ history: screens.length > 0 ? { range, bars: Math.max(...screens) } : null }),
    subscribe: (input, onEvent, options) => client.subscribe(systemFeed, input, onEvent, options),
  });
  return {
    ...live.store,
    watch(bars) {
      live.update({ screens: [...live.store.getState().screens, bars] });
      return () => {
        const screens = [...live.store.getState().screens];
        screens.splice(screens.indexOf(bars), 1);
        live.update({ screens });
      };
    },
    setRange(range) {
      live.update({ range });
    },
  };
}
