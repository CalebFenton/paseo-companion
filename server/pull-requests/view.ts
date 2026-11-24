import { countdown, joinParts, plural } from "../../shared/format";
import type { CheckOutTarget, PullRequestBadge, PullRequestRow, PullRequestSectionId, PullRequestsView } from "../../shared/pull-requests";
import { type Assessed, type Attention, assess } from "./attention";
import { type BatchKind, type PullRequestSummary, readAnswers } from "./github";
import { type Checkout, findHolder, type WorkspacePlan } from "./workspaces";

/**
 * Most actionable first: the viewer's own approved work, then feedback, then others' asks, then
 * what needs nothing from the viewer; each assessed pull request belongs to exactly one. A queue
 * lists the longest waiting first and folds bots' pull requests, such as dependency updates, behind
 * one row. A section with `aside` needs nothing from the viewer: the summary counts it apart.
 */
const SECTIONS: readonly {
  id: PullRequestSectionId;
  title: string;
  queue: boolean;
  aside?: (count: number) => string;
  has: (item: Assessed) => boolean;
}[] = [
  { id: "merge", title: "Ready to merge", queue: false, has: ({ attention }) => attention?.kind === "merge" },
  { id: "approved", title: "Approved, can't merge yet", queue: false, has: ({ attention }) => attention?.kind === "approved" },
  { id: "respond", title: "Respond", queue: false, has: ({ attention }) => attention?.kind === "respond" },
  { id: "checks", title: "Fix checks", queue: false, has: ({ attention }) => attention?.kind === "checks" },
  { id: "stuck", title: "Stuck", queue: true, has: ({ attention }) => attention?.kind === "stuck" },
  { id: "rereview", title: "Re-review", queue: false, has: ({ attention, approved }) => attention?.kind === "rereview" && !approved },
  { id: "review", title: "Review", queue: true, has: ({ attention, approved }) => attention?.kind === "review" && !approved },
  // Others approved it: the viewer's review is optional.
  {
    id: "optional",
    title: "Approved without you",
    queue: false,
    aside: (count) => `${count} approved without you`,
    has: ({ attention, approved }) => (attention?.kind === "review" || attention?.kind === "rereview") && approved,
  },
  // A workspace's pull request needing nothing from the viewer: their own waiting on reviewers, or one they reviewed.
  {
    id: "waiting",
    title: "Waiting on others",
    queue: true,
    aside: (count) => `${count} waiting on others`,
    has: ({ attention }) => attention === null,
  },
];

/** Why GitHub will not merge an approved pull request yet, by its merge state; CLEAN ones wait on the stack below. */
const MERGE_BLOCKERS: Record<string, string> = {
  BEHIND: "behind its base branch",
  BLOCKED: "waiting on required checks or reviews",
  DIRTY: "has merge conflicts",
  DRAFT: "still a draft",
  UNSTABLE: "checks failing",
  UNKNOWN: "GitHub is still checking",
};

/** Each kind of pull request a read asks for: its name in a problem, and what a failed read leaves out. */
const KINDS: Record<BatchKind, { label: string; missing: string }> = {
  reviewRequests: { label: "Review requests", missing: "some review requests" },
  authored: { label: "Your pull requests", missing: "some of your pull requests" },
  workspaces: { label: "Workspace pull requests", missing: "some of your workspaces' pull requests" },
};

/** A workspace badge by what its pull request needs; others' that others approved say so instead. */
const BADGES: Record<Attention["kind"], Pick<PullRequestBadge, "label" | "tone">> = {
  respond: { label: "reply", tone: "danger" },
  merge: { label: "merge", tone: "success" },
  checks: { label: "checks failing", tone: "danger" },
  approved: { label: "approved", tone: "warning" },
  stuck: { label: "no reviewer", tone: "warning" },
  rereview: { label: "re-review", tone: "info" },
  review: { label: "review", tone: "info" },
};

/**
 * The viewer's standing review of someone else's pull request: their latest approval or change
 * request, else their latest review, such as a comment or a reply in a thread.
 */
const VERDICTS: Record<string, string> = {
  APPROVED: "you approved",
  CHANGES_REQUESTED: "you want changes",
  COMMENTED: "you commented",
  DISMISSED: "your review dismissed",
};

/** How long it has been open, in its largest unit: "132d", not "132d 18h". */
function age(pr: PullRequestSummary, now: number): string {
  return countdown(now - Date.parse(pr.createdAt), { largest: true });
}

/** What a pull request needing nothing from the viewer waits on: "draft", "waiting 3d" on asked reviewers. */
function quiet({ approved, pr }: Assessed, now: number): string {
  if (!pr.viewerDidAuthor) {
    const opinion = pr.latestOpinionatedReviews.nodes.find((review) => review.viewerDidAuthor)?.state;
    return VERDICTS[opinion ?? pr.viewerLatestReview?.state ?? ""] ?? "you reviewed";
  }
  if (pr.isDraft) return "draft";
  return approved ? "approved" : `waiting ${age(pr, now)}`;
}

/**
 * Why the item is listed: "2 open threads · 1 new review", "new commits · asked again", "waiting
 * 3d". Others' approved pull requests have a section of their own, so only the viewer's own say "approved".
 */
function reasons(item: Assessed, now: number): (string | null)[] {
  const { attention, approved, pr } = item;
  const approval = approved ? "approved" : null;
  if (attention === null) return [quiet(item, now)];
  switch (attention.kind) {
    case "respond":
      return [
        attention.openThreads > 0 ? plural(attention.openThreads, "open thread") : null,
        attention.newReviews > 0 ? plural(attention.newReviews, "new review") : null,
        attention.newComments > 0 ? plural(attention.newComments, "new comment") : null,
        approval,
      ];
    case "rereview":
      return [
        attention.newCommits ? "new commits" : null,
        attention.authorReplies > 0 ? plural(attention.authorReplies, "reply", "replies") : null,
        attention.requested ? "asked again" : null,
      ];
    case "review":
      return [`waiting ${age(pr, now)}`];
    case "stuck":
      return [
        attention.untracked ? "not in Paseo" : null,
        attention.unasked ? `no reviewer asked for ${age(pr, now)}` : null,
        attention.draft ? "draft" : null,
      ];
    case "merge":
      return [approval];
    case "checks":
      return ["checks failing", approval];
    case "approved":
      return [MERGE_BLOCKERS[attention.mergeState] ?? null];
  }
}

function badge(item: Assessed, section: PullRequestSectionId, detail: string, now: number): PullRequestBadge {
  const { attention } = item;
  if (attention === null) return { label: quiet(item, now), tone: "muted", section, detail };
  if (section === "optional") return { label: "others approved", tone: "muted", section, detail };
  return { ...BADGES[attention.kind], section, detail };
}

/** Its place in a stack: the layer below, or those it lands, and the layers above. */
function stackParts(stack: Assessed["stack"]): (string | null)[] {
  if (stack === null) return [];
  const { below, above, landsWith } = stack;
  let lower: string | null = null;
  if (landsWith.length > 0) lower = `lands ${landsWith.map((number) => `↓#${number}`).join(" ")}`;
  else if (below?.state === "OPEN") lower = `↓#${below.number}`;
  else if (below) lower = `↓#${below.number} was ${below.state === "MERGED" ? "merged" : "closed"}; pick a new base branch`;
  return [lower, above.length > 0 ? above.map((number) => `↑#${number}`).join(" ") : null];
}

function rowOf(item: Assessed, projects: ReadonlyMap<string, string>, now: number): PullRequestRow {
  const { workspace, pr } = item;
  const author = pr.viewerDidAuthor ? null : (pr.author?.login ?? null);
  const { nameWithOwner } = pr.repository;
  const slash = nameWithOwner.indexOf("/");
  const repo = nameWithOwner.slice(slash + 1);
  const checkOut: CheckOutTarget | null =
    workspace === null && projects.has(nameWithOwner.toLowerCase())
      ? { pullRequest: { owner: nameWithOwner.slice(0, slash), repo, number: pr.number }, title: `#${pr.number} ${pr.title}` }
      : null;
  return {
    key: workspace?.id ?? pr.url,
    title: workspace?.name ?? pr.title,
    // The owner repeats on every row, so the repository goes by its name.
    subtitle: joinParts([
      ...reasons(item, now),
      ...stackParts(item.stack),
      author ? `by ${author}` : null,
      workspace ? `#${pr.number}` : `${repo}#${pr.number}`,
    ]),
    approval: item.approved ? (item.mergeable ? "ready" : "approved") : null,
    workspaceId: workspace?.id ?? null,
    checkOut,
    repository: nameWithOwner,
    url: pr.url,
  };
}

export interface PullRequestsInput {
  plan: WorkspacePlan;
  /** Checkouts of the plan's unmatched workspaces, by workspace id; absent where git could not say. */
  checkouts: Readonly<Record<string, Checkout>>;
  /**
   * gh's answers by query id, `{ error }` where one failed outright: to `pullRequestQueries` for
   * the planned refs, and to `foundQueries` for its searches' answers.
   */
  answers: Readonly<Record<string, unknown>>;
  /** Epoch milliseconds that waiting times count to. */
  now: number;
}

export interface PullRequestsRead {
  view: PullRequestsView;
  /** Paseo had not read every workspace yet: worth reading again soon. */
  readSoon: boolean;
}

/** Every assessed pull request, worded for display, those needing the viewer first; a failure when GitHub answered nothing. */
export function buildPullRequestsView({ plan, checkouts, answers, now }: PullRequestsInput): PullRequestsRead | { failure: string } {
  const read = readAnswers(plan.refs, answers);
  const problems = read.problems.map(({ kind, detail }) => `${KINDS[kind].label}: ${detail}`).join("; ");
  if (read.viewer === null) return { failure: problems || "GitHub answered nothing" };
  const assessed = assess(
    read.viewer,
    plan.workspaces.map((workspace) => ({ workspace, pr: read.pullRequests[workspace.ref] ?? null })),
    read.authored.map((pr) => ({ pr, workspace: findHolder(plan.unmatched, checkouts, pr) })),
    read.reviewRequests.map((pr) => ({ pr, workspace: findHolder(plan.unmatched, checkouts, pr) })),
  );
  const grouped = SECTIONS.flatMap(({ id, title, queue, aside, has }) => {
    const items = assessed.filter((item) => has(item));
    if (items.length === 0) return [];
    // A stack's lower layers are usually its older ones, so they still lead.
    if (queue) items.sort((a, b) => Date.parse(a.pr.createdAt) - Date.parse(b.pr.createdAt));
    const shown = items.map((item) => ({ item, bot: queue && item.pr.author?.__typename === "Bot", row: rowOf(item, plan.projects, now) }));
    const bots = shown.flatMap(({ bot, row }) => (bot ? [row] : []));
    const rows = shown.flatMap(({ bot, row }) => (bot ? [] : [row]));
    const section = { id, title, rows, folded: bots.length > 0 ? { title: plural(bots.length, "bot update"), rows: bots } : null };
    return [{ section, shown, aside }];
  });
  const sections = grouped.map(({ section }) => section);
  const needing = grouped.reduce((total, { shown, aside }) => total + (aside ? 0 : shown.length), 0);
  const asides = grouped.flatMap(({ shown, aside }) => (aside ? [aside(shown.length)] : []));
  // The most actionable pull request for a workspace speaks for it.
  const badges: Record<string, PullRequestBadge> = {};
  for (const { section, shown } of grouped) {
    for (const { item, row } of shown) if (item.workspace) badges[item.workspace.id] ??= badge(item, section.id, row.subtitle, now);
  }
  const holding = new Set([
    ...plan.workspaces.map(({ id }) => id),
    ...assessed.flatMap(({ workspace }) => (workspace ? [workspace.id] : [])),
  ]).size;
  // A directory git cannot read, such as one deleted under Paseo, is one Paseo will not read either.
  const unread = plan.unmatched.filter((workspace) => workspace.unread && checkouts[workspace.id] !== undefined).length;
  const missing = Object.entries(KINDS).flatMap(([kind, labels]) =>
    read.problems.some((problem) => problem.kind === kind) ? [labels.missing] : [],
  );
  return {
    view: {
      sections,
      badges,
      summary: joinParts([
        needing === 0 ? "Nothing needs you" : `${plural(needing, "pull request")} need${needing === 1 ? "s" : ""} you`,
        ...asides,
        holding > 0 ? `${plural(holding, "workspace")} with a pull request` : null,
        unread > 0 ? `Paseo is still reading ${plural(unread, "workspace")}` : null,
      ]),
      needing,
      ready: sections.find(({ id }) => id === "merge")?.rows.length ?? 0,
      error:
        missing.length > 0 ? { message: `Couldn't load ${missing.join(" and ")}. Trying again in a few minutes.`, detail: problems } : null,
    },
    readSoon: unread > 0,
  };
}
