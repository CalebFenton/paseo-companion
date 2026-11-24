import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/** A pull request by where it lives: what Check out sends, and what its workspace keeps. */
export const pullRequestRefSchema = z.object({ owner: z.string(), repo: z.string(), number: z.number() });
export type PullRequestRef = z.infer<typeof pullRequestRefSchema>;

/** A pull request Paseo can check out as a new worktree, in the project cloning its repository. */
const checkOutSchema = z.object({
  pullRequest: pullRequestRefSchema,
  /** The new workspace's title. */
  title: z.string(),
});
export type CheckOutTarget = z.infer<typeof checkOutSchema>;

/** One pull request, worded for display. */
const rowSchema = z.object({
  /** Stable across reads: the workspace, else the pull request's URL. */
  key: z.string(),
  /** The workspace's name, else the pull request's title. */
  title: z.string(),
  /**
   * Reason first: "waiting 3d · by carol · app#201", "has merge conflicts · ↑#1796 · #1735". In a
   * stack, ↓ marks the pull request below this one ("↓#2282": merge it first; "lands ↓#2280":
   * merging this one merges it too) and ↑ those stacked on this one.
   */
  subtitle: z.string(),
  /** "approved": reviewers approved it; "ready": approved and GitHub would merge it now. */
  approval: z.enum(["approved", "ready"]).nullable(),
  /** The Paseo workspace holding it, which a press opens; null opens `url`. */
  workspaceId: z.string().nullable(),
  /** Offered when no workspace holds it and a Paseo project clones its repository. */
  checkOut: checkOutSchema.nullable(),
  /** "owner/name". */
  repository: z.string(),
  url: z.string(),
});
export type PullRequestRow = z.infer<typeof rowSchema>;

const sectionIdSchema = z.enum(["respond", "checks", "stuck", "rereview", "review", "merge", "approved", "optional", "waiting"]);
export type PullRequestSectionId = z.infer<typeof sectionIdSchema>;

const sectionSchema = z.object({
  id: sectionIdSchema,
  title: z.string(),
  /** Empty when every pull request in it is folded. */
  rows: z.array(rowSchema),
  /** Rows shown behind one expandable row after the others: "3 bot updates". */
  folded: z.object({ title: z.string(), rows: z.array(rowSchema).min(1) }).nullable(),
});

/** A workspace's pull request at a glance, on its sidebar row. */
const badgeSchema = z.object({
  /** What it needs, in a word or two: "reply", "merge", "no reviewer", "waiting 3d". */
  label: z.string(),
  /** Paseo's badge tones: danger needs the viewer's answer, warning their move, info their review, muted nothing yet. */
  tone: z.enum(["muted", "success", "warning", "danger", "info"]),
  /** The list's section holding it, whose icon the badge shows. */
  section: sectionIdSchema,
  /** For screen readers and the tooltip: "#1796 · 2 open threads · approved". */
  detail: z.string(),
});
export type PullRequestBadge = z.infer<typeof badgeSchema>;

const viewSchema = z.object({
  /** Most actionable first; only sections with pull requests. */
  sections: z.array(sectionSchema),
  /** By Paseo workspace id, for each workspace holding an open pull request. */
  badges: z.record(z.string(), badgeSchema),
  /** "3 pull requests need you · 6 approved without you · 4 waiting on others · 2 workspaces with a pull request · Paseo is still reading 4 workspaces". */
  summary: z.string(),
  /** Pull requests needing the viewer: those outside Approved without you and Waiting on others, folded ones included. */
  needing: z.number(),
  /** Pull requests in Ready to merge. */
  ready: z.number(),
  /** What GitHub could not answer; the sections hold whatever it did answer. */
  error: z
    .object({
      /** Plain words: "Couldn't load some review requests. Trying again in a few minutes." */
      message: z.string(),
      /** gh's and GitHub's own words, joined. */
      detail: z.string(),
    })
    .nullable(),
});
export type PullRequestsView = z.infer<typeof viewSchema>;

export const pullRequestsRpc = defineRpc({
  name: "pull-requests.view",
  input: z.object({
    /** Ask GitHub again rather than reuse a recent result. */
    refresh: z.boolean().optional(),
  }),
  output: z.object({
    /** Null until a read succeeds. */
    view: viewSchema.nullable(),
    /** Epoch milliseconds of the read shown; null until one succeeds. */
    fetchedAt: z.number().nullable(),
    /** Why the latest read failed outright; `view` then holds the previous one. */
    error: z.string().nullable(),
  }),
});
export type PullRequestsSnapshot = z.output<typeof pullRequestsRpc.output>;

/** The pull request view, pushed on subscribing and after every read; the daemon side reads while anyone subscribes. */
export const pullRequestsFeed = defineSubscription({
  name: "pull-requests.feed",
  input: z.object({}),
  event: pullRequestsRpc.output,
});

/** Creates a worktree for the pull request; fails with Paseo's reason. */
export const checkOutRpc = defineRpc({
  name: "pull-requests.check-out",
  input: checkOutSchema,
  output: z.object({ workspaceId: z.string() }),
});
