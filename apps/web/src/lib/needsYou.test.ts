import { describe, expect, it } from "vitest";
import { phraseText } from "./money.js";
import {
  deriveHeadline,
  deriveNeedsYou,
  needsYouCountLabel,
  type NeedsYouAccountInput,
  type NeedsYouHouseholdInput,
  type NeedsYouInput,
} from "./needsYou.js";
import type {
  AccountPlanDto,
  HouseholdMemberPlanDto,
  HouseholdPlanDto,
  HouseholdPlanLineDto,
  PlanLineDto,
  TransferConfirmationDto,
  UpcomingItemDto,
} from "./types.js";

const AS_OF = "2026-08-04";

// --- fixtures ---------------------------------------------------------------
// The numbers are the design mockup's, so the strings these tests pin are the
// strings the mockup shows.

function hhLine(over: Partial<HouseholdPlanLineDto> & { paymentId: string }): HouseholdPlanLineDto {
  return {
    accountId: "bills",
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

function member(over: Partial<HouseholdMemberPlanDto> & { userId: string }) {
  return {
    shareBp: 5_000,
    monthlyIncomeMinor: 0,
    obligationMinor: 0,
    fundedMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    ...over,
  };
}

function householdPlan(over: Partial<HouseholdPlanDto> = {}): HouseholdPlanDto {
  return {
    householdId: "hh",
    asOfDate: AS_OF,
    currency: "GBP",
    monthlyIncomeMinor: 630_000,
    totalRequiredMinor: 277_338,
    totalFundedMinor: 273_338,
    leftoverMinor: 332_662,
    shortfallMinor: 4_000,
    members: [
      member({ userId: "ben", displayName: "Ben", shareBp: 6_000, obligationMinor: 131_400 }),
      member({
        userId: "alex",
        displayName: "Alex",
        shareBp: 4_000,
        obligationMinor: 87_600,
        fundedMinor: 83_600,
        shortfallMinor: 4_000,
      }),
    ],
    accounts: [
      {
        accountId: "ben-current",
        name: "Ben current",
        role: "personal",
        memberUserId: "ben",
        currency: "GBP",
        monthlyIncomeMinor: 400_000,
        requiredOutflowMinor: 0,
        fundedOutflowMinor: 0,
        transferInMinor: 0,
        transferOutMinor: 131_400,
        leftoverMinor: 154_162,
        shortfallMinor: 0,
      },
      {
        accountId: "bills",
        name: "Bills joint",
        role: "shared",
        memberUserId: null,
        currency: "GBP",
        monthlyIncomeMinor: 0,
        requiredOutflowMinor: 219_000,
        fundedOutflowMinor: 215_000,
        transferInMinor: 219_000,
        transferOutMinor: 0,
        leftoverMinor: 10_000,
        shortfallMinor: 0,
      },
      {
        accountId: "alex-current",
        name: "Alex current",
        role: "personal",
        memberUserId: "alex",
        currency: "GBP",
        monthlyIncomeMinor: 230_000,
        requiredOutflowMinor: 0,
        fundedOutflowMinor: 0,
        transferInMinor: 0,
        transferOutMinor: 87_600,
        leftoverMinor: 198_500,
        shortfallMinor: 0,
      },
    ],
    lines: [
      hhLine({
        paymentId: "rent",
        name: "Rent",
        tag: "housing",
        priority: 10,
        requiredMonthlyMinor: 100_000,
        fundedMonthlyMinor: 96_000,
        allocations: [
          { userId: "ben", requiredMinor: 60_000, fundedMinor: 60_000 },
          { userId: "alex", requiredMinor: 40_000, fundedMinor: 36_000 },
        ],
      }),
      hhLine({
        paymentId: "gym",
        name: "Gym",
        tag: "health",
        scope: "personal",
        accountId: "alex-current",
        priority: 200,
        requiredMonthlyMinor: 3_000,
        fundedMonthlyMinor: 3_000,
        allocations: [{ userId: "alex", requiredMinor: 3_000, fundedMinor: 3_000 }],
      }),
    ],
    transfers: [
      {
        fromAccountId: "ben-current",
        toAccountId: "bills",
        memberUserId: "ben",
        amountMinor: 131_400,
      },
      {
        fromAccountId: "alex-current",
        toAccountId: "bills",
        memberUserId: "alex",
        amountMinor: 87_600,
      },
    ],
    ...over,
  };
}

function confirmation(
  over: Partial<TransferConfirmationDto> & { fromAccountId: string; toAccountId: string },
): TransferConfirmationDto {
  return {
    id: `c-${over.fromAccountId}`,
    householdId: "hh",
    month: "2026-08-01",
    memberUserId: "ben",
    amountMinor: 131_400,
    createdAt: "2026-08-01T09:00:00.000Z",
    ...over,
  };
}

function household(over: Partial<NeedsYouHouseholdInput> = {}): NeedsYouHouseholdInput {
  return {
    plan: householdPlan(),
    confirmations: [confirmation({ fromAccountId: "ben-current", toAccountId: "bills" })],
    ...over,
  };
}

function accLine(over: Partial<PlanLineDto> & { paymentId: string }): PlanLineDto {
  return {
    name: over.paymentId,
    category: "fixed_point",
    amountMinor: 0,
    dueDate: "2027-06-01",
    targetDate: "2027-06-01",
    monthsUntilDue: 10,
    requiredMonthlyMinor: 0,
    fundedMonthlyMinor: 0,
    alreadySavedMinor: 0,
    onTrack: true,
    ...over,
  };
}

function accountPlan(over: Partial<AccountPlanDto> & { accountId: string }): AccountPlanDto {
  return {
    asOfDate: AS_OF,
    currency: "GBP",
    monthlyIncomeMinor: 400_000,
    bufferMinor: 0,
    totalRequiredMinor: 0,
    totalFundedMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    lines: [],
    contributionsMTD: [],
    latestBalance: { asOfDate: AS_OF, balanceMinor: 318_450 },
    reservedMinor: 0,
    ...over,
  };
}

/** Ben current: one save-up line unrecorded, one covered, one monthly bill. */
function benCurrent(over: Partial<NeedsYouAccountInput> = {}): NeedsYouAccountInput {
  return {
    name: "Ben current",
    householdId: "hh",
    plan: accountPlan({
      accountId: "ben-current",
      lines: [
        accLine({
          paymentId: "phone",
          name: "Phone",
          category: "monthly_recurring",
          fundedMonthlyMinor: 4_500,
        }),
        accLine({
          paymentId: "car",
          name: "Car insurance",
          category: "yearly_recurring",
          fundedMonthlyMinor: 7_715,
        }),
        accLine({ paymentId: "rainy", name: "Rainy day", fundedMonthlyMinor: 20_000 }),
      ],
      contributionsMTD: [{ paymentId: "car", amountMinor: 8_000 }],
    }),
    ...over,
  };
}

/** Bills joint: nothing to record, but the balance is twelve days old. */
function billsJoint(over: Partial<NeedsYouAccountInput> = {}): NeedsYouAccountInput {
  return {
    name: "Bills joint",
    householdId: "hh",
    plan: accountPlan({
      accountId: "bills",
      latestBalance: { asOfDate: "2026-07-23", balanceMinor: 146_200 },
    }),
    ...over,
  };
}

const energyDue: UpcomingItemDto = {
  paymentId: "energy",
  name: "energy",
  category: "monthly_recurring",
  amountMinor: 14_000,
  dueDate: "2026-08-15",
  daysUntil: 11,
  accountId: "bills",
  accountName: "Bills joint",
  currency: "GBP",
};

/** The mockup's household, whole: four things need you. */
function fullInput(over: Partial<NeedsYouInput> = {}): NeedsYouInput {
  return {
    asOfDate: AS_OF,
    households: [household()],
    accounts: [benCurrent(), billsJoint()],
    upcoming: [energyDue],
    ...over,
  };
}

// --- rules ------------------------------------------------------------------

describe("deriveNeedsYou · shortfall", () => {
  it("names the member and the tag group carrying the gap", () => {
    const [item] = deriveNeedsYou(fullInput());
    expect(item).toMatchObject({
      key: "shortfall:member:hh:alex",
      kind: "shortfall",
      label: "cover Alex's unfunded housing",
      amountMinor: 4_000,
      currency: "GBP",
      href: "/households/hh",
    });
    expect(item!.action).toBeUndefined();
  });

  it("suggests the two remedies: the share, or the thing funded last", () => {
    const [item] = deriveNeedsYou(fullInput());
    expect(phraseText(item!.meta)).toBe("raise Alex's share, or move £40.00 from Gym");
  });

  it("falls back to the payment name when the short group is untagged", () => {
    const plan = householdPlan();
    const items = deriveNeedsYou({
      asOfDate: AS_OF,
      households: [household({ plan: { ...plan, lines: [{ ...plan.lines[0]!, tag: null }] } })],
    });
    expect(items[0]!.label).toBe("cover Alex's unfunded Rent");
  });

  it("drops the second remedy when the member funds nothing to cut", () => {
    const plan = householdPlan();
    const bare = plan.lines.map((l) => ({
      ...l,
      allocations: l.allocations.map((a) => ({ ...a, fundedMinor: 0 })),
    }));
    const items = deriveNeedsYou({
      asOfDate: AS_OF,
      households: [household({ plan: { ...plan, lines: bare } })],
    });
    expect(phraseText(items[0]!.meta)).toBe("raise Alex's share to cover it");
  });

  it("ignores members whose income covers their obligation", () => {
    const items = deriveNeedsYou(fullInput());
    expect(items.filter((i) => i.kind === "shortfall")).toHaveLength(1);
  });

  it("reports a standalone account's own shortfall", () => {
    const items = deriveNeedsYou({
      asOfDate: AS_OF,
      accounts: [
        {
          name: "Side hustle",
          plan: accountPlan({
            accountId: "side",
            shortfallMinor: 12_500,
            lines: [accLine({ paymentId: "van", name: "Van", fundedMonthlyMinor: 5_000 })],
          }),
        },
      ],
    });
    expect(items[0]).toMatchObject({
      key: "shortfall:account:side",
      label: "cover the shortfall on Side hustle",
      amountMinor: 12_500,
      href: "/accounts/side",
    });
    expect(phraseText(items[0]!.meta)).toBe(
      "income is £125.00 short — trim the plan, or move £125.00 from Van",
    );
  });

  it("leaves an account assigned to a household to that household's member rows", () => {
    const items = deriveNeedsYou({
      asOfDate: AS_OF,
      households: [household()],
      accounts: [benCurrent({ plan: { ...benCurrent().plan, shortfallMinor: 9_900 } })],
    });
    expect(items.filter((i) => i.kind === "shortfall").map((i) => i.key)).toEqual([
      "shortfall:member:hh:alex",
    ]);
  });
});

describe("deriveNeedsYou · transfer", () => {
  it("lists only what has no confirmation this month, counting the rest", () => {
    const items = deriveNeedsYou(fullInput()).filter((i) => i.kind === "transfer");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "transfer:hh:alex-current|bills|alex",
      label: "Alex → Bills joint",
      amountMinor: 87_600,
      href: "/households/hh/plan",
    });
    expect(phraseText(items[0]!.meta)).toBe("transfer · aug 2026 · 1 of 2 done · waiting on Alex");
  });

  it("hands the UI everything the confirm endpoint needs", () => {
    const items = deriveNeedsYou(fullInput()).filter((i) => i.kind === "transfer");
    expect(items[0]!.action).toEqual({
      kind: "confirmTransfer",
      householdId: "hh",
      fromAccountId: "alex-current",
      toAccountId: "bills",
      memberUserId: "alex",
      month: "2026-08",
      amountMinor: 87_600,
    });
  });

  it("ignores a confirmation belonging to another month", () => {
    const stale = confirmation({
      fromAccountId: "ben-current",
      toAccountId: "bills",
      month: "2026-07-01",
    });
    const items = deriveNeedsYou({
      asOfDate: AS_OF,
      households: [household({ confirmations: [stale] })],
    }).filter((i) => i.kind === "transfer");
    expect(items).toHaveLength(2);
    expect(phraseText(items[0]!.meta)).toContain("0 of 2 done");
  });

  it("says nothing when every transfer is confirmed", () => {
    const items = deriveNeedsYou({
      asOfDate: AS_OF,
      households: [
        household({
          confirmations: [
            confirmation({ fromAccountId: "ben-current", toAccountId: "bills" }),
            confirmation({
              fromAccountId: "alex-current",
              toAccountId: "bills",
              memberUserId: "alex",
            }),
          ],
        }),
      ],
    }).filter((i) => i.kind === "transfer");
    expect(items).toEqual([]);
  });
});

describe("deriveNeedsYou · record", () => {
  it("asks for the save-up lines this month has funded but nobody set aside", () => {
    const items = deriveNeedsYou(fullInput()).filter((i) => i.kind === "record");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "record:rainy",
      label: "record Rainy day",
      amountMinor: 20_000,
      href: "/accounts/ben-current",
      action: {
        kind: "recordContribution",
        paymentId: "rainy",
        accountId: "ben-current",
        amountMinor: 20_000,
        month: "2026-08",
      },
    });
    expect(phraseText(items[0]!.meta)).toBe("Ben current · not yet set aside this month");
  });

  it("never asks for a monthly bill — those are paid, not saved up", () => {
    const items = deriveNeedsYou(fullInput()).filter((i) => i.kind === "record");
    expect(items.map((i) => i.key)).not.toContain("record:phone");
  });

  it("treats a contribution that meets the month's target as done", () => {
    const items = deriveNeedsYou(fullInput()).filter((i) => i.kind === "record");
    expect(items.map((i) => i.key)).not.toContain("record:car");
  });

  it("keeps asking after a part payment, and prefills only what is left", () => {
    const account = benCurrent();
    const items = deriveNeedsYou({
      asOfDate: AS_OF,
      accounts: [
        {
          ...account,
          plan: { ...account.plan, contributionsMTD: [{ paymentId: "rainy", amountMinor: 5_000 }] },
        },
      ],
    }).filter((i) => i.kind === "record" && i.key === "record:rainy");

    expect(items[0]!.amountMinor).toBe(20_000);
    expect(phraseText(items[0]!.meta)).toBe("Ben current · £50.00 of £200.00 set aside so far");
    expect(items[0]!.action).toMatchObject({ amountMinor: 15_000 });
  });

  it("skips lines this month funds nothing toward", () => {
    const items = deriveNeedsYou({
      asOfDate: AS_OF,
      accounts: [
        {
          name: "Ben current",
          plan: accountPlan({
            accountId: "ben-current",
            lines: [accLine({ paymentId: "japan", name: "Japan trip", fundedMonthlyMinor: 0 })],
          }),
        },
      ],
    });
    expect(items.filter((i) => i.kind === "record")).toEqual([]);
  });
});

describe("deriveNeedsYou · checkin", () => {
  it("asks about a balance older than the threshold, dated against what is due", () => {
    const items = deriveNeedsYou(fullInput()).filter((i) => i.kind === "checkin");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "checkin:bills",
      label: "check in Bills joint balance",
      days: 12,
      href: "/accounts/bills",
      action: { kind: "checkin", accountId: "bills" },
    });
    expect(phraseText(items[0]!.meta)).toBe("last confirmed 23 jul · energy £140.00 due in 11d");
    expect(items[0]!.amountMinor).toBeUndefined();
  });

  it("leaves the due payment out when nothing lands inside the look-ahead", () => {
    const far = { ...energyDue, daysUntil: 20, dueDate: "2026-08-24" };
    const items = deriveNeedsYou(fullInput({ upcoming: [far] })).filter(
      (i) => i.kind === "checkin",
    );
    expect(phraseText(items[0]!.meta)).toBe("last confirmed 23 jul");
  });

  it("honours an injected threshold in both directions", () => {
    expect(
      deriveNeedsYou(fullInput({ staleAfterDays: 30 })).filter((i) => i.kind === "checkin"),
    ).toEqual([]);

    const fiveDaysOld = benCurrent();
    fiveDaysOld.plan.latestBalance = { asOfDate: "2026-07-30", balanceMinor: 318_450 };
    expect(
      deriveNeedsYou(fullInput({ accounts: [fiveDaysOld, billsJoint()], staleAfterDays: 3 }))
        .filter((i) => i.kind === "checkin")
        .map((i) => i.key),
    ).toEqual(["checkin:bills", "checkin:ben-current"]);
  });

  it("treats a balance exactly at the threshold as current", () => {
    const at = billsJoint();
    at.plan.latestBalance = { asOfDate: "2026-07-25", balanceMinor: 1 };
    const items = deriveNeedsYou({ asOfDate: AS_OF, accounts: [at] });
    expect(items).toEqual([]);
  });

  it("asks about an account that has never been checked in", () => {
    const never = billsJoint();
    never.plan.latestBalance = null;
    const [item] = deriveNeedsYou({ asOfDate: AS_OF, accounts: [never], upcoming: [energyDue] });
    expect(item!.kind).toBe("checkin");
    expect(phraseText(item!.meta)).toBe("never checked in · energy £140.00 due in 11d");
    expect(item!.days).toBeUndefined();
  });
});

// --- ordering, keys, empty state -------------------------------------------

describe("deriveNeedsYou · ordering", () => {
  it("returns the mockup's four rows in kind order", () => {
    const items = deriveNeedsYou(fullInput());
    expect(items.map((i) => i.kind)).toEqual(["shortfall", "transfer", "record", "checkin"]);
    expect(items.map((i) => i.label)).toEqual([
      "cover Alex's unfunded housing",
      "Alex → Bills joint",
      "record Rainy day",
      "check in Bills joint balance",
    ]);
  });

  it("puts the biggest amount first inside a kind, then breaks ties by key", () => {
    const account = benCurrent();
    const items = deriveNeedsYou({
      asOfDate: AS_OF,
      accounts: [
        {
          ...account,
          plan: {
            ...account.plan,
            lines: [
              accLine({ paymentId: "b-small", name: "Small", fundedMonthlyMinor: 1_000 }),
              accLine({ paymentId: "a-tie", name: "Tie A", fundedMonthlyMinor: 5_000 }),
              accLine({ paymentId: "z-tie", name: "Tie Z", fundedMonthlyMinor: 5_000 }),
              accLine({ paymentId: "c-big", name: "Big", fundedMonthlyMinor: 9_000 }),
            ],
            contributionsMTD: [],
          },
        },
      ],
    });
    expect(items.map((i) => i.key)).toEqual([
      "record:c-big",
      "record:a-tie",
      "record:z-tie",
      "record:b-small",
    ]);
  });

  it("ranks check-ins by staleness, with never-checked-in above any day count", () => {
    const never = billsJoint();
    never.plan.latestBalance = null;
    const older = {
      ...billsJoint(),
      name: "Old",
      plan: accountPlan({
        accountId: "old",
        latestBalance: { asOfDate: "2026-06-01", balanceMinor: 1 },
      }),
    };
    const items = deriveNeedsYou({
      asOfDate: AS_OF,
      accounts: [
        billsJoint(),
        older,
        { ...never, name: "New", plan: { ...never.plan, accountId: "new" } },
      ],
    });
    expect(items.map((i) => i.key)).toEqual(["checkin:new", "checkin:old", "checkin:bills"]);
  });

  it("is stable: the same input twice gives the same keys in the same order", () => {
    const once = deriveNeedsYou(fullInput()).map((i) => i.key);
    const twice = deriveNeedsYou(fullInput()).map((i) => i.key);
    expect(once).toEqual(twice);
    expect(new Set(once).size).toBe(once.length);
  });

  it("merges several households without losing either one's rows", () => {
    const other = householdPlan({
      householdId: "hh2",
      members: [member({ userId: "cass", displayName: "Cass", shortfallMinor: 50_000 })],
      lines: [
        hhLine({
          paymentId: "loan",
          name: "Loan",
          tag: "debt",
          requiredMonthlyMinor: 50_000,
          allocations: [{ userId: "cass", requiredMinor: 50_000, fundedMinor: 0 }],
        }),
      ],
      transfers: [],
    });
    const items = deriveNeedsYou({
      asOfDate: AS_OF,
      households: [household(), household({ plan: other, confirmations: [] })],
    });
    expect(items.filter((i) => i.kind === "shortfall").map((i) => i.key)).toEqual([
      "shortfall:member:hh2:cass",
      "shortfall:member:hh:alex",
    ]);
  });
});

describe("needsYouCountLabel", () => {
  it("counts what is outstanding", () => {
    expect(needsYouCountLabel(deriveNeedsYou(fullInput()))).toBe("[4]");
  });

  it("says so plainly when nothing is", () => {
    expect(deriveNeedsYou({ asOfDate: AS_OF })).toEqual([]);
    expect(needsYouCountLabel([])).toBe("[0] · nothing outstanding");
  });
});

// --- headline ---------------------------------------------------------------

/** A month with nothing missing and nothing outstanding. */
function settled(): NeedsYouInput {
  const plan = householdPlan({
    shortfallMinor: 0,
    members: householdPlan().members.map((m) => member({ ...m, shortfallMinor: 0 })),
  });
  return {
    asOfDate: AS_OF,
    households: [
      household({
        plan,
        confirmations: [
          confirmation({ fromAccountId: "ben-current", toAccountId: "bills" }),
          confirmation({
            fromAccountId: "alex-current",
            toAccountId: "bills",
            memberUserId: "alex",
          }),
        ],
      }),
    ],
    accounts: [
      benCurrent({
        plan: {
          ...benCurrent().plan,
          contributionsMTD: [
            { paymentId: "car", amountMinor: 8_000 },
            { paymentId: "rainy", amountMinor: 20_000 },
          ],
        },
      }),
      billsJoint({
        plan: { ...billsJoint().plan, latestBalance: { asOfDate: AS_OF, balanceMinor: 1 } },
      }),
    ],
  };
}

describe("deriveHeadline", () => {
  it("leads with the shortfall, worded as the mockup words it", () => {
    const input = fullInput();
    const headline = deriveHeadline(input, deriveNeedsYou(input));
    expect(headline).toMatchObject({ kind: "shortfall", amountMinor: 4_000 });
    expect(phraseText(headline.sentence)).toBe(
      "Alex's share of housing is £40.00 short this month. Everything else across 2 payments " +
        "is covered — clear it and you're left with £3,326.62 for the month.",
    );
    // Every figure is its own part, so privacy mode has something to blur.
    expect(headline.sentence.filter((part) => typeof part !== "string")).toEqual([
      { minor: 4_000, currency: "GBP" },
      { minor: 332_662, currency: "GBP" },
    ]);
  });

  it("lets the shortfall win however much is left over", () => {
    const input = fullInput();
    const headline = deriveHeadline(input, deriveNeedsYou(input));
    expect(headline.kind).toBe("shortfall");
    expect(headline.amountMinor).toBe(4_000);
  });

  it("keeps the total as the number and names the biggest cause when two are short", () => {
    const plan = householdPlan({
      shortfallMinor: 54_000,
      members: [
        member({ userId: "ben", displayName: "Ben", shortfallMinor: 50_000 }),
        member({ userId: "alex", displayName: "Alex", shortfallMinor: 4_000 }),
      ],
      lines: [
        hhLine({
          paymentId: "rent",
          name: "Rent",
          tag: "housing",
          allocations: [
            { userId: "ben", requiredMinor: 60_000, fundedMinor: 10_000 },
            { userId: "alex", requiredMinor: 40_000, fundedMinor: 36_000 },
          ],
        }),
      ],
    });
    const input: NeedsYouInput = { asOfDate: AS_OF, households: [household({ plan })] };
    const headline = deriveHeadline(input, deriveNeedsYou(input));
    expect(headline.amountMinor).toBe(54_000);
    expect(phraseText(headline.sentence)).toMatch(
      /^£540\.00 is short this month, most of it Ben's share of housing\./,
    );
  });

  it("still says something when no member explains the gap", () => {
    const plan = householdPlan({ shortfallMinor: 2_500, members: [], lines: [] });
    const input: NeedsYouInput = { asOfDate: AS_OF, households: [household({ plan })] };
    expect(phraseText(deriveHeadline(input, deriveNeedsYou(input)).sentence)).toMatch(
      /^£25\.00 is short this month\. Everything else across 0 payments is covered/,
    );
  });

  it("switches to left over once nothing is missing, and counts what still waits", () => {
    const input = fullInput({
      households: [household({ plan: householdPlan({ shortfallMinor: 0, members: [] }) })],
    });
    const items = deriveNeedsYou(input);
    expect(deriveHeadline(input, items)).toEqual({
      kind: "leftover",
      amountMinor: 332_662,
      sentence: ["All 2 payments funded. 3 things still waiting on a human — see the list."],
    });
  });

  it("uses the singular when exactly one thing waits", () => {
    const input = fullInput({
      households: [household({ plan: householdPlan({ shortfallMinor: 0, members: [] }) })],
      accounts: [],
      upcoming: [],
    });
    const items = deriveNeedsYou(input);
    expect(items).toHaveLength(1);
    expect(phraseText(deriveHeadline(input, items).sentence)).toBe(
      "All 2 payments funded. 1 thing still waiting on a human — see the list.",
    );
  });

  it("says the month is clear when the list is empty", () => {
    const input = settled();
    const items = deriveNeedsYou(input);
    expect(items).toEqual([]);
    expect(deriveHeadline(input, items)).toEqual({
      kind: "leftover",
      amountMinor: 332_662,
      sentence: [
        "All 2 payments funded, both transfers settled, balances current. Nothing is waiting on you.",
      ],
    });
  });

  it("drops the transfers clause when the plan needs none", () => {
    const input = settled();
    const [entry] = input.households!;
    const noTransfers: NeedsYouInput = {
      ...input,
      households: [{ ...entry!, plan: { ...entry!.plan, transfers: [] }, confirmations: [] }],
    };
    expect(phraseText(deriveHeadline(noTransfers, deriveNeedsYou(noTransfers)).sentence)).toBe(
      "All 2 payments funded, balances current. Nothing is waiting on you.",
    );
  });

  it("has something to say about a household with no plan at all", () => {
    const input: NeedsYouInput = { asOfDate: AS_OF };
    expect(deriveHeadline(input, [])).toEqual({
      kind: "leftover",
      amountMinor: 0,
      sentence: ["Nothing planned yet. Nothing is waiting on you."],
    });
  });

  it("aggregates two households worst-first: the total, named by the bigger gap", () => {
    const other = householdPlan({
      householdId: "hh2",
      currency: "GBP",
      monthlyIncomeMinor: 200_000,
      leftoverMinor: 100_000,
      shortfallMinor: 50_000,
      members: [member({ userId: "cass", displayName: "Cass", shortfallMinor: 50_000 })],
      lines: [
        hhLine({
          paymentId: "loan",
          name: "Loan",
          tag: "debt",
          requiredMonthlyMinor: 50_000,
          allocations: [{ userId: "cass", requiredMinor: 50_000, fundedMinor: 0 }],
        }),
      ],
      transfers: [],
    });
    // The mockup's household (Alex, £40 short) plus a worse one (Cass, £500).
    const input: NeedsYouInput = {
      asOfDate: AS_OF,
      households: [household(), household({ plan: other, confirmations: [] })],
    };
    const headline = deriveHeadline(input, deriveNeedsYou(input));

    expect(headline.kind).toBe("shortfall");
    expect(headline.amountMinor).toBe(54_000);
    expect(phraseText(headline.sentence)).toBe(
      "£540.00 is short this month, most of it Cass's share of debt. Everything else across " +
        "3 payments is covered — clear it and you're left with £4,326.62 for the month.",
    );
  });

  it("counts the aggregate in one currency rather than adding pounds to euros", () => {
    const euro = householdPlan({
      householdId: "hh-eu",
      currency: "EUR",
      leftoverMinor: 900_000,
      shortfallMinor: 700_000,
      members: [member({ userId: "luc", displayName: "Luc", shortfallMinor: 700_000 })],
      lines: [],
      transfers: [],
    });
    const input: NeedsYouInput = {
      asOfDate: AS_OF,
      households: [household(), household({ plan: euro, confirmations: [] })],
    };
    const headline = deriveHeadline(input, deriveNeedsYou(input));

    // The euro household's rows still reach the list; only the figure is GBP.
    expect(deriveNeedsYou(input).map((i) => i.key)).toContain("shortfall:member:hh-eu:luc");
    expect(headline.amountMinor).toBe(4_000);
    expect(phraseText(headline.sentence)).toMatch(
      /^Alex's share of housing is £40\.00 short this month\./,
    );
  });

  it("adds up across households and standalone accounts", () => {
    const input: NeedsYouInput = {
      asOfDate: AS_OF,
      households: [household()],
      accounts: [
        {
          name: "Side hustle",
          plan: accountPlan({
            accountId: "side",
            shortfallMinor: 1_000,
            leftoverMinor: 500,
            lines: [accLine({ paymentId: "van", name: "Van" })],
          }),
        },
      ],
    };
    const headline = deriveHeadline(input, deriveNeedsYou(input));
    expect(headline.amountMinor).toBe(5_000);
    expect(phraseText(headline.sentence)).toContain("across 3 payments");
    expect(phraseText(headline.sentence)).toContain("£3,331.62");
  });
});
