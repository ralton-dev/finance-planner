import { describe, expect, it } from "vitest";
import type { HouseholdPlanDto, HouseholdPlanLineDto } from "./types.js";
import { buildMemberBars, groupByTag, shouldChartTags, tagKey, UNTAGGED } from "./tags.js";

function line(over: Partial<HouseholdPlanLineDto> & { paymentId: string }): HouseholdPlanLineDto {
  return {
    accountId: "acc",
    name: over.paymentId,
    category: "monthly_recurring",
    scope: "shared",
    amountMinor: 0,
    dueDate: "2026-08-01",
    targetDate: "2026-08-01",
    priority: 100,
    requiredMonthlyMinor: 0,
    fundedMonthlyMinor: 0,
    occurrencesThisMonth: 1,
    onTrack: true,
    allocations: [],
    ...over,
  };
}

function plan(over: Partial<HouseholdPlanDto>): HouseholdPlanDto {
  return {
    householdId: "hh",
    asOfDate: "2026-08-01",
    currency: "GBP",
    monthlyIncomeMinor: 0,
    totalRequiredMinor: 0,
    totalFundedMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    members: [],
    accounts: [],
    lines: [],
    transfers: [],
    ...over,
  };
}

describe("groupByTag", () => {
  it("sums required monthly cost per tag, biggest first, with shares", () => {
    const groups = groupByTag([
      { tag: "housing", requiredMonthlyMinor: 90_000 },
      { tag: "car", requiredMonthlyMinor: 20_000 },
      { tag: "housing", requiredMonthlyMinor: 10_000 },
    ]);

    expect(groups.map((g) => g.tag)).toEqual(["housing", "car"]);
    expect(groups[0]).toMatchObject({ valueMinor: 100_000, count: 2 });
    expect(groups[0]!.share).toBeCloseTo(100 / 120);
    expect(groups[1]!.share).toBeCloseTo(20 / 120);
  });

  it("buckets missing, null and whitespace-only tags as untagged", () => {
    const groups = groupByTag([
      { requiredMonthlyMinor: 1_000 },
      { tag: null, requiredMonthlyMinor: 2_000 },
      { tag: "   ", requiredMonthlyMinor: 3_000 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ tag: UNTAGGED, valueMinor: 6_000, count: 3, share: 1 });
  });

  it("trims tags so 'car ' and 'car' are one group", () => {
    const groups = groupByTag([
      { tag: "car ", requiredMonthlyMinor: 1_000 },
      { tag: "car", requiredMonthlyMinor: 1_000 },
    ]);
    expect(groups).toEqual([{ tag: "car", valueMinor: 2_000, count: 2, share: 1 }]);
  });

  it("drops lines that cost nothing this month", () => {
    const groups = groupByTag([
      { tag: "car", requiredMonthlyMinor: 0 },
      { tag: "housing", requiredMonthlyMinor: 500 },
    ]);
    expect(groups.map((g) => g.tag)).toEqual(["housing"]);
  });

  it("returns nothing for an empty plan", () => {
    expect(groupByTag([])).toEqual([]);
  });
});

describe("shouldChartTags", () => {
  it("says no when nothing is tagged and there is only one bucket", () => {
    expect(shouldChartTags(groupByTag([{ requiredMonthlyMinor: 1_000 }]))).toBe(false);
  });

  it("says no when there is nothing at all", () => {
    expect(shouldChartTags([])).toBe(false);
  });

  it("says yes once a second bucket exists", () => {
    const groups = groupByTag([
      { requiredMonthlyMinor: 1_000 },
      { tag: "car", requiredMonthlyMinor: 1_000 },
    ]);
    expect(shouldChartTags(groups)).toBe(true);
  });

  it("says yes for a single real tag", () => {
    expect(shouldChartTags(groupByTag([{ tag: "car", requiredMonthlyMinor: 1 }]))).toBe(true);
  });
});

describe("tagKey", () => {
  it("normalises to the untagged bucket", () => {
    expect(tagKey(undefined)).toBe(UNTAGGED);
    expect(tagKey("  housing  ")).toBe("housing");
  });
});

describe("buildMemberBars", () => {
  const fullyFunded = plan({
    members: [
      {
        userId: "alice",
        displayName: "Alice",
        shareBp: 6_000,
        monthlyIncomeMinor: 300_000,
        obligationMinor: 100_000,
        fundedMinor: 100_000,
        leftoverMinor: 200_000,
        shortfallMinor: 0,
      },
    ],
    lines: [
      line({
        paymentId: "rent",
        tag: "housing",
        requiredMonthlyMinor: 60_000,
        allocations: [{ userId: "alice", requiredMinor: 60_000, fundedMinor: 60_000 }],
      }),
      line({
        paymentId: "insurance",
        tag: "car",
        requiredMonthlyMinor: 25_000,
        allocations: [{ userId: "alice", requiredMinor: 25_000, fundedMinor: 25_000 }],
      }),
      line({
        paymentId: "misc",
        requiredMonthlyMinor: 15_000,
        allocations: [{ userId: "alice", requiredMinor: 15_000, fundedMinor: 15_000 }],
      }),
    ],
  });

  it("groups a member's funded allocations by tag, biggest first", () => {
    const [bar] = buildMemberBars(fullyFunded);
    expect(bar!.displayName).toBe("Alice");
    expect(bar!.segments.map((s) => s.tag)).toEqual(["housing", "car", UNTAGGED]);
    expect(bar!.segments.map((s) => s.valueMinor)).toEqual([60_000, 25_000, 15_000]);
  });

  it("fills the bar exactly when everything is funded", () => {
    const [bar] = buildMemberBars(fullyFunded);
    const total = bar!.segments.reduce((sum, s) => sum + s.widthPct, 0);
    expect(total).toBeCloseTo(100);
    expect(bar!.unfundedMinor).toBe(0);
    expect(bar!.unfundedPct).toBe(0);
    expect(bar!.segments[0]!.widthPct).toBeCloseTo(60);
  });

  it("leaves an unfunded remainder that tops the bar back up to 100%", () => {
    const short = plan({
      members: [
        {
          userId: "bob",
          displayName: "Bob",
          shareBp: 4_000,
          monthlyIncomeMinor: 90_000,
          obligationMinor: 100_000,
          fundedMinor: 40_000,
          leftoverMinor: 0,
          shortfallMinor: 60_000,
        },
      ],
      lines: [
        line({
          paymentId: "rent",
          tag: "housing",
          requiredMonthlyMinor: 100_000,
          allocations: [{ userId: "bob", requiredMinor: 100_000, fundedMinor: 40_000 }],
        }),
      ],
    });

    const [bar] = buildMemberBars(short);
    expect(bar!.fundedMinor).toBe(40_000);
    expect(bar!.unfundedMinor).toBe(60_000);
    expect(bar!.segments[0]!.widthPct).toBeCloseTo(40);
    expect(bar!.unfundedPct).toBeCloseTo(60);
    expect(bar!.segments.reduce((s, x) => s + x.widthPct, 0) + bar!.unfundedPct).toBeCloseTo(100);
  });

  it("gives a member with no obligation an empty bar rather than dividing by zero", () => {
    const idle = plan({
      members: [
        {
          userId: "carol",
          shareBp: 0,
          monthlyIncomeMinor: 0,
          obligationMinor: 0,
          fundedMinor: 0,
          leftoverMinor: 0,
          shortfallMinor: 0,
        },
      ],
    });
    const [bar] = buildMemberBars(idle);
    expect(bar).toMatchObject({ displayName: "member", segments: [], unfundedPct: 0 });
  });

  it("ignores allocations belonging to other members", () => {
    const shared = plan({
      members: [
        {
          userId: "alice",
          displayName: "Alice",
          shareBp: 5_000,
          monthlyIncomeMinor: 0,
          obligationMinor: 50_000,
          fundedMinor: 50_000,
          leftoverMinor: 0,
          shortfallMinor: 0,
        },
      ],
      lines: [
        line({
          paymentId: "rent",
          tag: "housing",
          requiredMonthlyMinor: 100_000,
          allocations: [
            { userId: "alice", requiredMinor: 50_000, fundedMinor: 50_000 },
            { userId: "bob", requiredMinor: 50_000, fundedMinor: 50_000 },
          ],
        }),
      ],
    });
    const [bar] = buildMemberBars(shared);
    expect(bar!.segments).toHaveLength(1);
    expect(bar!.segments[0]!.valueMinor).toBe(50_000);
  });
});
