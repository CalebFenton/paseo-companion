import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { foundQueries, pullRequestQueries } from "./github";
import { buildPullRequestsView, type PullRequestsInput } from "./view";
import { type Checkout, planWorkspaces, type WorkspacePlan } from "./workspaces";

/** Paseo's workspaces and projects, git's checkouts, and gh's answers, in the shapes they arrive in; see the scenarios each pull request title names. */
const input = z
  .object({
    workspaces: z.unknown(),
    projects: z.unknown(),
    checkouts: z.record(z.string(), z.object({ head: z.string(), branch: z.string().nullable() }) satisfies z.ZodType<Checkout>),
    answers: z.record(z.string(), z.unknown()),
    now: z.number(),
  })
  .parse(JSON.parse(readFileSync(new URL("../../fixtures/pull-requests.input.json", import.meta.url), "utf8")));
const plan = planWorkspaces(input.workspaces, input.projects);

/** An open pull request of the viewer's in acme/app into its default branch, with nothing on it yet; `fields` override. */
const pullRequest = (number: number, fields: Record<string, unknown> = {}) => ({
  stack: null,
  state: "OPEN",
  url: `https://github.com/acme/app/pull/${number}`,
  number,
  title: `Change ${number}`,
  createdAt: "2026-11-01T00:00:00Z",
  repository: { nameWithOwner: "acme/app", viewerPermission: "WRITE", defaultBranchRef: { name: "main" } },
  baseRefName: "main",
  baseRef: null,
  headRefName: `change-${number}`,
  headRefOid: `head${number}`,
  isCrossRepository: false,
  isDraft: false,
  mergeStateStatus: "BLOCKED",
  reviewDecision: null,
  latestOpinionatedReviews: { nodes: [] },
  viewerDidAuthor: true,
  author: { __typename: "User", login: "me" },
  viewerLatestReview: null,
  viewerLatestReviewRequest: null,
  timelineItems: { nodes: [] },
  commits: { nodes: [] },
  reviewRequests: { nodes: [] },
  reviewThreads: { nodes: [] },
  ...fields,
});

describe("buildPullRequestsView", () => {
  it("turns raw Paseo, git, and GitHub answers into the view", async () => {
    // The fixture answers exactly what the plan asks: the searches and the workspace batches, then
    // the batches of pull requests the searches found, and checkouts of these workspaces.
    const { searches, workspaces } = pullRequestQueries(plan.refs, true);
    expect([...searches, ...workspaces, ...foundQueries(input.answers, plan.refs, true)].map(({ id }) => id)).toEqual(
      Object.keys(input.answers),
    );
    expect(plan.unmatched.map(({ id }) => id)).toEqual(expect.arrayContaining(Object.keys(input.checkouts)));
    await expect(
      `${JSON.stringify(buildPullRequestsView({ plan, checkouts: input.checkouts, answers: input.answers, now: input.now }), null, 2)}\n`,
    ).toMatchFileSnapshot("../../fixtures/pull-requests.view.json");
  });

  it("fails when GitHub answered nothing", () => {
    expect(
      buildPullRequestsView({
        plan,
        checkouts: input.checkouts,
        now: input.now,
        answers: { reviewRequests: { error: "gh is not on the daemon's PATH" }, "workspaces-0": { error: "gh: HTTP 502" } },
      }),
    ).toEqual({ failure: "Review requests: gh is not on the daemon's PATH; Workspace pull requests: gh: HTTP 502" });
  });
});

describe("attention", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const viewer = { login: "me" };
  const noPlan: WorkspacePlan = { workspaces: [], refs: [], unmatched: [], projects: new Map(), directories: [] };

  /** The view for `answers` to the searches, which found nothing unless they say otherwise. */
  const viewOf = (asked: Pick<PullRequestsInput, "plan" | "answers">) => {
    const read = buildPullRequestsView({
      plan: asked.plan,
      checkouts: {},
      now,
      answers: {
        reviewRequests: { data: { viewer, reviewRequests: { nodes: [] } } },
        authored: { data: { viewer, authored: { nodes: [] } } },
        ...asked.answers,
      },
    });
    if ("failure" in read) throw new Error(read.failure);
    return read.view;
  };

  it("offers only the highest landable layer of a native stack, which lands the ones below it", () => {
    // Layers 1 and 2 would merge, layer 3 is blocked: merging 2 lands 1, so 1 is not offered and 3 waits.
    const states = { 1: "CLEAN", 2: "CLEAN", 3: "BLOCKED" };
    const stack = {
      entries: {
        nodes: Object.entries(states).map(([number, mergeStateStatus]) => ({
          position: Number(number),
          pullRequest: { number: Number(number), state: "OPEN", isDraft: false, mergeStateStatus },
        })),
      },
    };
    const layer = (number: 1 | 2 | 3) =>
      pullRequest(number, {
        stack,
        mergeStateStatus: states[number],
        reviewDecision: "APPROVED",
        latestOpinionatedReviews: { nodes: [{ state: "APPROVED", viewerDidAuthor: false }] },
      });
    const view = viewOf({
      plan: {
        ...noPlan,
        workspaces: [1, 2, 3].map((number) => ({ id: `w${number}`, name: `layer ${number}`, ref: number - 1 })),
        refs: [1, 2, 3].map((number) => ({ owner: "acme", repo: "app", number })),
      },
      answers: {
        "workspaces-0": { data: { viewer, p0: { pullRequest: layer(1) }, p1: { pullRequest: layer(2) }, p2: { pullRequest: layer(3) } } },
      },
    });

    expect(view.sections.map(({ id, rows }) => [id, rows.map(({ subtitle, approval }) => [subtitle, approval])])).toEqual([
      ["merge", [["approved · lands ↓#1 · #2", "ready"]]],
      ["approved", [["waiting on required checks or reviews · #3", "approved"]]],
      ["waiting", [["approved · #1", "approved"]]],
    ]);
    expect(view.ready).toBe(1);
  });

  it("folds bots' review requests and sets others' approved ones apart from what needs the viewer", () => {
    const requests = [
      pullRequest(11, { viewerDidAuthor: false, author: { __typename: "User", login: "carol" }, createdAt: "2026-11-10T00:00:00Z" }),
      pullRequest(12, { viewerDidAuthor: false, author: { __typename: "Bot", login: "dependabot" }, createdAt: "2026-11-05T00:00:00Z" }),
      pullRequest(13, { viewerDidAuthor: false, author: { __typename: "Bot", login: "renovate" }, createdAt: "2026-11-08T00:00:00Z" }),
      pullRequest(14, { viewerDidAuthor: false, author: { __typename: "User", login: "dave" }, reviewDecision: "APPROVED" }),
    ];
    const view = viewOf({
      plan: noPlan,
      answers: {
        reviewRequests: { data: { viewer, reviewRequests: { nodes: requests.map(({ number }) => ({ id: `PR_${number}` })) } } },
        "reviewRequests-0": { data: { nodes: requests } },
      },
    });

    expect(view.sections.map(({ id, rows }) => [id, rows.map(({ subtitle }) => subtitle)])).toEqual([
      ["review", ["waiting 10d · by carol · app#11"]],
      ["optional", ["waiting 19d · by dave · app#14"]],
    ]);
    expect(view.sections.map(({ folded }) => folded)).toEqual([
      {
        title: "2 bot updates",
        rows: [
          expect.objectContaining({ subtitle: "waiting 15d · by dependabot · app#12" }),
          expect.objectContaining({ subtitle: "waiting 12d · by renovate · app#13" }),
        ],
      },
      null,
    ]);
    expect(view.needing).toBe(3);
    expect(view.summary).toBe("3 pull requests need you · 1 approved without you");
  });
});
