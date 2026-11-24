import { expect, it } from "vitest";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../shared/format";
import type { Account, Window } from "./accounts";
import { byUseOrder, outlookOf, redeemable } from "./weekly";

const now = 1_000 * HOUR_MS;
/** 27% used of a 7-day window resetting in 8 hours. */
const window: Window = {
  id: "anthropic:7d",
  label: "Claude 7 Day",
  shortLabel: "7d",
  usedPct: 27,
  tone: "ok",
  resetsAt: now + 8 * HOUR_MS,
  durationMs: 168 * HOUR_MS,
  runsOutAt: null,
  modelFamily: null,
};

/** A readable Claude login whose 7-day windows differ from `window` by `windows`. */
function account(id: string, windows: Partial<Window>[], rest: Partial<Account> = {}): Account {
  return {
    id,
    provider: "anthropic",
    vendor: "Claude",
    label: id,
    organization: null,
    plan: null,
    profiles: ["default"],
    fetchedAt: now,
    problem: null,
    windows: windows.map((changes, index) => ({ ...window, id: `${id}:${index}`, ...changes })),
    balances: [],
    resets: [],
    ...rest,
  };
}

it("flags an account-wide weekly limit resetting within a day with a quarter or more unused", () => {
  expect(outlookOf(window, now)).toBe("unused");
  expect(outlookOf({ ...window, usedPct: 80 }, now)).toBe("onTrack");
  expect(outlookOf({ ...window, resetsAt: now + 30 * HOUR_MS }, now)).toBe("onTrack");
});

it("never flags a 5h window or a model pool, whose leftover the weekly limit caps", () => {
  expect(outlookOf({ ...window, id: "anthropic:5h", durationMs: 5 * HOUR_MS }, now)).toBe("onTrack");
  expect(outlookOf({ ...window, id: "anthropic:7d:fable", modelFamily: "fable" }, now)).toBe("onTrack");
});

it("orders by outlook, then the soonest reset, but a full account by when its last full limit is back, not its first", () => {
  const accounts = [
    account("broken", [], { problem: "omp has no usage report for this login.", fetchedAt: null }),
    // Back in 5 days: both limits are full, and the later one decides. Sorting by the first reset puts it before reachedSoon.
    account("reachedLate", [
      { usedPct: 100, resetsAt: now + DAY_MS },
      { usedPct: 100, resetsAt: now + 5 * DAY_MS },
    ]),
    account("onTrackLate", [{ usedPct: 50, resetsAt: now + 4 * DAY_MS }]),
    account("noWeekly", [], {
      balances: [{ id: "extra", label: "Extra", usedPct: 10, tone: "ok", resetsAt: null, unit: "usd", used: 1, limit: 10, remaining: 9 }],
    }),
    account("reachedSoon", [{ usedPct: 100, resetsAt: now + 3 * DAY_MS }]),
    account("runsOut", [{ usedPct: 60, resetsAt: now + 3 * DAY_MS, runsOutAt: now + DAY_MS }]),
    account("onTrackSoon", [{ usedPct: 50, resetsAt: now + 2 * DAY_MS }]),
    account("unused", [{ usedPct: 10, resetsAt: now + 12 * HOUR_MS }]),
  ];
  expect(accounts.toSorted(byUseOrder(now)).map(({ id }) => id)).toEqual([
    "unused",
    "onTrackSoon",
    "onTrackLate",
    "noWeekly",
    "runsOut",
    "reachedSoon",
    "reachedLate",
    "broken",
  ]);
});

it("offers a usable full reset only while the weekly limit stays full for more than a day", () => {
  const reset = { clears: null, usable: true, expiresAt: null };
  const full = (backInMs: number, usable = true) =>
    account("full", [{ usedPct: 100, resetsAt: now + backInMs }], { resets: [{ ...reset, usable }] });
  expect(redeemable(full(DAY_MS), now)).toBeNull();
  expect(redeemable(full(DAY_MS + MINUTE_MS), now)).toEqual({ backAt: now + DAY_MS + MINUTE_MS });
  expect(redeemable(full(2 * DAY_MS, false), now)).toBeNull();
});
