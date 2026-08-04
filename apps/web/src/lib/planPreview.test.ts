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

function plan(over: Partial<AccountPlanDto>): AccountPlanDto {
  return {
    accountId: "acc",
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

  it("flags an unchanged plan", () => {
    const same = plan({ leftoverMinor: 100, shortfallMinor: 0, lines: [line("p1", "car", true)] });
    expect(summarizePreview(same, same).unchanged).toBe(true);
  });

  it("takes the currency from the preview side", () => {
    const impact = summarizePreview(plan({ currency: "GBP" }), plan({ currency: "EUR" }));
    expect(impact.currency).toBe("EUR");
  });
});
