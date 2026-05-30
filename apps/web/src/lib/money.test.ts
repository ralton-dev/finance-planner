import { describe, expect, it } from "vitest";
import { formatMinor, toMajor, toMinor } from "./money.js";

describe("money", () => {
  it("formats minor units as currency", () => {
    expect(formatMinor(120_000, "GBP")).toBe("£1,200.00");
    expect(formatMinor(4_550, "GBP")).toBe("£45.50");
  });

  it("parses major-unit input to minor units", () => {
    expect(toMinor("12.50")).toBe(1250);
    expect(toMinor("£1,200")).toBe(120000);
    expect(toMinor("nonsense")).toBe(0);
  });

  it("round-trips through major units", () => {
    expect(toMajor(toMinor("99.99"))).toBe(99.99);
  });
});
