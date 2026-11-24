import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { ComponentType } from "react";
import type { Tone } from "../shared/tone";
import { gaugeStep, gaugeSvg } from "./gauge";
import { emphasis } from "./ui";
import { createAgentPopover } from "./usage";
import type { UsageStore } from "./usage-store";

type PillIcon = ComponentType<PluginButtonIconProps>;

/** By tone, accent, and needle step, so an update that moves none of them reuses its component. */
const gauges = new Map<string, PillIcon>();

/** A gauge whose needle shows `usedPct`, colored by tone, or accent for quota to use first; Lucide's own Gauge without a share used to show. */
function gauge(tone: Tone, accent: boolean, usedPct: number | null): PillIcon {
  const step = usedPct === null ? null : gaugeStep(usedPct);
  const key = `${tone}|${accent}|${step}`;
  let icon = gauges.get(key);
  if (!icon) {
    const svg = step === null ? null : { svg: gaugeSvg(step) };
    icon = function UsageGauge({ size, color, theme }: PluginButtonIconProps) {
      const tinted = emphasis(theme, tone, accent, color).color;
      return svg ? <Icon icon={svg} size={size} color={tinted} /> : <Icon name="Gauge" size={size} color={tinted} />;
    };
    gauges.set(key, icon);
  }
  return icon;
}

interface Pill {
  workspaceId: string;
  /** Title, icon, and label last published, to skip no-op updates. */
  shown: { title: string; icon: PillIcon; label: string };
  registration: PluginButtonRegistration;
}

/** Keeps one pill on every agent's composer whose account is known, showing it. */
export function syncComposerPills(client: PluginClientContext, store: UsageStore): () => void {
  const AgentUsagePopover = createAgentPopover(store);
  const pills = new Map<string, Pill>();

  const reconcile = () => {
    const { snapshot, agents } = store.getState();
    for (const [agentId, agent] of agents) {
      const view = snapshot?.pills[agentId];
      const account = snapshot?.accounts.find((candidate) => candidate.id === view?.accountId);
      let pill = pills.get(agentId);
      if (pill && (!view || !account || pill.workspaceId !== agent.workspaceId)) {
        pill.registration.remove();
        pills.delete(agentId);
        pill = undefined;
      }
      if (!view || !account) continue;
      const button = { title: account.title, icon: gauge(view.tone, view.accent, account.usedPct), label: view.text };
      if (pill) {
        const { shown } = pill;
        if (shown.title !== button.title || shown.icon !== button.icon || shown.label !== button.label) {
          pill.registration.update(button);
          pill.shown = button;
        }
        continue;
      }
      pills.set(agentId, {
        workspaceId: agent.workspaceId,
        shown: button,
        registration: client.addComposerPill({
          id: "usage",
          workspaceId: agent.workspaceId,
          agentId,
          button: { ...button, behavior: { kind: "popover", Content: AgentUsagePopover } },
        }),
      });
    }
    for (const [agentId, pill] of pills) {
      if (agents.has(agentId)) continue;
      pill.registration.remove();
      pills.delete(agentId);
    }
  };

  reconcile();
  const unsubscribe = store.subscribe(reconcile);
  return () => {
    unsubscribe();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}
