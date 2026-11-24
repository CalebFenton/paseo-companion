import type { PluginClientContext } from "@getpaseo/plugin/client";
import { type AgentRef, type UsageView, usageFeed, usageRpc } from "../shared/usage";
import { createLiveStore, type LiveState, type RefreshableStore } from "./live-store";

/** The fields read from Paseo's agent entries; plugins may import types only from host modules. */
interface DirectoryAgent {
  id: string;
  provider: string;
  workspaceId?: string | undefined;
  model: string | null;
  archivedAt?: string | null | undefined;
  runtimeInfo?: { model?: string | null | undefined; sessionId: string | null } | undefined;
  persistence: { sessionId: string } | null;
  lastUsage?:
    | {
        inputTokens?: number | undefined;
        cachedInputTokens?: number | undefined;
        outputTokens?: number | undefined;
        totalCostUsd?: number | undefined;
      }
    | undefined;
}

interface AgentInfo {
  workspaceId: string;
  ref: AgentRef;
  /** Paseo's running totals for the session; null until the provider reports them. */
  tokens: number | null;
  costUsd: number | null;
}

interface UsageExtra {
  agents: ReadonlyMap<string, AgentInfo>;
}

export type UsageState = LiveState<UsageView, UsageExtra>;
export type UsageStore = RefreshableStore<UsageState>;

function readAgent(agent: DirectoryAgent): AgentInfo | null {
  const model = agent.runtimeInfo?.model ?? agent.model;
  if (!agent.workspaceId || agent.archivedAt) return null;
  const usage = agent.lastUsage;
  const tokens = (usage?.inputTokens ?? 0) + (usage?.cachedInputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const ref: AgentRef = {
    agentId: agent.id,
    provider: agent.provider,
    model,
    sessionId: agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId ?? null,
  };
  return {
    workspaceId: agent.workspaceId,
    ref,
    tokens: tokens || null,
    costUsd: usage?.totalCostUsd ?? null,
  };
}

/** Read failures, worded for display. */
export function listProblems({ error, snapshot }: UsageState): string[] {
  return [...(error ? [error] : []), ...(snapshot?.errors ?? []).map((failure) => `${failure.source}: ${failure.message}`)];
}

/** A change to the agents' refs, such as a new session or model, subscribes again for their pills. */
export function createUsageStore(client: PluginClientContext): UsageStore {
  const live = createLiveStore<UsageView, { agents: AgentRef[] }, UsageExtra>({
    extra: { agents: new Map() },
    input: ({ agents }) => ({ agents: [...agents.values()].map((agent) => agent.ref) }),
    subscribe: (agents, onEvent, options) => client.subscribe(usageFeed, agents, onEvent, options),
  });

  void client.paseo.agents
    .list({ subscribe: {}, signal: live.signal })
    .then(({ subscription }) =>
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const agents = new Map<string, AgentInfo>();
          for (const { agent } of entries) {
            const info = readAgent(agent);
            if (info) agents.set(agent.id, info);
          }
          live.update({ agents });
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          const id = update.kind === "remove" ? update.agentId : update.agent.id;
          const after = update.kind === "remove" ? null : readAgent(update.agent);
          const agents = new Map(live.store.getState().agents);
          if (after) agents.set(id, after);
          else agents.delete(id);
          live.update({ agents });
        },
      }),
    )
    .catch((error: unknown) => {
      if (!live.signal.aborted) console.error("usage: agent observation failed", error);
    });

  return {
    ...live.store,
    refresh: () => live.refreshWith(({ agents }) => client.rpc(usageRpc, { agents, refresh: true })),
  };
}
