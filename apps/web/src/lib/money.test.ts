import { describe, expect, it } from "vitest";
import { formatCompactMinor, formatMinor, toMajor, toMinor } from "./money.js";

describe("money", () => {
  it("formats minor units as currency", () => {
    expect(formatMinor(120_000, "GBP")).toBe("£1,200.00");
    expect(formatMinor(4_550, "GBP")).toBe("£45.50");
  });

  // ICU flip-flops between "1.4K" and "1.4k" across Node builds; the compact
  // formatter normalises it so charts and grids render identically everywhere.
  it("uppercases the compact suffix whatever ICU says", () => {
    expect(formatCompactMinor(140_000, "GBP")).toBe("£1.4K");
    expect(formatCompactMinor(1_400_000, "GBP")).toBe("£14K");
    expect(formatCompactMinor(120_000_000, "GBP")).toBe("£1.2M");
  });

  it("leaves small amounts uncompacted", () => {
    expect(formatCompactMinor(8_250, "GBP")).toBe("£82.5");
    expect(formatCompactMinor(0, "GBP")).toBe("£0");
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
