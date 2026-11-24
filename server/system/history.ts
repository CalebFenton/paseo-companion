import { z } from "zod";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../shared/format";

/** One sample's charted readings by chart id; null where the platform has no such reading. */
export type Point = Record<string, number | null>;

/** A stretch of samples: per chart id, their average and peak. Minutes persist as one JSON line each. */
export const rowSchema = z.object({
  at: z.number(),
  values: z.record(z.string(), z.tuple([z.number(), z.number()]).nullable()),
});
export type Row = z.infer<typeof rowSchema>;

/** Every sample stays this long; ranges no longer than this chart them. */
const FINE_MS = HOUR_MS;
/** Minutes stay this long. */
export const COARSE_MS = 7 * DAY_MS;

function tenths(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface History {
  /** Takes a sample, each reading to one decimal; returns the minute it closed by starting the next one, for persisting. */
  add(at: number, point: Point): Row | null;
  /** Rows from `from` on: samples where they reach back that far, else minutes, the open one included. */
  rows(from: number, now: number): Row[];
}

interface OpenMinute {
  at: number;
  readings: Map<string, { sum: number; count: number; peak: number } | null>;
}

function summarize({ at, readings }: OpenMinute): Row {
  const values: Row["values"] = {};
  for (const [id, reading] of readings) {
    values[id] = reading && [tenths(reading.sum / reading.count), reading.peak];
  }
  return { at, values };
}

/** `minutes`: persisted ones, oldest first. */
export function createHistory(minutes: Row[]): History {
  let coarse = minutes;
  const fine: Row[] = [];
  let open: OpenMinute | null = null;
  return {
    add(at, sampled) {
      const point = Object.entries(sampled).map(([id, value]) => [id, value === null ? null : tenths(value)] as const);
      fine.push({ at, values: Object.fromEntries(point.map(([id, value]) => [id, value === null ? null : [value, value]])) });
      while (fine[0] && fine[0].at < at - FINE_MS) fine.shift();
      const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS;
      let closed: Row | null = null;
      if (open && open.at !== minute) {
        closed = summarize(open);
        coarse = [...coarse.filter((row) => row.at >= at - COARSE_MS), closed];
        open = null;
      }
      open ??= { at: minute, readings: new Map() };
      for (const [id, value] of point) {
        const reading = open.readings.get(id);
        if (value === null) open.readings.set(id, reading ?? null);
        else if (reading)
          open.readings.set(id, { sum: reading.sum + value, count: reading.count + 1, peak: Math.max(reading.peak, value) });
        else open.readings.set(id, { sum: value, count: 1, peak: value });
      }
      return closed;
    },
    rows(from, now) {
      if (now - from <= FINE_MS) {
        // After a restart, samples reach back only to it; minutes fill in before.
        const firstSample = fine[0]?.at ?? Number.POSITIVE_INFINITY;
        return [...coarse.filter((row) => row.at >= from && row.at + MINUTE_MS <= firstSample), ...fine.filter((row) => row.at >= from)];
      }
      return [...coarse, ...(open ? [summarize(open)] : [])].filter((row) => row.at >= from);
    },
  };
}
