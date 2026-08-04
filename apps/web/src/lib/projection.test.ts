import { describe, expect, it } from "vitest";
import { buildProjectionPoints, hasTransfers, type ProjectionMonthLike } from "./projection.js";

/** A month with nothing moving, so each test states only what it is about. */
function month(over: Partial<ProjectionMonthLike> = {}): ProjectionMonthLike {
  return {
    month: "2026-08",
    totalRequiredMinor: 40_000,
    leftoverMinor: 100_000,
    shortfallMinor: 0,
    reservedEndMinor: 0,
    lines: [],
    ...over,
  };
}

// Money moving between accounts stopped being a household feature: two accounts
// one person owns move money between them with no household anywhere. These
// views used to be able to read only the household's answer.
describe("money that has to move", () => {
  it("reads a household's transfers", () => {
    expect(hasTransfers([month({ transfersTotalMinor: 20_000 })])).toBe(true);
    expect(buildProjectionPoints([month({ transfersTotalMinor: 20_000 })])[0]?.transfers).toBe(
      20_000,
    );
  });

  it("reads an account's own outbound movements the same way", () => {
    expect(hasTransfers([month({ outboundInflowMinor: 30_320 })])).toBe(true);
    expect(buildProjectionPoints([month({ outboundInflowMinor: 30_320 })])[0]?.transfers).toBe(
      30_320,
    );
  });

  it("says nothing for a projection that tracks no movement at all", () => {
    expect(hasTransfers([month()])).toBe(false);
    expect(buildProjectionPoints([month()])[0]?.transfers).toBeNull();
  });

  it("does not mistake a zero for a gap", () => {
    // Zero is an answer — "nothing moves this month" — and must not fall
    // through to the other scope's field or to null.
    expect(
      buildProjectionPoints([month({ transfersTotalMinor: 0, outboundInflowMinor: 5 })])[0]
        ?.transfers,
    ).toBe(0);
    expect(hasTransfers([month({ outboundInflowMinor: 0 })])).toBe(false);
  });
});
