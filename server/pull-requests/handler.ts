import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { checkOutRpc, PullRequestRef, PullRequestsSnapshot, PullRequestsView, pullRequestsRpc } from "../../shared/pull-requests";
import { createCachedRead } from "../cached-read";
import { execFileAsync } from "../exec";
import { openGitHub } from "../gh";
import { foundQueries, pullRequestQueries } from "./github";
import { buildPullRequestsView } from "./view";
import { type Checkout, githubProjects, PULL_REQUEST_METADATA_KEY, planWorkspaces, type UnmatchedWorkspace } from "./workspaces";

const SNAPSHOT_MAX_AGE_MS = 180_000;
/** A manual refresh, or any read after one that missed workspaces Paseo had not read, still reuses a read this fresh. */
const REFRESH_MAX_AGE_MS = 10_000;
const GIT_TIMEOUT_MS = 5_000;

/** Checkouts by workspace id. */
async function readCheckouts(workspaces: readonly UnmatchedWorkspace[]): Promise<Record<string, Checkout>> {
  const checkouts: Record<string, Checkout> = {};
  await Promise.all(
    workspaces.map(async ({ id, directory }) => {
      try {
        // The commit, then the branch, or "HEAD" when detached.
        const { stdout } = await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD", "--abbrev-ref", "HEAD"], {
          timeout: GIT_TIMEOUT_MS,
        });
        const [head = "", branch = "HEAD"] = stdout.trim().split("\n");
        checkouts[id] = { head, branch: branch === "HEAD" ? null : branch };
      } catch {
        // A directory git cannot read, such as one deleted under Paseo, matches nothing.
      }
    }),
  );
  return checkouts;
}

/** gh's answers to every query, by id. What the searches found is a second step, started as soon as they answer. */
async function readGitHub(directories: readonly string[], refs: readonly PullRequestRef[]): Promise<Record<string, unknown>> {
  const github = await openGitHub(directories);
  const { searches, workspaces } = pullRequestQueries(refs, github.nativeStacks);
  const [found, workspacePullRequests] = await Promise.all([
    github
      .query(searches)
      .then(async (answers) => ({ ...answers, ...(await github.query(foundQueries(answers, refs, github.nativeStacks))) })),
    github.query(workspaces),
  ]);
  return { ...found, ...workspacePullRequests };
}

/**
 * Fetches what the view is built from: Paseo's workspaces and projects, then gh's answers and git's
 * checkouts. A read that met workspaces Paseo had not read yet is redone at the next recompute
 * instead of after the full interval. A GitHub problem counts as a failed read, so it keeps the last
 * view and waits the interval too: retrying sooner feeds GitHub's secondary rate limit. Checking a
 * pull request out makes the next read fresh. `changed` runs after each read and each checkout, so
 * subscribers may see something new.
 */
export function createPullRequestsHandler(changed: () => void) {
  const reads = createCachedRead<{ view: PullRequestsView; fetchedAt: number }>({ settled: changed });
  let readSoon = false;

  const load = async ({ paseo }: PluginHandlerContext) => {
    readSoon = false;
    const [{ entries }, projects] = await Promise.all([paseo.workspaces.list(), paseo.projects.list()]);
    const plan = planWorkspaces(entries, projects);
    const [answers, checkouts] = await Promise.all([readGitHub(plan.directories, plan.refs), readCheckouts(plan.unmatched)]);
    const read = buildPullRequestsView({ plan, checkouts, answers, now: Date.now() });
    if ("failure" in read) throw new Error(read.failure);
    readSoon = read.readSoon;
    return { view: read.view, fetchedAt: Date.now() };
  };

  return {
    view: async (input: RpcInput<typeof pullRequestsRpc>, context: PluginHandlerContext): Promise<PullRequestsSnapshot> => {
      const maxAgeMs = input.refresh || readSoon ? REFRESH_MAX_AGE_MS : SNAPSHOT_MAX_AGE_MS;
      const { value, error } = await reads.get(maxAgeMs, () => load(context));
      return { view: value?.view ?? null, fetchedAt: value?.fetchedAt ?? null, error };
    },

    /**
     * Paseo's own pull request checkout, the one its create_workspace tool runs; forks included.
     * The workspace keeps which pull request it was made for, whatever branch it moves to.
     */
    checkOut: async ({ pullRequest, title }: RpcInput<typeof checkOutRpc>, { paseo }: PluginHandlerContext) => {
      const repository = `${pullRequest.owner}/${pullRequest.repo}`;
      const root = githubProjects(await paseo.projects.list()).projects.get(repository.toLowerCase());
      if (!root) throw new Error(`No Paseo project clones ${repository}`);
      const workspace = await paseo.workspaces.create({
        title,
        source: {
          kind: "worktree",
          cwd: root,
          action: "checkout",
          checkoutSource: { kind: "change_request", number: pullRequest.number },
        },
      });
      await workspace.setMetadata({ [PULL_REQUEST_METADATA_KEY]: pullRequest });
      reads.invalidate();
      changed();
      return { workspaceId: workspace.id };
    },
  };
}
