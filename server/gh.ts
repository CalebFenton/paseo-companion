import { z } from "zod";
import { errorMessage } from "../shared/format";
import { execFailure, execFileAsync } from "./exec";

const GH_TIMEOUT_MS = 30_000;
const GH_START_TIMEOUT_MS = 5_000;

/** The first directory where gh starts: a per-project install (mise, asdf) only resolves inside its project. */
async function ghDirectory(directories: readonly string[]): Promise<string | undefined> {
  for (const directory of directories) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- tried one at a time in order of preference; the first that starts wins
      await execFileAsync("gh", ["--version"], { cwd: directory, timeout: GH_START_TIMEOUT_MS });
      return directory;
    } catch {
      // gh does not start here; try the next one.
    }
  }
  // A slow start may still finish there; else its error says why.
  return directories[0];
}

/** A GraphQL answer as gh printed it, unparsed beyond JSON. */
async function graphql(query: string, cwd: string | undefined): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("gh", ["api", "graphql", "-f", `query=${query}`], {
      cwd,
      timeout: GH_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    // GraphQL errors exit 1 but still print the response with whatever GitHub could answer.
    if (!(error instanceof Error && "stdout" in error && typeof error.stdout === "string" && error.stdout.trimStart().startsWith("{"))) {
      throw execFailure(error, "gh", GH_TIMEOUT_MS);
    }
    stdout = error.stdout;
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("gh printed invalid JSON");
  }
}

const typeProbeSchema = z.object({ data: z.object({ __type: z.object({ name: z.string() }).nullable() }) });

/** Whether the server has GitHub's own stacked pull requests: asked once per daemon, again after a failed ask. */
let nativeStacks: boolean | undefined;

export interface GitHubQuery {
  id: string;
  query: string;
}

export interface GitHub {
  /** The server has GitHub's own stacked pull requests. */
  nativeStacks: boolean;
  /** Runs every query at once as the user gh is signed in as: raw answers by id, `{ error }` for a failed one. */
  query(queries: readonly GitHubQuery[]): Promise<Record<string, unknown>>;
}

/** `directories`: where gh may run, in order of preference. */
export async function openGitHub(directories: readonly string[]): Promise<GitHub> {
  const cwd = await ghDirectory(directories);
  if (nativeStacks === undefined) {
    try {
      const probe = typeProbeSchema.safeParse(await graphql('{ __type(name: "PullRequestStack") { name } }', cwd));
      if (probe.success) nativeStacks = probe.data.data.__type !== null;
    } catch {
      // The queries report why gh fails, if it does.
    }
  }
  return {
    nativeStacks: nativeStacks ?? false,
    async query(queries) {
      const answers = await Promise.all(
        queries.map(({ id, query }) =>
          graphql(query, cwd).then(
            (answer) => [id, answer] as const,
            (reason: unknown) => [id, { error: errorMessage(reason) }] as const,
          ),
        ),
      );
      return Object.fromEntries(answers);
    },
  };
}
