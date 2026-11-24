import type { PluginClientContext, PluginSidebarItemProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SidebarRow, SidebarSeparator } from "@getpaseo/plugin/client/ui";
import type { FunctionComponent } from "react";
import { syncComposerPills } from "./client/pills";
import {
  createPullRequestBadge,
  createPullRequestsPage,
  createPullRequestsSidebar,
  createPullRequestsTrailing,
  PULL_REQUESTS_SCREEN,
} from "./client/pull-requests";
import { createPullRequestsStore } from "./client/pull-requests-store";
import { createSystemPage, createSystemTrailing, SYSTEM_SCREEN } from "./client/system";
import { createSystemStore } from "./client/system-store";
import type { Themed } from "./client/ui";
import { createUsagePage, createUsageTrailing, USAGE_SCREEN, UsageSettings } from "./client/usage";
import { createUsageStore } from "./client/usage-store";

/** A screen and the sidebar footer row that opens it, with the feature's status in the row's trailing slot. */
interface Feature {
  id: string;
  title: string;
  icon: string;
  Page: FunctionComponent<PluginSurfaceProps>;
  Trailing: FunctionComponent<Themed>;
}

function footerRow({ id, icon, Trailing }: Feature): FunctionComponent<PluginSidebarItemProps> {
  return function FooterRow(props) {
    return (
      <>
        <SidebarSeparator />
        <SidebarRow
          icon={icon}
          active={props.currentScreen?.screenId === id}
          onPress={() => props.openScreen({ screenId: id })}
          trailing={<Trailing theme={props.theme} />}
        />
      </>
    );
  };
}

export default function contribute(client: PluginClientContext) {
  const usage = createUsageStore(client);
  const pullRequests = createPullRequestsStore(client);
  const system = createSystemStore(client);
  const stopPills = syncComposerPills(client, usage);
  const features: Feature[] = [
    {
      id: PULL_REQUESTS_SCREEN,
      title: "Pull requests",
      icon: "GitPullRequest",
      Page: createPullRequestsPage(pullRequests),
      Trailing: createPullRequestsTrailing(pullRequests),
    },
    { id: USAGE_SCREEN, title: "Usage", icon: "Gauge", Page: createUsagePage(usage), Trailing: createUsageTrailing(usage) },
    { id: SYSTEM_SCREEN, title: "System", icon: "Activity", Page: createSystemPage(system), Trailing: createSystemTrailing(system) },
  ];
  const removals = features.flatMap((feature) => [
    client.addScreen({ id: feature.id, title: feature.title, Component: feature.Page }),
    client.addSidebarFooterItem({ id: feature.id, title: feature.title, Component: footerRow(feature) }),
  ]);
  removals.push(
    client.addSettingsScreen({ id: USAGE_SCREEN, title: "Usage", icon: "Gauge", Component: UsageSettings }),
    client.addWorkspaceRowBadgeItem({
      id: "pull-request",
      title: "Pull request",
      icon: "GitPullRequest",
      Component: createPullRequestBadge(pullRequests),
    }),
    client.addSidebarView({
      id: PULL_REQUESTS_SCREEN,
      title: "Pull requests",
      description: "What needs your reply, review, or merge",
      Component: createPullRequestsSidebar(pullRequests),
    }),
  );
  return async () => {
    const removed = removals.map(async (remove) => {
      await remove();
    });
    stopPills();
    usage.dispose();
    pullRequests.dispose();
    system.dispose();
    await Promise.all(removed);
  };
}
