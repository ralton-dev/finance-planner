import { describe, expect, it } from "vitest";
import { accountPlanFromScope } from "./engine.js";
import { householdPlanFromScope } from "./household.js";
import {
  computeScopeProjection,
  householdProjectionFromScope,
  type AccountProjection,
  type MonthProjection,
} from "./projection.js";
import { computeScopePlan, type ScopeAccountInput, type ScopeInput } from "./scope.js";
import type { IncomeInput, InflowInput, OutboundInflowInput, PaymentInput } from "./types.js";

/** An account as the walk's own fixtures describe one, before its scope role is
 *  bolted on by `owned` below. */
interface PlainAccount {
  accountId: string;
  currency: string;
  monthlyBufferMinor?: number;
  incomes: IncomeInput[];
  payments: PaymentInput[];
  inflows?: InflowInput[];
  outboundInflows?: OutboundInflowInput[];
}

const AS_OF = "2026-08-03";

// --- factories ---------------------------------------------------------------

function income(amountMinor: number, over: Partial<IncomeInput> = {}): IncomeInput {
  return { id: "inc", amountMinor, frequency: "monthly", anchorDate: AS_OF, ...over };
}

function account(
  payments: PaymentInput[],
  over: Partial<PlainAccount> = {},
  incomes: IncomeInput[] = [income(200_000)],
): PlainAccount {
  return { accountId: "acct", currency: "GBP", incomes, payments, ...over };
}

/** The same account, as a scope of one member at 100% — the degenerate case the
 *  pass plans a solo user with, and the one every figure below is read from. */
function owned(acc: PlainAccount): ScopeAccountInput {
  return {
    ...acc,
    role: "personal",
    memberUserId: "owner",
    payments: acc.payments.map((p) => ({ ...p, scope: "personal" as const })),
  };
}

function soloScope(...accounts: PlainAccount[]): ScopeInput {
  return {
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: accounts.map(owned),
  };
}

interface ProjOpts {
  months?: number;
  startingBalanceMinor?: number | null;
}

/** One account's walk, taken out of the scope walk that produced it. */
function project(acc: PlainAccount, opts: ProjOpts = {}): AccountProjection {
  return computeScopeProjection(soloScope(acc), AS_OF, {
    months: opts.months,
    startingBalancesMinor: { [acc.accountId]: opts.startingBalanceMinor ?? null },
  }).accounts[0]!;
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

describe("computeScopeProjection — monthly recurring", () => {
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

  it("matches the account's plan for the as-of month", () => {
    const acc = account([
      { id: "phone", name: "Phone", category: "monthly_recurring", amountMinor: 4_500 },
    ]);
    const scope = soloScope(acc);
    const plan = accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), acc.accountId);
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

describe("computeScopeProjection — yearly recurring", () => {
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

describe("computeScopeProjection — fixed_point goals", () => {
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

// --- contribution-first goals ------------------------------------------------

describe("computeScopeProjection — dateless contribution-first goal", () => {
  const goal: PaymentInput = {
    id: "bike",
    name: "New bike",
    category: "fixed_point",
    amountMinor: 60_000,
    fixedMonthlyMinor: 20_000,
  };
  const p = project(account([goal]), { months: 5, startingBalanceMinor: 0 });

  it("asks for the cap each month until the target is reached", () => {
    expect(p.months.map((m) => only(m)?.requiredMonthlyMinor)).toEqual([
      20_000,
      20_000,
      20_000,
      undefined,
      undefined,
    ]);
  });

  it("accumulates the reserve month by month", () => {
    expect(p.months.map((m) => only(m)?.alreadySavedEndMinor)).toEqual([
      20_000,
      40_000,
      60_000,
      undefined,
      undefined,
    ]);
  });

  it("never falls due — there is no date on which to pay it out", () => {
    for (const month of p.months) {
      expect(only(month)?.dueThisMonth ?? false).toBe(false);
      expect(only(month)?.dueAmountMinor ?? 0).toBe(0);
    }
  });

  it("drops out of later months once complete", () => {
    expect(p.months[2]?.lines).toHaveLength(1);
    expect(p.months[3]?.lines).toEqual([]);
    expect(p.months[3]?.totalRequiredMinor).toBe(0);
    expect(p.months[3]?.leftoverMinor).toBe(200_000);
  });

  it("keeps the money: completion is not a payout", () => {
    // The reserve stays counted, and the balance only ever grows by it.
    expect(p.months.map((m) => m.reservedEndMinor)).toEqual([
      20_000, 40_000, 60_000, 60_000, 60_000,
    ]);
    expect(p.months.map((m) => m.projectedBalanceMinor)).toEqual([
      20_000, 40_000, 60_000, 60_000, 60_000,
    ]);
  });

  it("asks only for the remainder in a ragged final month", () => {
    const ragged = project(account([{ ...goal, amountMinor: 50_000 }]), { months: 4 });
    expect(ragged.months.map((m) => only(m)?.requiredMonthlyMinor)).toEqual([
      20_000,
      20_000,
      10_000,
      undefined,
    ]);
    expect(only(ragged.months[2]!)?.alreadySavedEndMinor).toBe(50_000);
  });

  it("keeps going for as long as the money is short", () => {
    // 5,000 a month of income against a 20,000 cap: the goal never completes
    // inside the window, so it stays in every month.
    const starved = project(account([goal], {}, [income(5_000)]), { months: 4 });
    expect(starved.months.every((m) => m.lines.length === 1)).toBe(true);
    expect(starved.months.map((m) => only(m)?.fundedMonthlyMinor)).toEqual([
      5_000, 5_000, 5_000, 5_000,
    ]);
    expect(starved.months[3]?.shortfallMinor).toBe(15_000);
  });
});

describe("computeScopeProjection — dated contribution-first goal", () => {
  const p = project(
    account([
      {
        id: "bike",
        name: "New bike",
        category: "fixed_point",
        amountMinor: 60_000,
        dueDate: "2026-10-01",
        fixedMonthlyMinor: 20_000,
      },
    ]),
    { months: 4, startingBalanceMinor: 0 },
  );

  it("still pays out in its due month, like any dated goal", () => {
    const due = p.months[2]!;
    expect(due.month).toBe("2026-10");
    expect(only(due)?.dueThisMonth).toBe(true);
    expect(only(due)?.dueAmountMinor).toBe(60_000);
    expect(only(due)?.alreadySavedEndMinor).toBe(0);
    expect(p.months[3]?.lines).toEqual([]);
  });

  it("spends the reserve rather than keeping it", () => {
    expect(p.months.map((m) => m.projectedBalanceMinor)).toEqual([20_000, 40_000, 0, 0]);
  });
});

// --- shortfalls --------------------------------------------------------------

describe("computeScopeProjection — underfunded account", () => {
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

describe("computeScopeProjection — custom_recurring", () => {
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

  it("requires exactly what the pass requires", () => {
    const scope = soloScope(acc);
    expect(only(p.months[0]!)?.requiredMonthlyMinor).toBe(
      accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), acc.accountId).lines[0]
        ?.requiredMonthlyMinor,
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

describe("computeScopeProjection — projected balance", () => {
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

describe("computeScopeProjection — income", () => {
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

describe("computeScopeProjection — options", () => {
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
    const scope = soloScope(input);
    const before = snapshot(scope);
    computeScopeProjection(scope, AS_OF, {
      months: 14,
      startingBalancesMinor: { acct: 1_000 },
    });
    expect(scope).toEqual(before);
  });
});

// --- arriving inflow ---------------------------------------------------------

/** A bills pot: no income of its own, one bill it has to save up for. */
const insurance: PaymentInput = {
  id: "ins",
  name: "Home insurance",
  category: "yearly_recurring",
  amountMinor: 120_000,
  dueDate: "2026-12-01",
};

/** The reserve an account funded 40,000 a month builds toward that bill, and
 *  starts rebuilding after it. Pinned once; three tests read it. */
const FUNDED_RESERVE = [40_000, 66_667, 93_334, 120_000, 0, 10_910, 21_819, 32_728];

function pot(over: Partial<PlainAccount> = {}): PlainAccount {
  return { accountId: "pot", currency: "GBP", incomes: [], payments: [insurance], ...over };
}

/** The same pot, with the account that feeds it — a scope of one member whose
 *  income is in one account and whose bill is paid from another. Nobody authors
 *  the feed; the pass derives it (decision 9). */
function fedScope(over: Partial<PlainAccount> = {}): ScopeInput {
  return soloScope(
    { accountId: "current", currency: "GBP", incomes: [income(40_000)], payments: [] },
    pot(over),
  );
}

const forScopeAccount = (p: ReturnType<typeof computeScopeProjection>, accountId: string) =>
  p.accounts.find((a) => a.accountId === accountId)!;

describe("computeScopeProjection — a pot the pass feeds", () => {
  it("projects itself into the ground with nothing arriving", () => {
    // The defect, stated first so the fix has something to be a fix of: no
    // income, nobody feeding it, and the bill still gets paid in December.
    const p = project(pot(), { months: 8, startingBalanceMinor: 0 });
    expect(p.months.every((m) => m.reservedEndMinor === 0)).toBe(true);
    expect(p.months.every((m) => m.shortfallMinor > 0)).toBe(true);
    expect(p.months.map((m) => m.projectedBalanceMinor)).toEqual([
      0, 0, 0, 0, -120_000, -120_000, -120_000, -120_000,
    ]);
  });

  it("builds a stable reserve out of a derived feed, month after month", () => {
    // The pot has no income and no authored inflow. Its bill is an obligation of
    // the member who owns it, funded from that member's budget wherever their
    // income happens to sit, and transported by a transfer the pass derives. The
    // reserve is exactly the one an account earning the money itself would hold.
    const p = computeScopeProjection(fedScope(), AS_OF, {
      months: 8,
      startingBalancesMinor: { pot: 0 },
    });
    const months = forScopeAccount(p, "pot").months;
    expect(months.map((m) => m.reservedEndMinor)).toEqual(FUNDED_RESERVE);
    expect(months.map((m) => m.projectedBalanceMinor)).toEqual(FUNDED_RESERVE);
    expect(months.every((m) => m.shortfallMinor === 0)).toBe(true);
  });

  it("says what arrived, so the month can explain its own arithmetic", () => {
    const months = forScopeAccount(
      computeScopeProjection(fedScope(), AS_OF, { months: 3 }),
      "pot",
    ).months;
    for (const month of months) {
      // Funded beyond own income minus buffer, and the reason is on the wire.
      expect(month.monthlyIncomeMinor).toBe(0);
      expect(month.allocatedInflowMinor).toBeGreaterThan(0);
      expect(month.totalFundedMinor).toBeGreaterThan(month.monthlyIncomeMinor - month.bufferMinor);
    }
  });

  it("re-derives the feed each month instead of holding month 0 flat", () => {
    // The old single-account walk could only hold the as-of month's arrival flat
    // — it did not contain the account that funded it. One pass over the whole
    // scope re-derives the transfer against *this* month's obligation, so a pot
    // most of the way to its bill is fed less, not the same.
    const months = forScopeAccount(
      computeScopeProjection(fedScope(), AS_OF, { months: 5 }),
      "pot",
    ).months;
    expect(months.map((m) => m.allocatedInflowMinor)).toEqual([40_000, 26_667, 26_667, 26_666, 0]);
    // And the sender's projection is the same pass, so it cannot disagree: what
    // it says it sends is what the pot says arrived.
    const current = forScopeAccount(
      computeScopeProjection(fedScope(), AS_OF, { months: 5 }),
      "current",
    ).months;
    expect(current.map((m) => m.leftoverMinor)).toEqual([0, 13_333, 13_333, 13_334, 40_000]);
  });

  it("confirms only the as-of month — nobody has moved next March's money", () => {
    const scope: ScopeInput = {
      ...fedScope(),
      confirmedTransfers: [
        {
          fromAccountId: "current",
          toAccountId: "pot",
          memberUserId: "owner",
          confirmedMinor: 40_000,
        },
      ],
    };
    const months = forScopeAccount(
      computeScopeProjection(scope, AS_OF, { months: 4 }),
      "pot",
    ).months;
    expect(months.map((m) => m.confirmedInflowMinor)).toEqual([40_000, 0, 0, 0]);
    // The money still arrives every month; only the claim that it moved expires.
    expect(months.every((m) => m.allocatedInflowMinor > 0)).toBe(true);
  });
});

describe("computeScopeProjection — a standalone account is unchanged", () => {
  const acc = account([
    { id: "phone", name: "Phone", category: "monthly_recurring", amountMinor: 4_500 },
  ]);

  it("reports nothing arriving and nothing leaving, in every month", () => {
    for (const month of project(acc, { months: 6 }).months) {
      expect(month.allocatedInflowMinor).toBe(0);
      expect(month.confirmedInflowMinor).toBe(0);
      expect(month.outboundInflowMinor).toBe(0);
    }
  });

  it("keeps every figure it had before inflows existed", () => {
    for (const month of project(acc, { months: 6 }).months) {
      expect(month.monthlyIncomeMinor).toBe(200_000);
      expect(month.totalRequiredMinor).toBe(4_500);
      expect(month.totalFundedMinor).toBe(4_500);
      expect(month.leftoverMinor).toBe(195_500);
      expect(month.shortfallMinor).toBe(0);
    }
  });

  it("is unmoved by the confirmation rule, having nothing to confirm", () => {
    // An account with no `inflow` at all takes the same path as one with an
    // empty one; the later-month reset has nothing to reset.
    expect(project(acc, { months: 4 })).toEqual(project(account([...acc.payments]), { months: 4 }));
  });
});

// --- estate projection -------------------------------------------------------

const salary = (amountMinor: number, over: Partial<IncomeInput> = {}): IncomeInput => ({
  id: "pay",
  amountMinor,
  frequency: "monthly",
  anchorDate: AS_OF,
  ...over,
});

const leaving = (
  id: string,
  amountMinor: number,
  toAccountId: string,
  over: Partial<OutboundInflowInput> = {},
): OutboundInflowInput => ({
  id,
  toAccountId,
  amountMinor,
  frequency: "monthly",
  recurrence: null,
  anchorDate: AS_OF,
  active: true,
  priority: 10,
  ...over,
});

const arriving = (id: string, amountMinor: number, sourceAccountId: string): InflowInput => ({
  id,
  amountMinor,
  frequency: "monthly",
  recurrence: null,
  anchorDate: AS_OF,
  active: true,
  source: "account",
  sourceAccountId,
  priority: 10,
});

const bill = (id: string, amountMinor: number): PaymentInput => ({
  id,
  name: id,
  category: "monthly_recurring",
  amountMinor,
  priority: 1,
});

/** current pays the rent and sends 40,000 a month into the bills pot. */
function fedPot(): PlainAccount[] {
  return [
    {
      accountId: "current",
      currency: "GBP",
      incomes: [salary(200_000)],
      payments: [bill("rent", 100_000)],
      outboundInflows: [leaving("cur->pot", 40_000, "pot")],
    },
    pot({ inflows: [arriving("cur->pot", 40_000, "current")] }),
  ];
}

/**
 * The same fixture, planned as one scope rather than as an estate.
 *
 * Two things move, and both are decisions 9 and 12 rather than drift. The pot's
 * bill is an obligation of the account's owner, so the pass **derives** a
 * transfer to cover it whether or not anybody authored one — and the authored
 * £400 arrives on top of that, as savings, because netting the two would put
 * savings money inside expense arithmetic (decision 12). And the sending
 * account's `leftoverMinor` is its own income after the derived transfer has
 * left, which is why it is no longer flat.
 */
describe("computeScopeProjection — the whole scope walks forward together", () => {
  const p = computeScopeProjection(soloScope(...fedPot()), AS_OF, {
    months: 8,
    startingBalancesMinor: { pot: 0 },
  });

  it("plans senders before receivers and echoes the identity", () => {
    expect(p.asOfDate).toBe(AS_OF);
    expect(p.accounts.map((a) => a.accountId)).toEqual(["current", "pot"]);
    expect(p.cycles).toEqual([]);
    expect(p.months.map((m) => m.month).slice(0, 3)).toEqual(["2026-08", "2026-09", "2026-10"]);
  });

  it("builds the pot's reserve out of what the month's bill actually needs", () => {
    expect(forScopeAccount(p, "pot").months.map((m) => m.reservedEndMinor)).toEqual(FUNDED_RESERVE);
    expect(forScopeAccount(p, "pot").months.every((m) => m.shortfallMinor === 0)).toBe(true);
  });

  it("feeds the pot what its bill costs, and the authored £400 on top", () => {
    // The derived transfer is exactly the month's obligation; the authored
    // movement is a further £400 of savings, arriving whether or not the bill
    // needed it. The month the bill falls due, only the movement arrives.
    expect(forScopeAccount(p, "pot").months.map((m) => m.allocatedInflowMinor)).toEqual([
      80_000, 66_667, 66_667, 66_666, 40_000, 50_910, 50_909, 50_909,
    ]);
  });

  it("says what the sending account sends, so its surplus is not read as spare", () => {
    const current = forScopeAccount(p, "current");
    expect(current.months.every((m) => m.outboundInflowMinor === 40_000)).toBe(true);
    expect(current.months.every((m) => m.allocatedInflowMinor === 0)).toBe(true);
    // £2,000 income, £1,000 rent, then the derived transfer the pot's bill
    // needs. The savings movement is *not* subtracted — `leftoverMinor` keeps
    // its meaning (decision 13) and `outboundInflowMinor` sits alongside it.
    expect(current.months.map((m) => m.leftoverMinor)).toEqual([
      60_000, 73_333, 73_333, 73_334, 100_000, 89_090, 89_091, 89_091,
    ]);
  });

  it("reports the movements and the derived transfers of each simulated month", () => {
    expect(p.months[5]?.movements).toEqual([
      {
        inflowId: "cur->pot",
        fromAccountId: "current",
        toAccountId: "pot",
        currency: "GBP",
        priority: 10,
        requestedMinor: 40_000,
        fundedMinor: 40_000,
        fundedFromOwnMinor: 40_000,
        fundedFromInflowMinor: 0,
        status: "funded",
      },
    ]);
    expect(p.months[5]?.transfers).toEqual([
      {
        fromAccountId: "current",
        toAccountId: "pot",
        memberUserId: "owner",
        currency: "GBP",
        amountMinor: 10_910,
        confirmedMinor: 0,
      },
    ]);
  });

  it("reports a null balance for an account given no opening figure", () => {
    expect(
      forScopeAccount(p, "current").months.every((m) => m.projectedBalanceMinor === null),
    ).toBe(true);
    expect(
      computeScopeProjection(soloScope(...fedPot()), AS_OF, { months: 2 }).accounts[1]?.months[0]
        ?.projectedBalanceMinor,
    ).toBe(null);
  });

  it("clamps and defaults the month count like the account projection", () => {
    expect(computeScopeProjection(soloScope(...fedPot()), AS_OF).months).toHaveLength(12);
    expect(
      computeScopeProjection(soloScope(...fedPot()), AS_OF, { months: 99 }).months,
    ).toHaveLength(24);
    expect(
      computeScopeProjection(soloScope(...fedPot()), AS_OF, { months: 0 }).months,
    ).toHaveLength(1);
  });

  it("does not mutate its input", () => {
    const input = fedPot();
    const before = snapshot(input);
    computeScopeProjection(soloScope(...input), AS_OF, {
      months: 14,
      startingBalancesMinor: { pot: 5_000 },
    });
    expect(input).toEqual(before);
  });

  it("plans a lone standalone account exactly as the account projection does", () => {
    const solo = account([
      { id: "phone", name: "Phone", category: "monthly_recurring", amountMinor: 4_500 },
    ]);
    expect(
      computeScopeProjection(soloScope(solo), AS_OF, { months: 4 }).accounts[0]?.months,
    ).toEqual(project(solo, { months: 4 }).months);
  });
});

// --- the plan changing mid-horizon -------------------------------------------

describe("computeScopeProjection — the plan changes mid-horizon", () => {
  it("passes on the money a completed goal stops consuming", () => {
    // 60,000 saved at 20,000 a month: three months of the sender's income is
    // spoken for, and from the fourth the pot gets the lot.
    const accounts: PlainAccount[] = [
      {
        accountId: "current",
        currency: "GBP",
        incomes: [salary(100_000)],
        payments: [
          {
            id: "bike",
            name: "New bike",
            category: "fixed_point",
            amountMinor: 60_000,
            fixedMonthlyMinor: 20_000,
            priority: 1,
          },
        ],
        outboundInflows: [leaving("cur->pot", 100_000, "pot")],
      },
      { accountId: "pot", currency: "GBP", incomes: [], payments: [] },
    ];
    const p = computeScopeProjection(soloScope(...accounts), AS_OF, { months: 5 });
    expect(forScopeAccount(p, "pot").months.map((m) => m.allocatedInflowMinor)).toEqual([
      80_000, 80_000, 80_000, 100_000, 100_000,
    ]);
    expect(p.months.map((m) => m.movements[0]?.status)).toEqual([
      "short",
      "short",
      "short",
      "funded",
      "funded",
    ]);
  });

  it("sends less when the sender can no longer afford it, and says so", () => {
    const accounts: PlainAccount[] = [
      {
        accountId: "current",
        currency: "GBP",
        incomes: [
          salary(100_000),
          salary(40_000, { id: "bonus", frequency: "one_off", anchorDate: "2026-11-01" }),
        ],
        payments: [],
        outboundInflows: [leaving("cur->pot", 130_000, "pot")],
      },
      { accountId: "pot", currency: "GBP", incomes: [], payments: [bill("bills", 130_000)] },
    ];
    const p = computeScopeProjection(soloScope(...accounts), AS_OF, { months: 5 });
    // The bonus tapers in, lands, and is gone; the feed follows it down. What
    // arrives is the derived transfer covering the pot's bill — plus, in the
    // bonus month, the £100 of surplus the authored movement could carry after
    // it (decision 8: every expense first, savings out of what is left).
    expect(forScopeAccount(p, "pot").months.map((m) => m.allocatedInflowMinor)).toEqual([
      120_000, 120_000, 140_000, 100_000, 100_000,
    ]);
    expect(forScopeAccount(p, "pot").months.map((m) => m.shortfallMinor)).toEqual([
      10_000, 10_000, 0, 30_000, 30_000,
    ]);
    expect(p.months.map((m) => m.movements[0]?.status)).toEqual([
      "unfunded",
      "unfunded",
      "short",
      "unfunded",
      "unfunded",
    ]);
  });

  it("stops a one-off movement once its date has passed", () => {
    const accounts: PlainAccount[] = [
      {
        accountId: "current",
        currency: "GBP",
        incomes: [salary(200_000)],
        payments: [],
        outboundInflows: [
          leaving("cur->pot", 60_000, "pot", { frequency: "one_off", anchorDate: "2026-11-01" }),
        ],
      },
      { accountId: "pot", currency: "GBP", incomes: [], payments: [] },
    ];
    const p = computeScopeProjection(soloScope(...accounts), AS_OF, { months: 5 });
    expect(forScopeAccount(p, "pot").months.map((m) => m.allocatedInflowMinor)).toEqual([
      30_000, 30_000, 60_000, 0, 0,
    ]);
    // One pass over the scope reaches the same answer, and for the same reason:
    // the sending account's month is planned beside the pot's, so a movement
    // whose cadence has expired stops arriving rather than being held flat at
    // whatever month 0 happened to settle.
    const scope = computeScopeProjection(soloScope(...accounts), AS_OF, { months: 5 });
    expect(forScopeAccount(scope, "pot").months.map((m) => m.allocatedInflowMinor)).toEqual([
      30_000, 30_000, 60_000, 0, 0,
    ]);
  });

  it("breaks a funding loop the same way every month rather than hanging", () => {
    const accounts: PlainAccount[] = [
      {
        accountId: "a",
        currency: "GBP",
        incomes: [salary(100_000)],
        payments: [],
        outboundInflows: [leaving("a->b", 50_000, "b")],
      },
      {
        accountId: "b",
        currency: "GBP",
        incomes: [],
        payments: [],
        outboundInflows: [leaving("b->a", 50_000, "a")],
      },
    ];
    const p = computeScopeProjection(soloScope(...accounts), AS_OF, { months: 6 });
    expect(p.cycles).toHaveLength(1);
    expect(p.cycles[0]?.accountIds).toEqual(["a", "b"]);
    expect(p.months).toHaveLength(6);
    // The broken edge stays broken in every month — the tie-breaks are priority,
    // destination and id, none of which move with the calendar.
    for (const month of p.months) {
      expect(month.movements.find((m) => m.inflowId === "b->a")?.status).toBe("broken_cycle");
    }
  });
});

// --- the invariant, over a whole horizon --------------------------------------

/** current → pot → savings → isa, one salary and a bill at every stop. */
function chain(): PlainAccount[] {
  return [
    {
      accountId: "current",
      currency: "GBP",
      incomes: [salary(500_000)],
      payments: [bill("rent", 100_000)],
      outboundInflows: [leaving("to-pot", 300_000, "pot")],
    },
    {
      accountId: "pot",
      currency: "GBP",
      incomes: [],
      inflows: [arriving("to-pot", 300_000, "current")],
      payments: [bill("bills", 100_000)],
      outboundInflows: [leaving("to-savings", 200_000, "savings")],
    },
    {
      accountId: "savings",
      currency: "GBP",
      incomes: [],
      inflows: [arriving("to-savings", 200_000, "pot")],
      payments: [bill("emergency", 100_000)],
      outboundInflows: [leaving("to-isa", 100_000, "isa")],
    },
    {
      accountId: "isa",
      currency: "GBP",
      incomes: [],
      inflows: [arriving("to-isa", 100_000, "savings")],
      payments: [bill("stocks", 100_000)],
    },
  ];
}

describe("computeScopeProjection — money in is still only what comes from outside", () => {
  it("never inflates the estate's income, at any month or any depth", () => {
    // A projection that treated a movement as new money would add a salary's
    // worth per hop per month — invisible on one account, ruinous on a chain.
    for (const depth of [2, 3, 4]) {
      const p = computeScopeProjection(soloScope(...chain().slice(0, depth)), AS_OF, {
        months: 12,
      });
      for (const month of p.months) {
        expect(month.perCurrency).toHaveLength(1);
        expect(month.perCurrency[0]!.monthlyIncomeMinor).toBe(500_000);
      }
    }
  });

  it("keeps funded plus left over equal to what came in, every month", () => {
    // No netting term anywhere: the pass takes a transferred pound out of the
    // sending account's own surplus before anything sums it, so the identity
    // holds on a four-deep chain with nothing subtracted (see
    // `overviewFromPlans` for the netting this replaced).
    const p = computeScopeProjection(soloScope(...chain()), AS_OF, { months: 12 });
    for (const month of p.months) {
      const bucket = month.perCurrency[0]!;
      expect(bucket.totalFundedMinor).toBe(400_000);
      expect(bucket.totalFundedMinor + bucket.leftoverMinor).toBe(bucket.monthlyIncomeMinor);
    }
  });

  it("agrees with the one-month plan in its first month", () => {
    const p = computeScopeProjection(soloScope(...chain()), AS_OF, { months: 12 });
    const plan = computeScopePlan(soloScope(...chain()), AS_OF);
    const partition = plan.partitions[0]!;
    expect(p.months[0]?.perCurrency).toEqual([
      {
        currency: partition.currency,
        monthlyIncomeMinor: partition.monthlyIncomeMinor,
        totalRequiredMinor: partition.totalRequiredMinor,
        totalFundedMinor: partition.totalFundedMinor,
        leftoverMinor: partition.leftoverMinor,
        committedMinor: partition.committedMinor,
        shortfallMinor: partition.shortfallMinor,
      },
    ]);
    expect(p.months[0]?.movements).toEqual(plan.movements);
    expect(p.months[0]?.transfers).toEqual(plan.transfers);
  });
});

// --- household ---------------------------------------------------------------

const HOUSEHOLD_ACCOUNTS = ["alice-cur", "bob-cur", "bills"];

function household(): ScopeInput {
  return {
    scopeId: "hh",
    householdId: "hh",
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

/** The household's months, read off the one scope walk. */
function householdWalk(input: ScopeInput, months: number) {
  return householdProjectionFromScope(
    computeScopeProjection(input, AS_OF, { months }),
    "hh",
    HOUSEHOLD_ACCOUNTS,
    "GBP",
  );
}

describe("householdProjectionFromScope", () => {
  const p = householdWalk(household(), 7);
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
    // Both shares round up, so a month whose requirement does not divide by the
    // split moves a penny more than it strictly needs (26_667 → 26_668).
    expect(p.months.map((m) => m.transfersTotalMinor)).toEqual([
      40_000, 26_668, 26_668, 26_667, 0, 10_910, 10_910,
    ]);
    expect(p.months.slice(0, 4).every((m) => m.transfersTotalMinor > 0)).toBe(true);
  });

  it("evolves the shared reserve and empties it in the due month", () => {
    // The members are asked for a penny more than the bill costs, and the pot
    // keeps it: what is *set aside* is the requirement, so the reserve tracks
    // the bill exactly rather than running a penny ahead of it. That penny is
    // the pot's surplus, which is where `splitByShares`' overshoot belongs.
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
    const p2 = householdWalk(input, 4);
    expect(p2.months[1]?.lines.some((l) => l.paymentId === "sofa")).toBe(true);
    expect(p2.months[2]?.lines.find((l) => l.paymentId === "sofa")?.dueThisMonth).toBe(true);
    expect(p2.months[3]?.lines.some((l) => l.paymentId === "sofa")).toBe(false);
  });

  it("surfaces a household shortfall that persists month to month", () => {
    const input = household();
    input.accounts[0]!.incomes = [income(20_000, { id: "alice-pay" })];
    input.accounts[1]!.incomes = [income(10_000, { id: "bob-pay" })];
    const p2 = householdWalk(input, 3);
    expect(p2.months.every((m) => m.shortfallMinor > 0)).toBe(true);
  });

  it("defaults to 12 months and clamps like the account projection", () => {
    expect(
      householdProjectionFromScope(
        computeScopeProjection(household(), AS_OF),
        "hh",
        HOUSEHOLD_ACCOUNTS,
        "GBP",
      ).months,
    ).toHaveLength(12);
    expect(householdWalk(household(), 99).months).toHaveLength(24);
    expect(householdWalk(household(), 0).months).toHaveLength(1);
  });

  it("reports only the household's own accounts, however far the pass reached", () => {
    // The scope walk plans whatever funds the household as well; a sender
    // nobody assigned to it is not one of its accounts.
    const input = household();
    input.accounts.push({
      accountId: "alice-isa",
      role: "personal",
      memberUserId: "alice",
      currency: "GBP",
      incomes: [],
      payments: [],
    });
    const p2 = householdWalk(input, 2);
    expect(p2.months[0]?.lines.map((l) => l.accountId)).toEqual(["alice-cur", "bills"]);
    expect(p2.months[0]?.monthlyIncomeMinor).toBe(500_000);
  });

  it("does not mutate its input", () => {
    const input = household();
    const before = snapshot(input);
    householdWalk(input, 14);
    expect(input).toEqual(before);
  });
});

// --- the household's month 0 is the household's plan --------------------------

/**
 * Month 0 of a walk is the plan for the as-of date, and the household surfaces
 * are no exception: `GET /households/:id/projection` and `GET /households/:id/plan`
 * are handed the same roster and the same currency by `scopeForHousehold`, so
 * "money the members must move" has to be one figure.
 *
 * It was two. `transfersTotalMinor` counted every transfer that *touched* one of
 * the household's accounts, including money leaving a member's account for their
 * own pot outside the household — the set `householdPlanFromScope` deliberately
 * excludes, because the destination is what has lines on this plan for a
 * confirmation to book against. Any household that sends anything out read a
 * bigger figure on its projection than on its plan for the same month.
 */
describe("householdProjectionFromScope — month 0 is the household plan", () => {
  /** The household, plus a pot of Alice's own that no member assigned to it. */
  function withOutsidePot(): ScopeInput {
    const input = household();
    input.accounts.push({
      accountId: "alice-isa",
      role: "personal",
      memberUserId: "alice",
      currency: "GBP",
      incomes: [],
      payments: [
        {
          id: "isa",
          name: "ISA",
          category: "monthly_recurring",
          amountMinor: 30_000,
          scope: "personal",
        },
      ],
    });
    return input;
  }

  const planFor = (input: ScopeInput) =>
    householdPlanFromScope(computeScopePlan(input, AS_OF), "hh", HOUSEHOLD_ACCOUNTS, "GBP");

  it("reports the same money to move as the plan does, to the penny", () => {
    const input = withOutsidePot();
    const plan = planFor(input);
    const planTotal = plan.transfers.reduce((n, t) => n + t.amountMinor, 0);

    // The pass really does derive the outbound feed — this is not a fixture that
    // happens to have nothing to disagree about.
    expect(
      computeScopePlan(input, AS_OF).transfers.some((t) => t.toAccountId === "alice-isa"),
    ).toBe(true);
    expect(householdWalk(input, 1).months[0]?.transfersTotalMinor).toBe(planTotal);
    // And the figure is the arriving set, not the touching one: £400 into the
    // bills pot, with Alice's £300 to her own ISA left off both surfaces.
    expect(planTotal).toBe(40_000);
  });

  it("ignores a transfer in a currency this household is not planned in", () => {
    // Reachable through `PATCH /api/accounts/:id`, which takes a currency: a
    // roster can hold an account the plan's partition no longer contains. The
    // plan drops it; the projection's transfer total has to drop it too.
    const input = withOutsidePot();
    input.accounts.push(
      {
        accountId: "alice-eur",
        role: "personal",
        memberUserId: "alice",
        currency: "EUR",
        incomes: [income(100_000, { id: "alice-eur-pay" })],
        payments: [],
      },
      {
        accountId: "eur-pot",
        role: "shared",
        currency: "EUR",
        incomes: [],
        payments: [
          {
            id: "eur-bill",
            name: "Broadband",
            category: "monthly_recurring",
            amountMinor: 20_000,
            scope: "shared",
          },
        ],
      },
    );
    const roster = [...HOUSEHOLD_ACCOUNTS, "eur-pot"];
    const walk = householdProjectionFromScope(
      computeScopeProjection(input, AS_OF, { months: 1 }),
      "hh",
      roster,
      "GBP",
    );
    const plan = householdPlanFromScope(computeScopePlan(input, AS_OF), "hh", roster, "GBP");

    expect(computeScopePlan(input, AS_OF).transfers.some((t) => t.currency === "EUR")).toBe(true);
    expect(walk.months[0]?.transfersTotalMinor).toBe(
      plan.transfers.reduce((n, t) => n + t.amountMinor, 0),
    );
    expect(walk.months[0]?.transfersTotalMinor).toBe(40_000);
  });
});

// --- month one is the plan ---------------------------------------------------

/**
 * A sending account's projection cannot diverge from its plan, because there is
 * nothing left for it to diverge *from*: month 0 of the walk is one call to
 * `computeScopePlan` for the as-of date and one view of it, which is exactly
 * what the plan endpoint returns. Asserted directly rather than trusted, and
 * over the account that sends — the one the old walk had to approximate.
 */
describe("computeScopeProjection — month one is the plan for that date", () => {
  const scope: ScopeInput = {
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      {
        accountId: "current",
        role: "personal",
        memberUserId: "owner",
        currency: "GBP",
        monthlyBufferMinor: 15_000,
        incomes: [income(200_000)],
        payments: [
          {
            id: "rent",
            name: "rent",
            category: "monthly_recurring",
            scope: "personal",
            amountMinor: 90_000,
            priority: 1,
          },
        ],
        outboundInflows: [
          {
            id: "cur->pot",
            toAccountId: "pot",
            amountMinor: 25_000,
            frequency: "monthly",
            anchorDate: AS_OF,
            priority: 10,
          },
        ],
      },
      {
        accountId: "pot",
        role: "personal",
        memberUserId: "owner",
        currency: "GBP",
        incomes: [],
        payments: [
          {
            id: "ins",
            name: "Home insurance",
            category: "yearly_recurring",
            scope: "personal",
            amountMinor: 120_000,
            dueDate: "2026-12-01",
          },
        ],
      },
    ],
  };

  const projection = computeScopeProjection(scope, AS_OF, { months: 6 });
  const plan = computeScopePlan(scope, AS_OF);

  for (const accountId of ["current", "pot"]) {
    it(`equals ${accountId}'s plan for the as-of date, figure for figure`, () => {
      const month = forScopeAccount(projection, accountId).months[0]!;
      const view = accountPlanFromScope(scope, plan, accountId);
      expect({
        monthlyIncomeMinor: month.monthlyIncomeMinor,
        allocatedInflowMinor: month.allocatedInflowMinor,
        confirmedInflowMinor: month.confirmedInflowMinor,
        bufferMinor: month.bufferMinor,
        totalRequiredMinor: month.totalRequiredMinor,
        totalFundedMinor: month.totalFundedMinor,
        leftoverMinor: month.leftoverMinor,
        outboundInflowMinor: month.outboundInflowMinor,
        shortfallMinor: month.shortfallMinor,
        lines: month.lines.map((l) => [l.paymentId, l.requiredMonthlyMinor, l.fundedMonthlyMinor]),
      }).toEqual({
        monthlyIncomeMinor: view.monthlyIncomeMinor,
        allocatedInflowMinor: view.allocatedInflowMinor,
        confirmedInflowMinor: view.confirmedInflowMinor,
        bufferMinor: view.bufferMinor,
        totalRequiredMinor: view.totalRequiredMinor,
        totalFundedMinor: view.totalFundedMinor,
        leftoverMinor: view.leftoverMinor,
        outboundInflowMinor: view.outboundInflowMinor,
        shortfallMinor: view.shortfallMinor,
        lines: view.lines.map((l) => [l.paymentId, l.requiredMonthlyMinor, l.fundedMonthlyMinor]),
      });
    });
  }

  it("reports the month's totals off the pass rather than summing them again", () => {
    const first = projection.months[0]!.perCurrency[0]!;
    expect(first).toEqual({
      currency: "GBP",
      monthlyIncomeMinor: plan.partitions[0]!.monthlyIncomeMinor,
      totalRequiredMinor: plan.partitions[0]!.totalRequiredMinor,
      totalFundedMinor: plan.partitions[0]!.totalFundedMinor,
      leftoverMinor: plan.partitions[0]!.leftoverMinor,
      committedMinor: plan.partitions[0]!.committedMinor,
      shortfallMinor: plan.partitions[0]!.shortfallMinor,
    });
    expect(projection.scopeId).toBe("owner");
    expect(projection.householdId).toBeNull();
    expect(projection.cycles).toEqual([]);
    expect(projection.months.map((m) => m.month).slice(0, 3)).toEqual([
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
  });

  it("says every month what has to move, and what the movements take", () => {
    expect(projection.months[0]!.transfers.map((t) => [t.toAccountId, t.amountMinor])).toEqual([
      ["pot", 40_000],
    ]);
    expect(projection.months[0]!.movements.map((m) => [m.inflowId, m.fundedMinor])).toEqual([
      ["cur->pot", 25_000],
    ]);
  });
});

// --- a pooled account ---------------------------------------------------------

/**
 * A shared pot has no owner and no income; it holds a reserve and pays the
 * household's bills out of what the members are asked for. Its buffer is an
 * obligation at the lowest priority (never spendable savings), and its bill is a
 * shared cost split by share — so a pooled account's reserve has to be stable
 * month after month, not drained by the first movement that comes past.
 */
describe("computeScopeProjection — a pooled account holds its reserve", () => {
  const pooled: ScopeInput = {
    scopeId: "h1",
    householdId: "h1",
    members: [
      { userId: "alice", shareBp: 6_000 },
      { userId: "bob", shareBp: 4_000 },
    ],
    accounts: [
      {
        accountId: "alice-cur",
        role: "personal",
        memberUserId: "alice",
        currency: "GBP",
        incomes: [income(300_000)],
        payments: [],
      },
      {
        accountId: "bob-cur",
        role: "personal",
        memberUserId: "bob",
        currency: "GBP",
        incomes: [income(200_000, { id: "inc2" })],
        payments: [],
      },
      {
        accountId: "bills",
        role: "shared",
        currency: "GBP",
        monthlyBufferMinor: 30_000,
        incomes: [],
        payments: [
          {
            id: "ins",
            name: "Home insurance",
            category: "yearly_recurring",
            scope: "shared",
            amountMinor: 120_000,
            dueDate: "2026-12-01",
          },
        ],
      },
    ],
  };

  const months = forScopeAccount(
    computeScopeProjection(pooled, AS_OF, { months: 8, startingBalancesMinor: { bills: 0 } }),
    "bills",
  ).months;

  it("builds and rebuilds the same reserve an owned account would", () => {
    expect(months.map((m) => m.reservedEndMinor)).toEqual(FUNDED_RESERVE);
    expect(months.every((m) => m.shortfallMinor === 0)).toBe(true);
  });

  it("keeps the buffer arriving every month, and never spends it", () => {
    // The buffer is funded as an obligation at the lowest priority, so it is
    // part of what arrives and none of what the bill takes.
    expect(months.every((m) => m.bufferMinor === 30_000)).toBe(true);
    // The buffer, plus the month's share of the bill. The odd penny in the
    // middle four is `splitByShares` rounding each member's share up, so a bill
    // is never a penny short — the members are asked for 26,668 to pay 26,667.
    expect(months.map((m) => m.allocatedInflowMinor)).toEqual([
      70_000, 56_668, 56_668, 56_667, 30_000, 40_910, 40_910, 40_910,
    ]);
    expect(months.every((m) => m.allocatedInflowMinor - m.totalFundedMinor >= 30_000)).toBe(true);
  });
});
