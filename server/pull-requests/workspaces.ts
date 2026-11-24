import { z } from "zod";
import { type PullRequestRef, pullRequestRefSchema } from "../../shared/pull-requests";
import { activeWorkspaces, workspaceEntrySchema } from "../workspaces";
import { type PullRequestSummary, pullRequestKey } from "./github";

/** The workspace metadata key Check out stores the pull request under; Paseo never reads it. */
export const PULL_REQUEST_METADATA_KEY = "paseo-companion.pullRequest";

/**
 * Paseo adds `githubRuntime` only once it has read the workspace's git state, which it does while an
 * app watches the workspace list, so a list taken soon after an app connects may lack it.
 */
const entrySchema = workspaceEntrySchema.extend({
  workspaceKind: z.string().optional(),
  metadata: z
    .object({ [PULL_REQUEST_METADATA_KEY]: pullRequestRefSchema.optional().catch(undefined) })
    .nullish()
    .catch(null),
  githubRuntime: z
    .object({
      pullRequest: z
        .object({ number: z.number().optional(), state: z.string(), repoOwner: z.string().optional(), repoName: z.string().optional() })
        .nullish(),
    })
    .nullish(),
});

const projectSchema = z.object({ projectKey: z.string(), projectRootPath: z.string() });
const projectListSchema = z.object({ projects: z.array(z.unknown()) }).catch({ projects: [] });

/** Paseo's key for a project cloning a GitHub repository: "remote:github.com/owner/name". */
const GITHUB_PROJECT_KEY = /^remote:github\.com\/([^/]+\/[^/]+)$/;

export interface Workspace {
  id: string;
  name: string;
}

/** A workspace Paseo found no open pull request for, in a project cloning a GitHub repository. */
export interface UnmatchedWorkspace extends Workspace {
  directory: string;
  /** "owner/name", lowercase. */
  repository: string;
  /** Paseo has not read its git state yet, so its own pull request may be missing. */
  unread: boolean;
}

/** What git says a workspace has checked out. */
export interface Checkout {
  head: string;
  /** Null on a detached HEAD. */
  branch: string | null;
}

export interface WorkspacePlan {
  /**
   * Active workspaces with a pull request: the one Check out made it for, else the open one Paseo
   * found, the one its hover card shows. Paseo matches by branch, which an agent may since have left.
   */
  workspaces: (Workspace & { ref: number })[];
  /** The pull requests to read; workspaces on one share it. */
  refs: PullRequestRef[];
  /** Matched to review requests by their checkouts, which are read for that. */
  unmatched: UnmatchedWorkspace[];
  /** Project root by repository ("owner/name", lowercase): where Paseo checks its pull requests out. */
  projects: Map<string, string>;
  /** Where gh may run: workspaces with a pull request first, as Paseo reached GitHub there, then every GitHub project. */
  directories: string[];
}

/**
 * The projects cloning a GitHub repository, as `paseo.projects.list()` gave them; one repository
 * may have several. `projects`: root by repository ("owner/name", lowercase), the first project
 * Paseo lists cloning it.
 */
export function githubProjects(list: unknown): { projects: Map<string, string>; repositoryByRoot: Map<string, string> } {
  const projects = new Map<string, string>();
  const repositoryByRoot = new Map<string, string>();
  for (const raw of projectListSchema.parse(list).projects) {
    const project = projectSchema.safeParse(raw);
    const repository = project.success ? project.data.projectKey.match(GITHUB_PROJECT_KEY)?.[1]?.toLowerCase() : undefined;
    if (!project.success || !repository) continue;
    if (!projects.has(repository)) projects.set(repository, project.data.projectRootPath);
    repositoryByRoot.set(project.data.projectRootPath, repository);
  }
  return { projects, repositoryByRoot };
}

/** What to read for `paseo.workspaces.list()` entries and `paseo.projects.list()`, as Paseo gave them. */
export function planWorkspaces(entries: unknown, projectList: unknown): WorkspacePlan {
  const active = activeWorkspaces(entries, entrySchema);
  const { projects, repositoryByRoot } = githubProjects(projectList);

  const refs: PullRequestRef[] = [];
  const refByKey = new Map<string, number>();
  const prDirectories: string[] = [];
  const workspaces: WorkspacePlan["workspaces"] = [];
  const unmatched: UnmatchedWorkspace[] = [];
  for (const entry of active) {
    const found = entry.githubRuntime?.pullRequest;
    const pr =
      entry.metadata?.[PULL_REQUEST_METADATA_KEY] ??
      (found?.state === "open" && found.number !== undefined && found.repoOwner && found.repoName
        ? { owner: found.repoOwner, repo: found.repoName, number: found.number }
        : null);
    if (pr) {
      const key = pullRequestKey(`${pr.owner}/${pr.repo}`, pr.number);
      const ref = refByKey.get(key) ?? refs.push(pr) - 1;
      refByKey.set(key, ref);
      prDirectories.push(entry.directory);
      workspaces.push({ id: entry.id, name: entry.label, ref });
      continue;
    }
    // Every clone's workspaces, not only the first clone's: a second project may clone the same repository for reviews.
    const repository = repositoryByRoot.get(entry.projectRootPath);
    if (!repository) continue;
    unmatched.push({
      id: entry.id,
      name: entry.label,
      directory: entry.directory,
      repository,
      unread: !entry.githubRuntime && entry.workspaceKind !== "directory",
    });
  }
  return {
    workspaces,
    refs,
    unmatched,
    projects,
    directories: [...new Set([...prDirectories, ...projects.values()])],
  };
}

/**
 * The first workspace holding a pull request Paseo matched none to: on its branch, or with HEAD at
 * its head or last-reviewed commit. Paseo matches by branch alone, and agents detach HEAD to look
 * at a fetched head. A fork's branch name says nothing about this repository's branches.
 */
export function findHolder(
  unmatched: readonly UnmatchedWorkspace[],
  checkouts: Readonly<Record<string, Checkout>>,
  pr: PullRequestSummary,
): Workspace | null {
  const repository = pr.repository.nameWithOwner.toLowerCase();
  const reviewed = pr.viewerLatestReview?.commit?.oid;
  return (
    unmatched.find(({ id, repository: theirs }) => {
      const checkout = checkouts[id];
      if (theirs !== repository || checkout === undefined) return false;
      if (!pr.isCrossRepository && checkout.branch === pr.headRefName) return true;
      return checkout.head === pr.headRefOid || checkout.head === reviewed;
    }) ?? null
  );
}
