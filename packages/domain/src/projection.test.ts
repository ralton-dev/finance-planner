import { describe, expect, it } from "vitest";
import { computeAccountPlan } from "./engine.js";
import type { HouseholdInput } from "./household.js";
import {
  computeAccountProjection,
  computeHouseholdProjection,
  type MonthProjection,
  type ProjectionOptions,
} from "./projection.js";
import type { AccountInput, IncomeInput, PaymentInput } from "./types.js";

const AS_OF = "2026-08-03";

// --- factories ---------------------------------------------------------------

function income(amountMinor: number, over: Partial<IncomeInput> = {}): IncomeInput {
  return { id: "inc", amountMinor, frequency: "monthly", anchorDate: AS_OF, ...over };
}

function account(
  payments: PaymentInput[],
  over: Partial<AccountInput> = {},
  incomes: IncomeInput[] = [income(200_000)],
): AccountInput {
  return { accountId: "acct", currency: "GBP", incomes, payments, ...over };
}

function project(acc: AccountInput, opts?: ProjectionOptions) {
  return computeAccountProjection(acc, AS_OF, opts);
}

/** The single line of a single-payment month (undefined once it retires). */
function only(month: MonthProjection) {
  return month.lines[0];
}

/** Deep snapshot of an input, for asserting the projection never writes to it. */
function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// --- monthly bills -----------------------------------------------------------

describe("computeAccountProjection — monthly recurring", () => {
  const p = project(
    account([{ id: "phone", name: "Phone", category: "monthly_recurring", amountMinor: 4_500 }]),
  );

  it("projects 12 months by default and echoes the account identity", () => {
    expect(p.accountId).toBe("acct");
    expect(p.currency).toBe("GBP");
    expect(p.asOfDate).toBe(AS_OF);
    expect(p.months).toHaveLength(12);
  });

  it("labels months from the as-of month forward", () => {
    expect(p.months.map((m) => m.month).slice(0, 4)).toEqual([
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
    expect(p.months[11]?.month).toBe("2027-07");
  });

  it("charges the same amount every month and never reserves anything", () => {
    for (const month of p.months) {
      expect(month.totalRequiredMinor).toBe(4_500);
      expect(month.totalFundedMinor).toBe(4_500);
      expect(month.leftoverMinor).toBe(195_500);
      expect(month.shortfallMinor).toBe(0);
      expect(month.reservedEndMinor).toBe(0);
      expect(only(month)?.alreadySavedEndMinor).toBe(0);
      expect(only(month)?.dueThisMonth).toBe(true);
      expect(only(month)?.dueAmountMinor).toBe(4_500);
    }
  });

  it("never retires a monthly bill", () => {
    expect(p.months.every((m) => m.lines.length === 1)).toBe(true);
  });

  it("matches computeAccountPlan for the as-of month", () => {
    const acc = account([
      { id: "phone", name: "Phone", category: "monthly_recurring", amountMinor: 4_500 },
    ]);
    const plan = computeAccountPlan(acc, AS_OF);
    const first = project(acc).months[0]!;
    expect(first.monthlyIncomeMinor).toBe(plan.monthlyIncomeMinor);
    expect(first.totalRequiredMinor).toBe(plan.totalRequiredMinor);
    expect(first.leftoverMinor).toBe(plan.leftoverMinor);
  });

  it("carries the buffer through from the plan", () => {
    const withBuffer = project(
      account([{ id: "phone", name: "Phone", category: "monthly_recurring", amountMinor: 4_500 }], {
        monthlyBufferMinor: 30_000,
      }),
      { months: 2 },
    );
    expect(withBuffer.months[0]?.bufferMinor).toBe(30_000);
    expect(withBuffer.months[1]?.leftoverMinor).toBe(165_500);
  });

  it("omits payments that are inactive from the start", () => {
    const p2 = project(
      account([
        { id: "phone", name: "Phone", category: "monthly_recurring", amountMinor: 4_500 },
        {
          id: "old",
          name: "Cancelled",
          category: "monthly_recurring",
          amountMinor: 9_900,
          active: false,
        },
      ]),
      { months: 2 },
    );
    expect(p2.months.every((m) => m.lines.length === 1)).toBe(true);
    expect(p2.months[0]?.totalRequiredMinor).toBe(4_500);
  });
});

// --- yearly bills ------------------------------------------------------------

describe("computeAccountProjection — yearly recurring", () => {
  const p = project(
    account([
      {
        id: "ins",
        name: "Car insurance",
        category: "yearly_recurring",
        amountMinor: 120_000,
        dueDate: "2026-12-01",
      },
    ]),
    { months: 8, startingBalanceMinor: 0 },
  );

  it("builds the reserve month by month toward the due date", () => {
    expect(p.months.map((m) => only(m)?.requiredMonthlyMinor)).toEqual([
      40_000, 26_667, 26_667, 26_666, 0, 10_910, 10_909, 10_909,
    ]);
    expect(p.months.map((m) => m.reservedEndMinor)).toEqual([
      40_000, 66_667, 93_334, 120_000, 0, 10_910, 21_819, 32_728,
    ]);
  });

  it("flags the due month and spends the reserve on the bill", () => {
    const due = p.months[4]!;
    expect(due.month).toBe("2026-12");
    expect(only(due)?.dueThisMonth).toBe(true);
    expect(only(due)?.dueAmountMinor).toBe(120_000);
    expect(only(due)?.fundedMonthlyMinor).toBe(0);
    expect(only(due)?.alreadySavedEndMinor).toBe(0);
  });

  it("keeps the bill alive and rebuilds toward the next occurrence", () => {
    expect(p.months.every((m) => m.lines.length === 1)).toBe(true);
    const after = p.months[5]!;
    expect(after.month).toBe("2027-01");
    expect(only(after)?.dueThisMonth).toBe(false);
    expect(only(after)?.alreadySavedEndMinor).toBe(10_910);
  });

  it("marks no month as due before the due date", () => {
    expect(p.months.slice(0, 4).every((m) => only(m)?.dueThisMonth === false)).toBe(true);
    expect(p.months.slice(0, 4).every((m) => only(m)?.dueAmountMinor === 0)).toBe(true);
  });
});

// --- fixed point goals -------------------------------------------------------

describe("computeAccountProjection — fixed_point goals", () => {
  const goal: PaymentInput = {
    id: "holiday",
    name: "Holiday",
    category: "fixed_point",
    amountMinor: 90_000,
    dueDate: "2026-11-01",
  };
  const p = project(account([goal]), { months: 5, startingBalanceMinor: 25_000 });

  it("funds the goal to completion by its due month", () => {
    expect(p.months.map((m) => only(m)?.requiredMonthlyMinor)).toEqual([
      45_000,
      22_500,
      22_500,
      0,
      undefined,
    ]);
    expect(p.months.map((m) => m.reservedEndMinor)).toEqual([45_000, 67_500, 90_000, 0, 0]);
  });

  it("flags the due month then drops the goal from later months", () => {
    const due = p.months[3]!;
    expect(due.month).toBe("2026-11");
    expect(only(due)?.dueThisMonth).toBe(true);
    expect(only(due)?.dueAmountMinor).toBe(90_000);
    expect(p.months[4]?.lines).toEqual([]);
    expect(p.months[4]?.totalRequiredMinor).toBe(0);
    expect(p.months[4]?.leftoverMinor).toBe(200_000);
  });

  it("retires a spent goal even when autoRenew is set", () => {
    const renewing = project(account([{ ...goal, autoRenew: true }]), { months: 5 });
    expect(renewing.months[3]?.lines).toHaveLength(1);
    expect(renewing.months[4]?.lines).toEqual([]);
  });

  it("treats a goal due in the as-of month as due straight away", () => {
    const p2 = project(
      account([
        {
          id: "tax",
          name: "Tax bill",
          category: "fixed_point",
          amountMinor: 60_000,
          dueDate: "2026-08-20",
          alreadySavedMinor: 10_000,
        },
      ]),
      { months: 3, startingBalanceMinor: 10_000 },
    );
    const first = p2.months[0]!;
    expect(only(first)?.requiredMonthlyMinor).toBe(50_000);
    expect(only(first)?.dueThisMonth).toBe(true);
    expect(only(first)?.dueAmountMinor).toBe(60_000);
    expect(first.reservedEndMinor).toBe(0);
    // 10k already put by + 50k funded this month - the 60k bill = back to zero.
    expect(first.projectedBalanceMinor).toBe(0);
    expect(p2.months[1]?.lines).toEqual([]);
  });

  it("treats an already-overdue goal as due in the first projected month", () => {
    const p2 = project(
      account([
        {
          id: "old",
          name: "Overdue",
          category: "fixed_point",
          amountMinor: 30_000,
          dueDate: "2026-05-01",
        },
      ]),
      { months: 2 },
    );
    expect(only(p2.months[0]!)?.requiredMonthlyMinor).toBe(30_000);
    expect(only(p2.months[0]!)?.dueThisMonth).toBe(true);
    expect(p2.months[1]?.lines).toEqual([]);
  });

  it("uses targetDate in preference to dueDate", () => {
    const p2 = project(
      account([
        {
          id: "wedding",
          name: "Wedding",
          category: "fixed_point",
          amountMinor: 60_000,
          dueDate: "2026-09-01",
          targetDate: "2026-10-01",
        },
      ]),
      { months: 4 },
    );
    expect(p2.months[1]?.lines).toHaveLength(1);
    expect(only(p2.months[2]!)?.dueThisMonth).toBe(true);
    expect(p2.months[3]?.lines).toEqual([]);
  });

  it("treats a dateless goal as due immediately", () => {
    const p2 = project(
      account([{ id: "misc", name: "Misc", category: "fixed_point", amountMinor: 15_000 }]),
      { months: 2 },
    );
    expect(only(p2.months[0]!)?.requiredMonthlyMinor).toBe(15_000);
    expect(only(p2.months[0]!)?.dueAmountMinor).toBe(15_000);
    expect(p2.months[1]?.lines).toEqual([]);
  });
});

// --- shortfalls --------------------------------------------------------------

describe("computeAccountProjection — underfunded account", () => {
  const p = project(
    account(
      [
        {
          id: "gym",
          name: "Gym",
          category: "monthly_recurring",
          amountMinor: 20_000,
          priority: 5,
        },
        {
          id: "rent",
          name: "Rent",
          category: "monthly_recurring",
          amountMinor: 40_000,
          priority: 1,
        },
      ],
      {},
      [income(50_000)],
    ),
    { months: 4 },
  );

  it("funds the lower priority number first, every month", () => {
    for (const month of p.months) {
      expect(month.lines.map((l) => l.paymentId)).toEqual(["rent", "gym"]);
      expect(month.lines[0]?.fundedMonthlyMinor).toBe(40_000);
      expect(month.lines[1]?.fundedMonthlyMinor).toBe(10_000);
    }
  });

  it("carries the same shortfall through every month", () => {
    expect(p.months.map((m) => m.shortfallMinor)).toEqual([10_000, 10_000, 10_000, 10_000]);
    expect(p.months.every((m) => m.leftoverMinor === 0)).toBe(true);
  });

  it("lets an underfunded goal fall behind and drives the balance negative", () => {
    const p2 = project(
      account(
        [
          {
            id: "boiler",
            name: "Boiler service",
            category: "yearly_recurring",
            amountMinor: 60_000,
            dueDate: "2026-10-01",
          },
        ],
        {},
        [income(10_000)],
      ),
      { months: 3, startingBalanceMinor: 0 },
    );
    // Only 10k a month against a bill that needs the lot by October: the gap
    // narrows as the reserve grows, and the bill still gets paid in October, so
    // the account is pushed into the red.
    expect(p2.months.map((m) => m.shortfallMinor)).toEqual([50_000, 40_000, 30_000]);
    expect(p2.months.map((m) => m.reservedEndMinor)).toEqual([10_000, 20_000, 0]);
    expect(p2.months.map((m) => m.projectedBalanceMinor)).toEqual([10_000, 20_000, -30_000]);
  });
});

// --- custom cadences ---------------------------------------------------------

describe("computeAccountProjection — custom_recurring", () => {
  const acc = account([
    {
      id: "box",
      name: "Veg box",
      category: "custom_recurring",
      amountMinor: 2_000,
      dueDate: "2026-08-01",
      recurrence: { interval: 2, unit: "week", anchor: "2026-08-01" },
    },
  ]);
  const p = project(acc, { months: 6, startingBalanceMinor: 5_000 });

  it("swings between two and three occurrences a month", () => {
    expect(p.months.map((m) => only(m)?.dueAmountMinor)).toEqual([
      6_000, 4_000, 4_000, 4_000, 4_000, 6_000,
    ]);
    expect(p.months.every((m) => only(m)?.dueThisMonth === true)).toBe(true);
  });

  it("requires exactly what the engine requires", () => {
    expect(only(p.months[0]!)?.requiredMonthlyMinor).toBe(
      computeAccountPlan(acc, AS_OF).lines[0]?.requiredMonthlyMinor,
    );
    expect(only(p.months[1]!)?.requiredMonthlyMinor).toBe(4_000);
  });

  it("holds no reserve and leaves the balance flat when fully funded", () => {
    expect(p.months.every((m) => m.reservedEndMinor === 0)).toBe(true);
    expect(p.months.every((m) => m.projectedBalanceMinor === 5_000)).toBe(true);
  });

  it("saves up toward a cadence that skips months", () => {
    const quarterly = project(
      account([
        {
          id: "water",
          name: "Water",
          category: "custom_recurring",
          amountMinor: 9_000,
          dueDate: "2026-10-01",
          recurrence: { interval: 3, unit: "month", anchor: "2026-10-01" },
        },
      ]),
      { months: 3 },
    );
    expect(quarterly.months.map((m) => only(m)?.dueThisMonth)).toEqual([false, false, true]);
    expect(quarterly.months.map((m) => only(m)?.dueAmountMinor)).toEqual([0, 0, 9_000]);
  });

  it("falls due once in its due month when no cadence can be resolved", () => {
    const p2 = project(
      account([
        {
          id: "odd",
          name: "Odd one",
          category: "custom_recurring",
          amountMinor: 30_000,
          dueDate: "2026-10-01",
        },
      ]),
      { months: 4 },
    );
    expect(p2.months.map((m) => only(m)?.dueThisMonth)).toEqual([false, false, true, false]);
    // Recurring payments are never retired, unlike a fixed_point goal.
    expect(p2.months[3]?.lines).toHaveLength(1);
  });

  it("falls due every month when it has neither cadence nor due date", () => {
    const p2 = project(
      account([{ id: "odd", name: "Odd one", category: "custom_recurring", amountMinor: 3_000 }]),
      { months: 3 },
    );
    expect(p2.months.every((m) => only(m)?.dueAmountMinor === 3_000)).toBe(true);
    expect(p2.months.every((m) => m.reservedEndMinor === 0)).toBe(true);
  });

  it("anchors an undated cadence on the month being simulated", () => {
    const p2 = project(
      account([
        {
          id: "weekly",
          name: "Weekly",
          category: "custom_recurring",
          amountMinor: 1_000,
          recurrence: { interval: 1, unit: "week", anchor: AS_OF },
        },
      ]),
      { months: 2 },
    );
    // From 2026-08-03: 03, 10, 17, 24, 31 → five hits in August.
    expect(only(p2.months[0]!)?.dueAmountMinor).toBe(5_000);
    // September is simulated from the 1st: 01, 08, 15, 22, 29 → five again.
    expect(only(p2.months[1]!)?.dueAmountMinor).toBe(5_000);
  });
});

// --- balances ----------------------------------------------------------------

describe("computeAccountProjection — projected balance", () => {
  const goal: PaymentInput = {
    id: "holiday",
    name: "Holiday",
    category: "fixed_point",
    amountMinor: 90_000,
    dueDate: "2026-11-01",
  };

  it("rises while saving and drops by the bill in the due month", () => {
    const p = project(account([goal]), { months: 5, startingBalanceMinor: 25_000 });
    expect(p.months.map((m) => m.projectedBalanceMinor)).toEqual([
      70_000, 92_500, 115_000, 25_000, 25_000,
    ]);
  });

  it("reports null throughout when no starting balance is given", () => {
    const p = project(account([goal]), { months: 3 });
    expect(p.months.every((m) => m.projectedBalanceMinor === null)).toBe(true);
  });

  it("treats an explicit null starting balance as unknown", () => {
    const p = project(account([goal]), { months: 2, startingBalanceMinor: null });
    expect(p.months.map((m) => m.projectedBalanceMinor)).toEqual([null, null]);
  });

  it("leaves the balance untouched by monthly bills, buffer and leftover", () => {
    const p = project(
      account([{ id: "phone", name: "Phone", category: "monthly_recurring", amountMinor: 4_500 }], {
        monthlyBufferMinor: 20_000,
      }),
      { months: 3, startingBalanceMinor: 80_000 },
    );
    expect(p.months.every((m) => m.projectedBalanceMinor === 80_000)).toBe(true);
  });
});

// --- income over time --------------------------------------------------------

describe("computeAccountProjection — income", () => {
  it("drops a one_off income once its anchor has passed", () => {
    const p = project(
      account([], {}, [
        income(100_000),
        income(40_000, { id: "bonus", frequency: "one_off", anchorDate: "2026-11-01" }),
      ]),
      { months: 5 },
    );
    expect(p.months.map((m) => m.monthlyIncomeMinor)).toEqual([
      120_000, 120_000, 140_000, 100_000, 100_000,
    ]);
  });

  it("ignores inactive income in every month", () => {
    const p = project(
      account([], {}, [income(100_000), income(50_000, { id: "x", active: false })]),
      {
        months: 2,
      },
    );
    expect(p.months.every((m) => m.monthlyIncomeMinor === 100_000)).toBe(true);
  });
});

// --- options + purity --------------------------------------------------------

describe("computeAccountProjection — options", () => {
  const acc = account([
    { id: "phone", name: "Phone", category: "monthly_recurring", amountMinor: 4_500 },
  ]);

  it("clamps the month count to 1..24", () => {
    expect(project(acc, { months: 0 }).months).toHaveLength(1);
    expect(project(acc, { months: -5 }).months).toHaveLength(1);
    expect(project(acc, { months: 99 }).months).toHaveLength(24);
    expect(project(acc, { months: 6 }).months).toHaveLength(6);
  });

  it("falls back to 12 months for a missing or nonsense count", () => {
    expect(project(acc, {}).months).toHaveLength(12);
    expect(project(acc, { months: Number.NaN }).months).toHaveLength(12);
    expect(project(acc).months).toHaveLength(12);
  });

  it("truncates a fractional month count", () => {
    expect(project(acc, { months: 3.9 }).months).toHaveLength(3);
  });

  it("does not mutate its input", () => {
    const input = account([
      {
        id: "ins",
        name: "Car insurance",
        category: "yearly_recurring",
        amountMinor: 120_000,
        dueDate: "2026-12-01",
        alreadySavedMinor: 5_000,
      },
      {
        id: "holiday",
        name: "Holiday",
        category: "fixed_point",
        amountMinor: 90_000,
        dueDate: "2026-11-01",
      },
    ]);
    const before = snapshot(input);
    computeAccountProjection(input, AS_OF, { months: 14, startingBalanceMinor: 1_000 });
    expect(input).toEqual(before);
  });
});

// --- household ---------------------------------------------------------------

function household(): HouseholdInput {
  return {
    householdId: "hh",
    currency: "GBP",
    members: [
      { userId: "alice", shareBp: 6_000, displayName: "Alice" },
      { userId: "bob", shareBp: 4_000, displayName: "Bob" },
    ],
    accounts: [
      {
        accountId: "alice-cur",
        role: "personal",
        memberUserId: "alice",
        currency: "GBP",
        incomes: [income(300_000, { id: "alice-pay" })],
        payments: [
          {
            id: "gym",
            name: "Gym",
            category: "monthly_recurring",
            amountMinor: 5_000,
            scope: "personal",
          },
        ],
      },
      {
        accountId: "bob-cur",
        role: "personal",
        memberUserId: "bob",
        currency: "GBP",
        incomes: [income(200_000, { id: "bob-pay" })],
        payments: [],
      },
      {
        accountId: "bills",
        role: "shared",
        currency: "GBP",
        incomes: [],
        payments: [
          {
            id: "ins",
            name: "Home insurance",
            category: "yearly_recurring",
            amountMinor: 120_000,
            dueDate: "2026-12-01",
            scope: "shared",
          },
        ],
      },
    ],
  };
}

describe("computeHouseholdProjection", () => {
  const p = computeHouseholdProjection(household(), AS_OF, { months: 7 });
  const insurance = (m: number) => p.months[m]?.lines.find((l) => l.paymentId === "ins");
  const gym = (m: number) => p.months[m]?.lines.find((l) => l.paymentId === "gym");

  it("echoes the household identity and month labels", () => {
    expect(p.householdId).toBe("hh");
    expect(p.currency).toBe("GBP");
    expect(p.asOfDate).toBe(AS_OF);
    expect(p.months.map((m) => m.month)).toEqual([
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });

  it("keys lines by payment and account", () => {
    expect(p.months[0]?.lines.map((l) => [l.paymentId, l.accountId])).toEqual([
      ["gym", "alice-cur"],
      ["ins", "bills"],
    ]);
  });

  it("pools income and totals the month's obligations", () => {
    expect(p.months[0]?.monthlyIncomeMinor).toBe(500_000);
    expect(p.months[0]?.totalRequiredMinor).toBe(45_000);
    expect(p.months[0]?.totalFundedMinor).toBe(45_000);
    expect(p.months[0]?.leftoverMinor).toBe(455_000);
    expect(p.months[0]?.shortfallMinor).toBe(0);
  });

  it("moves money into the shared account while the bill is being saved for", () => {
    // The whole 60/40 split of the shared bill has to reach the joint account.
    expect(p.months.map((m) => m.transfersTotalMinor)).toEqual([
      40_000, 26_667, 26_667, 26_666, 0, 10_910, 10_909,
    ]);
    expect(p.months.slice(0, 4).every((m) => m.transfersTotalMinor > 0)).toBe(true);
  });

  it("evolves the shared reserve and empties it in the due month", () => {
    expect(p.months.map((m) => m.reservedEndMinor)).toEqual([
      40_000, 66_667, 93_334, 120_000, 0, 10_910, 21_819,
    ]);
    expect(insurance(3)?.alreadySavedEndMinor).toBe(120_000);
    expect(insurance(4)?.dueThisMonth).toBe(true);
    expect(insurance(4)?.dueAmountMinor).toBe(120_000);
    expect(insurance(4)?.requiredMonthlyMinor).toBe(0);
    expect(insurance(4)?.alreadySavedEndMinor).toBe(0);
  });

  it("keeps the personal monthly bill flat and unreserved", () => {
    for (let m = 0; m < 7; m++) {
      expect(gym(m)?.requiredMonthlyMinor).toBe(5_000);
      expect(gym(m)?.fundedMonthlyMinor).toBe(5_000);
      expect(gym(m)?.alreadySavedEndMinor).toBe(0);
      expect(gym(m)?.dueAmountMinor).toBe(5_000);
    }
  });

  it("retires a shared fixed_point goal once its month passes", () => {
    const input = household();
    input.accounts[2]!.payments.push({
      id: "sofa",
      name: "Sofa",
      category: "fixed_point",
      amountMinor: 80_000,
      dueDate: "2026-10-01",
      scope: "shared",
    });
    const p2 = computeHouseholdProjection(input, AS_OF, { months: 4 });
    expect(p2.months[1]?.lines.some((l) => l.paymentId === "sofa")).toBe(true);
    expect(p2.months[2]?.lines.find((l) => l.paymentId === "sofa")?.dueThisMonth).toBe(true);
    expect(p2.months[3]?.lines.some((l) => l.paymentId === "sofa")).toBe(false);
  });

  it("surfaces a household shortfall that persists month to month", () => {
    const input = household();
    input.accounts[0]!.incomes = [income(20_000, { id: "alice-pay" })];
    input.accounts[1]!.incomes = [income(10_000, { id: "bob-pay" })];
    const p2 = computeHouseholdProjection(input, AS_OF, { months: 3 });
    expect(p2.months.every((m) => m.shortfallMinor > 0)).toBe(true);
  });

  it("defaults to 12 months and clamps like the account projection", () => {
    expect(computeHouseholdProjection(household(), AS_OF).months).toHaveLength(12);
    expect(computeHouseholdProjection(household(), AS_OF, { months: 99 }).months).toHaveLength(24);
    expect(computeHouseholdProjection(household(), AS_OF, { months: 0 }).months).toHaveLength(1);
  });

  it("does not mutate its input", () => {
    const input = household();
    const before = snapshot(input);
    computeHouseholdProjection(input, AS_OF, { months: 14 });
    expect(input).toEqual(before);
  });
});
