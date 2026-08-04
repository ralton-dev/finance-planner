import { describe, expect, it } from "vitest";
import { splitByShares } from "./money.js";

describe("splitByShares", () => {
  it("splits proportionally when every share is a whole minor unit", () => {
    expect(splitByShares(160_000, [6600, 3400])).toEqual([105_600, 54_400]);
  });

  it("rounds every share up rather than sharing a remainder out", () => {
    // 100 / 3 = 33.33 each. Flooring would leave someone contributing 33 and
    // the pot a penny short, so all three round up and the pot runs 2 over.
    const parts = splitByShares(100, [1, 1, 1]);
    expect(parts).toEqual([34, 34, 34]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(102);
  });

  it("never asks anyone for less than their exact share", () => {
    for (const amount of [1, 7, 99, 100, 1234, 99_999]) {
      for (const weights of [
        [6600, 3400],
        [1, 1, 1],
        [5000, 3000, 2000],
        [1, 2, 3, 4],
      ]) {
        const total = weights.reduce((s, w) => s + w, 0);
        const parts = splitByShares(amount, weights);
        parts.forEach((part, i) => {
          expect(Number.isInteger(part)).toBe(true);
          expect(part).toBeGreaterThanOrEqual((amount * weights[i]!) / total);
        });
        // …and never by more than a minor unit each.
        const sum = parts.reduce((s, p) => s + p, 0);
        expect(sum).toBeGreaterThanOrEqual(amount);
        expect(sum).toBeLessThanOrEqual(amount + weights.length - 1);
      }
    }
  });

  it("falls back to an equal split when total weight is zero", () => {
    expect(splitByShares(100, [0, 0])).toEqual([50, 50]);
    expect(splitByShares(100, [0, 0, 0])).toEqual([34, 34, 34]);
  });

  it("handles a single weight and a zero amount", () => {
    expect(splitByShares(500, [42])).toEqual([500]);
    expect(splitByShares(0, [1, 2, 3])).toEqual([0, 0, 0]);
  });

  it("ignores negative weights rather than crediting them", () => {
    expect(splitByShares(100, [-1, 1])).toEqual([0, 100]);
  });

  it("returns an empty array for no members", () => {
    expect(splitByShares(100, [])).toEqual([]);
  });
});
