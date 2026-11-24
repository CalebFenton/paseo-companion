/**
 * Deploys this checkout to the local Paseo daemon and calls the plugin's RPCs and subscriptions the
 * way the app does: through the daemon, into the plugin process, out to omp and GitHub. Needs a
 * running daemon with this directory installed as the plugin, plus gh and omp signed in.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { connectToDaemon, hasMethods, isMethod, type Methods } from "../scripts/daemon.ts";
import { joinParts } from "../shared/format";
import { PLUGIN_ID } from "../shared/plugin";
import { type PullRequestRow, type PullRequestsView, pullRequestsFeed, pullRequestsRpc } from "../shared/pull-requests";
import { type SystemView, systemFeed } from "../shared/system";
import { type AccountView, limitText, type UsageView, usageFeed, usageRpc } from "../shared/usage";

/** How a subscription's event reaches the client. */
const eventMessageSchema = z.object({ type: z.literal("plugin.rpc.event"), payload: z.object({ event: z.unknown() }) });

let client: Methods<"invokePluginRpc" | "observePluginRpc" | "close"> | undefined;

beforeAll(async () => {
  execFileSync("paseo", ["plugin", "reload", PLUGIN_ID], { stdio: "ignore" });
  client = await connectToDaemon(["invokePluginRpc", "observePluginRpc", "close"]);
});

afterAll(async () => {
  await client?.close();
});

async function call<Input extends z.ZodType, Output extends z.ZodType>(
  rpc: { name: string; input: Input; output: Output },
  input: z.input<Input>,
): Promise<z.infer<Output>> {
  if (!client) throw new Error("Not connected to the daemon");
  return rpc.output.parse(await client.invokePluginRpc(PLUGIN_ID, rpc.name, input));
}

/** The first event `feed` pushes for `input` that `accept` takes. */
async function pushed<Input extends z.ZodType, Event extends z.ZodType>(
  feed: { name: string; input: Input; event: Event },
  input: z.input<Input>,
  accept: (event: z.infer<Event>) => boolean,
): Promise<z.infer<Event>> {
  if (!client) throw new Error("Not connected to the daemon");
  const subscription = client.observePluginRpc(PLUGIN_ID, feed.name, input);
  if (!hasMethods(subscription, ["subscribe", "release"])) throw new Error("The daemon client's subscription lacks subscribe or release");
  const { promise, resolve } = Promise.withResolvers<z.infer<Event>>();
  const stop = subscription.subscribe({
    snapshot() {},
    update(message: unknown) {
      const parsed = eventMessageSchema.safeParse(message);
      if (!parsed.success) return;
      const event = feed.event.parse(parsed.data.payload.event);
      if (accept(event)) resolve(event);
    },
  });
  try {
    return await promise;
  } finally {
    if (isMethod(stop)) stop();
    await subscription.release();
  }
}

/** `value`, failing the test where it is null. */
function present<Value>(value: Value | null, what: string): Value {
  if (value === null) throw new Error(`No ${what}`);
  return value;
}

/** ▣ in a workspace, + Paseo can check it out, else GitHub only. */
function rowMark({ workspaceId, checkOut }: PullRequestRow): string {
  if (workspaceId !== null) return "▣";
  return checkOut ? "+" : " ";
}

function printPullRequests(view: PullRequestsView): void {
  console.log(view.summary);
  for (const section of view.sections) {
    console.log(`  ${section.title}:`);
    for (const row of section.rows) console.log(`    ${rowMark(row)} ${row.subtitle}`);
  }
}

/** Takes a view sampled after `at`. */
function sampledAfter(at: number): (event: SystemView) => boolean {
  return (event) => event.sampledAt !== null && event.sampledAt > at;
}

function printAccount(account: AccountView): void {
  const resets = account.resets.map(({ scope, count, usable }) => `⟲ ${count} ${scope} (${usable} usable)`).join(", ");
  const limits = account.windows.map(limitText).join(" · ");
  const mark = `${account.avatar.symbol} ${account.vendor}`;
  console.log(`    ${mark} ${account.label}: ${joinParts([limits, resets === "" ? null : resets, account.redeem ? "UNLOCK" : null])}`);
}

function printUsage(usage: UsageView): void {
  const alarm = usage.overview;
  const sidebar = alarm ? `${usage.accounts.find(({ id }) => id === alarm.accountId)?.label}: ${alarm.text}` : "weekly strip";
  console.log(`  ${usage.accounts.length} accounts, in use order; sidebar: ${sidebar}`);
  for (const account of usage.accounts) printAccount(account);
}

it("lists pull requests from a fresh GitHub read", async () => {
  const { view, fetchedAt, error } = await call(pullRequestsRpc, { refresh: true });
  expect(error).toBeNull();
  const read = present(view, "pull request view");
  expect(read.error).toBeNull();
  printPullRequests(read);
  const subscribed = await pushed(pullRequestsFeed, {}, (event) => event.fetchedAt !== null);
  expect(subscribed.fetchedAt).toBeGreaterThanOrEqual(present(fetchedAt, "read time"));
});

it("reads usage for every omp profile and Paseo's own sources", async () => {
  const usage = await call(usageRpc, { agents: [], refresh: true });
  expect(usage.errors).toEqual([]);
  expect(usage.accounts.length).toBeGreaterThan(0);
  printUsage(usage);
  const subscribed = await pushed(usageFeed, { agents: [] }, () => true);
  expect(subscribed.accounts.map(({ id }) => id)).toEqual(usage.accounts.map(({ id }) => id));
});

it("pushes every sample of this host, with bars over the asked range and its filesystems", async () => {
  // The reload restarted sampling: a first sample takes two reads, a sample interval apart.
  const history = { range: "1h", bars: 60 } as const;
  const view = await pushed(systemFeed, { history }, (event) => event.sampledAt !== null);
  await pushed(systemFeed, { history }, sampledAfter(present(view.sampledAt, "sample")));
  expect(view.error).toBeNull();
  expect(view.charts.map(({ id }) => id)).toEqual(expect.arrayContaining(["cpu", "memory", "load"]));
  expect(view.charts.every(({ peak }) => peak.length === 60)).toBe(true);
  expect(view.filesystems.map(({ path }) => path)).toContain("/");
  console.log(`  ${view.host}: ${view.headline?.map(({ text, tone }) => `${text} (${tone})`).join(" · ")}`);
  for (const { path, value, detail } of view.filesystems) console.log(`    ${path} ${value} · ${detail}`);
}, 20_000);
