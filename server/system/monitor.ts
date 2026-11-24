import { readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readlink, statfs, writeFile } from "node:fs/promises";
import { cpus, freemem, homedir, hostname, loadavg, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";
import { DAY_MS, errorMessage, joinParts } from "../../shared/format";
import { PLUGIN_ID } from "../../shared/plugin";
import { SAMPLE_MS, type SystemRequest, type SystemView } from "../../shared/system";
import { COARSE_MS, createHistory, type Row, rowSchema } from "./history";
import {
  busiestProcesses,
  type Counters,
  type CpuTimes,
  type Filesystem,
  type Mount,
  measure,
  type ProcessCounters,
  type ProcessFiles,
  type ProcFiles,
  parseMounts,
  parseProc,
  parseProcesses,
  type Sample,
  topProcess,
} from "./proc";
import { buildSystemView, type ProcessesInput, pointOf } from "./view";

/** Fullness moves slowly, and a statfs on a network mount is a round trip. */
const FILESYSTEM_MS = 10_000;
/** A statfs slower than this is left running, and its mount skipped until it returns. */
const STATFS_WAIT_MS = 2_000;
/** Each stuck statfs holds one of libuv's four threads, which the rest of the daemon needs too. */
const MAX_PENDING_STATFS = 2;
/** Every process's CPU time is read this often while a System screen is open. */
const PROCESS_MS = 10_000;
const TOP_PROCESSES = 10;
/** Processes read synchronously between yields to the event loop. */
const PROCESS_CHUNK = 500;

function readProc(name: string): Promise<string> {
  return readFile(`/proc/${name}`, "utf8");
}

async function readLinux(): Promise<ProcFiles> {
  const [stat, meminfo, loadavgText, diskstats, netDev] = await Promise.all([
    readProc("stat"),
    readProc("meminfo"),
    readProc("loadavg"),
    readProc("diskstats"),
    readProc("net/dev"),
  ]);
  // Kernels built without PSI have no /proc/pressure.
  const pressure = await Promise.all([readProc("pressure/cpu"), readProc("pressure/memory"), readProc("pressure/io")]).then(
    ([cpu, memory, io]) => ({ cpu, memory, io }),
    () => null,
  );
  return { stat, meminfo, loadavg: loadavgText, diskstats, netDev, pressure };
}

/** Elsewhere, macOS included, Node's view: no pressure, disk, network, or swap. */
function readPortable(at: number): Counters {
  const cores = cpus().map(({ times }) => ({
    user: times.user + times.nice,
    system: times.sys + times.irq,
    iowait: 0,
    steal: 0,
    idle: times.idle,
  }));
  const total = (key: keyof CpuTimes) => cores.reduce((sum, core) => sum + core[key], 0);
  const cpu = { user: total("user"), system: total("system"), iowait: 0, steal: 0, idle: total("idle") };
  const [one = 0, five = 0, fifteen = 0] = loadavg();
  return {
    at,
    cpu,
    cores,
    memory: { total: totalmem(), available: freemem(), swapTotal: 0, swapFree: 0 },
    load: { one, five, fifteen, running: null, blocked: null },
    pressure: null,
    disks: null,
    interfaces: null,
  };
}

async function readMounts(): Promise<Mount[]> {
  if (process.platform === "linux") return parseMounts(await readFile("/proc/self/mountinfo", "utf8"));
  return [{ path: "/", type: "", source: "" }];
}

/** The last week's minutes, rewriting the file without older ones and any line a crash tore. */
async function trimMinutes(path: string, now: number): Promise<Row[]> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  const minutes = text.split("\n").flatMap((line) => {
    if (!line) return [];
    try {
      const row = rowSchema.safeParse(JSON.parse(line));
      return row.success && row.data.at >= now - COARSE_MS ? [row.data] : [];
    } catch {
      return [];
    }
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, minutes.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return minutes;
}

/**
 * /proc/stat and every process's stat. Synchronous, in chunks: through libuv's threads the same
 * reads take ten times the CPU (750 ms against 75 ms for 3,800 processes).
 */
async function readProcessFiles(): Promise<ProcessFiles> {
  const pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  const processes: Record<string, string> = {};
  for (const [index, pid] of pids.entries()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- yields to the event loop between chunks
    if (index > 0 && index % PROCESS_CHUNK === 0) await setImmediate();
    try {
      processes[pid] = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      // It exited since the listing.
    }
  }
  return { stat: readFileSync("/proc/stat", "utf8"), processes };
}

/** Details only the busiest get; a process gone meanwhile, or another user's cwd, reads as null. */
async function readTopProcess(pid: number) {
  const [status, cmdline, cwd] = await Promise.all([
    readFile(`/proc/${pid}/status`, "utf8").catch(() => null),
    readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => null),
    readlink(`/proc/${pid}/cwd`).catch(() => null),
  ]);
  return { status, cmdline, cwd };
}

/** Jobs record their own failures through `attempt`, so one that escapes is a bug. */
function unexpected(error: unknown): void {
  console.error("System monitor: unexpected failure", error);
}

/** A subscription that wants history; it gets the process rows while its signal has not aborted. */
type Watcher = Pick<PluginSubscriptionContext, "paseo" | "signal">;

/**
 * Samples this host while the plugin runs, persisting closed minutes under PASEO_HOME, and reads how
 * full each filesystem is. `sampled` runs after each sample, failed ones included.
 */
export function createSystemMonitor(sampled: () => void) {
  const path = join(process.env["PASEO_HOME"] ?? join(homedir(), ".paseo"), "plugin-data", PLUGIN_ID, "system-history.jsonl");
  const host = hostname();
  let history = createHistory([]);
  const filesystems = new Map<string, Filesystem>();
  let previous: Counters | null = null;
  let latest: Sample | null = null;
  let sampling = false;
  let statting = false;
  /** Mounts whose statfs has not returned. */
  const pending = new Set<string>();
  const watchers = new Set<Watcher>();
  let watching = false;
  let processes: ProcessesInput | null = null;
  /** Each job's last failure, until it next succeeds, so one job's success does not hide another's failure. */
  const failures: Record<"sample" | "history" | "filesystems" | "processes", string | null> = {
    sample: null,
    history: null,
    filesystems: null,
    processes: null,
  };
  const timers: ReturnType<typeof setInterval>[] = [];
  const lifetime = new AbortController();

  const attempt = async (job: keyof typeof failures, run: () => Promise<void>) => {
    try {
      await run();
      failures[job] = null;
    } catch (failure) {
      const message = errorMessage(failure);
      // Once per distinct failure, not every tick.
      if (message !== failures[job]) console.error(`System monitor: ${job} failed`, failure);
      failures[job] = message;
    }
  };

  const sample = async () => {
    // A read slower than the interval, on a swamped host, skips the ticks it overlaps.
    if (sampling) return;
    sampling = true;
    await attempt("sample", async () => {
      const at = Date.now();
      const counters = process.platform === "linux" ? parseProc(await readLinux(), at) : readPortable(at);
      const before = previous;
      previous = counters;
      if (!before) return;
      latest = measure(before, counters);
      const closed = history.add(latest.at, pointOf(latest));
      if (!closed) return;
      await attempt("history", async () => {
        await appendFile(path, `${JSON.stringify(closed)}\n`);
        // Start trims the file too, but a plugin can run for weeks.
        if (closed.at % DAY_MS === 0) await trimMinutes(path, closed.at);
      });
    });
    sampling = false;
    sampled();
  };

  /** Mounts the plugin may not look into, docker's volumes among them, are left out, as df does. */
  const statMount = async (mount: Mount) => {
    try {
      const stats = await statfs(mount.path);
      filesystems.set(mount.path, { ...mount, at: Date.now(), stats });
    } catch {
      filesystems.delete(mount.path);
    } finally {
      pending.delete(mount.path);
    }
  };

  const statAll = async () => {
    if (statting) return;
    statting = true;
    await attempt("filesystems", async () => {
      const mounts = await readMounts();
      const paths = new Set(mounts.map((mount) => mount.path));
      for (const mounted of filesystems.keys()) if (!paths.has(mounted)) filesystems.delete(mounted);
      for (const mount of mounts) {
        if (pending.has(mount.path)) continue;
        // Past this many stuck, the rest go stale rather than starve the daemon's own file reads.
        if (pending.size >= MAX_PENDING_STATFS) break;
        pending.add(mount.path);
        // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time; a dead network mount's never returns, and its last reading stays, aging, until it does
        await Promise.race([statMount(mount), sleep(STATFS_WAIT_MS)]);
      }
    });
    statting = false;
  };

  /**
   * Every process's CPU time while any watcher is subscribed; the first rows come a sample interval
   * after the first subscribes. Checked before each read, not on abort, so a screen that subscribes
   * again, as a range change does, keeps its rows.
   */
  const watchProcesses = async () => {
    watching = true;
    let before: ProcessCounters | null = null;
    const measureProcesses = async () => {
      const counters = parseProcesses(await readProcessFiles(), Date.now());
      const earlier = before;
      before = counters;
      if (!earlier) return;
      const [watcher] = watchers;
      const [top, workspaces] = await Promise.all([
        Promise.all(
          busiestProcesses(earlier, counters, TOP_PROCESSES).map(async (busy) => topProcess(busy, await readTopProcess(busy.pid))),
        ),
        // Without them, rows just lack their workspace.
        watcher?.paseo.workspaces.list().then(
          ({ entries }) => entries,
          () => [],
        ) ?? [],
      ]);
      processes = { seconds: (counters.at - earlier.at) / 1000, top, workspaces, home: homedir() };
    };
    while (watchers.size > 0 && !lifetime.signal.aborted) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- polls: each read waits out the last one's interval
      await attempt("processes", measureProcesses);
      // Rejects on stop, which the loop's condition then sees.
      // oxlint-disable-next-line eslint/no-await-in-loop -- the poll interval
      await sleep(processes ? PROCESS_MS : SAMPLE_MS, undefined, { signal: lifetime.signal }).catch(() => {});
    }
    watching = false;
    processes = null;
    failures.processes = null;
  };

  /** `job` now and every `ms`. */
  const repeat = (job: () => Promise<void>, ms: number) => {
    const run = () => {
      job().catch(unexpected);
    };
    run();
    timers.push(setInterval(run, ms));
  };

  const start = async () => {
    await attempt("history", async () => {
      history = createHistory(await trimMinutes(path, Date.now()));
    });
    if (lifetime.signal.aborted) return;
    repeat(sample, SAMPLE_MS);
    repeat(statAll, FILESYSTEM_MS);
  };
  start().catch(unexpected);

  return {
    view: ({ history: request }: SystemRequest, watcher: Watcher): SystemView => {
      const linux = process.platform === "linux";
      if (request && linux && !watchers.has(watcher)) {
        watchers.add(watcher);
        watcher.signal.addEventListener(
          "abort",
          () => {
            watchers.delete(watcher);
          },
          { once: true },
        );
        if (!watching) watchProcesses().catch(unexpected);
      }
      const error = joinParts(Object.values(failures));
      return buildSystemView({
        host,
        latest,
        history,
        filesystems: [...filesystems.values()],
        processes: linux ? (processes ?? "measuring") : null,
        request,
        now: Date.now(),
        error: error === "" ? null : error,
      });
    },
    stop: () => {
      lifetime.abort();
      for (const timer of timers) clearInterval(timer);
    },
  };
}
