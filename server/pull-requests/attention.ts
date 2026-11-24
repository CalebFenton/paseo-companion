import { type PullRequest, type PullRequestSummary, pullRequestKey } from "./github";
import type { Workspace } from "./workspaces";

/** Merge states behind GitHub's green merge button; HAS_HOOKS is GitHub Enterprise's CLEAN. */
const MERGE_READY: Record<string, true> = { CLEAN: true, HAS_HOOKS: true };
/** Reviews that ask something of the author; approvals and dismissals do not. */
const FEEDBACK_STATES: Record<string, true> = { CHANGES_REQUESTED: true, COMMENTED: true };
/** Check rollups that fail: a check failed, or one errored. */
const CHECKS_FAILING: Record<string, true> = { FAILURE: true, ERROR: true };
/** Repository permissions that can merge; elsewhere merging is the maintainers' move. */
const MERGE_PERMISSIONS: Record<string, true> = { ADMIN: true, MAINTAIN: true, WRITE: true };

const keyOf = (pr: PullRequestSummary) => pullRequestKey(pr.repository.nameWithOwner, pr.number);

/** What a pull request needs from the viewer. */
export type Attention =
  /** The viewer's pull request has feedback newer than their last push, comment, or review. */
  | { kind: "respond"; openThreads: number; newReviews: number; newComments: number }
  /** Someone else's pull request changed since the viewer reviewed it; `authorReplies` counts the author's reviews and comments. */
  | { kind: "rereview"; newCommits: boolean; authorReplies: number; requested: boolean }
  /** Someone else's pull request the viewer has not reviewed. */
  | { kind: "review" }
  /** The viewer's pull request, and GitHub's merge button is green, into the branch it is meant to land on. */
  | { kind: "merge" }
  /** The viewer's own pull request, out of draft, whose latest commit fails its checks. */
  | { kind: "checks" }
  /** The viewer's own approved pull request GitHub will not merge yet; DRAFT for drafts. */
  | { kind: "approved"; mergeState: string }
  /**
   * The viewer's own pull request nothing else lists: in no Paseo workspace, or ready with no
   * person reviewing it or asked to. `draft`: nobody reviews it yet, so it is never `unasked`.
   */
  | { kind: "stuck"; untracked: boolean; unasked: boolean; draft: boolean };

export interface Assessed {
  /** The Paseo workspace holding it; null for a review request none holds. */
  workspace: Workspace | null;
  pr: PullRequestSummary;
  approved: boolean;
  mergeable: boolean;
  /** Its place among pull requests targeting each other's branches; null when it stands alone. */
  stack: {
    /** The pull request whose branch this one targets: OPEN, or MERGED or CLOSED when this one needs retargeting. */
    below: { number: number; state: string } | null;
    /** Listed pull requests targeting this one's branch. */
    above: number[];
    /** Where the forge lands stacks whole: the layers below that merging this one lands too, lowest first. */
    landsWith: number[];
  } | null;
  /** Null when it needs nothing from the viewer, such as their own waiting on asked reviewers. */
  attention: Attention | null;
}

/** Feedback on the viewer's pull request newer than their last commit, push, comment, or review. */
function feedback(pr: PullRequest, viewer: string): Attention | null {
  const items = pr.timelineItems.nodes;
  let lastOwn = Math.max(0, ...pr.commits.nodes.map(({ commit }) => Date.parse(commit.committedDate)));
  for (const item of items) {
    const own = item.__typename === "HeadRefForcePushedEvent" ? item.actor?.login === viewer : item.viewerDidAuthor;
    const at = item.__typename === "PullRequestReview" ? item.submittedAt : item.createdAt;
    if (own && at !== null) lastOwn = Math.max(lastOwn, Date.parse(at));
  }
  let newReviews = 0;
  let newComments = 0;
  for (const item of items) {
    if (item.__typename === "HeadRefForcePushedEvent" || item.viewerDidAuthor || item.author?.__typename === "Bot") {
      continue;
    }
    if (item.__typename === "IssueComment") {
      if (Date.parse(item.createdAt) > lastOwn) newComments += 1;
    } else if (FEEDBACK_STATES[item.state] && item.submittedAt !== null && Date.parse(item.submittedAt) > lastOwn) {
      newReviews += 1;
    }
  }
  const openThreads = pr.reviewThreads.nodes.filter(
    (thread) => !thread.isResolved && thread.comments.nodes.at(-1)?.viewerDidAuthor === false,
  ).length;
  return openThreads + newReviews + newComments > 0 ? { kind: "respond", openThreads, newReviews, newComments } : null;
}

/**
 * Where nothing else lists the viewer's own pull request, whether nobody would find or review it:
 * no Paseo workspace holds it, or it is ready and no person reviewed it or is asked to. Bots, such
 * as Copilot, are not reviewers.
 */
function stuck(pr: PullRequest, workspace: Workspace | null): Attention | null {
  const reviewed =
    pr.latestOpinionatedReviews.nodes.length > 0 ||
    pr.timelineItems.nodes.some(
      (item) => item.__typename === "PullRequestReview" && !item.viewerDidAuthor && item.author?.__typename !== "Bot",
    );
  // A reviewer the viewer may not see is still someone asked.
  const asked = pr.reviewRequests.nodes.some(({ requestedReviewer }) => requestedReviewer?.__typename !== "Bot");
  const untracked = workspace === null;
  const unasked = !pr.isDraft && !reviewed && !asked;
  return untracked || unasked ? { kind: "stuck", untracked, unasked, draft: pr.isDraft } : null;
}

/**
 * Someone else's pull request: not reviewed yet, or changed since the viewer's latest review.
 * `requested`: GitHub asks the viewer, or a team of theirs, for a review.
 */
function reviewerAttention(pr: PullRequestSummary, requested: boolean): Attention | null {
  const review = pr.viewerLatestReview;
  // A pending review has no submittedAt yet.
  if (!review?.submittedAt) return { kind: "review" };
  const since = Date.parse(review.submittedAt);
  const author = pr.author?.login;
  const authorReplies = pr.timelineItems.nodes.filter((item) => {
    if (author === undefined || item.__typename === "HeadRefForcePushedEvent" || item.author?.login !== author) {
      return false;
    }
    const at = item.__typename === "PullRequestReview" ? item.submittedAt : item.createdAt;
    return at !== null && Date.parse(at) > since;
  }).length;
  const newCommits = review.commit?.oid !== pr.headRefOid;
  // GitHub drops the viewer's review request once they review; another one is a new ask.
  return newCommits || authorReplies > 0 || requested ? { kind: "rereview", newCommits, authorReplies, requested } : null;
}

/**
 * GitHub's review decision where branch protection requires reviews; elsewhere, a reviewer with
 * write access approved and none asks for changes.
 */
function isApproved(pr: PullRequestSummary): boolean {
  if (pr.reviewDecision !== null) return pr.reviewDecision === "APPROVED";
  const opinions = new Set(pr.latestOpinionatedReviews.nodes.map((review) => review.state));
  return opinions.has("APPROVED") && !opinions.has("CHANGES_REQUESTED");
}

/**
 * Where the forge lands a stack whole, as GitHub's own stacks do, merging a layer lands every open
 * layer below it. The open layers that merge now, lowest first: each one with every layer below it
 * mergeable. Null outside such a stack.
 */
function landableLayers(pr: PullRequestSummary): number[] | null {
  if (!pr.stack) return null;
  const layers = pr.stack.entries.nodes
    .flatMap(({ position, pullRequest }) => (pullRequest?.state === "OPEN" ? [{ position, ...pullRequest }] : []))
    .toSorted((a, b) => a.position - b.position);
  const landable: number[] = [];
  for (const layer of layers) {
    if (layer.isDraft || !MERGE_READY[layer.mergeStateStatus]) break;
    landable.push(layer.number);
  }
  return landable;
}

/**
 * The viewer's own pull request: feedback first, then merging it, fixing its checks out of draft,
 * unblocking it once approved, and last bringing it into Paseo or asking for its review.
 * `landsHigher`: a higher layer of its stack lands it, so that layer's row offers the merge.
 */
function authorAttention(
  pr: PullRequest,
  {
    viewer,
    workspace,
    approved,
    mergeable,
    landsHigher,
  }: { viewer: string; workspace: Workspace | null; approved: boolean; mergeable: boolean; landsHigher: boolean },
): Attention | null {
  const canMerge = MERGE_PERMISSIONS[pr.repository.viewerPermission ?? ""] === true;
  const feedbackNeeded = feedback(pr, viewer);
  if (feedbackNeeded) return feedbackNeeded;
  if (canMerge && mergeable) return { kind: "merge" };
  if (!pr.isDraft && CHECKS_FAILING[pr.commits.nodes.at(-1)?.commit.statusCheckRollup?.state ?? ""]) return { kind: "checks" };
  if (canMerge && approved && !landsHigher) return { kind: "approved", mergeState: pr.isDraft ? "DRAFT" : pr.mergeStateStatus };
  return stuck(pr, workspace);
}

export interface WorkspaceRead {
  workspace: Workspace;
  /** Null when GitHub returned nothing for it. */
  pr: PullRequest | null;
}

/** A pull request a search found, and a workspace Paseo did not match to it, found by its branch or HEAD commit. */
export interface Found<T> {
  pr: T;
  workspace: Workspace | null;
}

/**
 * The open pull requests of the workspaces, in workspace order, then the viewer's own in none of
 * those, then the review requests in none of those; with what each needs from the viewer. Once
 * nothing else does, the viewer is needed to merge their own pull requests GitHub would merge, to
 * fix the checks failing on their own out of draft, to unblock their own approved ones, and to
 * bring their own into Paseo or ask for its review; merging someone else's is the author's move,
 * and merging one into a repository the viewer cannot write to is the maintainers'.
 *
 * A stacked pull request targets another one's branch, whatever tool stacked it. It lands after
 * that one, so GitHub letting it merge into that branch does not count. Where the forge lands
 * stacks whole, merging the highest landable layer lands the ones below it too, so it alone is
 * offered. Stacks are reviewed and landed bottom up, so listed layers of one stack sit together,
 * lowest first, where its first-listed layer was.
 */
export function assess(
  viewer: string,
  reads: readonly WorkspaceRead[],
  authored: readonly Found<PullRequest>[],
  reviewRequests: readonly Found<PullRequestSummary>[],
): Assessed[] {
  const requested = new Set(reviewRequests.map(({ pr }) => keyOf(pr)));
  const listed = new Set(reads.flatMap(({ pr }) => (pr ? [keyOf(pr)] : [])));
  const own = authored.filter(({ pr }) => !listed.has(keyOf(pr)));
  for (const { pr } of own) listed.add(keyOf(pr));
  const candidates: { workspace: Workspace | null; pr: PullRequest | PullRequestSummary }[] = [
    ...reads.flatMap(({ workspace, pr }) => (pr ? [{ workspace, pr }] : [])),
    ...own,
    ...reviewRequests.filter(({ pr }) => !listed.has(keyOf(pr))),
  ];
  const open = candidates.flatMap(({ workspace, pr }) => {
    // Search lags a moment behind merges and closes.
    if (pr.state !== "OPEN") return [];
    // The pull request whose branch this one targets, open or since landed. The default branch can
    // head a pull request too, such as a release, without anything stacking on it; so can a
    // protected long-lived branch, such as develop after a release into main.
    const longLived =
      pr.baseRefName === pr.repository.defaultBranchRef?.name ||
      (pr.baseRef !== null && (pr.baseRef.refUpdateRule !== null || pr.baseRef.rules.totalCount > 0));
    const below = longLived ? null : (pr.baseRef?.associatedPullRequests.nodes[0] ?? null);
    return [{ workspace, pr, below }];
  });
  const aboveByKey = new Map<string, number[]>();
  for (const { pr, below } of open) {
    if (below?.state !== "OPEN") continue;
    const key = pullRequestKey(pr.repository.nameWithOwner, below.number);
    const above = aboveByKey.get(key);
    if (above) above.push(pr.number);
    else aboveByKey.set(key, [pr.number]);
  }
  const byKey = new Map(open.map((entry) => [keyOf(entry.pr), entry]));
  const placed = open.map((entry, index) => {
    let root = entry;
    let depth = 0;
    // Bounded: a branch cannot target itself, but GitHub's answer is not ours to trust.
    while (root.below?.state === "OPEN" && depth < open.length) {
      const next = byKey.get(pullRequestKey(root.pr.repository.nameWithOwner, root.below.number));
      if (!next) break;
      root = next;
      depth += 1;
    }
    return { entry, index, root, depth };
  });
  const firstIndex = new Map<(typeof open)[number], number>();
  for (const { index, root } of placed) if (!firstIndex.has(root)) firstIndex.set(root, index);
  placed.sort((a, b) => (firstIndex.get(a.root) ?? 0) - (firstIndex.get(b.root) ?? 0) || a.depth - b.depth);
  return placed.flatMap(({ entry: { workspace, pr, below } }) => {
    const approved = isApproved(pr);
    const landable = landableLayers(pr);
    const mergeable = landable ? landable.at(-1) === pr.number : !pr.isDraft && MERGE_READY[pr.mergeStateStatus] === true && below === null;
    const landsHigher = landable !== null && landable.includes(pr.number) && !mergeable;
    // Only the viewer's own pull requests carry review threads; review requests are never theirs.
    const attention =
      "reviewThreads" in pr && pr.viewerDidAuthor
        ? authorAttention(pr, { viewer, workspace, approved, mergeable, landsHigher })
        : reviewerAttention(pr, pr.viewerLatestReviewRequest !== null || requested.has(keyOf(pr)));
    // Only a workspace's badge shows a pull request needing nothing.
    if (!attention && !workspace) return [];
    const above = aboveByKey.get(keyOf(pr)) ?? [];
    const landsWith = landable && mergeable ? landable.slice(0, -1) : [];
    return [
      {
        workspace,
        pr,
        approved,
        mergeable,
        stack: below || above.length > 0 || landsWith.length > 0 ? { below, above, landsWith } : null,
        attention,
      },
    ];
  });
}
