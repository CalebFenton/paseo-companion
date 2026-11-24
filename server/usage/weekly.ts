import { DAY_MS } from "../../shared/format";
import type { Outlook } from "../../shared/usage";
import type { Account, BankedReset, Window } from "./accounts";

/**
 * A weekly window resetting within this long with at least `UNUSED_PCT` left is about to waste it.
 * A tenth of a week is still most of a day's work, so the bar sits low.
 */
const UNUSED_WITHIN_MS = DAY_MS;
const UNUSED_PCT = 10;

/**
 * The limits that ration an account: account-wide windows a day or longer, such as Claude's and
 * Codex's 7d. Where the source gives no lengths, every account-wide window.
 */
export function weeklyWindows(account: Pick<Account, "windows">): Window[] {
  const wide = account.windows.filter((window) => window.modelFamily === null);
  const weekly = wide.filter((window) => (window.durationMs ?? 0) >= DAY_MS);
  return weekly.length > 0 ? weekly : wide;
}

/**
 * Only an account-wide window a day or longer can waste quota worth flagging: a 5h one resets
 * several times a day, and a model pool's leftover is capped by the account's own weekly limit.
 */
export function outlookOf(window: Window, now: number): Outlook {
  if (window.usedPct >= 100) return "reached";
  if (window.runsOutAt !== null) return "runsOut";
  const resetsSoon = window.resetsAt !== null && window.resetsAt - now <= UNUSED_WITHIN_MS;
  const wasteable = window.modelFamily === null && (window.durationMs ?? 0) >= DAY_MS;
  if (wasteable && resetsSoon && 100 - window.usedPct >= UNUSED_PCT) return "unused";
  return "onTrack";
}

/** The account's weekly outlook: reached if any weekly limit is, else unused if any is about to waste quota, else runsOut if any will; null without weekly limits. */
export function accountOutlook(account: Account, now: number): Outlook | null {
  if (account.problem !== null) return null;
  const outlooks = weeklyWindows(account).map((window) => outlookOf(window, now));
  if (outlooks.length === 0) return null;
  return (["reached", "unused", "runsOut"] as const).find((outlook) => outlooks.includes(outlook)) ?? "onTrack";
}

/** Earlier sorts first: quota about to reset unused, then room to spare, then quota running out early, then none left. */
const USE_RANK: Record<Outlook, number> = { unused: 0, onTrack: 1, runsOut: 2, reached: 3 };

/**
 * Compares accounts in the order to use them, so that no quota resets unused: by weekly outlook, then
 * the soonest deadline, which is the next weekly reset, or for a reached account when it is back.
 * Accounts without weekly limits sit with those on track, after them; unreadable ones last.
 */
export function byUseOrder(now: number): (a: Account, b: Account) => number {
  const key = (account: Account): [number, number] => {
    if (account.problem !== null) return [4, 0];
    const outlook = accountOutlook(account, now);
    const rank = USE_RANK[outlook ?? "onTrack"];
    const resets = weeklyWindows(account).flatMap((window) => (window.resetsAt === null ? [] : [window.resetsAt]));
    if (resets.length === 0) return [rank, Number.POSITIVE_INFINITY];
    return [rank, outlook === "reached" ? Math.max(...resets) : Math.min(...resets)];
  };
  return (a, b) => {
    const [rankA, deadlineA] = key(a);
    const [rankB, deadlineB] = key(b);
    return rankA - rankB || deadlineA - deadlineB;
  };
}

/** "full" for a reset clearing the weekly limit, or one naming nothing, which clears every limit; else the pool it clears, "fable". */
export function resetScope(reset: BankedReset, account: Pick<Account, "windows">): string {
  const { clears } = reset;
  if (clears === null || weeklyWindows(account).some((window) => clears.includes(window.id))) return "full";
  const pool = account.windows.find((window) => window.modelFamily !== null && clears.includes(window.id));
  return pool?.modelFamily ?? clears[0]?.slice(clears[0].lastIndexOf(":") + 1) ?? "other";
}

/** When the weekly limit is back, if a usable full reset is worth redeeming now: the limit is reached for over a day more. */
export function redeemable(account: Account, now: number): { backAt: number } | null {
  const reached = weeklyWindows(account).filter((window) => outlookOf(window, now) === "reached");
  const backAt = Math.max(...reached.map((window) => window.resetsAt ?? Number.POSITIVE_INFINITY));
  if (reached.length === 0 || backAt - now <= DAY_MS) return null;
  const full = account.resets.some(
    (reset) => reset.usable && (reset.expiresAt ?? Number.POSITIVE_INFINITY) > now && resetScope(reset, account) === "full",
  );
  return full && Number.isFinite(backAt) ? { backAt } : null;
}
