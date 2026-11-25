import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import { toneSchema } from "./tone.ts";

/** How often the daemon side samples, and an open System screen polls it. */
export const SAMPLE_MS = 2_000;

/** How far back the charts reach. */
export const RANGES = ["30m", "1h", "6h", "24h", "7d"] as const;
const rangeSchema = z.enum(RANGES);
export type Range = z.infer<typeof rangeSchema>;

const chartIdSchema = z.enum(["cpu", "memory", "load", "cpu-pressure", "memory-pressure", "io-pressure", "disk", "network"]);
export type ChartId = z.infer<typeof chartIdSchema>;

/**
 * Bars, oldest first, as fractions of the chart's top: each bar's average, and its peak, so a
 * spike survives a long range. Null where nothing was sampled. `tones`: each bar's, by its
 * average, since its peak is one sample, which a build pins for seconds at a time; null for
 * throughput, which has no bad level.
 */
const barsSchema = z.object({
  average: z.array(z.number().nullable()),
  peak: z.array(z.number().nullable()),
  tones: z.array(toneSchema).nullable(),
});
export type Bars = z.infer<typeof barsSchema>;

const chartSchema = barsSchema.extend({
  id: chartIdSchema,
  title: z.string(),
  /** The latest sample: "43%". */
  value: z.string(),
  /** Its breakdown: "user 30% · system 10% · iowait 3%". */
  detail: z.string(),
  tone: toneSchema,
  /** The chart's top: "100%", "214", "812 MiB/s". */
  scale: z.string(),
});
export type Chart = z.infer<typeof chartSchema>;

const filesystemSchema = z.object({
  /** "/srv/data". */
  path: z.string(),
  /** Used share of the space users can fill, as df counts it: "80%". */
  value: z.string(),
  fraction: z.number(),
  /** "691 GiB free of 3.5 TiB · ext4", with inodes when they run short and the read's age when it is old. */
  detail: z.string(),
  /** By the fuller of space and inodes. */
  tone: toneSchema,
});
export type FilesystemView = z.infer<typeof filesystemSchema>;

const processSchema = z.object({
  pid: z.number(),
  /** "250%": of one core, so two and a half cores. */
  cpu: z.string(),
  /** Resident: "1.2 GiB"; empty for kernel threads. */
  memory: z.string(),
  /** "node paseo daemon", "[kworker/3:1]". */
  command: z.string(),
  /** "pid 4121 · in workspace fix-login", the workspace found by its working directory. */
  detail: z.string(),
});
export type ProcessView = z.infer<typeof processSchema>;

/** The host's view, pushed on subscribing and after every sample. */
export const systemFeed = defineSubscription({
  name: "system.feed",
  input: z.object({
    /** Null: the latest sample only, with bars and cores left empty. */
    history: z.object({ range: rangeSchema, bars: z.number().int().min(10).max(240) }).nullable(),
  }),
  event: z.object({
    host: z.string(),
    /** Epoch milliseconds; null until two reads made a first sample. */
    sampledAt: z.number().nullable(),
    /**
     * Two readings, each toned on its own so the sidebar row says which one is the problem:
     * "cpu ▂▃▅▇▆ 43%" (each of the last five minutes' average as a block, then the last minute's,
     * which a build's seconds at full load do not pin), then "mem 32%", or "load 146" when load is
     * worse than memory. The row does not truncate, and a third reading runs into its label.
     */
    headline: z.array(z.object({ text: z.string(), tone: toneSchema })).nullable(),
    charts: z.array(chartSchema),
    /** Busy share of every core in the latest sample; only with history. */
    cores: barsSchema.extend({ title: z.string(), detail: z.string() }).nullable(),
    /** By path; one per filesystem, however many places it is mounted. */
    filesystems: z.array(filesystemSchema),
    /** The busiest processes; only with history, on hosts with /proc. */
    processes: z
      .object({
        /** "CPU as % of one core, over the last 10 s"; says so while the first two reads are pending. */
        detail: z.string(),
        rows: z.array(processSchema),
      })
      .nullable(),
    /** Each kind of read that is failing, by its last failure: "ENOENT: /proc/pressure/cpu". */
    error: z.string().nullable(),
  }),
});
export type SystemView = z.output<typeof systemFeed.event>;
export type SystemRequest = z.output<typeof systemFeed.input>;
