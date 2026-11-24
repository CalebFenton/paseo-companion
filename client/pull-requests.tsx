import {
  openExternalUrl,
  type PluginSidebarViewProps,
  type PluginSurfaceProps,
  type PluginWorkspaceRowBadgeItemProps,
  useWorkspaces,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { errorMessage, joinParts } from "../shared/format";
import type { PullRequestRow, PullRequestSectionId } from "../shared/pull-requests";
import { readFailure, useLiveState } from "./live-store";
import type { PullRequestsStore } from "./pull-requests-store";
import { Page, ReadStatus, SectionHeading, styles, type Themed, TonedText } from "./ui";

export const PULL_REQUESTS_SCREEN = "pull-requests";

/** Lucide icons by section id. */
const SECTION_ICONS: Record<PullRequestSectionId, string> = {
  respond: "MessageSquare",
  checks: "CircleX",
  stuck: "CircleAlert",
  rereview: "GitPullRequestArrow",
  review: "Eye",
  merge: "GitMerge",
  approved: "Check",
  optional: "CheckCheck",
  waiting: "Hourglass",
};

const APPROVAL_ICONS: Record<NonNullable<PullRequestRow["approval"]>, { icon: string; label: string }> = {
  approved: { icon: "CircleCheck", label: "Approved" },
  ready: { icon: "PartyPopper", label: "Approved and ready to merge" },
};

interface RowProps extends Pick<PluginSurfaceProps, "theme"> {
  row: PullRequestRow;
  checkOut: PullRequestsStore["checkOut"];
  /** Null where the surface cannot open workspaces; rows then open on GitHub and offer no check out. */
  openWorkspace: ((workspaceId: string) => void) | null;
  /** Phones and the sidebar: the check out button shows its icon alone. */
  compact: boolean;
}

/**
 * A row a workspace holds is marked, opens the workspace, and its trailing icon the pull request
 * on GitHub. Others open on GitHub, and offer a new worktree where Paseo can check them out.
 */
function RowCard({ row, theme, openWorkspace, checkOut, compact }: RowProps) {
  const [checkingOut, setCheckingOut] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { workspaceId } = row;
  const open = openWorkspace && workspaceId ? () => openWorkspace(workspaceId) : null;
  const openOnGitHub = () => void openExternalUrl(row.url).catch((error: unknown) => setFailure(errorMessage(error)));
  const target = openWorkspace ? row.checkOut : null;
  const startCheckOut = () => {
    if (!openWorkspace || !target) return;
    setCheckingOut(true);
    setFailure(null);
    checkOut(target)
      .then(openWorkspace, (error: unknown) => setFailure(errorMessage(error)))
      .finally(() => setCheckingOut(false));
  };
  const approval = row.approval && APPROVAL_ICONS[row.approval];
  const s = styles(theme);
  return (
    <View style={{ ...s.card, flexDirection: "row", alignItems: "center" }}>
      <Pressable
        accessibilityRole={open ? "button" : "link"}
        onPress={open ?? openOnGitHub}
        style={{ flex: 1, gap: 2, paddingVertical: 10, paddingHorizontal: 12 }}
      >
        <View style={s.label}>
          {workspaceId ? (
            <View accessibilityLabel="In a Paseo workspace">
              <Icon name="FolderGit2" size={14} color={theme.colors.accent} />
            </View>
          ) : null}
          <Text style={{ ...s.text, flexShrink: 1 }} numberOfLines={1}>
            {row.title}
          </Text>
          {approval ? (
            <View accessibilityLabel={approval.label}>
              <Icon name={approval.icon} size={14} color={theme.colors.statusSuccess} />
            </View>
          ) : null}
        </View>
        <Text style={s.muted} numberOfLines={1}>
          {row.subtitle}
        </Text>
        {failure ? <Text style={{ ...s.problem, fontSize: 12 }}>{failure}</Text> : null}
      </Pressable>
      {open ? (
        // An icon button: Paseo's ExternalLink is a text link, which adds an arrow of its own.
        <Pressable accessibilityRole="link" accessibilityLabel="Open on GitHub" onPress={openOnGitHub} style={{ padding: 12 }}>
          <Icon name="ExternalLink" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : null}
      {!open && target ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Check out in a new worktree"
          disabled={checkingOut}
          onPress={startCheckOut}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, padding: 12 }}
        >
          <Icon name="GitBranchPlus" size={14} color={theme.colors.foregroundMuted} />
          {compact ? null : <Text style={s.muted}>{checkingOut ? "Checking out…" : "Check out"}</Text>}
        </Pressable>
      ) : null}
    </View>
  );
}

/** Rows behind one expandable row, such as bots' updates; open while the filter narrows them. */
function Fold({ title, rows, open, ...rowProps }: Omit<RowProps, "row"> & { title: string; rows: PullRequestRow[]; open: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const shown = open || expanded;
  const s = styles(rowProps.theme);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: shown }}
        onPress={() => setExpanded(!expanded)}
        style={{ ...s.label, paddingVertical: 6, paddingHorizontal: 12 }}
      >
        <Icon name={shown ? "ChevronDown" : "ChevronRight"} size={14} color={rowProps.theme.colors.foregroundMuted} />
        <Icon name="Bot" size={14} color={rowProps.theme.colors.foregroundMuted} />
        <Text style={s.muted}>{title}</Text>
      </Pressable>
      {shown ? rows.map((row) => <RowCard key={row.key} row={row} {...rowProps} />) : null}
    </>
  );
}

/** Narrows the page to rows whose title, subtitle, or repository holds every word typed. */
function FilterBar({ theme, value, onChange }: Pick<PluginSurfaceProps, "theme"> & { value: string; onChange: (value: string) => void }) {
  const [focused, setFocused] = useState(false);
  const s = styles(theme);
  return (
    <View style={{ ...s.label, ...s.card, borderColor: focused ? theme.colors.accent : theme.colors.border, paddingHorizontal: 10 }}>
      <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Filter by title, repository, author, or number"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="Filter pull requests"
        autoCapitalize="none"
        autoCorrect={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        // The bar's border shows focus; a browser's ring would draw a second box inside it.
        style={{ ...s.text, flex: 1, paddingVertical: 8, outlineWidth: 0 }}
      />
      {value ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear the filter" onPress={() => onChange("")} hitSlop={8}>
          <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

interface ListProps extends Pick<PluginSurfaceProps, "theme"> {
  store: PullRequestsStore;
  openWorkspace: RowProps["openWorkspace"];
  compact: boolean;
}

/** The daemon's pull request view: the read's age and problems, then its sections, filtered as typed. */
function PullRequestsList({ store, theme, openWorkspace, compact }: ListProps) {
  const state = useLiveState(store);
  const [filter, setFilter] = useState("");
  const view = state.snapshot?.view ?? null;
  const failure = readFailure(state);
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (row: PullRequestRow) => {
    const text = `${row.title} ${row.subtitle} ${row.repository}`.toLowerCase();
    return words.every((word) => text.includes(word));
  };
  const sections = (view?.sections ?? []).flatMap((section) => {
    const rows = section.rows.filter(matches);
    const folded = section.folded?.rows.filter(matches) ?? [];
    const total = section.rows.length + (section.folded?.rows.length ?? 0);
    return rows.length + folded.length > 0 ? [{ ...section, rows, foldedRows: folded, shown: rows.length + folded.length, total }] : [];
  });
  const rowProps = { theme, openWorkspace, checkOut: store.checkOut, compact };
  const s = styles(theme);
  return (
    <>
      <ReadStatus
        theme={theme}
        label="Refresh pull requests"
        refreshing={state.refreshing}
        fetchedAt={state.snapshot?.fetchedAt ?? null}
        onRefresh={() => store.refresh()}
        problems={failure === null ? [] : [failure]}
      >
        <Text style={{ ...s.muted, flexShrink: 1 }}>{view?.summary ?? (failure ? "" : "Asking GitHub…")}</Text>
      </ReadStatus>
      {failure === null && view?.error ? (
        <View style={{ gap: 2 }}>
          <Text style={s.problem}>{view.error.message}</Text>
          <Text style={s.muted}>{view.error.detail}</Text>
        </View>
      ) : null}
      {view !== null && view.sections.length > 0 ? <FilterBar theme={theme} value={filter} onChange={setFilter} /> : null}
      {words.length > 0 && sections.length === 0 ? <Text style={s.muted}>No pull requests match.</Text> : null}
      {sections.map(({ id, title, rows, folded, foldedRows, shown, total }) => (
        <View key={id} style={{ gap: 6 }}>
          <SectionHeading theme={theme} icon={SECTION_ICONS[id]}>
            {`${title} · ${shown === total ? total : `${shown} of ${total}`}`}
          </SectionHeading>
          {rows.map((row) => (
            <RowCard key={row.key} row={row} {...rowProps} />
          ))}
          {folded && foldedRows.length > 0 ? <Fold title={folded.title} rows={foldedRows} open={words.length > 0} {...rowProps} /> : null}
        </View>
      ))}
    </>
  );
}

export function createPullRequestsPage(store: PullRequestsStore) {
  return function PullRequestsPage({ theme, layout, navigation }: PluginSurfaceProps) {
    return (
      <Page theme={theme} layout={layout} maxWidth={720}>
        <PullRequestsList
          store={store}
          theme={theme}
          compact={layout.compact}
          openWorkspace={navigation ? (workspaceId) => navigation.openWorkspace({ workspaceId }) : null}
        />
      </Page>
    );
  };
}

/**
 * The same list in place of the sidebar's workspaces. Sidebar navigation takes Paseo's workspace
 * references, so a workspace just checked out opens once Paseo lists it.
 */
export function createPullRequestsSidebar(store: PullRequestsStore) {
  return function PullRequestsSidebar(props: PluginSidebarViewProps) {
    const workspaces = useWorkspaces();
    const [pending, setPending] = useState<string | null>(null);
    const arrived = pending === null ? undefined : workspaces.find(({ id }) => id === pending);
    // Reads the latest navigation and layout without making them reasons to run the effect again.
    const open = useEffectEvent((workspace: NonNullable<typeof arrived>) => {
      props.navigation.openWorkspace(workspace);
      if (props.layout.compact) props.dismiss();
    });
    useEffect(() => {
      if (!arrived) return;
      setPending(null);
      open(arrived);
    }, [arrived]);
    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 12 }}>
        <PullRequestsList store={store} theme={props.theme} compact openWorkspace={setPending} />
      </ScrollView>
    );
  };
}

/**
 * The sidebar footer row's trailing text: what needs the viewer, led by what is ready to merge,
 * with the party popper. A read GitHub only partly answered says so.
 */
export function createPullRequestsTrailing(store: PullRequestsStore) {
  return function PullRequestsTrailing({ theme }: Themed) {
    const state = useLiveState(store);
    const view = state.snapshot?.view ?? null;
    const failure = readFailure(state);
    if (!view) {
      return failure ? (
        <TonedText theme={theme} tone="danger">
          unavailable
        </TonedText>
      ) : null;
    }
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        {view.ready > 0 ? (
          <View accessibilityLabel={APPROVAL_ICONS.ready.label}>
            <Icon name={APPROVAL_ICONS.ready.icon} size={12} color={theme.colors.statusSuccess} />
          </View>
        ) : null}
        <TonedText theme={theme} tone={view.error ? "warning" : "ok"}>
          {joinParts([
            view.ready > 0 ? `${view.ready} ready` : null,
            view.needing > 0 || view.error ? String(view.needing) : "all clear",
            view.error ? "partial" : null,
          ])}
        </TonedText>
      </View>
    );
  };
}

/**
 * A workspace's pull request on its sidebar row: its section's icon and what it needs, "reply",
 * "merge", "waiting 3d"; nothing without one.
 */
export function createPullRequestBadge(store: PullRequestsStore) {
  return function PullRequestBadge({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
    const badge = useSyncExternalStore(store.subscribe, () => store.getState().snapshot?.view?.badges[workspaceId] ?? null);
    if (!badge) return null;
    return (
      <WorkspaceRowBadge icon={SECTION_ICONS[badge.section]} label={badge.label} tone={badge.tone} accessibilityLabel={badge.detail} />
    );
  };
}
