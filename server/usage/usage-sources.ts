import type { PluginServerContext } from "@getpaseo/plugin/server";
import { UsageScopeSchema } from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { type LoadUsage, USAGE_MAX_AGE_MS } from "./handler";
import { discoverAccounts, scopeLogins, toUsageReport, USAGE_SOURCES } from "./view";

const FETCH_MAX_AGE_MS = 60_000;

const inputSchema = z.object({ profile: z.string(), account: z.string() }).strict();

/** Feeds Paseo's Usage screen and its per-session usage popover. */
export function registerUsageSources(server: PluginServerContext, load: LoadUsage): void {
  for (const source of USAGE_SOURCES) {
    server.registerUsageSource({
      id: source.id,
      label: source.label,
      input: inputSchema,
      async discover(scope) {
        const filter = scopeLogins(UsageScopeSchema.parse(scope), process.env);
        if (filter === null) return [];
        const { accounts } = await load({ maxAgeMs: USAGE_MAX_AGE_MS });
        return discoverAccounts(source, filter, accounts);
      },
      async fetch(value) {
        const { profile, account: id } = inputSchema.parse(value);
        const view = await load({ maxAgeMs: FETCH_MAX_AGE_MS, profile });
        const account = view.accounts.find((candidate) => candidate.id === id);
        if (account?.profiles.includes(profile)) return toUsageReport(account);
        const failure = view.errors.find((error) => error.profile === profile);
        throw new Error(failure?.message ?? `omp profile ${profile} no longer has this login`);
      },
    });
  }
}
