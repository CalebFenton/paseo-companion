import { HOUR_MS, MINUTE_MS } from "../../shared/format";

/** What a window's pace needs: how full it is, when it resets, and how long it runs. */
export interface PacedWindow {
  usedPct: number;
  /** Epoch milliseconds. */
  resetsAt: number | null;
  durationMs: number | null;
  /** The source's own estimate, epoch milliseconds; trusted when it falls before the reset. */
  runsOutAt: number | null;
}

/**
 * When the window reaches 100% at its average pace so far, if that is before it resets; else null.
 * Paseo's Usage screen estimates the same way from the same reading, so both say the same: it waits
 * for 1% of the window, between a minute and an hour, before trusting the pace.
 */
export function runsOutAt(window: PacedWindow, observedAt: number | null, now: number): number | null {
  const { usedPct, resetsAt, durationMs } = window;
  if (observedAt === null || resetsAt === null || resetsAt <= now || usedPct >= 100) return null;
  if (window.runsOutAt !== null && window.runsOutAt < resetsAt) return window.runsOutAt;
  if (durationMs === null || durationMs <= 0 || usedPct <= 0 || observedAt >= resetsAt) return null;
  const elapsed = observedAt - (resetsAt - durationMs);
  if (elapsed < Math.max(MINUTE_MS, Math.min(durationMs * 0.01, HOUR_MS))) return null;
  if ((usedPct / elapsed) * durationMs <= 100) return null;
  return Math.round(observedAt + ((100 - usedPct) / usedPct) * elapsed);
}
