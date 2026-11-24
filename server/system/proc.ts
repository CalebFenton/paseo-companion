import type { StatsFs } from "node:fs";

/** Text of the /proc files one read takes; `pressure` is null on kernels without PSI. */
export interface ProcFiles {
  stat: string;
  meminfo: string;
  loadavg: string;
  diskstats: string;
  netDev: string;
  pressure: { cpu: string; memory: string; io: string } | null;
}

/** Jiffies since boot. */
export interface CpuTimes {
  user: number;
  system: number;
  iowait: number;
  steal: number;
  idle: number;
}

/** Cumulative counters at one moment; rates come from two of them. */
export interface Counters {
  /** Epoch milliseconds. */
  at: number;
  cpu: CpuTimes;
  cores: CpuTimes[];
  /** Bytes. */
  memory: { total: number; available: number; swapTotal: number; swapFree: number };
  load: { one: number; five: number; fifteen: number; running: number | null; blocked: number | null };
  /** Microseconds stalled since boot. */
  pressure: { cpu: number; memory: number; memoryFull: number; io: number; ioFull: number } | null;
  /** Bytes moved since boot, by device or interface; null where the platform has no such file. */
  disks: Record<string, { read: number; written: number }> | null;
  interfaces: Record<string, { received: number; sent: number }> | null;
}

/** Rates over the interval between two reads. */
export interface Sample {
  at: number;
  /** Percent of all cores. */
  cpu: { busy: number; user: number; system: number; iowait: number; steal: number };
  /** Percent busy, per core. */
  cores: number[];
  memory: { usedPct: number; used: number; total: number; swapPct: number | null };
  load: Counters["load"] & { cores: number };
  /** Percent of the interval some (or, `…Full`, all) runnable tasks stalled on the resource. */
  pressure: Counters["pressure"];
  /** Bytes per second. */
  disk: { read: number; written: number } | null;
  network: { received: number; sent: number } | null;
}

/** Whole disks: partitions, device mapper, and loop devices would count the same bytes again. */
const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
/** Loopback, and bridges and veths, which carry container traffic the host interface carries too. */
const VIRTUAL_INTERFACE = /^(lo|veth|br-|docker|virbr|cni|flannel|cali)/;
const SECTOR_BYTES = 512;

/** A /proc/stat cpu line's times. */
function cpuTimes(line: string): CpuTimes {
  // user nice system idle iowait irq softirq steal; guest time is already inside user.
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  return { user: user + nice, system: system + irq + softirq, iowait, steal, idle };
}

/** /proc/stat's times for all cores together, then for each. */
function parseStat(stat: string): { cpu: CpuTimes; cores: CpuTimes[] } {
  const lines = stat.split("\n");
  const cpuLine = lines.find((line) => line.startsWith("cpu "));
  if (!cpuLine) throw new Error("No cpu line in /proc/stat");
  return { cpu: cpuTimes(cpuLine), cores: lines.filter((line) => /^cpu\d+ /.test(line)).map((line) => cpuTimes(line)) };
}

/** All the time the times cover, busy or idle. */
function jiffies({ user, system, iowait, steal, idle }: CpuTimes): number {
  return user + system + iowait + steal + idle;
}

/** "some avg10=… total=123" → 123, for the line starting with `kind`. */
function stallTotal(text: string, kind: "some" | "full"): number {
  const match = new RegExp(`^${kind} .*total=(\\d+)`, "m").exec(text);
  if (!match?.[1]) throw new Error(`No "${kind}" line in pressure file`);
  return Number(match[1]);
}

export function parseProc(files: ProcFiles, at: number): Counters {
  const counter = (name: string) => {
    const match = new RegExp(`^${name} (\\d+)`, "m").exec(files.stat);
    return match?.[1] ? Number(match[1]) : null;
  };
  const meminfo = new Map(
    files.meminfo.split("\n").flatMap((line) => {
      const match = /^(\w+):\s+(\d+)/.exec(line);
      return match?.[1] && match[2] ? [[match[1], Number(match[2]) * 1024] as const] : [];
    }),
  );
  const [one = 0, five = 0, fifteen = 0] = files.loadavg.trim().split(/\s+/).map(Number);
  const disks: NonNullable<Counters["disks"]> = {};
  for (const line of files.diskstats.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const name = fields[2];
    if (name && WHOLE_DISK.test(name)) {
      disks[name] = { read: Number(fields[5]) * SECTOR_BYTES, written: Number(fields[9]) * SECTOR_BYTES };
    }
  }
  const interfaces: NonNullable<Counters["interfaces"]> = {};
  for (const line of files.netDev.split("\n")) {
    const match = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined || VIRTUAL_INTERFACE.test(match[1])) continue;
    const fields = match[2].trim().split(/\s+/).map(Number);
    interfaces[match[1]] = { received: fields[0] ?? 0, sent: fields[8] ?? 0 };
  }
  return {
    at,
    ...parseStat(files.stat),
    memory: {
      total: meminfo.get("MemTotal") ?? 0,
      available: meminfo.get("MemAvailable") ?? meminfo.get("MemFree") ?? 0,
      swapTotal: meminfo.get("SwapTotal") ?? 0,
      swapFree: meminfo.get("SwapFree") ?? 0,
    },
    load: { one, five, fifteen, running: counter("procs_running"), blocked: counter("procs_blocked") },
    pressure: files.pressure && {
      cpu: stallTotal(files.pressure.cpu, "some"),
      memory: stallTotal(files.pressure.memory, "some"),
      memoryFull: stallTotal(files.pressure.memory, "full"),
      io: stallTotal(files.pressure.io, "some"),
      ioFull: stallTotal(files.pressure.io, "full"),
    },
    disks,
    interfaces,
  };
}

function cpuPercents(before: CpuTimes, after: CpuTimes) {
  const delta = (key: keyof CpuTimes) => Math.max(0, after[key] - before[key]);
  const spent = { user: delta("user"), system: delta("system"), iowait: delta("iowait"), steal: delta("steal"), idle: delta("idle") };
  const total = jiffies(spent);
  const pct = (value: number) => (total > 0 ? (value / total) * 100 : 0);
  // iowait is idle time with I/O outstanding: shown, but not busy.
  return {
    busy: pct(spent.user + spent.system + spent.steal),
    user: pct(spent.user),
    system: pct(spent.system),
    iowait: pct(spent.iowait),
    steal: pct(spent.steal),
  };
}

/** Per-second change of `key`, summed over the entries both reads have; ones that came or went between them are skipped. */
function rate<Key extends string>(
  before: Record<string, Record<Key, number>>,
  after: Record<string, Record<Key, number>>,
  key: Key,
  seconds: number,
): number {
  let total = 0;
  for (const [name, now] of Object.entries(after)) {
    const then = before[name];
    // A counter that went backwards was reset: its interface or device restarted.
    if (then) total += Math.max(0, now[key] - then[key]) / seconds;
  }
  return total;
}

export function measure(before: Counters, after: Counters): Sample {
  const seconds = Math.max(0.001, (after.at - before.at) / 1000);
  const { total, available, swapTotal, swapFree } = after.memory;
  const stalls = before.pressure && after.pressure ? { before: before.pressure, after: after.pressure } : null;
  // Stall totals are microseconds: per second of interval, 10,000 of them make one percent.
  const stalled = (key: keyof NonNullable<Counters["pressure"]>) =>
    stalls ? Math.min(100, Math.max(0, stalls.after[key] - stalls.before[key]) / (seconds * 10_000)) : 0;
  return {
    at: after.at,
    cpu: cpuPercents(before.cpu, after.cpu),
    cores: after.cores.map((core, index) => {
      const previous = before.cores[index];
      return previous ? cpuPercents(previous, core).busy : 0;
    }),
    memory: {
      usedPct: total > 0 ? ((total - available) / total) * 100 : 0,
      used: total - available,
      total,
      swapPct: swapTotal > 0 ? ((swapTotal - swapFree) / swapTotal) * 100 : null,
    },
    load: { ...after.load, cores: after.cores.length },
    pressure: stalls && {
      cpu: stalled("cpu"),
      memory: stalled("memory"),
      memoryFull: stalled("memoryFull"),
      io: stalled("io"),
      ioFull: stalled("ioFull"),
    },
    disk:
      before.disks && after.disks
        ? { read: rate(before.disks, after.disks, "read", seconds), written: rate(before.disks, after.disks, "written", seconds) }
        : null,
    network:
      before.interfaces && after.interfaces
        ? {
            received: rate(before.interfaces, after.interfaces, "received", seconds),
            sent: rate(before.interfaces, after.interfaces, "sent", seconds),
          }
        : null,
  };
}

/** A mounted filesystem, by the shortest path it is mounted at. */
export interface Mount {
  path: string;
  type: string;
  /** "/dev/sdb1", "192.0.2.10:/export". */
  source: string;
}

/** A mount's statfs at one moment. */
export interface Filesystem extends Mount {
  at: number;
  /** The fields read of the statfs result, so a test can give a plain object. */
  stats: Pick<StatsFs, "bsize" | "blocks" | "bfree" | "bavail" | "files" | "ffree">;
}

/**
 * Kernel and memory filesystems; container layers; read-only images, always full; and autofs,
 * which statfs would make mount.
 */
const SKIPPED_TYPES: Record<string, true> = {
  autofs: true,
  binfmt_misc: true,
  bpf: true,
  cgroup: true,
  cgroup2: true,
  configfs: true,
  debugfs: true,
  devpts: true,
  devtmpfs: true,
  efivarfs: true,
  fusectl: true,
  hugetlbfs: true,
  mqueue: true,
  nsfs: true,
  overlay: true,
  proc: true,
  pstore: true,
  ramfs: true,
  rpc_pipefs: true,
  securityfs: true,
  selinuxfs: true,
  squashfs: true,
  sysfs: true,
  tmpfs: true,
  tracefs: true,
};

/** /proc/self/mountinfo → one mount per filesystem, keeping the shortest path of its bind mounts. */
export function parseMounts(mountinfo: string): Mount[] {
  const byDevice = new Map<string, Mount>();
  for (const line of mountinfo.split("\n")) {
    // id parent major:minor root path options [optional…] - type source super-options
    const fields = line.split(" ");
    const separator = fields.indexOf("-", 6);
    const device = fields[2];
    const path = fields[4];
    const type = fields[separator + 1];
    const source = fields[separator + 2];
    if (separator < 0 || !device || !path || !type || source === undefined || SKIPPED_TYPES[type] === true) continue;
    // The kernel escapes space, tab, newline, and backslash in paths as octal.
    const mount = {
      path: path.replaceAll(/\\(\d{3})/g, (_match, octal: string) => String.fromCodePoint(Number.parseInt(octal, 8))),
      type,
      source,
    };
    const kept = byDevice.get(device);
    if (!kept || mount.path.length < kept.path.length) byDevice.set(device, mount);
  }
  return [...byDevice.values()];
}

/** /proc/stat and each process's /proc/[pid]/stat by pid, read together. */
export interface ProcessFiles {
  stat: string;
  processes: Record<string, string>;
}

/** CPU time at one moment, in jiffies. */
export interface ProcessCounters {
  at: number;
  /** All cores' time, busy or idle. */
  host: number;
  cores: number;
  /** By pid and start time, so a reused pid is not taken for the process that had it before. */
  processes: Record<string, { pid: number; name: string; ticks: number }>;
}

export function parseProcesses(files: ProcessFiles, at: number): ProcessCounters {
  const { cpu, cores } = parseStat(files.stat);
  const processes: ProcessCounters["processes"] = {};
  for (const [pid, text] of Object.entries(files.processes)) {
    // pid (comm) state …: comm may hold spaces and parentheses itself.
    const close = text.lastIndexOf(")");
    const open = text.indexOf("(");
    if (open < 0 || close < open) continue;
    // From field 3, state, on: utime and stime are fields 14 and 15, starttime field 22.
    const fields = text.slice(close + 2).split(" ");
    processes[`${pid} ${fields[19]}`] = {
      pid: Number(pid),
      name: text.slice(open + 1, close),
      ticks: Number(fields[11]) + Number(fields[12]),
    };
  }
  return { at, host: jiffies(cpu), cores: cores.length, processes };
}

export interface BusyProcess {
  pid: number;
  /** comm: "node", "kworker/3:1". */
  name: string;
  /** Percent of one core over the interval: 250 is two and a half cores. */
  cpu: number;
}

/** The `count` processes that used the most CPU between two reads. */
export function busiestProcesses(before: ProcessCounters, after: ProcessCounters, count: number): BusyProcess[] {
  // The host's jiffies stand in for the clock, so neither the tick rate nor the read's own delay matters.
  const coreJiffies = (after.host - before.host) / after.cores;
  if (coreJiffies <= 0) return [];
  const busy: BusyProcess[] = [];
  for (const [key, { pid, name, ticks }] of Object.entries(after.processes)) {
    // One the previous read did not see started since: all its time falls in the interval.
    const used = ticks - (before.processes[key]?.ticks ?? 0);
    if (used > 0) busy.push({ pid, name, cpu: (used / coreJiffies) * 100 });
  }
  return busy.toSorted((first, second) => second.cpu - first.cpu).slice(0, count);
}

/** One process's /proc/[pid]/status and cmdline, and where its cwd link points; null where unreadable, as another user's cwd is. */
export interface ProcessDetailFiles {
  status: string | null;
  cmdline: string | null;
  cwd: string | null;
}

export interface TopProcess extends BusyProcess {
  /** Resident bytes; null for kernel threads. */
  memory: number | null;
  /** Empty for kernel threads. */
  argv: string[];
  cwd: string | null;
}

export function topProcess(busy: BusyProcess, { status, cmdline, cwd }: ProcessDetailFiles): TopProcess {
  const rss = status && /^VmRSS:\s+(\d+) kB/m.exec(status)?.[1];
  return {
    ...busy,
    memory: rss ? Number(rss) * 1024 : null,
    argv: cmdline ? cmdline.split("\0").filter((arg) => arg !== "") : [],
    cwd,
  };
}
