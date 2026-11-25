import { defineRpc, defineSettings, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import { joinParts, percent } from "./format.ts";
import { toneSchema } from "./tone.ts";

export const balanceUnitSchema = z.enum(["usd", "credits", "requests", "tokens"]);
export type BalanceUnit = z.infer<typeof balanceUnitSchema>;

const toneAndAccentSchema = z.object({
  tone: toneSchema,
  /** A weekly limit resets soon with much left: use this account first. Shown in blue. */
  accent: z.boolean(),
});

const summarySchema = toneAndAccentSchema.extend({ text: z.string() });
export type Summary = z.infer<typeof summarySchema>;

/**
 * Where a window is headed: reached its limit; on pace to run out before it resets; resetting
 * within a day with a tenth or more unused (weekly windows only); else on track.
 */
const outlookSchema = z.enum(["reached", "runsOut", "unused", "onTrack"]);
export type Outlook = z.infer<typeof outlookSchema>;

const windowSchema = z.object({
  /** The source's limit id, stable across accounts. */
  id: z.string(),
  label: z.string(),
  /** The model family or the window's short name ("5h", "7d", "wk"). */
  shortLabel: z.string(),
  usedPct: z.number(),
  tone: toneSchema,
  /** Epoch milliseconds. */
  resetsAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  /** Epoch milliseconds when, at its pace so far, it reaches 100% before resetting; else null. */
  runsOutAt: z.number().nullable(),
  outlook: outlookSchema,
  /** One of the account-wide limits a day or longer, which ration the account. */
  weekly: z.boolean(),
  /** An account-wide limit besides the weekly ones, reached: it stops every session now, as a full 5h window does. */
  stopsNow: z.boolean(),
});
export type WindowView = z.infer<typeof windowSchema>;

const balanceSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** "$74.97 of $500.00", "1,200 credits left". */
  text: z.string(),
  /** Share of a known limit used; null leaves the meter out. */
  usedPct: z.number().nullable(),
  tone: toneSchema,
  /** Epoch milliseconds. */
  resetsAt: z.number().nullable(),
  unit: balanceUnitSchema,
  used: z.number().nullable(),
  limit: z.number().nullable(),
  remaining: z.number().nullable(),
});

/** How a login is told apart at a glance beside its vendor's logo: a glyph in a color, "◆" in pink. */
const avatarSchema = z.object({ symbol: z.string(), color: z.string() });
export type Avatar = z.infer<typeof avatarSchema>;

const accountSchema = z.object({
  /** Stable across profiles and token rotation; also the Usage-screen account key. */
  id: z.string(),
  /** omp provider id, or the id of the Paseo usage source that read it, such as "cursor". */
  provider: z.string(),
  /** "Claude", "Codex": the brand whose logo marks the account. */
  vendor: z.string(),
  avatar: avatarSchema,
  /** "Claude · me@example.com", for pills and lists. */
  title: z.string(),
  /** Card heading: the vendor, with the organization when there is one. */
  heading: z.string(),
  /** The login's email, account id, or project id; else the profile holding it. */
  label: z.string(),
  organization: z.string().nullable(),
  plan: z.string().nullable(),
  /** omp profiles holding this login; empty for a login only Paseo's own usage sources read. */
  profiles: z.array(z.string()),
  /** Epoch milliseconds of the report shown. */
  fetchedAt: z.number().nullable(),
  /** Why there is no report; set exactly when `fetchedAt` is null. */
  problem: z.string().nullable(),
  windows: z.array(windowSchema),
  balances: z.array(balanceSchema),
  /**
   * Banked limit resets, those clearing the weekly limit ("full") first, then by the pool they
   * clear ("fable"). `usable`: how many can be redeemed now; others wait their turn or for a limit
   * to be reached. `expiresAt`: the soonest one's expiry, epoch milliseconds; warning when a usable
   * one expires within a day.
   */
  resets: z.array(
    z.object({ scope: z.string(), count: z.number(), usable: z.number(), expiresAt: z.number().nullable(), tone: toneSchema }),
  ),
  /** A usable full reset is worth redeeming now: the weekly limit is reached for over a day more, until `backAt`, epoch milliseconds. */
  redeem: z.object({ backAt: z.number() }).nullable(),
  /** Tone: the worst of the weekly limits and those that `stopsNow`; else the first balance's; warning without a report. */
  ...toneAndAccentSchema.shape,
  /** The fullest weekly limit's id, which the row describes; null without weekly limits. */
  fullestWeekly: z.string().nullable(),
  /** The share used the row's bar and the pill's needle show: the fullest weekly limit's, else the first balance's; null without either. */
  usedPct: z.number().nullable(),
});
export type AccountView = z.infer<typeof accountSchema>;

const OUTLOOK_MARK: Record<Outlook, string> = { unused: " ↓", runsOut: " ↑", reached: "", onTrack: "" };

/** A limit's state after its name: "43%"; "57% ↑" on pace to run out early; "25% ↓" resetting soon with much unused; "full" reached. */
export function windowState({ usedPct, outlook }: Pick<WindowView, "usedPct" | "outlook">): string {
  return outlook === "reached" ? "full" : `${percent(usedPct)}${OUTLOOK_MARK[outlook]}`;
}

/** A limit by its short name and state: "7d 57% ↑", "5h full". */
export function limitText(window: Pick<WindowView, "shortLabel" | "usedPct" | "outlook">): string {
  return `${window.shortLabel} ${windowState(window)}`;
}

/** Banked resets by what they clear: "1 full · 2 fable"; `expiry` words each group's soonest expiry: "1 full, next expires 2026-12-10". */
export function resetsText(resets: AccountView["resets"], expiry?: (at: number) => string): string {
  return joinParts(
    resets.map(({ count, scope, expiresAt }) =>
      expiry === undefined || expiresAt === null ? `${count} ${scope}` : `${count} ${scope}, next expires ${expiry(expiresAt)}`,
    ),
  );
}

/**
 * A composer pill: the account an agent's session draws from, by its avatar's glyph, and its fullest
 * weekly limit's `windowState`, then each limit stopping the session's model now: "◆ 57% ↑",
 * "★ 40% · 5h full".
 */
const pillSchema = summarySchema.extend({
  accountId: z.string(),
  /**
   * Same-vendor omp logins with room left, in the order to use them: those with quota about to reset
   * unused first. Each lists its weekly limits, then those stopping the session's model now, by `limitText`.
   */
  others: z.array(summarySchema.extend({ accountId: z.string() })),
});

export const agentRefSchema = z.object({
  agentId: z.string(),
  /** Paseo provider id. */
  provider: z.string(),
  /** `<omp provider>/<model id>` for omp agents. */
  model: z.string().nullable(),
  /** omp session id for omp agents. */
  sessionId: z.string().nullable(),
});
export type AgentRef = z.infer<typeof agentRefSchema>;

const usageViewSchema = z.object({
  /** In the order to use them, so no quota resets unused: about to reset unused, on track, running out early, full; each by its next deadline. */
  accounts: z.array(accountSchema),
  /**
   * What the sidebar row says: a login about to let quota reset unused, and how much and when,
   * "70% unused · 2h"; null when none is, and the row draws each account's weekly use instead.
   */
  overview: z.object({ accountId: z.string(), text: z.string() }).nullable(),
  /** By agent id, for agents whose account is known: omp's by its pins, others' by their provider's sole sign-in. */
  pills: z.record(z.string(), pillSchema),
  /** Epoch milliseconds of the oldest report shown. */
  fetchedAt: z.number().nullable(),
  /** Reads that failed: "omp profile gmail", "Paseo"; `profile` names the omp profile whose run failed. */
  errors: z.array(z.object({ source: z.string(), message: z.string(), profile: z.string().optional() })),
});
export type UsageView = z.output<typeof usageViewSchema>;

/** How account cards word a reset: time left, "4d 9h", or the device's local time, "Tue 2:40 PM". */
const resetTimesSchema = z.enum(["countdown", "clock"]);
export type ResetTimes = z.infer<typeof resetTimesSchema>;

const displaySettingsSchema = z.object({ resetTimes: resetTimesSchema.default("countdown") });

/** Kept per device: a phone and a desktop may want resets worded differently. */
export const displaySettings = defineSettings({ id: "display", scope: "device", version: 1, schema: displaySettingsSchema });

export const usageRpc = defineRpc({
  name: "usage.view",
  input: z.object({
    agents: z.array(agentRefSchema),
    /** Rerun omp rather than reuse a recent result. */
    refresh: z.boolean().optional(),
  }),
  output: usageViewSchema,
});

/** The usage view for these agents, pushed on subscribing and whenever a read changes it, such as after an agent's turn. */
export const usageFeed = defineSubscription({
  name: "usage.feed",
  input: z.object({ agents: z.array(agentRefSchema) }),
  event: usageViewSchema,
});
