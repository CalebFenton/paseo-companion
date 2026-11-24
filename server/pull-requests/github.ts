import { z } from "zod";
import type { PullRequestRef } from "../../shared/pull-requests";
import type { GitHubQuery } from "../gh";

/** Pull requests each search reads per poll, most recently updated first. */
const SEARCH_LIMIT = 50;
/** Pull requests per query: GitHub abandons a query after about 10 seconds (502 or a cut-off body); 15 keeps a batch well under. */
const REFS_PER_QUERY = 15;
const UNEXPECTED_SHAPE = "GitHub answered in an unexpected shape";

/**
 * Which pull requests a batch reads: review requests or the viewer's own, each found by a search of
 * the same id, or the workspaces' own.
 */
const batchKindSchema = z.enum(["reviewRequests", "authored", "workspaces"]);
export type BatchKind = z.infer<typeof batchKindSchema>;
type SearchKind = Exclude<BatchKind, "workspaces">;

/** Each search's qualifier: GitHub's "Review requests" list, asking the viewer or a team of theirs, and the viewer's own. */
const SEARCHES: Record<SearchKind, string> = { reviewRequests: "review-requested:@me", authored: "author:@me" };

/** Query id of the batch asking for the pull request at `index` of its kind. */
const batchId = (kind: BatchKind, index: number) => `${kind}-${Math.floor(index / REFS_PER_QUERY)}`;
/** GraphQL alias of the workspace ref at `index` within its batch. */
const aliasOf = (index: number) => `p${index}`;

/**
 * GitHub's own stacked pull requests, in public preview since July 2026: every layer up to the one
 * merged lands together, held to the trunk's rules. Servers without them reject these fields.
 */
const NATIVE_STACK_FIELDS = `
  stack { entries(first: 20) { nodes { position pullRequest { number state isDraft mergeStateStatus } } } }`;

/**
 * Fields every listed pull request needs; the viewer-specific ones serve a reviewer's attention,
 * the head branch and commit find a workspace Paseo did not match.
 */
function summaryFields(nativeStacks: boolean): string {
  return `
fragment Summary on PullRequest {${nativeStacks ? NATIVE_STACK_FIELDS : ""}
  state
  url
  number
  title
  createdAt
  repository { nameWithOwner viewerPermission defaultBranchRef { name } }
  baseRefName
  baseRef {
    refUpdateRule { pattern }
    rules(first: 0) { totalCount }
    associatedPullRequests(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number state } }
  }
  headRefName
  headRefOid
  isCrossRepository
  isDraft
  mergeStateStatus
  reviewDecision
  latestOpinionatedReviews(first: 20, writersOnly: true) { nodes { state viewerDidAuthor } }
  viewerDidAuthor
  author { __typename login }
  viewerLatestReview { state submittedAt commit { oid } }
  viewerLatestReviewRequest { id }
  timelineItems(last: 50, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT, PULL_REQUEST_REVIEW, ISSUE_COMMENT]) {
    nodes {
      __typename
      ... on HeadRefForcePushedEvent { createdAt actor { __typename login } }
      ... on PullRequestReview { state submittedAt viewerDidAuthor author { __typename login } }
      ... on IssueComment { createdAt viewerDidAuthor author { __typename login } }
    }
  }
}`;
}

/**
 * The viewer's own pull requests, a workspace's or found by the search, add what the author's
 * attention needs: review threads, the last commit and its checks, and who is asked to review.
 * The threads' comments are most of the query's cost.
 */
const WORKSPACE_FIELDS = `
fragment Workspace on PullRequest {
  ...Summary
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename } } }
  reviewThreads(first: 50) {
    nodes { isResolved comments(last: 1) { nodes { viewerDidAuthor } } }
  }
}`;

/**
 * Open pull requests matching the search's qualifier. Ids only, and where they are to skip the
 * workspaces' own: with every pull request's fields the search outlasts GitHub's time limit, so
 * they are read after it in batches.
 */
const searchQuery = (kind: SearchKind) => `query PaseoSearch {
  viewer { login }
  ${kind}: search(type: ISSUE, first: ${SEARCH_LIMIT}, query: "is:pr is:open archived:false ${SEARCHES[kind]} sort:updated-desc") {
    nodes { ... on PullRequest { id number repository { nameWithOwner } } }
  }
}`;

/** Deleted accounts come back as null. */
const actorSchema = z.object({ __typename: z.string(), login: z.string() }).nullable();

const timelineItemSchema = z.discriminatedUnion("__typename", [
  z.object({ __typename: z.literal("HeadRefForcePushedEvent"), createdAt: z.string(), actor: actorSchema }),
  z.object({
    __typename: z.literal("PullRequestReview"),
    state: z.string(),
    /** Null while the review is pending. */
    submittedAt: z.string().nullable(),
    viewerDidAuthor: z.boolean(),
    author: actorSchema,
  }),
  z.object({
    __typename: z.literal("IssueComment"),
    createdAt: z.string(),
    viewerDidAuthor: z.boolean(),
    author: actorSchema,
  }),
]);

const summarySchema = z.object({
  state: z.string(),
  url: z.string(),
  number: z.number(),
  title: z.string(),
  createdAt: z.string(),
  repository: z.object({
    nameWithOwner: z.string(),
    /** Null where GitHub will not say. */
    viewerPermission: z.string().nullable(),
    defaultBranchRef: z.object({ name: z.string() }).nullable(),
  }),
  baseRefName: z.string(),
  /**
   * Null once the base branch is deleted. Its pull requests are the ones it is the head of, latest
   * first. A protection rule or ruleset on it marks a long-lived branch, such as develop, not a stack layer.
   */
  baseRef: z
    .object({
      refUpdateRule: z.object({ pattern: z.string() }).nullable(),
      rules: z.object({ totalCount: z.number() }),
      associatedPullRequests: z.object({ nodes: z.array(z.object({ number: z.number(), state: z.string() })) }),
    })
    .nullable(),
  /** GitHub's own stack, if the pull request is in one: its layers, position 1 nearest the trunk. Absent where unsupported. */
  stack: z
    .object({
      entries: z.object({
        nodes: z.array(
          z.object({
            position: z.number(),
            pullRequest: z.object({ number: z.number(), state: z.string(), isDraft: z.boolean(), mergeStateStatus: z.string() }).nullable(),
          }),
        ),
      }),
    })
    .nullish(),
  headRefName: z.string(),
  headRefOid: z.string(),
  /** From a fork: its branch name says nothing about branches in this repository. */
  isCrossRepository: z.boolean(),
  isDraft: z.boolean(),
  mergeStateStatus: z.string(),
  /** Null where branch protection requires no review. */
  reviewDecision: z.string().nullable(),
  /** Each reviewer's latest approval or change request. */
  latestOpinionatedReviews: z.object({ nodes: z.array(z.object({ state: z.string(), viewerDidAuthor: z.boolean() })) }),
  viewerDidAuthor: z.boolean(),
  author: actorSchema,
  viewerLatestReview: z
    .object({ state: z.string(), submittedAt: z.string().nullable(), commit: z.object({ oid: z.string() }).nullable() })
    .nullable(),
  viewerLatestReviewRequest: z.object({ id: z.string() }).nullable(),
  timelineItems: z.object({ nodes: z.array(timelineItemSchema) }),
});
export type PullRequestSummary = z.infer<typeof summarySchema>;

const pullRequestSchema = summarySchema.extend({
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          committedDate: z.string(),
          /** Every check and status on the commit together: SUCCESS, PENDING, FAILURE, ERROR, or EXPECTED; null without any. */
          statusCheckRollup: z.object({ state: z.string() }).nullable(),
        }),
      }),
    ),
  }),
  /** Null for a reviewer the viewer may not see. */
  reviewRequests: z.object({ nodes: z.array(z.object({ requestedReviewer: z.object({ __typename: z.string() }).nullable() })) }),
  reviewThreads: z.object({
    nodes: z.array(
      z.object({ isResolved: z.boolean(), comments: z.object({ nodes: z.array(z.object({ viewerDidAuthor: z.boolean() })) }) }),
    ),
  }),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

const responseSchema = z.object({
  data: z
    .object({ viewer: z.object({ login: z.string() }).optional() })
    .catchall(z.unknown())
    .nullish(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});
type Answer = NonNullable<z.infer<typeof responseSchema>["data"]>;

/** What the gh adapter answers for a query that failed outright. */
const failureSchema = z.object({ error: z.string() });

const aliasSchema = z.object({ pullRequest: pullRequestSchema.nullable() }).nullable();

/** Null when the search failed; `errors` says why. Nodes GitHub could not return are null, other kinds empty. */
const searchSchema = z
  .object({
    nodes: z.array(
      z
        .object({
          id: z.string().optional(),
          number: z.number().optional(),
          repository: z.object({ nameWithOwner: z.string() }).optional(),
        })
        .nullable(),
    ),
  })
  .nullable();

/** A batch of found pull requests, in the order of the ids asked; null where GitHub could not return one. */
const nodesSchema = z.array(z.unknown());

/** `items` in query-sized batches, each with its query id. */
function inBatches<T>(kind: BatchKind, items: readonly T[]): { id: string; items: T[] }[] {
  const batches: { id: string; items: T[] }[] = [];
  for (let start = 0; start < items.length; start += REFS_PER_QUERY) {
    batches.push({ id: batchId(kind, start), items: items.slice(start, start + REFS_PER_QUERY) });
  }
  return batches;
}

/**
 * What to ask GitHub first, all at once: each search, and the refs in batches, each a query of its
 * own so one failing keeps the rest.
 */
export function pullRequestQueries(
  refs: readonly PullRequestRef[],
  nativeStacks: boolean,
): { searches: GitHubQuery[]; workspaces: GitHubQuery[] } {
  const aliases = refs.map(
    ({ owner, repo, number }, index) =>
      `${aliasOf(index)}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { pullRequest(number: ${number}) { ...Workspace } }`,
  );
  return {
    searches: (["reviewRequests", "authored"] as const).map((kind) => ({ id: kind, query: searchQuery(kind) })),
    workspaces: inBatches("workspaces", aliases).map(({ id, items }) => ({
      id,
      query: `query PaseoWorkspacePullRequests {\n  viewer { login }\n  ${items.join("\n  ")}\n}\n${summaryFields(nativeStacks)}\n${WORKSPACE_FIELDS}`,
    })),
  };
}

/** One pull request's identity in a set or map; GitHub matches owners and names in any case. */
export const pullRequestKey = (repository: string, number: number) => `${repository}#${number}`.toLowerCase();

/**
 * The node ids the search found, as it answered them; null when it answered in an unexpected shape.
 * The viewer's own skip the refs, read already; review requests keep them, as the search alone
 * knows of a team's request.
 */
function foundIds(answers: Readonly<Record<string, unknown>>, kind: SearchKind, refs: readonly PullRequestRef[]): string[] | null {
  const response = responseSchema.safeParse(answers[kind]);
  const search = searchSchema.safeParse(response.data?.data?.[kind] ?? null);
  if (!search.success) return null;
  const read = new Set(kind === "authored" ? refs.map(({ owner, repo, number }) => pullRequestKey(`${owner}/${repo}`, number)) : []);
  return (search.data?.nodes ?? []).flatMap((node) =>
    node?.id && !(node.repository && node.number !== undefined && read.has(pullRequestKey(node.repository.nameWithOwner, node.number)))
      ? [node.id]
      : [],
  );
}

/**
 * What to ask GitHub once the searches answered: what they found, in batches run at once. Someone
 * else's stack is theirs to land, so review requests skip GitHub's stack layers, the slowest part.
 */
export function foundQueries(
  answers: Readonly<Record<string, unknown>>,
  refs: readonly PullRequestRef[],
  nativeStacks: boolean,
): GitHubQuery[] {
  return [
    ...inBatches("reviewRequests", foundIds(answers, "reviewRequests", refs) ?? []).map(({ id, items }) => ({
      id,
      query: `query PaseoReviewRequests {\n  nodes(ids: ${JSON.stringify(items)}) { ... on PullRequest { ...Summary } }\n}\n${summaryFields(false)}`,
    })),
    ...inBatches("authored", foundIds(answers, "authored", refs) ?? []).map(({ id, items }) => ({
      id,
      query: `query PaseoAuthoredPullRequests {\n  nodes(ids: ${JSON.stringify(items)}) { ... on PullRequest { ...Workspace } }\n}\n${summaryFields(nativeStacks)}\n${WORKSPACE_FIELDS}`,
    })),
  ];
}

/** Something GitHub could not answer: the raw reason, and which kind of pull request it leaves out. */
interface Problem {
  kind: BatchKind;
  detail: string;
}

export interface GitHubRead {
  /** Null when no query was answered. */
  viewer: string | null;
  /** By ref, in the order asked; null where GitHub returned none. */
  pullRequests: (PullRequest | null)[];
  /** Open pull requests awaiting the viewer's review, most recently updated first. */
  reviewRequests: PullRequestSummary[];
  /** The viewer's open pull requests outside the refs, most recently updated first. */
  authored: PullRequest[];
  problems: Problem[];
}

/** Reads the raw answers, by query id, to `pullRequestQueries(refs, …)` and `foundQueries`. */
export function readAnswers(refs: readonly PullRequestRef[], answers: Readonly<Record<string, unknown>>): GitHubRead {
  const problems: Problem[] = [];
  let viewer: string | null = null;
  const data: Record<string, Answer | null> = {};
  for (const [id, answer] of Object.entries(answers)) {
    const kind = batchKindSchema.parse(id.split("-")[0]);
    const failure = failureSchema.safeParse(answer);
    if (failure.success) {
      problems.push({ kind, detail: failure.data.error });
      data[id] = null;
      continue;
    }
    const response = responseSchema.safeParse(answer);
    if (response.success) {
      const { data: answered, errors = [] } = response.data;
      problems.push(...errors.map((error) => ({ kind, detail: error.message })));
      if (!answered && errors.length === 0) problems.push({ kind, detail: "GitHub returned no data" });
      viewer ??= answered?.viewer?.login ?? null;
    } else problems.push({ kind, detail: UNEXPECTED_SHAPE });
    data[id] = response.data?.data ?? null;
  }

  /** What the search of `kind` found, read by `schema`. */
  const found = <T>(kind: SearchKind, schema: z.ZodType<T>): T[] => {
    const ids = foundIds(answers, kind, refs);
    if (!ids) problems.push({ kind, detail: UNEXPECTED_SHAPE });
    return (ids ?? []).flatMap((_, index) => {
      const batch = nodesSchema.safeParse(data[batchId(kind, index)]?.["nodes"]);
      // A failed batch is reported above.
      const node = batch.success ? batch.data[index % REFS_PER_QUERY] : null;
      if (node === null || node === undefined) return [];
      const pr = schema.safeParse(node);
      if (pr.success) return [pr.data];
      problems.push({ kind, detail: "GitHub answered one in an unexpected shape" });
      return [];
    });
  };
  const reviewRequests = found("reviewRequests", summarySchema);
  const authored = found("authored", pullRequestSchema);

  const pullRequests = refs.map(({ owner, repo, number }, index) => {
    const batch = data[batchId("workspaces", index)];
    if (!batch) return null;
    const alias = aliasSchema.safeParse(batch[aliasOf(index)]);
    if (alias.success) return alias.data?.pullRequest ?? null;
    problems.push({ kind: "workspaces", detail: `GitHub answered ${owner}/${repo}#${number} in an unexpected shape` });
    return null;
  });
  return { viewer, pullRequests, reviewRequests, authored, problems };
}
