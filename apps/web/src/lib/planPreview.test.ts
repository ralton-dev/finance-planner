import { describe, expect, it } from "vitest";
import type { AccountPlanDto, PlanLineDto } from "./types.js";
import { summarizePreview } from "./planPreview.js";

function line(paymentId: string, name: string, onTrack: boolean): PlanLineDto {
  return {
    paymentId,
    name,
    category: "fixed_point",
    amountMinor: 100_000,
    dueDate: "2026-12-01",
    targetDate: "2026-12-01",
    monthsUntilDue: 4,
    requiredMonthlyMinor: 25_000,
    fundedMonthlyMinor: onTrack ? 25_000 : 10_000,
    alreadySavedMinor: 0,
    onTrack,
  };
}

/** Covered, but only by money nobody has moved yet. Still `onTrack`. */
function awaiting(paymentId: string, name: string): PlanLineDto {
  return { ...line(paymentId, name, true), status: "awaiting_transfer" };
}

function plan(over: Partial<AccountPlanDto>): AccountPlanDto {
  return {
    accountId: "acc",
    asOfDate: "2026-08-04",
    currency: "GBP",
    monthlyIncomeMinor: 300_000,
    bufferMinor: 0,
    totalRequiredMinor: 0,
    totalFundedMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    lines: [],
    contributionsMTD: [],
    latestBalance: null,
    reservedMinor: 0,
    ...over,
  };
}

describe("summarizePreview", () => {
  it("reports the leftover and shortfall move", () => {
    const impact = summarizePreview(
      plan({ leftoverMinor: 200_000, shortfallMinor: 0 }),
      plan({ leftoverMinor: 150_000, shortfallMinor: 0 }),
    );
    expect(impact).toMatchObject({
      leftoverFromMinor: 200_000,
      leftoverToMinor: 150_000,
      leftoverWorse: true,
      shortfallWorse: false,
      unchanged: false,
    });
  });

  it("does not call an improvement a worsening", () => {
    const impact = summarizePreview(
      plan({ leftoverMinor: 0, shortfallMinor: 50_000 }),
      plan({ leftoverMinor: 10_000, shortfallMinor: 0 }),
    );
    expect(impact.leftoverWorse).toBe(false);
    expect(impact.shortfallWorse).toBe(false);
  });

  it("names existing goals that flip from on-track to off-track", () => {
    const base = plan({ lines: [line("p1", "car insurance", true), line("p2", "holiday", false)] });
    const preview = plan({
      lines: [
        line("p1", "car insurance", false),
        line("p2", "holiday", false),
        line("new", "new telly", false),
      ],
    });
    expect(summarizePreview(base, preview).newlyAtRisk).toEqual(["car insurance"]);
  });

  it("names goals the draft pushes onto money that has not moved", () => {
    // `onTrack` is true on both sides, so the old comparison saw nothing at all
    // and the strip said "no goal falls behind" while quietly making one depend
    // on a transfer.
    const base = plan({ lines: [line("p1", "car insurance", true)] });
    const preview = plan({ lines: [awaiting("p1", "car insurance"), line("new", "telly", true)] });

    const impact = summarizePreview(base, preview);
    expect(impact.newlyAwaiting).toEqual(["car insurance"]);
    // A smaller claim than at-risk, and never confused with it.
    expect(impact.newlyAtRisk).toEqual([]);
    expect(impact.unchanged).toBe(false);
  });

  it("does not re-report a line that was already waiting on a transfer", () => {
    const same = plan({ lines: [awaiting("p1", "car insurance")] });
    expect(summarizePreview(same, same).newlyAwaiting).toEqual([]);
  });

  it("calls a line that goes all the way to short at-risk, not merely waiting", () => {
    const base = plan({ lines: [line("p1", "car insurance", true)] });
    const preview = plan({ lines: [line("p1", "car insurance", false)] });

    const impact = summarizePreview(base, preview);
    expect(impact.newlyAtRisk).toEqual(["car insurance"]);
    expect(impact.newlyAwaiting).toEqual([]);
  });

  it("flags an unchanged plan", () => {
    const same = plan({ leftoverMinor: 100, shortfallMinor: 0, lines: [line("p1", "car", true)] });
    expect(summarizePreview(same, same).unchanged).toBe(true);
  });

  it("takes the currency from the preview side", () => {
    const impact = summarizePreview(plan({ currency: "GBP" }), plan({ currency: "EUR" }));
    expect(impact.currency).toBe("EUR");
  });
});
