import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { ago } from "../shared/format";
import {
  type Bars,
  type Chart,
  type ChartId,
  type FilesystemView,
  type ProcessView,
  RANGES,
  type Range,
  SAMPLE_MS,
} from "../shared/system";
import { readFailure, useLiveState } from "./live-store";
import type { SystemStore } from "./system-store";
import { emphasis, Meter, Page, SectionHeading, styles, type Themed, TonedText, toneColor, useNow } from "./ui";

export const SYSTEM_SCREEN = "system";

const CHART_ICONS: Record<ChartId, string> = {
  cpu: "Cpu",
  memory: "MemoryStick",
  load: "Gauge",
  "cpu-pressure": "Hourglass",
  "memory-pressure": "Hourglass",
  "io-pressure": "Hourglass",
  disk: "HardDrive",
  network: "Network",
};

/** A sample older than this means the daemon side stopped sampling. */
const STALE_MS = 5 * SAMPLE_MS;

/** Each bar's solid average, toned, under a faint uncoloured cap up to its peak; throughput in a neutral colour. */
function BarStrip({ bars, theme, height, gap }: { bars: Bars; theme: PluginTheme; height: number; gap: number }) {
  return (
    <View
      style={{
        height,
        flexDirection: "row",
        alignItems: "flex-end",
        gap,
        backgroundColor: theme.colors.surface2,
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      {bars.peak.map((peak, index) => {
        const average = bars.average[index] ?? null;
        // oxlint-disable-next-line react/no-array-index-key -- bars are positions in time, not items
        if (peak === null || average === null) return <View key={index} style={{ flex: 1 }} />;
        const color = bars.tones ? toneColor(theme, bars.tones[index] ?? "ok", theme.colors.accent) : theme.colors.foregroundMuted;
        return (
          // oxlint-disable-next-line react/no-array-index-key -- bars are positions in time, not items
          <View key={index} style={{ flex: 1, height: `${peak * 100}%`, minHeight: 1 }}>
            <View style={{ flex: 1, backgroundColor: theme.colors.foregroundMuted, opacity: 0.25 }} />
            <View style={{ height: `${peak > 0 ? (average / peak) * 100 : 0}%`, backgroundColor: color }} />
          </View>
        );
      })}
    </View>
  );
}

function ChartCard({ chart, range, theme, compact }: { chart: Chart; range: Range; theme: PluginTheme; compact: boolean }) {
  const s = styles(theme);
  return (
    <View style={{ ...s.card, flexGrow: 1, flexBasis: compact ? "100%" : "40%", gap: 6, padding: 12 }}>
      <View style={s.label}>
        <Icon name={CHART_ICONS[chart.id]} size={14} color={theme.colors.foregroundMuted} />
        <Text style={{ ...s.strong, flex: 1 }}>{chart.title}</Text>
        <Text style={{ color: toneColor(theme, chart.tone, theme.colors.foreground), fontSize: 15, fontWeight: "600" }}>{chart.value}</Text>
      </View>
      <Text style={s.muted} numberOfLines={1}>
        {chart.detail}
      </Text>
      <BarStrip bars={chart} theme={theme} height={64} gap={compact ? 0 : 1} />
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={s.caption}>{`−${range}`}</Text>
        <Text style={s.caption}>{`top ${chart.scale}`}</Text>
        <Text style={s.caption}>now</Text>
      </View>
    </View>
  );
}

function FilesystemRow({ filesystem, theme, compact }: { filesystem: FilesystemView; theme: PluginTheme; compact: boolean }) {
  const s = styles(theme);
  return (
    <View style={{ width: compact ? "100%" : "48%", gap: 4 }}>
      <View style={s.row}>
        <Text style={{ ...s.text, flex: 1 }} numberOfLines={1} ellipsizeMode="middle">
          {filesystem.path}
        </Text>
        <Text style={{ ...s.strong, color: toneColor(theme, filesystem.tone, theme.colors.foreground) }}>{filesystem.value}</Text>
      </View>
      <Meter theme={theme} fraction={filesystem.fraction} tone={filesystem.tone} />
      <Text style={s.caption} numberOfLines={1}>
        {filesystem.detail}
      </Text>
    </View>
  );
}

const CPU_COLUMN = 52;
const MEMORY_COLUMN = 72;

/** CPU and memory in fixed columns, so they line up down the table; the command takes the rest. */
function ProcessRow({ row, theme }: { row: ProcessView; theme: PluginTheme }) {
  const s = styles(theme);
  return (
    <View style={{ flexDirection: "row", gap: 12 }}>
      <Text style={{ ...s.strong, width: CPU_COLUMN, textAlign: "right" }}>{row.cpu}</Text>
      <Text style={{ ...s.text, width: MEMORY_COLUMN, textAlign: "right" }}>{row.memory}</Text>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.text} numberOfLines={1}>
          {row.command}
        </Text>
        <Text style={s.caption} numberOfLines={1}>
          {row.detail}
        </Text>
      </View>
    </View>
  );
}

/** This host's charts over the picked range; Paseo's host picker in the screen header switches hosts. */
export function createSystemPage(store: SystemStore) {
  return function SystemPage({ theme, layout }: PluginSurfaceProps) {
    useEffect(() => store.watch(layout.compact ? 60 : 120), [layout.compact]);
    const state = useLiveState(store);
    const view = state.snapshot;
    const s = styles(theme);
    const sampledAt = view?.sampledAt ?? null;
    // Samples render every few seconds; the clock renders when they stop.
    const now = useNow(SAMPLE_MS);
    const problem = readFailure(state) ?? (sampledAt !== null && now - sampledAt > STALE_MS ? `Last sample ${ago(now - sampledAt)}` : null);
    return (
      <Page theme={theme} layout={layout} maxWidth={1100}>
        <View style={s.row}>
          <Text style={s.muted} numberOfLines={1}>
            {view ? `${view.host} · every ${SAMPLE_MS / 1000} s` : ""}
          </Text>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {RANGES.map((range) => {
              const selected = range === state.range;
              return (
                <Pressable
                  key={range}
                  accessibilityRole="button"
                  accessibilityLabel={`Show the last ${range}`}
                  accessibilityState={{ selected }}
                  onPress={() => store.setRange(range)}
                  style={{
                    paddingHorizontal: layout.compact ? 10 : 8,
                    paddingVertical: 3,
                    // A finger needs a bigger target than a pointer.
                    minHeight: layout.compact ? 32 : undefined,
                    justifyContent: "center",
                    borderRadius: 6,
                    backgroundColor: selected ? theme.colors.surface2 : "transparent",
                  }}
                >
                  <Text style={selected ? { ...s.muted, color: theme.colors.foreground } : s.muted}>{range}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        {problem ? <Text style={s.problem}>{problem}</Text> : null}
        {view && sampledAt === null ? <Text style={s.muted}>Taking the first sample…</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {(view?.charts ?? []).map((chart) => (
            <ChartCard key={chart.id} chart={chart} range={state.range} theme={theme} compact={layout.compact} />
          ))}
        </View>
        {view?.cores ? (
          <View style={{ gap: 6 }}>
            <SectionHeading theme={theme} icon="Grid3x3">{`${view.cores.title} · ${view.cores.detail}`}</SectionHeading>
            <BarStrip bars={view.cores} theme={theme} height={32} gap={1} />
          </View>
        ) : null}
        {view?.processes ? (
          <View style={{ gap: 8 }}>
            <SectionHeading theme={theme} icon="ListOrdered">{`Top processes · ${view.processes.detail}`}</SectionHeading>
            {view.processes.rows.length > 0 ? (
              <View style={{ flexDirection: "row", gap: 12 }}>
                <Text style={{ ...s.caption, width: CPU_COLUMN, textAlign: "right" }}>CPU</Text>
                <Text style={{ ...s.caption, width: MEMORY_COLUMN, textAlign: "right" }}>Memory</Text>
                <Text style={{ ...s.caption, flex: 1 }}>Command</Text>
              </View>
            ) : null}
            {view.processes.rows.map((row) => (
              <ProcessRow key={row.pid} row={row} theme={theme} />
            ))}
          </View>
        ) : null}
        {view !== null && view.filesystems.length > 0 ? (
          <View style={{ gap: 8 }}>
            <SectionHeading theme={theme} icon="HardDrive">
              Filesystems
            </SectionHeading>
            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 12 }}>
              {view.filesystems.map((filesystem) => (
                <FilesystemRow key={filesystem.path} filesystem={filesystem} theme={theme} compact={layout.compact} />
              ))}
            </View>
          </View>
        ) : null}
      </Page>
    );
  };
}

/** The sidebar footer row's trailing headline, each reading green, yellow, or red. */
export function createSystemTrailing(store: SystemStore) {
  return function SystemTrailing({ theme }: Themed) {
    const state = useLiveState(store);
    const headline = state.snapshot?.headline ?? null;
    if (!headline) {
      return readFailure(state) ? (
        <TonedText theme={theme} tone="danger">
          unavailable
        </TonedText>
      ) : null;
    }
    return (
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {headline.map(({ text, tone }, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- each position is one reading, whose text changes every sample
          <Text key={index}>
            {index > 0 ? " · " : ""}
            <Text style={emphasis(theme, tone, false, theme.colors.statusSuccess)}>{text}</Text>
          </Text>
        ))}
      </Text>
    );
  };
}
