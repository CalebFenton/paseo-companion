import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createFeed } from "./server/feed";
import { createPullRequestsHandler } from "./server/pull-requests/handler";
import { createSystemMonitor } from "./server/system/monitor";
import { createUsageHandler, createUsageLoader } from "./server/usage/handler";
import { registerUsageSources } from "./server/usage/usage-sources";
import { checkOutRpc, pullRequestsFeed, pullRequestsRpc } from "./shared/pull-requests";
import { systemFeed } from "./shared/system";
import { usageFeed, usageRpc } from "./shared/usage";

/** The usage and pull-request views recompute this often; each read behind them is reused until older than its own limit. */
const RECOMPUTE_MS = 60_000;

export default function contribute(server: PluginServerContext) {
  // Each read that settles publishes, so a forced refresh or a turn's reread reaches every subscriber.
  const load = createUsageLoader(() => usageUpdates.publish());
  registerUsageSources(server, load);
  const usage = createUsageHandler(load, () => usageUpdates.publish());
  const usageUpdates = createFeed("usage.feed", usage.view);
  server.handle(usageFeed, usageUpdates.handle);
  server.handle(usageRpc, usage.view);
  // A turn is what spends quota.
  server.addHook("agent.turn.after", ({ agent }, { paseo }) => usage.afterTurn(agent.provider, paseo));

  const pullRequests = createPullRequestsHandler(() => pullRequestUpdates.publish());
  const pullRequestUpdates = createFeed("pull-requests.feed", (_input, context) => pullRequests.view({}, context));
  server.handle(pullRequestsFeed, pullRequestUpdates.handle);
  server.handle(pullRequestsRpc, pullRequests.view);
  server.handle(checkOutRpc, pullRequests.checkOut);

  const system = createSystemMonitor(() => systemUpdates.publish());
  const systemUpdates = createFeed("system.feed", system.view);
  server.handle(systemFeed, systemUpdates.handle);

  const recompute = setInterval(() => {
    usageUpdates.publish();
    pullRequestUpdates.publish();
  }, RECOMPUTE_MS);
  return () => {
    clearInterval(recompute);
    system.stop();
  };
}
