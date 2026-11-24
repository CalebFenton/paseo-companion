import { readFileSync } from "node:fs";
import { type UsageScope, UsageScopeSchema } from "@getpaseo/plugin/server/usage";
import { expect, it } from "vitest";
import { z } from "zod";
import { DAY_MS, HOUR_MS } from "../../shared/format";
import { type AccountView, agentRefSchema } from "../../shared/usage";
import type { ProfileUsage } from "./accounts";
import { avatars } from "./avatars";
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
  /** 60% left, resetting in 20 hours: unused too, but later in use order than `unused`. */
  later: report("later@example.com", 40, 20 * HOUR_MS),
  /** Full for 3 more days, with a full reset to unlock it. */
  redeem: report("redeemer@example.com", 100, 3 * DAY_MS, 10 * DAY_MS),
  fine: report("fine@example.com", 20, 3 * DAY_MS),
};

/** What the sidebar row says for these reads: the alarmed login and the sentence, else "strip". */
function sidebarOf(reads: (keyof typeof READS)[]) {
  const profiles: ProfileUsage[] = [
    {
      profile: "default",
      usage: { reports: reads.map((read) => READS[read]), accountsWithoutUsage: [], disabledCredentials: [] },
      error: null,
    },
  ];
  const view = buildUsageView({ profiles, providers: undefined, env: {}, agents: [], now, pinnedIdentity: () => null });
  if (view.overview === null) return "strip";
  const { accountId, text } = view.overview;
  return `${view.accounts.find((account) => account.id === accountId)?.label}: ${text}`;
}

it("raises the sidebar row only for quota about to reset unused, soonest first; anything else leaves the strip", () => {
  expect(sidebarOf(["fine", "later", "redeem", "unused"])).toBe("wasting@example.com: 70% unused · 12h");
  expect(sidebarOf(["fine", "later", "redeem"])).toBe("later@example.com: 60% unused · 20h");
  expect(sidebarOf(["fine", "redeem"])).toBe("strip");
});

it("keeps each login's glyph whatever order the logins arrive in, and gives 16 logins 16 glyphs", () => {
  const ids = Array.from({ length: 16 }, (_, index) => `login-${index}`);
  const forward = avatars(ids);
  const backward = avatars(ids.toReversed());
  expect(ids.map((id) => backward.get(id))).toEqual(ids.map((id) => forward.get(id)));
  expect(new Set(ids.map((id) => forward.get(id)?.symbol)).size).toBe(16);
});
