import { expect, it } from "vitest";
import { runsOutAt } from "./pace";

const HOUR = 3_600_000;
const now = 1_000 * HOUR;
/** A 5-hour window resetting in 3 hours: 2 hours in at the reading. */
const window = { usedPct: 60, resetsAt: now + 3 * HOUR, durationMs: 5 * HOUR, runsOutAt: null };

it("projects 100% from the average pace so far when that falls before the reset", () => {
  // 60% in 2 hours is 30% an hour: the last 40% takes 80 minutes.
  expect(runsOutAt(window, now, now)).toBe(now + 80 * 60_000);
  expect(runsOutAt({ ...window, usedPct: 30 }, now, now)).toBeNull();
});

it("counts from the reading, not from now", () => {
  // 60% in 1.5 hours: the last 40% takes an hour.
  expect(runsOutAt(window, now - HOUR / 2, now)).toBe(now + HOUR / 2);
});

it("waits for 1% of the window, at least a minute, before trusting the pace", () => {
  const start = now - 2 * HOUR;
  expect(runsOutAt({ ...window, usedPct: 5 }, start + 2 * 60_000, now)).toBeNull();
  expect(runsOutAt({ ...window, usedPct: 5 }, start + 4 * 60_000, now)).not.toBeNull();
});

it("takes the source's own estimate before the reset, and none once the limit is reached or the window has reset", () => {
  expect(runsOutAt({ ...window, usedPct: 10, runsOutAt: now + HOUR }, now, now)).toBe(now + HOUR);
  expect(runsOutAt({ ...window, usedPct: 100 }, now, now)).toBeNull();
  expect(runsOutAt(window, now, now + 4 * HOUR)).toBeNull();
});
