import { ago, DAY_MS, HOUR_MS, joinParts, MINUTE_MS } from "../../shared/format";
import type { Chart, ChartId, FilesystemView, ProcessView, Range, SystemView } from "../../shared/system";
import { type Tone, worstTone } from "../../shared/tone";
import { activeWorkspaces, workspaceEntrySchema } from "../workspaces";
import type { History, Point, Row } from "./history";
import type { Filesystem, Sample, TopProcess } from "./proc";

const RANGE_MS: Record<Range, number> = {
  "30m": 30 * MINUTE_MS,
  "1h": HOUR_MS,
  "6h": 6 * HOUR_MS,
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
};

/** "4.3", "43": one decimal below 10, so a small reading keeps two figures where a whole number would round it away. */
function twoFigures(value: number): string {
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

/** "4.3%", "43%". */
function percent(value: number): string {
  return `${twoFigures(value)}%`;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/** "812 KiB", "1.4 GiB". */
function bytes(value: number): string {
  let unit = 0;
  let scaled = value;
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(scaled) : twoFigures(scaled)} ${BYTE_UNITS[unit]}`;
}

/** Readings from which a value warns, then is in danger. */
type Levels = [warning: number, danger: number];

interface ChartSpec {
  id: ChartId;
  title: string;
  /** The charted reading; null hides the chart. */
  reading: (sample: Sample) => number | null;
  format: (value: number) => string;
  detail: (sample: Sample) => string;
  /** The chart's top, given the highest peak shown. */
  top: (peak: number, sample: Sample) => number;
  /** Null when no level is bad. */
  levels: (sample: Sample) => Levels | null;
}

const CPU_LEVELS: Levels = [80, 95];
const MEMORY_LEVELS: Levels = [80, 90];
const PRESSURE_LEVELS: Levels = [10, 40];
const FULL_LEVELS: Levels = [85, 95];
/** Several refreshes missed: its statfs, or too many others', is stuck on a network mount. */
const FILESYSTEM_STALE_MS = MINUTE_MS;

const CHARTS: ChartSpec[] = [
  {
    id: "cpu",
    title: "CPU",
    reading: (sample) => sample.cpu.busy,
    format: percent,
    detail: ({ cpu }) =>
      joinParts([
        `user ${percent(cpu.user)}`,
        `system ${percent(cpu.system)}`,
        `iowait ${percent(cpu.iowait)}`,
        cpu.steal >= 1 ? `steal ${percent(cpu.steal)}` : null,
      ]),
    top: () => 100,
    levels: () => CPU_LEVELS,
  },
  {
    id: "memory",
    title: "Memory",
    reading: (sample) => sample.memory.usedPct,
    format: percent,
    detail: ({ memory }) =>
      `${bytes(memory.used)} of ${bytes(memory.total)} · ${memory.swapPct === null ? "no swap" : `swap ${percent(memory.swapPct)}`}`,
    top: () => 100,
    levels: () => MEMORY_LEVELS,
  },
  {
    id: "load",
    title: "Load",
    reading: (sample) => sample.load.one,
    format: twoFigures,
    detail: ({ load }) =>
      joinParts([
        `5m ${twoFigures(load.five)}`,
        `15m ${twoFigures(load.fifteen)}`,
        `${load.cores} cores`,
        load.running === null ? null : `${load.running} running`,
        (load.blocked ?? 0) > 0 ? `${load.blocked} blocked` : null,
      ]),
    top: (peak, { load }) => Math.max(peak, load.cores),
    // Linux counts tasks waiting on disk too, so a busy disk alone can carry it past the core count.
    levels: ({ load }) => [load.cores * 2, load.cores * 4],
  },
  {
    id: "cpu-pressure",
    title: "CPU wait",
    reading: (sample) => sample.pressure?.cpu ?? null,
    format: percent,
    detail: () => "programs waiting for a free CPU",
    top: () => 100,
    levels: () => PRESSURE_LEVELS,
  },
  {
    id: "memory-pressure",
    title: "Memory wait",
    reading: (sample) => sample.pressure?.memory ?? null,
    format: percent,
    detail: ({ pressure }) => `programs waiting for memory · fully stalled ${percent(pressure?.memoryFull ?? 0)}`,
    top: () => 100,
    levels: () => PRESSURE_LEVELS,
  },
  {
    id: "io-pressure",
    title: "Disk wait",
    reading: (sample) => sample.pressure?.io ?? null,
    format: percent,
    detail: ({ pressure }) => `programs waiting for storage · fully stalled ${percent(pressure?.ioFull ?? 0)}`,
    top: () => 100,
    levels: () => PRESSURE_LEVELS,
  },
  {
    id: "disk",
    title: "Disk",
    reading: ({ disk }) => disk && disk.read + disk.written,
    format: (value) => `${bytes(value)}/s`,
    detail: ({ disk }) => `read ${bytes(disk?.read ?? 0)}/s · write ${bytes(disk?.written ?? 0)}/s`,
    // A floor keeps an idle disk's few KiB/s from filling the chart.
    top: (peak) => Math.max(peak, 1024 * 1024),
    levels: () => null,
  },
  {
    id: "network",
    title: "Network",
    reading: ({ network }) => network && network.received + network.sent,
    format: (value) => `${bytes(value)}/s`,
    detail: ({ network }) => `in ${bytes(network?.received ?? 0)}/s · out ${bytes(network?.sent ?? 0)}/s`,
    top: (peak) => Math.max(peak, 128 * 1024),
    levels: () => null,
  },
];

/** What history keeps of a sample. */
export function pointOf(sample: Sample): Point {
  return Object.fromEntries(CHARTS.map(({ id, reading }) => [id, reading(sample)]));
}

function toneOf(value: number, levels: Levels | null): Tone {
  if (!levels) return "ok";
  if (value >= levels[1]) return "danger";
  return value >= levels[0] ? "warning" : "ok";
}

function fraction(value: number, top: number): number {
  return Math.round((value / top) * 1000) / 1000;
}

/** Each bar's average and peak of `id`, in the reading's own units. */
function bucket(rows: Row[], id: string, from: number, span: number, count: number) {
  const sums = Array.from({ length: count }, () => ({ sum: 0, count: 0, peak: Number.NEGATIVE_INFINITY }));
  for (const row of rows) {
    const value = row.values[id];
    const index = Math.min(count - 1, Math.floor(((row.at - from) / span) * count));
    const bar = sums[index];
    if (!value || !bar) continue;
    bar.sum += value[0];
    bar.count += 1;
    bar.peak = Math.max(bar.peak, value[1]);
  }
  return sums.map((bar) => (bar.count === 0 ? null : { average: bar.sum / bar.count, peak: bar.peak }));
}

/** Block heights, lowest first. */
const SPARK = "▁▂▃▄▅▆▇█";
const SPARK_MINUTES = 5;

/** A percentage's trend: one block per minute of the last five, by its average; minutes without samples, as after a restart, left out. */
function sparkline(rows: Row[], id: string, now: number): string {
  const span = SPARK_MINUTES * MINUTE_MS;
  return bucket(rows, id, now - span, span, SPARK_MINUTES)
    .flatMap((bar) => (bar === null ? [] : [SPARK[Math.min(SPARK.length - 1, Math.floor((bar.average / 100) * SPARK.length))]]))
    .join("");
}

function describeFilesystem({ path, type, at, stats }: Filesystem, now: number): FilesystemView {
  const { bsize, blocks, bfree, bavail, files, ffree } = stats;
  const used = (blocks - bfree) * bsize;
  const available = bavail * bsize;
  // As df counts it: blocks reserved for root are neither used nor free.
  const usedPct = used + available > 0 ? (used / (used + available)) * 100 : 0;
  const inodesPct = files > 0 ? ((files - ffree) / files) * 100 : 0;
  return {
    path,
    value: percent(usedPct),
    fraction: fraction(usedPct, 100),
    detail: joinParts([
      `${bytes(available)} free of ${bytes(blocks * bsize)}`,
      type,
      inodesPct >= FULL_LEVELS[0] ? `inodes ${percent(inodesPct)}` : null,
      now - at > FILESYSTEM_STALE_MS ? `last read ${ago(now - at)}` : null,
    ]),
    tone: worstTone([toneOf(usedPct, FULL_LEVELS), toneOf(inodesPct, FULL_LEVELS)]),
  };
}

/** The busiest processes as last measured. */
export interface ProcessesInput {
  /** What the CPU shares were measured over. */
  seconds: number;
  top: TopProcess[];
  /** `paseo.workspaces.list()` entries, as Paseo gave them. */
  workspaces: unknown;
  /** The daemon user's home: a workspace there contains nearly every process, so it names none. */
  home: string;
}

function describeProcesses(processes: ProcessesInput | "measuring"): NonNullable<SystemView["processes"]> {
  if (processes === "measuring") return { detail: "Measuring…", rows: [] };
  const { seconds, top, workspaces, home } = processes;
  // Deepest first, so a worktree inside its project's checkout claims its own processes.
  const directories = activeWorkspaces(workspaces, workspaceEntrySchema)
    .filter(({ directory }) => directory !== "" && directory !== home)
    .toSorted((first, second) => second.directory.length - first.directory.length);
  const rows = top.map(({ pid, name, cpu, memory, argv, cwd }): ProcessView => {
    const workspace = cwd === null ? undefined : directories.find(({ directory }) => cwd === directory || cwd.startsWith(`${directory}/`));
    // Some processes rewrite their arguments into one space-padded string: "/bin/k3s server      ".
    const words = argv
      .join(" ")
      .split(/\s+/)
      .filter((word) => word !== "");
    return {
      pid,
      cpu: percent(cpu),
      memory: memory === null ? "" : bytes(memory),
      // Kernel threads have no arguments; ps brackets their names. Paths shrink to their last part.
      command:
        words.length === 0
          ? `[${name}]`
          : words
              .map((word, index) => (index === 0 || word.startsWith("/") ? word.slice(word.lastIndexOf("/") + 1) || word : word))
              .join(" ")
              .slice(0, 200),
      detail: joinParts([`pid ${pid}`, workspace ? `in workspace ${workspace.label}` : null]),
    };
  });
  return { detail: `CPU as % of one core, over the last ${Math.round(seconds)} s`, rows };
}

export interface SystemInput {
  host: string;
  /** The latest sample; null before the second read. */
  latest: Sample | null;
  history: Pick<History, "rows">;
  filesystems: Filesystem[];
  /** Null where there is no /proc to read them from. */
  processes: ProcessesInput | "measuring" | null;
  request: { range: Range; bars: number } | null;
  now: number;
  error: string | null;
}

/** The latest sample worded for display, with bars over the requested range. */
export function buildSystemView({ host, latest, history, filesystems, processes, request, now, error }: SystemInput): SystemView {
  const filesystemViews = filesystems
    .filter(({ stats }) => stats.blocks > 0)
    .map((filesystem) => describeFilesystem(filesystem, now))
    .toSorted((first, second) => first.path.localeCompare(second.path));
  const processesView = request === null || processes === null ? null : describeProcesses(processes);
  if (!latest) {
    return {
      host,
      sampledAt: null,
      headline: null,
      charts: [],
      cores: null,
      filesystems: filesystemViews,
      processes: processesView,
      error,
    };
  }
  const span = request ? RANGE_MS[request.range] : 0;
  const rows = request ? history.rows(now - span, now) : [];
  const charts: Chart[] = CHARTS.flatMap((spec) => {
    const value = spec.reading(latest);
    if (value === null) return [];
    const bars = request ? bucket(rows, spec.id, now - span, span, request.bars) : [];
    const top = spec.top(Math.max(value, ...bars.map((bar) => bar?.peak ?? 0)), latest);
    const levels = spec.levels(latest);
    return [
      {
        id: spec.id,
        title: spec.title,
        value: spec.format(value),
        detail: spec.detail(latest),
        tone: toneOf(value, levels),
        scale: spec.format(top),
        average: bars.map((bar) => bar && fraction(bar.average, top)),
        peak: bars.map((bar) => bar && fraction(bar.peak, top)),
        tones: levels && bars.map((bar) => (bar ? toneOf(bar.average, levels) : "ok")),
      },
    ];
  });
  const recent = history.rows(now - SPARK_MINUTES * MINUTE_MS, now);
  const cpuMinute = bucket(recent, "cpu", now - MINUTE_MS, MINUTE_MS, 1)[0]?.average ?? latest.cpu.busy;
  const [cpuWarning] = CPU_LEVELS;
  const coreShares = latest.cores.map((busy) => fraction(busy, 100));
  const memory = { text: `mem ${percent(latest.memory.usedPct)}`, tone: toneOf(latest.memory.usedPct, MEMORY_LEVELS) };
  const loadTone = charts.find(({ id }) => id === "load")?.tone ?? "ok";
  const load = { text: `load ${twoFigures(latest.load.one)}`, tone: loadTone };
  return {
    host,
    sampledAt: latest.at,
    // Pressure has its own charts on the System screen. The sidebar row fits two readings beside its
    // label, so the second is memory unless load is worse.
    headline: [
      {
        text: ["cpu", sparkline(recent, "cpu", now), percent(cpuMinute)].filter((part) => part !== "").join(" "),
        tone: toneOf(cpuMinute, CPU_LEVELS),
      },
      worstTone([memory.tone, load.tone]) === memory.tone ? memory : load,
    ],
    charts,
    cores: request
      ? {
          title: `${latest.cores.length} cores`,
          detail: `busiest ${percent(Math.max(0, ...latest.cores))} · ${latest.cores.filter((busy) => busy >= cpuWarning).length} at ${cpuWarning}% or more`,
          average: coreShares,
          peak: coreShares,
          tones: latest.cores.map((busy) => toneOf(busy, CPU_LEVELS)),
        }
      : null,
    filesystems: filesystemViews,
    processes: processesView,
    error,
  };
}
