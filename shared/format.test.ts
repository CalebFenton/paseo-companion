import { expect, it } from "vitest";
import { countdown } from "./format";

const MINUTE = 60_000;

it("rolls countdowns over at unit boundaries and shows at most two units", () => {
  expect(countdown(59.6 * MINUTE)).toBe("1h");
  expect(countdown(234 * MINUTE)).toBe("3h 54m");
  expect(countdown(43 * 60 * MINUTE)).toBe("1d 19h");
  expect(countdown(48 * 60 * MINUTE)).toBe("2d");
  expect(countdown(-5)).toBe("0m");
});

it("keeps only the largest unit when asked, rounding down", () => {
  expect(countdown(234 * MINUTE, { largest: true })).toBe("3h");
  expect(countdown(47 * 60 * MINUTE, { largest: true })).toBe("1d");
  expect(countdown(45 * MINUTE, { largest: true })).toBe("45m");
});
