import type { SubscriptionInput } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { type CheckOutTarget, checkOutRpc, type PullRequestsSnapshot, pullRequestsFeed, pullRequestsRpc } from "../shared/pull-requests";
import { createLiveStore, type LiveState, type RefreshableStore } from "./live-store";

export interface PullRequestsStore extends RefreshableStore<LiveState<PullRequestsSnapshot>> {
  /** Has Paseo check the pull request out as a new worktree; resolves to the workspace's id. The next read lists it. */
  checkOut: (target: CheckOutTarget) => Promise<string>;
}

export function createPullRequestsStore(client: PluginClientContext): PullRequestsStore {
  const live = createLiveStore<PullRequestsSnapshot, SubscriptionInput<typeof pullRequestsFeed>>({
    extra: {},
    input: () => ({}),
    subscribe: (input, onEvent, options) => client.subscribe(pullRequestsFeed, input, onEvent, options),
  });
  return {
    ...live.store,
    refresh: () => live.refreshWith(() => client.rpc(pullRequestsRpc, { refresh: true })),
    checkOut: async (target) => {
      const { workspaceId } = await client.rpc(checkOutRpc, target);
      return workspaceId;
    },
  };
}
