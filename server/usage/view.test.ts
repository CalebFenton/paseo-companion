import { readFileSync } from "node:fs";
import { type UsageScope, UsageScopeSchema } from "@getpaseo/plugin/server/usage";
import { expect, it } from "vitest";
import { z } from "zod";
import { DAY_MS, HOUR_MS } from "../../shared/format";
import { type AccountView, agentRefSchema } from "../../shared/usage";
import type { ProfileUsage } from "./accounts";
import { buildUsageView, discoverAccounts, scopeLogins, toUsageReport, USAGE_SOURCES } from "./view";

/** omp outputs per profile, Paseo's own usage sources, omp's session pins as `identity_key` by cache key, Paseo's config and agents, and Usage-screen scopes. */
const inputSchema = z.object({
  profiles: z.array(z.object({ profile: z.string(), usage: z.unknown().optional(), error: z.string().nullable().default(null) })),
  paseoUsage: z.unknown(),
  pins: z.record(z.string(), z.record(z.string(), z.string())),
  providers: z.unknown(),
  env: z.record(z.string(), z.string()),
  agents: z.array(agentRefSchema),
  now: z.number(),
  scopes: z.record(z.string(), UsageScopeSchema),
});
const input = inputSchema.parse(JSON.parse(readFileSync(new URL("../../fixtures/usage.input.json", import.meta.url), "utf8")));

function pinnedIdentity(profile: string, provider: string, sessionId: string): string | null {
  return input.pins[profile]?.[`session:sticky:${provider}:${sessionId}`] ?? null;
}

/** The Usage-screen entries one scope lists, each with the source listing it. */
function scopeEntries(scope: UsageScope, accounts: readonly AccountView[]) {
  const filter = scopeLogins(scope, input.env);
  if (filter === null) return [];
  return USAGE_SOURCES.flatMap((source) =>
    discoverAccounts(source, filter, accounts).map((account) => Object.assign({ source: source.id }, account)),
  );
}

it("change detector: omp outputs, Paseo's own sources, session pins, Paseo config, and agents give the recorded usage view and usage sources", async () => {
  const view = buildUsageView({ ...input, pinnedIdentity });
  const usageSources = Object.fromEntries(Object.entries(input.scopes).map(([name, scope]) => [name, scopeEntries(scope, view.accounts)]));
  const reports = Object.fromEntries(view.accounts.map((account) => [account.title, toUsageReport(account)]));
  await expect(`${JSON.stringify({ view, usageSources, reports }, null, 2)}\n`).toMatchFileSnapshot("../../fixtures/usage.view.json");
});

const now = 1_000 * DAY_MS;

/** An omp report for a Claude login with one 7-day limit, `usedPct` used, resetting in `resetsInMs`; `resetExpiresInMs` banks a full reset. */
function report(email: string, usedPct: number, resetsInMs: number, resetExpiresInMs?: number) {
  return {
    provider: "anthropic",
    fetchedAt: now,
    limits: [
      {
        id: "anthropic:7d",
        label: "Claude 7 Day",
        scope: {},
        window: { id: "7d", durationMs: 7 * DAY_MS, resetsAt: now + resetsInMs },
        amount: { usedFraction: usedPct / 100, unit: "percent" },
      },
    ],
    metadata: { email },
    resetCredits:
      resetExpiresInMs === undefined
        ? undefined
        : {
            credits: [{ usable: true, expiresAt: new Date(now + resetExpiresInMs).toISOString(), remainingCount: 1, status: "available" }],
          },
  };
}

const READS = {
  /** 70% of the week left, resetting in 12 hours. */
  unused: report("wasting@example.com", 30, 12 * HOUR_MS),
  /** Full for 3 more days, with a full reset to redeem. */
  redeem: report("redeemer@example.com", 100, 3 * DAY_MS, 10 * DAY_MS),
  /** On track, with a full reset expiring in 6 hours. */
  expiring: report("expiring@example.com", 50, 3 * DAY_MS, 6 * HOUR_MS),
  /** Full, back in 12 hours: too soon for a reset to be worth redeeming. */
  full: report("full@example.com", 100, 12 * HOUR_MS),
  fine: report("fine@example.com", 20, 3 * DAY_MS),
};

function overviewOf(reads: (keyof typeof READS)[], unread: boolean, failed: boolean) {
  const profiles: ProfileUsage[] = [
    {
      profile: "default",
      usage: {
        reports: reads.map((read) => READS[read]),
        accountsWithoutUsage: unread ? [{ provider: "anthropic", email: "unread@example.com" }] : [],
        disabledCredentials: [],
      },
      error: null,
    },
    ...(failed ? [{ profile: "broken", error: "omp usage timed out after 20s" }] : []),
  ];
  const { text, tone } = buildUsageView({ profiles, providers: undefined, env: {}, agents: [], now, pinnedIdentity: () => null }).overview;
  return `${tone}: ${text}`;
}

it("words the sidebar's most pressing item in a fixed order, so checking any one earlier than its place picks the wrong sentence", () => {
  expect(overviewOf(["unused", "redeem", "expiring", "full", "fine"], true, true)).toBe("ok: wasting: 70% expires in 12h");
  expect(overviewOf(["redeem", "expiring", "full", "fine"], true, true)).toBe("ok: redeem a reset: redeemer");
  expect(overviewOf(["expiring", "full", "fine"], true, true)).toBe("warning: a full reset expires within a day");
  expect(overviewOf(["full", "fine"], true, true)).toBe("danger: 1 of 3 accounts full");
  expect(overviewOf(["fine"], true, true)).toBe("warning: 1 account without data");
  expect(overviewOf(["fine"], false, true)).toBe("warning: a usage read failed");
  expect(overviewOf(["fine"], false, false)).toBe("ok: 1 account, all fine");
});
