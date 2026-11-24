import { errorMessage } from "../shared/format";

export interface CachedValue<T> {
  /** From the last read that succeeded; undefined until one does. */
  value: T | undefined;
  /** Why the latest read failed; null when it succeeded. */
  error: string | null;
  /** When the latest read settled, failed or not. */
  at: number;
}

export interface CachedRead<T> {
  /** The latest result, if any, reusing it when no older than `maxAgeMs`; else the read in flight, or a new `read`. */
  get(maxAgeMs: number, read: () => Promise<T>): Promise<CachedValue<T>>;
  latest(): CachedValue<T> | undefined;
  /** The next `get` reads again. */
  invalidate(): void;
}

/**
 * One read at a time, reused until older than the caller allows. A failure keeps the last value and
 * waits the same interval as a success: the sources here (omp, gh, Paseo) fail from rate limits and
 * timeouts, which retrying sooner makes worse. `settled` runs after each read.
 */
export function createCachedRead<T>({ now = Date.now, settled }: { now?: () => number; settled?: () => void } = {}): CachedRead<T> {
  let latest: CachedValue<T> | undefined;
  let pending: Promise<CachedValue<T>> | undefined;
  let invalid = false;
  return {
    get(maxAgeMs, read) {
      if (latest && !invalid && now() - latest.at <= maxAgeMs) return Promise.resolve(latest);
      if (pending) return pending;
      invalid = false;
      pending = read()
        .then(
          (value): CachedValue<T> => ({ value, error: null, at: now() }),
          (error: unknown): CachedValue<T> => ({ value: latest?.value, error: errorMessage(error), at: now() }),
        )
        .then((result) => {
          latest = result;
          pending = undefined;
          settled?.();
          return result;
        });
      return pending;
    },
    latest: () => latest,
    invalidate() {
      invalid = true;
    },
  };
}
