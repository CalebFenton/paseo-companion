import { describe, expect, it } from "vitest";
import { createCachedRead } from "./cached-read";

describe("createCachedRead", () => {
  it("keeps the last good value when a read fails, so accounts survive a timeout", async () => {
    let clock = 0;
    const cache = createCachedRead<{ run: number }>({ now: () => clock });
    await cache.get(60_000, () => Promise.resolve({ run: 1 }));
    clock = 90_000;
    const result = await cache.get(60_000, () => Promise.reject(new Error("omp usage timed out after 20s")));
    expect(result).toEqual({ value: { run: 1 }, error: "omp usage timed out after 20s", at: 90_000 });
  });

  it("waits as long after a failure as after a success, unless a caller asks for fresher", async () => {
    let clock = 0;
    let runs = 0;
    const cache = createCachedRead<never>({ now: () => clock });
    const read = () => {
      runs++;
      return Promise.reject(new Error("omp: not signed in"));
    };
    await cache.get(120_000, read);
    clock = 60_000;
    await cache.get(120_000, read);
    expect(runs).toBe(1);
    await cache.get(10_000, read);
    expect(runs).toBe(2);
    clock = 200_000;
    await cache.get(120_000, read);
    expect(runs).toBe(3);
  });

  it("joins a read in flight instead of starting a second one", async () => {
    let runs = 0;
    const { promise, resolve } = Promise.withResolvers<number>();
    const cache = createCachedRead<number>();
    const read = () => {
      runs++;
      return promise;
    };
    const first = cache.get(0, read);
    const second = cache.get(0, read);
    resolve(7);
    expect((await first).value).toBe(7);
    expect((await second).value).toBe(7);
    expect(runs).toBe(1);
  });

  it("reads again after invalidate, however fresh the last value", async () => {
    let runs = 0;
    const cache = createCachedRead<number>();
    const read = () => Promise.resolve(++runs);
    await cache.get(Number.POSITIVE_INFINITY, read);
    cache.invalidate();
    expect((await cache.get(Number.POSITIVE_INFINITY, read)).value).toBe(2);
  });
});
