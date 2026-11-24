import { type Dirent, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as NodeSqlite from "node:sqlite";
import { z } from "zod";
import { execFailure, execFileAsync } from "../exec";
import { DEFAULT_PROFILE, type DaemonEnv } from "./agents";

/** omp's rule for profile names. */
const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** omp sessions export these to their children; inherited, they would override `--profile`. */
const STORE_ENV_KEYS = ["OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR", "PI_CONFIG_FILES"];

const USAGE_TIMEOUT_MS = 20_000;

const pinnedRowSchema = z.object({ identity_key: z.string() });

export interface OmpLocation {
  home?: string;
  env?: DaemonEnv;
  platform?: NodeJS.Platform;
}

function roots(location: OmpLocation) {
  const env: DaemonEnv = location.env ?? process.env;
  const platform = location.platform ?? process.platform;
  const base = join(location.home ?? homedir(), env.PI_CONFIG_DIR || ".omp");
  const xdg = (platform === "linux" || platform === "darwin") && env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "omp") : null;
  return { base, xdg };
}

/** Where omp keeps a profile's agent.db, including an XDG data root once it exists. */
export function agentDbPath(profile: string, location: OmpLocation = {}): string {
  const { base, xdg } = roots(location);
  const segments = profile === DEFAULT_PROFILE ? [] : ["profiles", profile];
  if (xdg) {
    const xdgRoot = join(xdg, ...segments);
    if (existsSync(xdgRoot)) return join(xdgRoot, "agent.db");
  }
  return join(base, ...segments, "agent", "agent.db");
}

/** The default profile when it has a store, then every named profile, sorted. */
export function listProfiles(location: OmpLocation = {}): string[] {
  const { base, xdg } = roots(location);
  const names = new Set<string>();
  for (const root of [base, xdg]) {
    if (!root) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, "profiles"), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && PROFILE_NAME.test(entry.name) && entry.name !== DEFAULT_PROFILE) {
        names.add(entry.name);
      }
    }
  }
  const named = [...names].toSorted();
  return existsSync(agentDbPath(DEFAULT_PROFILE, location)) ? [DEFAULT_PROFILE, ...named] : named;
}

export async function runOmpUsage(profile: string): Promise<unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STORE_ENV_KEYS) delete env[key];
  // `--profile` must precede the subcommand: after it, omp hands the flag to `usage`. Extensions
  // stay off so polling never runs third-party code; their providers' logins then lack reports.
  const args = ["--profile", profile, "usage", "--json", "--no-extensions"];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("omp", args, {
      env,
      timeout: USAGE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    throw execFailure(error, "omp", USAGE_TIMEOUT_MS, "omp usage");
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("omp usage printed invalid JSON");
  }
}

/**
 * The `identity_key` of the login omp pinned one session to, or null without a pin. Also null
 * when the store is missing or unreadable: the session stays unattributed.
 */
export function readPinnedIdentity(dbPath: string, provider: string, sessionId: string): string | null {
  // Loaded on first use: Node warns that it is experimental. @types/node declares both below for
  // every Node, but older Node and Electron builds lack `getBuiltinModule`, or `node:sqlite` in it.
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- Node before 20.16 has no getBuiltinModule
  const sqlite: typeof NodeSqlite | undefined = process.getBuiltinModule?.("node:sqlite");
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- Node before 22.5 returns undefined for node:sqlite
  if (sqlite === undefined) return null;
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    // Never select `data`: it holds the tokens.
    const row = db
      .prepare(
        "SELECT identity_key FROM cache JOIN auth_credentials ON auth_credentials.id = json_extract(cache.value, '$.credentialId') WHERE cache.key = ?",
      )
      .get(`session:sticky:${provider}:${sessionId}`);
    return pinnedRowSchema.safeParse(row).data?.identity_key ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
