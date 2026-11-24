import type { PluginButtonContentProps, PluginHostProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView, SettingsAction, SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ago, clockTime, countdown, DAY_MS, HOUR_MS, joinParts, MINUTE_MS, percent, plural, usd } from "../shared/format";
import { worstTone } from "../shared/tone";
import {
  type AccountView,
  displaySettings,
  limitText,
  type ResetTimes,
  resetsText,
  type Summary,
  type WindowView,
  windowState,
} from "../shared/usage";
import { AccountMark, WeeklyStrip } from "./account-mark";
import { useLiveState } from "./live-store";
import { emphasis, Meter, Page, ReadStatus, styles, type Themed, TonedText, useNow } from "./ui";
import { listProblems, type UsageStore } from "./usage-store";

export const USAGE_SCREEN = "usage";

/** Paseo places a popover from its measured size, so the body needs a definite width; compact layouts are full-width sheets. */
const POPOVER_WIDTH = 380;
/** Past this, a desktop popover scrolls rather than running off the window. */
const POPOVER_MAX_HEIGHT = 560;

function tokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
}

const RESET_WORDING: Record<ResetTimes, (at: number, now: number) => string> = {
  countdown: (at, now) => countdown(at - now),
  clock: clockTime,
};

/**
 * The time, moving every minute, and a reset worded as this device's setting asks: `at`, "2h" or
 * "Tue 2:40 PM"; `when`, the same within a sentence, "in 2h" or "Tue 2:40 PM".
 */
function useResetWording() {
  const settings = useSettings(displaySettings);
  const resetTimes: ResetTimes = settings.status === "ready" ? settings.values.resetTimes : "countdown";
  const now = useNow(MINUTE_MS);
  const at = (time: number) => RESET_WORDING[resetTimes](time, now);
  const when = (time: number) => `${resetTimes === "countdown" ? "in " : ""}${at(time)}`;
  return { now, at, when };
}

/** `children` beside one refresh for everything, then read failures. */
function UsageStatus({ store, theme, children }: Themed & { store: UsageStore; children: ReactNode }) {
  const state = useLiveState(store);
  return (
    <ReadStatus
      theme={theme}
      label="Refresh usage"
      refreshing={state.refreshing}
      fetchedAt={state.snapshot?.fetchedAt ?? null}
      onRefresh={() => store.refresh()}
      problems={listProblems(state)}
    >
      {children}
    </ReadStatus>
  );
}

/** Every popover and sheet: `UsageStatus`, then `children`, scrolling when tall. */
function PopoverBody({ store, theme, layout, children }: PluginHostProps & { store: UsageStore; children: ReactNode }) {
  const s = styles(theme);
  return (
    <View style={{ gap: 12, width: layout.compact ? undefined : POPOVER_WIDTH }}>
      <UsageStatus store={store} theme={theme}>
        <Text style={s.strong}>Usage</Text>
      </UsageStatus>
      <ScrollView style={{ maxHeight: layout.compact ? undefined : POPOVER_MAX_HEIGHT }} contentContainerStyle={{ gap: 12 }}>
        {children}
      </ScrollView>
    </View>
  );
}

/** A reading older than this says how old it is: live ones are a few minutes old at most. */
const STALE_MS = 10 * MINUTE_MS;

/** A window's share used, with how far through the window it is. */
function WindowMeter({ theme, window, now, ...meter }: Themed & { window: WindowView; now: number; height?: number }) {
  const elapsed =
    window.resetsAt !== null && window.durationMs !== null && window.durationMs > 0
      ? 1 - (window.resetsAt - now) / window.durationMs
      : null;
  return (
    <Meter
      theme={theme}
      fraction={window.usedPct / 100}
      tone={window.tone}
      accent={window.outlook === "unused"}
      elapsed={elapsed}
      {...meter}
    />
  );
}

/** The omp profiles holding a login, or that only Paseo reads it. */
function ProfilesLine({ theme, profiles }: Themed & { profiles: readonly string[] }) {
  return <Text style={styles(theme).muted}>{profiles.length > 0 ? `Profiles: ${profiles.join(", ")}` : "Read by Paseo"}</Text>;
}

/**
 * The account's weekly limits, with where each is headed, then its balances; its shorter and
 * per-model limits as one muted line each; then its banked resets, by what they clear.
 */
function AccountCard({
  account,
  theme,
  named = true,
}: Themed & {
  account: AccountView;
  /** False under a row that already names the account. */
  named?: boolean;
}) {
  const { now, at, when } = useResetWording();
  const s = styles(theme);
  const resets = (resetsAt: number | null) => (resetsAt === null ? "" : ` · resets ${at(resetsAt)}`);
  /** A limit's name, then its value and when it resets. */
  const heading = (label: string, value: string, resetsAt: number | null) => (
    <View style={s.row}>
      <Text style={{ ...s.text, flexShrink: 1 }} numberOfLines={1}>
        {label}
      </Text>
      <Text style={s.muted}>{`${value}${resets(resetsAt)}`}</Text>
    </View>
  );
  const stale = account.fetchedAt !== null && now - account.fetchedAt > STALE_MS ? `as of ${ago(now - account.fetchedAt)}` : null;
  return (
    <View style={{ gap: 10 }}>
      {named ? (
        <View style={{ gap: 2 }}>
          <View style={s.label}>
            <AccountMark theme={theme} account={account} />
            <Text style={{ ...s.strong, flexShrink: 1 }} numberOfLines={1}>
              {account.heading}
            </Text>
          </View>
          <Text style={s.muted} numberOfLines={1}>
            {joinParts([account.label, stale])}
          </Text>
        </View>
      ) : null}
      {!named && stale ? <Text style={s.muted}>{`Reading ${stale}`}</Text> : null}
      {account.problem ? <Text style={s.problem}>{account.problem}</Text> : null}
      {account.windows
        .filter((window) => window.weekly)
        .map((window) => (
          <View key={window.id} style={{ gap: 4 }}>
            {heading(window.label, percent(window.usedPct), window.resetsAt)}
            <WindowMeter theme={theme} window={window} now={now} />
            {window.outlook === "unused" && window.resetsAt !== null ? (
              <TonedText theme={theme} tone="ok" accent>
                {`↓ ${percent(100 - window.usedPct)} resets unused ${when(window.resetsAt)} · use this account first`}
              </TonedText>
            ) : null}
            {window.outlook === "runsOut" && window.runsOutAt !== null ? (
              <TonedText theme={theme} tone="warning">
                {`↑ runs out ${when(window.runsOutAt)} at this pace`}
              </TonedText>
            ) : null}
          </View>
        ))}
      {account.balances.map((balance) => (
        <View key={balance.id} style={{ gap: 4 }}>
          {heading(balance.label, balance.text, balance.resetsAt)}
          {balance.usedPct === null ? null : <Meter theme={theme} fraction={balance.usedPct / 100} tone={balance.tone} />}
        </View>
      ))}
      {account.windows
        .filter((window) => !window.weekly)
        .map((window) => (
          <TonedText key={window.id} theme={theme} tone={window.outlook === "reached" ? "danger" : "ok"}>
            {`${window.label} ${percent(window.usedPct)}${resets(window.resetsAt)}`}
          </TonedText>
        ))}
      {account.redeem ? (
        <TonedText theme={theme} tone="ok" accent>
          {`⟲ Full, back ${when(account.redeem.backAt)}. A banked full reset unlocks it now.`}
        </TonedText>
      ) : null}
      {account.resets.map(({ scope, count, usable, expiresAt, tone }) => (
        <TonedText key={scope} theme={theme} tone={tone}>
          {joinParts([
            `⟲ ${plural(count, `${scope} reset`)} banked`,
            usable < count ? `${usable} usable now` : null,
            expiresAt === null ? null : `next expires ${at(expiresAt)}`,
          ])}
        </TonedText>
      ))}
      {account.plan ? <Text style={s.muted}>Plan: {account.plan}</Text> : null}
      <ProfilesLine theme={theme} profiles={account.profiles} />
    </View>
  );
}

/** Pill popover: the account this session draws from, its running totals, and where it could move. */
export function createAgentPopover(store: UsageStore) {
  return function AgentUsagePopover(props: PluginButtonContentProps) {
    const { snapshot, agents } = useLiveState(store);
    if (props.context !== "agent" || !snapshot) return null;
    const pill = snapshot.pills[props.agentId];
    const account = snapshot.accounts.find((candidate) => candidate.id === pill?.accountId);
    if (!pill || !account) return null;
    const s = styles(props.theme);
    const agent = agents.get(props.agentId);
    const tokens = agent?.tokens ?? 0;
    const costUsd = agent?.costUsd ?? 0;
    const session = joinParts([
      tokens > 0 ? `${tokenCount(tokens)} tokens` : null,
      costUsd > 0 ? `${usd(costUsd)} (API-equivalent)` : null,
    ]);
    return (
      <PopoverBody {...props} store={store}>
        <AccountCard theme={props.theme} account={account} />
        {session === "" ? null : (
          <View style={{ ...s.section, ...s.row }}>
            <Text style={{ ...s.text, flexShrink: 0 }}>This session</Text>
            <Text style={{ ...s.muted, flexShrink: 1, textAlign: "right" }}>{session}</Text>
          </View>
        )}
        {pill.others.length > 0 ? (
          <View style={s.section}>
            <Text style={s.muted}>Other accounts with room left, in the order to use them</Text>
            {pill.others.map((other) => {
              const view = snapshot.accounts.find((candidate) => candidate.id === other.accountId);
              if (!view) return null;
              return (
                <View key={other.accountId} style={{ gap: 2 }}>
                  <View style={s.row}>
                    <View style={{ ...s.label, flexShrink: 1 }}>
                      <AccountMark theme={props.theme} account={view} />
                      <Text style={{ ...s.text, flexShrink: 1 }} numberOfLines={1}>
                        {view.label}
                      </Text>
                    </View>
                    <TonedText theme={props.theme} tone={other.tone} accent={other.accent}>
                      {other.accent ? `use first · ${other.text}` : other.text}
                    </TonedText>
                  </View>
                  <ProfilesLine theme={props.theme} profiles={view.profiles} />
                </View>
              );
            })}
          </View>
        ) : null}
      </PopoverBody>
    );
  };
}

/** The Usage screen's columns on wide layouts; phones stack the bar under the name. */
const NAME_COLUMN = 250;
const STATE_COLUMN = 120;

/** What the row's symbols mean, once, above the list. */
const LEGEND =
  "Logo: vendor · glyph: which login. Bar: weekly limit used · paler: where it ends at this pace · │ now in the week. ↓ resets unused soon · ↑ runs out early · ⟲ banked resets";

/** Under a row's bar: what its fullest weekly limit does next, worded by `when` as of now; else its first balance. */
function nextStep(account: AccountView, weekly: WindowView | undefined, when: (time: number) => string): Summary | null {
  if (account.problem) return { text: account.problem, tone: "warning", accent: false };
  if (weekly === undefined || weekly.resetsAt === null) {
    const [balance] = account.balances;
    return balance ? { text: balance.text, tone: balance.tone, accent: false } : null;
  }
  const resets = when(weekly.resetsAt);
  if (weekly.outlook === "unused") return { text: `${percent(100 - weekly.usedPct)} resets unused ${resets}`, tone: "ok", accent: true };
  if (weekly.outlook === "reached") return { text: `full · back ${resets}`, tone: "danger", accent: false };
  if (weekly.outlook === "runsOut" && weekly.runsOutAt !== null) {
    return { text: `runs out ${when(weekly.runsOutAt)} · resets ${resets}`, tone: "warning", accent: false };
  }
  return { text: `resets ${resets}`, tone: "ok", accent: false };
}

/** A row's banked-reset badge: redeem one now, else what is banked. */
function resetsBadge(account: AccountView): Summary | null {
  if (account.redeem) return { text: "⟲ unlock now", tone: "ok", accent: true };
  if (account.resets.length === 0) return null;
  return { text: `⟲ ${resetsText(account.resets)}`, tone: worstTone(account.resets.map((group) => group.tone)), accent: false };
}

/** The row's share used: its fullest weekly limit's `windowState`, else the first balance's share. */
function usedText(account: AccountView, weekly: WindowView | undefined): string {
  if (weekly) return windowState(weekly);
  return account.usedPct === null ? "–" : percent(account.usedPct);
}

/**
 * One account per row: its name; its fullest weekly limit as a bar, with where that ends at this pace
 * and how far through the week it is; under the bar, when that limit resets or runs out, and any
 * other limit stopping it now; on the right, the share used and its banked resets. A press shows
 * every limit and reset.
 */
function AccountRow({ account, theme, compact }: Themed & { account: AccountView; compact: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const { now, when } = useResetWording();
  const s = styles(theme);
  const weekly = account.windows.find((window) => window.id === account.fullestWeekly);
  const [balance] = account.balances;

  // Under the bar: what the weekly limit does next, then whatever else stops the account.
  const next = nextStep(account, weekly, when);
  const extras = [
    ...account.windows.filter((window) => window.weekly && window !== weekly),
    ...account.windows.filter((window) => window.stopsNow),
  ].map((window) => limitText(window));

  const state = usedText(account, weekly);
  const badge = resetsBadge(account);

  let meter: ReactNode = null;
  if (weekly) meter = <WindowMeter theme={theme} window={weekly} now={now} height={8} />;
  else if (balance && account.usedPct !== null)
    meter = <Meter theme={theme} fraction={account.usedPct / 100} tone={balance.tone} height={8} />;

  const bar = (
    <View style={{ flex: 1, gap: 4 }}>
      {meter}
      <Text style={{ fontSize: 12 }} numberOfLines={1}>
        {next ? <Text style={emphasis(theme, next.tone, next.accent, theme.colors.foregroundMuted)}>{next.text}</Text> : null}
        {extras.length > 0 ? <Text style={s.muted}>{`${next ? " · " : ""}${extras.join(" · ")}`}</Text> : null}
      </Text>
    </View>
  );
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${account.title}: ${joinParts([state, next?.text ?? null, ...extras, badge?.text ?? null])}`}
        onPress={() => setExpanded(!expanded)}
        style={{ paddingVertical: 10, gap: 8 }}
      >
        <View style={{ ...s.row, gap: 14 }}>
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
          <View style={{ width: compact ? undefined : NAME_COLUMN, flex: compact ? 1 : undefined }}>
            <View style={s.label}>
              <AccountMark theme={theme} account={account} />
              <Text style={{ ...s.text, flexShrink: 1 }} numberOfLines={1}>
                {account.label}
              </Text>
            </View>
            <Text style={s.muted} numberOfLines={1}>
              {account.heading}
            </Text>
          </View>
          {compact ? null : bar}
          <View style={{ width: compact ? undefined : STATE_COLUMN, alignItems: "flex-end", gap: 2 }}>
            <Text
              style={{
                fontSize: 15,
                fontVariant: ["tabular-nums"],
                ...emphasis(theme, account.tone, account.accent, theme.colors.foreground),
              }}
            >
              {state}
            </Text>
            {badge ? (
              <TonedText theme={theme} tone={badge.tone} accent={badge.accent}>
                {badge.text}
              </TonedText>
            ) : null}
          </View>
        </View>
        {compact ? bar : null}
      </Pressable>
      {expanded ? (
        <View style={{ paddingLeft: 28, paddingBottom: 12 }}>
          <AccountCard theme={theme} account={account} named={false} />
        </View>
      ) : null}
    </View>
  );
}

/** Every account in the order to use them, so no quota resets unused; one line each, details on a press. */
export function createUsagePage(store: UsageStore) {
  return function UsagePage({ theme, layout }: PluginSurfaceProps) {
    const { snapshot } = useLiveState(store);
    const s = styles(theme);
    return (
      <Page theme={theme} layout={layout} maxWidth={900}>
        <UsageStatus store={store} theme={theme}>
          <Text style={{ ...s.muted, flexShrink: 1 }}>{LEGEND}</Text>
        </UsageStatus>
        <View>
          {(snapshot?.accounts ?? []).map((account) => (
            <AccountRow key={account.id} account={account} theme={theme} compact={layout.compact} />
          ))}
        </View>
      </Page>
    );
  };
}

/**
 * The sidebar footer row's trailing slot: the login about to let quota reset unused, by its mark,
 * with how much and when; else every account's weekly use as a strip of bars.
 */
export function createUsageTrailing(store: UsageStore) {
  return function UsageTrailing({ theme }: Themed) {
    const { snapshot, error } = useLiveState(store);
    if (!snapshot) {
      return (
        <TonedText theme={theme} tone={error ? "danger" : "ok"}>
          {error ? "unavailable" : "…"}
        </TonedText>
      );
    }
    const alarm = snapshot.overview;
    const account = alarm && snapshot.accounts.find((candidate) => candidate.id === alarm.accountId);
    if (!alarm || !account) return <WeeklyStrip theme={theme} accounts={snapshot.accounts} />;
    return (
      <View accessibilityLabel={`${account.title}: ${alarm.text}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <AccountMark theme={theme} account={account} size={13} />
        <TonedText theme={theme} tone="ok" accent>
          {alarm.text}
        </TonedText>
      </View>
    );
  };
}

/** Shown in a setting's choices, so local time appears in this device's own format. */
const EXAMPLE_RESET_MS = 4 * DAY_MS + 9 * HOUR_MS;

/** Settings → Plugins → this plugin → Usage. Kept on this device; each app chooses its own. */
export function UsageSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(displaySettings);
  const now = useNow(MINUTE_MS);
  const s = styles(theme);
  if (settings.status === "loading") return <Text style={s.muted}>Loading…</Text>;
  if (settings.status === "error") return <Text style={s.problem}>{settings.error}</Text>;
  if (settings.status === "invalid") {
    return (
      <SettingsSection title="Display">
        <SettingsCard>
          <SettingsAction
            label="The saved settings cannot be read"
            hint={settings.error}
            error={settings.saveError}
            actionLabel="Reset"
            disabled={settings.saving}
            onPress={() => void settings.reset()}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  return (
    <SettingsSection title="Display">
      <SettingsCard>
        <SettingsSelect
          label="Reset times"
          hint="How account cards on this device show when a limit resets, in its time zone."
          value={settings.values.resetTimes}
          options={[
            { value: "countdown", label: `Time left, like ${countdown(EXAMPLE_RESET_MS)}` },
            { value: "clock", label: `Local time, like ${clockTime(now + EXAMPLE_RESET_MS, now)}` },
          ]}
          error={settings.saveError}
          disabled={settings.saving}
          onValueChange={(resetTimes) => void settings.save({ ...settings.values, resetTimes }, settings.revision)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
