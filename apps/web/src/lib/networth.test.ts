import { describe, expect, it } from "vitest";
import { buildNetWorthSeries, seriesCurrencies, type AccountBalanceHistory } from "./networth.js";
import type { BalanceSnapshotDto } from "./types.js";

function snap(accountId: string, asOfDate: string, balanceMinor: number): BalanceSnapshotDto {
  return {
    id: `${accountId}-${asOfDate}`,
    accountId,
    asOfDate,
    balanceMinor,
    createdAt: `${asOfDate}T09:00:00.000Z`,
  };
}

function history(
  id: string,
  currency: string,
  snapshots: BalanceSnapshotDto[],
): AccountBalanceHistory {
  return { account: { id, currency }, snapshots };
}

const march = new Date("2026-03-15T12:00:00.000Z");

describe("buildNetWorthSeries", () => {
  it("returns nothing when no account has ever been checked in", () => {
    expect(buildNetWorthSeries([], march)).toEqual([]);
    expect(buildNetWorthSeries([history("a1", "GBP", [])], march)).toEqual([]);
  });

  it("carries the last balance forward through months with no check-in", () => {
    const series = buildNetWorthSeries(
      [history("a1", "GBP", [snap("a1", "2026-01-10", 100_000)])],
      march,
    );

    expect(series.map((p) => p.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(series.map((p) => p.totals.GBP)).toEqual([100_000, 100_000, 100_000]);
  });

  it("uses the latest snapshot in a month and restates from there", () => {
    const series = buildNetWorthSeries(
      [
        history("a1", "GBP", [
          snap("a1", "2026-01-05", 100_000),
          snap("a1", "2026-01-20", 140_000),
          snap("a1", "2026-03-02", 90_000),
        ]),
      ],
      march,
    );

    expect(series.map((p) => p.totals.GBP)).toEqual([140_000, 140_000, 90_000]);
  });

  it("buckets a snapshot dated on the 31st into that month, not the next", () => {
    const series = buildNetWorthSeries(
      [history("a1", "GBP", [snap("a1", "2026-01-31", 55_000)])],
      march,
    );

    expect(series[0]).toEqual({ month: "2026-01", totals: { GBP: 55_000 } });
    expect(series[1]?.totals.GBP).toBe(55_000);
  });

  it("sums accounts sharing a currency and keeps currencies apart", () => {
    const series = buildNetWorthSeries(
      [
        history("a1", "GBP", [snap("a1", "2026-01-10", 100_000)]),
        history("a2", "GBP", [snap("a2", "2026-01-10", 25_000)]),
        history("a3", "EUR", [snap("a3", "2026-01-10", 70_000)]),
      ],
      march,
    );

    expect(series[0]?.totals).toEqual({ GBP: 125_000, EUR: 70_000 });
    expect(seriesCurrencies(series)).toEqual(["GBP", "EUR"]);
  });

  it("leaves a currency out until one of its accounts has been checked in", () => {
    const series = buildNetWorthSeries(
      [
        history("a1", "GBP", [snap("a1", "2026-01-10", 100_000)]),
        history("a2", "EUR", [snap("a2", "2026-03-01", 70_000)]),
      ],
      march,
    );

    expect(series[0]?.totals).toEqual({ GBP: 100_000 });
    expect(series[1]?.totals).toEqual({ GBP: 100_000 });
    expect(series[2]?.totals).toEqual({ GBP: 100_000, EUR: 70_000 });
  });

  it("keeps negative balances (overdrafts) in the total", () => {
    const series = buildNetWorthSeries(
      [
        history("a1", "GBP", [snap("a1", "2026-03-01", 100_000)]),
        history("a2", "GBP", [snap("a2", "2026-03-01", -30_000)]),
      ],
      march,
    );

    expect(series.at(-1)?.totals.GBP).toBe(70_000);
  });

  it("walks across the year boundary", () => {
    const series = buildNetWorthSeries(
      [history("a1", "GBP", [snap("a1", "2025-11-20", 10_000)])],
      new Date("2026-02-01T00:00:00.000Z"),
    );

    expect(series.map((p) => p.month)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("extends the range to cover a future-dated check-in", () => {
    const series = buildNetWorthSeries(
      [history("a1", "GBP", [snap("a1", "2026-05-01", 10_000)])],
      march,
    );

    expect(series.map((p) => p.month)).toEqual(["2026-05"]);
  });
});
