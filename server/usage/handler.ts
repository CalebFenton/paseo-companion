import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentRef, UsageView, usageRpc } from "../../shared/usage";
import { type CachedRead, type CachedValue, createCachedRead } from "../cached-read";
import { profileForProvider } from "./agents";
import { agentDbPath, listProfiles, readPinnedIdentity, runOmpUsage } from "./omp";
import { buildUsageView } from "./view";

export const USAGE_MAX_AGE_MS = 120_000;
/** A manual refresh still reuses a run this fresh, so repeated presses cost nothing. */
const REFRESH_MAX_AGE_MS = 10_000;
const CONFIG_MAX_AGE_MS = 30_000;

export type LoadUsage = (options: {
  maxAgeMs: number;
  /** Limits the age check to this profile; the others reuse whatever they have. */
  profile?: string;
  agents?: readonly AgentRef[];
  providers?: unknown;
  /** Paseo's own usage sources' answer; absent for omp's logins alone. */
  paseo?: CachedValue<unknown>;
}) => Promise<UsageView>;

/**
 * Reads every omp profile, and the pins of agents whose account omp picks per session, into the
 * usage view. `changed` runs after each omp run, so subscribers may see something new.
 */
export function createUsageLoader(changed: () => void): LoadUsage {
  const runs = new Map<string, CachedRead<unknown>>();
  const runFor = (profile: string) => {
    const run = runs.get(profile) ?? createCachedRead<unknown>({ settled: changed });
    runs.set(profile, run);
    return run;
  };
  return async ({ maxAgeMs, profile: focus, agents = [], providers, paseo }) => {
    const profiles = await Promise.all(
      listProfiles().map(async (profile) => {
        const ageMs = focus === undefined || focus === profile ? maxAgeMs : Number.POSITIVE_INFINITY;
        const { value, error } = await runFor(profile).get(ageMs, () => runOmpUsage(profile));
        return { profile, usage: value, error };
      }),
    );
    return buildUsageView({
      profiles,
      paseoUsage: paseo?.value,
      paseoError: paseo?.error ?? null,
      providers,
      env: process.env,
      agents,
      now: Date.now(),
      pinnedIdentity: (profile, provider, sessionId) => readPinnedIdentity(agentDbPath(profile), provider, sessionId),
    });
  };
}

/**
 * `changed` runs when Paseo's own usage sources answer, so subscribers may see something new. They
 * answer for every source at once, this plugin's included, and wait on the slowest, so a view
 * serves their last answer while a newer one comes; only the first read waits.
 */
export function createUsageHandler(load: LoadUsage, changed: () => void) {
  const config = createCachedRead<unknown>();
  const paseoUsage = createCachedRead<unknown>({ settled: changed });

  const readProviders = async (paseo: PluginHandlerContext["paseo"]) => {
    const read = () =>
      paseo.config.get().then(
        ({ config: daemon }) => daemon.providers,
        (error: unknown) => {
          console.error("Reading provider config failed", error);
          throw error;
        },
      );
    return (await config.get(CONFIG_MAX_AGE_MS, read)).value;
  };
  const askPaseo = (paseo: PluginHandlerContext["paseo"], maxAgeMs: number) => paseoUsage.get(maxAgeMs, () => paseo.providers.listUsage());

  return {
    view: async (input: RpcInput<typeof usageRpc>, { paseo }: PluginHandlerContext): Promise<UsageView> => {
      const maxAgeMs = input.refresh ? REFRESH_MAX_AGE_MS : USAGE_MAX_AGE_MS;
      const asking = askPaseo(paseo, maxAgeMs);
      const [providers, paseoRead] = await Promise.all([
        input.agents.length > 0 ? readProviders(paseo) : undefined,
        paseoUsage.latest() ?? asking,
      ]);
      return load({ maxAgeMs, agents: input.agents, providers, paseo: paseoRead });
    },

    /** Rereads the quota an agent's turn drew from: its omp profile's, else Paseo's own sources'. */
    afterTurn: async (provider: string, paseo: PluginHandlerContext["paseo"]): Promise<void> => {
      const profile = profileForProvider(provider, await readProviders(paseo), process.env);
      if (profile === null) await askPaseo(paseo, REFRESH_MAX_AGE_MS);
      else await load({ maxAgeMs: REFRESH_MAX_AGE_MS, profile });
    },
  };
}
