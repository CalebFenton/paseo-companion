import { z } from "zod";
import type { AgentRef } from "../../shared/usage";
import type { ProfileLogin } from "./accounts";

export const DEFAULT_PROFILE = "default";

/** The daemon environment variables that pick an omp profile or move omp's store. */
export interface DaemonEnv {
  OMP_PROFILE?: string;
  PI_PROFILE?: string;
  PI_CONFIG_DIR?: string;
  PI_CODING_AGENT_DIR?: string;
  XDG_DATA_HOME?: string;
}

/** The omp profile an environment picks. */
export function profileOf(env: DaemonEnv): string {
  return (env.OMP_PROFILE ?? env.PI_PROFILE)?.trim() || DEFAULT_PROFILE;
}

/** The omp provider of a `<omp provider>/<model id>` model, or null for any other model. */
export function ompVendorOf(model: string | null): string | null {
  const slash = model?.indexOf("/") ?? -1;
  return model && slash > 0 ? model.slice(0, slash) : null;
}

/** The `identity_key` of the login omp pinned a session to in one profile, or null without a pin. */
export type PinLookup = (profile: string, provider: string, sessionId: string) => string | null;

// The daemon config types `providers` loosely; read only what profile resolution needs.
const providersSchema = z
  .record(
    z.string(),
    z
      .object({
        extends: z.string().optional().catch(undefined),
        env: z.record(z.string(), z.string()).optional().catch(undefined),
      })
      .catch({}),
  )
  .catch({});

/**
 * The omp profile a Paseo provider launches, from the daemon config's `providers` as read, or null
 * when it does not launch omp. Env merges the way Paseo launches: the daemon's own, then each
 * provider from the base `omp` up.
 */
export function profileForProvider(providerId: string, providers: unknown, daemonEnv: DaemonEnv): string | null {
  const config = providersSchema.parse(providers);
  const envs: (Record<string, string> | undefined)[] = [];
  const seen = new Set<string>();
  for (let id: string | undefined = providerId; id !== undefined && !seen.has(id); id = config[id]?.extends) {
    seen.add(id);
    envs.unshift(config[id]?.env);
    if (id === "omp") {
      const env: DaemonEnv = { ...daemonEnv };
      for (const providerEnv of envs) Object.assign(env, providerEnv);
      return profileOf(env);
    }
  }
  return null;
}

const LOGIN_FIELD_BY_KIND: Record<string, "email" | "accountId" | "projectId" | "orgId"> = {
  email: "email",
  account: "accountId",
  project: "projectId",
  org: "orgId",
};

export interface BindInput {
  agents: readonly AgentRef[];
  providers: unknown;
  env: DaemonEnv;
  /** Read only for sessions whose profile holds several logins of their provider. */
  pinnedIdentity: PinLookup;
}

/** The account each omp agent draws from, by agent id, for agents whose account is known. */
export function bindAgents(
  { agents, providers, env, pinnedIdentity }: BindInput,
  logins: Readonly<Record<string, readonly ProfileLogin[]>>,
): Record<string, string> {
  const bound: Record<string, string> = {};
  for (const ref of agents) {
    const profile = profileForProvider(ref.provider, providers, env);
    const provider = ompVendorOf(ref.model);
    if (profile === null || provider === null) continue;
    const candidates = (logins[profile] ?? []).filter((login) => login.provider === provider);
    let login = candidates.length === 1 ? candidates[0] : undefined;
    if (candidates.length > 1 && ref.sessionId) {
      const identity = pinnedIdentity(profile, provider, ref.sessionId);
      // omp identity keys join `kind:value` parts with `|`, such as `email:<e>|org:<id>`; every part must match.
      login = candidates.find((candidate) =>
        identity?.split("|").every((part) => {
          const colon = part.indexOf(":");
          const field = LOGIN_FIELD_BY_KIND[part.slice(0, colon)];
          return field !== undefined && candidate[field]?.toLowerCase() === part.slice(colon + 1).toLowerCase();
        }),
      );
    }
    if (login) bound[ref.agentId] = login.account;
  }
  return bound;
}
