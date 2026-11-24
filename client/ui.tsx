import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginHostProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ago } from "../shared/format";
import type { Tone } from "../shared/tone";
import { Mark } from "./mark";

export type Themed = Pick<PluginHostProps, "theme">;

export function styles(theme: PluginTheme) {
  return {
    text: { color: theme.colors.foreground, fontSize: 13 },
    strong: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
    caption: { color: theme.colors.foregroundMuted, fontSize: 11 },
    problem: { color: theme.colors.statusWarning, fontSize: 13 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 8 },
    label: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    section: { gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 10 },
    card: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface1 },
  };
}

/** The time, rendering again every `periodMs`, so text such as "3m ago" or "in 2h" moves with the clock, not only with new data. */
export function useNow(periodMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}

/** The theme's status color for warning and danger; `ok` gets the caller's neutral color. */
export function toneColor(theme: PluginTheme, tone: Tone, ok: string): string {
  if (tone === "danger") return theme.colors.statusDanger;
  return tone === "warning" ? theme.colors.statusWarning : ok;
}

/** Bold for warning and danger, so the state does not rest on color alone; red and green look alike to many. */
const TONE_WEIGHT: Record<Tone, "400" | "600"> = { ok: "400", warning: "600", danger: "600" };

/**
 * Blue, for quota to use before it resets unused: a call to act, not a problem. Fixed, because
 * Paseo's theme has no hue apart from its status colors; its accent is the same green as success.
 * Readable on light and dark surfaces alike.
 */
const USE_FIRST_COLOR = "#3b82f6";

/** `USE_FIRST_COLOR` for quota to use before it resets unused, else the tone's color. Bold either way when it calls for action. */
export function emphasis(theme: PluginTheme, tone: Tone, accent: boolean, ok: string) {
  return accent
    ? { color: USE_FIRST_COLOR, fontWeight: "600" as const }
    : { color: toneColor(theme, tone, ok), fontWeight: TONE_WEIGHT[tone] };
}

/** One line of 12px text, muted unless its tone, or `accent`, says otherwise. */
export function TonedText({
  theme,
  tone,
  accent = false,
  children,
}: {
  theme: PluginTheme;
  tone: Tone;
  accent?: boolean;
  children: string;
}) {
  return (
    <Text numberOfLines={1} style={{ fontSize: 12, ...emphasis(theme, tone, accent, theme.colors.foregroundMuted) }}>
      {children}
    </Text>
  );
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function percentOf(value: number) {
  return `${clamp(value) * 100}%` as const;
}

/**
 * A filled bar; `fraction` from 0 to 1, green while fine, `USE_FIRST_COLOR` with quota to use before
 * it resets. `elapsed`, from 0 to 1, marks how far through its window the limit is: a fill short of
 * the mark is quota going unused, one past it is running out early. A paler extension shows where
 * the fill ends at the reset if the pace so far holds; it reaching the end means running out.
 */
export function Meter({
  theme,
  fraction,
  tone,
  accent = false,
  elapsed = null,
  height = 6,
}: {
  theme: PluginTheme;
  fraction: number;
  tone: Tone;
  accent?: boolean;
  elapsed?: number | null;
  height?: number;
}) {
  const color = accent ? USE_FIRST_COLOR : toneColor(theme, tone, theme.colors.statusSuccess);
  // Too early in the window, the pace is noise.
  const projected = elapsed !== null && elapsed >= 0.02 ? clamp(fraction / elapsed) : null;
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      {projected !== null && projected > fraction ? (
        <View
          style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: percentOf(projected), backgroundColor: color, opacity: 0.3 }}
        />
      ) : null}
      <View style={{ width: percentOf(fraction), height: "100%", backgroundColor: color }} />
      {elapsed === null ? null : (
        <View
          accessibilityLabel={`${Math.round(clamp(elapsed) * 100)}% of the window elapsed`}
          style={{
            position: "absolute",
            left: percentOf(elapsed),
            top: 0,
            bottom: 0,
            width: 2,
            marginLeft: -1,
            backgroundColor: theme.colors.foreground,
          }}
        />
      )}
    </View>
  );
}

/** A screen's scrolling, centered column. */
export function Page({
  theme,
  layout,
  maxWidth,
  children,
}: Pick<PluginSurfaceProps, "theme" | "layout"> & { maxWidth: number; children: ReactNode }) {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24 }}>
      <View style={{ width: "100%", maxWidth, alignSelf: "center", gap: 16 }}>{children}</View>
    </ScrollView>
  );
}

/**
 * A read's first lines: `children` beside "Updated 3m ago · Refresh", which forces a fresh read,
 * then why reads failed, one line each.
 */
export function ReadStatus({
  theme,
  label,
  refreshing,
  fetchedAt,
  onRefresh,
  problems,
  children,
}: {
  theme: PluginTheme;
  /** What it refreshes, for screen readers: "Refresh usage". */
  label: string;
  refreshing: boolean;
  fetchedAt: number | null;
  onRefresh: () => void;
  problems: readonly string[];
  children: ReactNode;
}) {
  const now = useNow(30_000);
  const updated = fetchedAt === null ? "Refresh" : `Updated ${ago(now - fetchedAt)} · Refresh`;
  const s = styles(theme);
  return (
    <>
      <View style={{ ...s.row, flexWrap: "wrap" }}>
        {children}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          disabled={refreshing}
          onPress={onRefresh}
          style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
        >
          {/* One 16 px slot for both, so the screen does not shift when a refresh starts or ends. */}
          <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
            {refreshing ? (
              <Mark theme={theme} size={16} turning />
            ) : (
              <Icon name="RotateCw" size={14} color={theme.colors.foregroundMuted} />
            )}
          </View>
          <Text style={s.muted}>{refreshing ? "Refreshing…" : updated}</Text>
        </Pressable>
      </View>
      {problems.map((problem) => (
        <Text key={problem} style={s.problem}>
          {problem}
        </Text>
      ))}
    </>
  );
}

/** A muted Lucide icon and title over a group of rows: "Top processes · by CPU". */
export function SectionHeading({ theme, icon, children }: { theme: PluginTheme; icon: string; children: string }) {
  const s = styles(theme);
  return (
    <View style={s.label}>
      <Icon name={icon} size={14} color={theme.colors.foregroundMuted} />
      <Text style={s.muted}>{children}</Text>
    </View>
  );
}
