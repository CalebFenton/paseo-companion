import type { PluginSubscribeOptions, PluginSubscriptionHandle } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import { errorMessage } from "../shared/format";

interface Live<Snapshot> {
  snapshot: Snapshot | null;
  /** Last failure reaching the plugin's daemon side. */
  error: string | null;
  /** A forced refresh is running. */
  refreshing: boolean;
}

/** `Extra`: what a store keeps beside its snapshot, changed through `update`. */
export type LiveState<Snapshot, Extra extends object = object> = Extra & Live<Snapshot>;

/** Members are arrow properties: callers hand them to React as callbacks. */
export interface LiveStore<State> {
  getState: () => State;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
}

/** A store whose daemon side can read again now rather than reuse its cache. */
export interface RefreshableStore<State> extends LiveStore<State> {
  refresh: () => void;
}

export interface LiveStoreHandle<Snapshot, Input, Extra extends object> {
  store: LiveStore<LiveState<Snapshot, Extra>>;
  update(patch: Partial<Extra>): void;
  /** Runs a forced read with the current input, whose answer the daemon side also pushes to every subscriber. */
  refreshWith(read: (input: Input) => Promise<Snapshot>): void;
  /** Aborts on dispose. */
  signal: AbortSignal;
}

/** After the daemon closes a subscription, as a plugin reload does, subscribing again waits this long. */
const RESUBSCRIBE_MS = 5_000;

/**
 * Holds what the daemon side pushes to a subscription made with `input(state)`, subscribing again
 * whenever that input changes. Paseo itself subscribes again after a reconnect.
 */
export function createLiveStore<Snapshot, Input, Extra extends object = object>(options: {
  extra: Extra;
  input(state: LiveState<Snapshot, Extra>): Input;
  subscribe(input: Input, onEvent: (snapshot: Snapshot) => void, options: PluginSubscribeOptions): PluginSubscriptionHandle;
}): LiveStoreHandle<Snapshot, Input, Extra> {
  let state: LiveState<Snapshot, Extra> = { ...options.extra, snapshot: null, error: null, refreshing: false };
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  let current: { key: string; handle: PluginSubscriptionHandle } | undefined;

  const publish = (patch: Partial<Live<Snapshot>> | Partial<Extra>) => {
    if (lifetime.signal.aborted) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const failed = (error: unknown) => publish({ error: errorMessage(error) });

  const connect = () => {
    if (lifetime.signal.aborted) return;
    const input = options.input(state);
    const key = JSON.stringify(input);
    if (current?.key === key) return;
    current?.handle();
    // Refused, as while the plugin restarts, or closed by the daemon: try again in a moment.
    const lost = (error: unknown) => {
      if (current?.handle !== handle) return;
      current = undefined;
      if (error !== undefined) failed(error);
      setTimeout(connect, RESUBSCRIBE_MS);
    };
    const handle = options.subscribe(input, (snapshot) => publish({ snapshot, error: null }), {
      signal: lifetime.signal,
      onClosed: ({ error }) => lost(error),
    });
    current = { key, handle };
    handle.ready.catch(lost);
  };

  connect();

  return {
    store: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      dispose: () => {
        // Aborting releases the subscription and turns a pending retry into a no-op.
        lifetime.abort();
        listeners.clear();
      },
    },
    refreshWith(read) {
      if (state.refreshing) return;
      publish({ refreshing: true });
      read(options.input(state)).then(
        (snapshot) => publish({ snapshot, error: null, refreshing: false }),
        (error: unknown) => {
          failed(error);
          publish({ refreshing: false });
        },
      );
    },
    update(patch) {
      publish(patch);
      connect();
    },
    signal: lifetime.signal,
  };
}

export function useLiveState<State>(store: LiveStore<State>): State {
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** Why the latest read failed: reaching the daemon side, else the daemon side's own read. */
export function readFailure({ error, snapshot }: LiveState<{ error: string | null }>): string | null {
  return error ?? snapshot?.error ?? null;
}
