import { describe, expect, it } from "vitest";
import {
  accountPlanFromScope,
  computeAccountPlan,
  monthlyIncomeMinor,
  requiredMonthlyForPayment,
} from "./engine.js";
import { parseISODate } from "./dates.js";
import { computeScopePlan, type ScopeInput } from "./scope.js";
import type { AccountInput, AllocatedInflow, IncomeInput, PaymentInput } from "./types.js";

const AS_OF = "2026-01-01";
const now = parseISODate(AS_OF);

describe("monthlyIncomeMinor", () => {
  it("passes monthly income through unchanged", () => {
    const income: IncomeInput = {
      id: "i1",
      amountMinor: 200_000,
      frequency: "monthly",
      anchorDate: AS_OF,
    };
    expect(monthlyIncomeMinor(income, now)).toBe(200_000);
  });

  it("spreads yearly income over 12 months", () => {
    const income: IncomeInput = {
      id: "i2",
      amountMinor: 120_000,
      frequency: "yearly",
      anchorDate: AS_OF,
    };
    expect(monthlyIncomeMinor(income, now)).toBe(10_000);
  });

  it("excludes inactive income", () => {
    const income: IncomeInput = {
      id: "i3",
      amountMinor: 999_999,
      frequency: "monthly",
      anchorDate: AS_OF,
      active: false,
    };
    expect(monthlyIncomeMinor(income, now)).toBe(0);
  });
});

describe("requiredMonthlyForPayment", () => {
  it("fixed_point: spreads remaining over months until target", () => {
    const p: PaymentInput = {
      id: "p1",
      name: "Holiday",
      category: "fixed_point",
      amountMinor: 120_000,
      dueDate: "2026-09-01",
    };
    // 8 months out → 120000 / 8 = 15000
    expect(requiredMonthlyForPayment(p, now).requiredMinor).toBe(15_000);
  });

  it("fixed_point: accounts for already-saved amount", () => {
    const p: PaymentInput = {
      id: "p1",
      name: "Holiday",
      category: "fixed_point",
      amountMinor: 120_000,
      alreadySavedMinor: 40_000,
      dueDate: "2026-09-01",
    };
    // (120000 - 40000) / 8 = 10000
    expect(requiredMonthlyForPayment(p, now).requiredMinor).toBe(10_000);
  });

  it("yearly_recurring: saves toward the next occurrence", () => {
    const p: PaymentInput = {
      id: "p2",
      name: "Car insurance",
      category: "yearly_recurring",
      amountMinor: 32_000,
      dueDate: "2026-06-01",
    };
    // 5 months out → 32000 / 5 = 6400
    expect(requiredMonthlyForPayment(p, now).requiredMinor).toBe(6_400);
  });

  it("monthly_recurring: full amount due each month", () => {
    const p: PaymentInput = {
      id: "p3",
      name: "Phone",
      category: "monthly_recurring",
      amountMinor: 4_500,
    };
    const r = requiredMonthlyForPayment(p, now);
    expect(r.requiredMinor).toBe(4_500);
    expect(r.monthsUntilDue).toBe(1);
    expect(r.occurrencesThisMonth).toBe(1);
  });

  it("custom_recurring: spreads over months until next occurrence", () => {
    const p: PaymentInput = {
      id: "p4",
      name: "Water",
      category: "custom_recurring",
      amountMinor: 9_000,
      dueDate: "2026-03-01",
      recurrence: { interval: 3, unit: "month", anchor: "2026-03-01" },
    };
    // next due 2026-03-01, 2 months out → 9000 / 2 = 4500; nothing falls in Jan.
    const r = requiredMonthlyForPayment(p, now);
    expect(r.requiredMinor).toBe(4_500);
    expect(r.occurrencesThisMonth).toBe(1);
  });

  it("custom_recurring: charges every occurrence that lands this month", () => {
    const p: PaymentInput = {
      id: "p4b",
      name: "Butternut",
      category: "custom_recurring",
      amountMinor: 8_213,
      dueDate: "2026-01-08",
      recurrence: { interval: 2, unit: "week", anchor: "2026-01-08" },
    };
    // 01-08 and 01-22 both fall in January → 2 × 8213, due this month.
    const r = requiredMonthlyForPayment(p, now);
    expect(r.requiredMinor).toBe(16_426);
    expect(r.monthsUntilDue).toBe(1);
    expect(r.effectiveDate).toBe("2026-01-08");
    expect(r.occurrencesThisMonth).toBe(2);
  });

  it("custom_recurring: counts three occurrences in a straddling month", () => {
    const p: PaymentInput = {
      id: "p4c",
      name: "Fortnightly",
      category: "custom_recurring",
      amountMinor: 1_000,
      dueDate: "2026-01-01",
      recurrence: { interval: 2, unit: "week", anchor: "2026-01-01" },
    };
    // 01-01, 01-15, 01-29 → 3 × 1000.
    expect(requiredMonthlyForPayment(p, now).requiredMinor).toBe(3_000);
  });

  it("target date in the past requires the full remaining now", () => {
    const p: PaymentInput = {
      id: "p5",
      name: "Overdue",
      category: "fixed_point",
      amountMinor: 50_000,
      dueDate: "2025-01-01",
    };
    const r = requiredMonthlyForPayment(p, now);
    expect(r.monthsUntilDue).toBe(1);
    expect(r.requiredMinor).toBe(50_000);
  });
});

describe("computeAccountPlan", () => {
  it("reports leftover when income comfortably covers contributions", () => {
    const account: AccountInput = {
      accountId: "a1",
      currency: "GBP",
      incomes: [{ id: "i1", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
      payments: [{ id: "p3", name: "Phone", category: "monthly_recurring", amountMinor: 4_500 }],
    };
    const plan = computeAccountPlan(account, AS_OF);
    expect(plan.monthlyIncomeMinor).toBe(100_000);
    expect(plan.totalRequiredMinor).toBe(4_500);
    expect(plan.leftoverMinor).toBe(95_500);
    expect(plan.shortfallMinor).toBe(0);
    expect(plan.lines[0]?.onTrack).toBe(true);
  });

  it("funds by priority and surfaces a shortfall when income is short", () => {
    const account: AccountInput = {
      accountId: "a2",
      currency: "GBP",
      incomes: [{ id: "i1", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
      payments: [
        {
          id: "high",
          name: "High priority",
          category: "fixed_point",
          amountMinor: 80_000,
          dueDate: AS_OF,
          priority: 1,
        },
        {
          id: "low",
          name: "Low priority",
          category: "fixed_point",
          amountMinor: 50_000,
          dueDate: AS_OF,
          priority: 2,
        },
      ],
    };
    const plan = computeAccountPlan(account, AS_OF);
    expect(plan.totalRequiredMinor).toBe(130_000);
    expect(plan.totalFundedMinor).toBe(100_000);
    expect(plan.leftoverMinor).toBe(0);
    expect(plan.shortfallMinor).toBe(30_000);

    const high = plan.lines.find((l) => l.paymentId === "high");
    const low = plan.lines.find((l) => l.paymentId === "low");
    expect(high?.fundedMonthlyMinor).toBe(80_000);
    expect(high?.onTrack).toBe(true);
    expect(low?.fundedMonthlyMinor).toBe(20_000);
    expect(low?.onTrack).toBe(false);
    expect(low?.projectedCompletionDate).toBeDefined();
  });

  it("counts a sub-monthly custom recurrence multiple times in the month", () => {
    const account: AccountInput = {
      accountId: "a4",
      currency: "GBP",
      incomes: [{ id: "i1", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
      payments: [
        {
          id: "fortnightly",
          name: "Butternut",
          category: "custom_recurring",
          amountMinor: 8_213,
          dueDate: "2026-01-08",
          recurrence: { interval: 2, unit: "week", anchor: "2026-01-08" },
        },
      ],
    };
    const plan = computeAccountPlan(account, AS_OF);
    // Two occurrences in January → the plan reflects both, not a single payment.
    expect(plan.lines[0]?.requiredMonthlyMinor).toBe(16_426);
    expect(plan.lines[0]?.occurrencesThisMonth).toBe(2);
    expect(plan.totalRequiredMinor).toBe(16_426);
  });

  it("totals are summed from the rounded per-payment figures", () => {
    const account: AccountInput = {
      accountId: "a3",
      currency: "GBP",
      incomes: [{ id: "i1", amountMinor: 500_000, frequency: "monthly", anchorDate: AS_OF }],
      payments: [
        {
          id: "p1",
          name: "Holiday",
          category: "fixed_point",
          amountMinor: 120_000,
          dueDate: "2026-09-01",
        },
        {
          id: "p2",
          name: "Insurance",
          category: "yearly_recurring",
          amountMinor: 32_000,
          dueDate: "2026-06-01",
        },
      ],
    };
    const plan = computeAccountPlan(account, AS_OF);
    const sumRequired = plan.lines.reduce((s, l) => s + l.requiredMonthlyMinor, 0);
    expect(plan.totalRequiredMinor).toBe(sumRequired);
  });
});

describe("computeAccountPlan — allocated inflow", () => {
  /** Three bills, funded in this order. 10000 + 15000 + 5300 = 30300. */
  const BILLS: PaymentInput[] = [
    {
      id: "b1",
      name: "Council tax",
      category: "monthly_recurring",
      amountMinor: 10_000,
      priority: 1,
    },
    { id: "b2", name: "Energy", category: "monthly_recurring", amountMinor: 15_000, priority: 2 },
    { id: "b3", name: "Broadband", category: "monthly_recurring", amountMinor: 5_300, priority: 3 },
  ];
  const TOTAL = 30_300;

  /** A bills pot: no income of its own, so everything it funds arrives. */
  const pot = (inflow?: AllocatedInflow, over: Partial<AccountInput> = {}): AccountInput => ({
    accountId: "pot",
    currency: "GBP",
    incomes: [],
    payments: BILLS,
    ...(inflow ? { inflow } : {}),
    ...over,
  });

  const statuses = (account: AccountInput): string[] =>
    computeAccountPlan(account, AS_OF).lines.map((l) => l.status);

  it("leaves a standalone account's plan exactly as it was", () => {
    // Pinned in full: everything but the four additive fields is the byte-for-
    // byte output of the engine before it learned about inflow, and the additive
    // fields sit at the values an account with nothing arriving must report.
    const account: AccountInput = {
      accountId: "solo",
      currency: "GBP",
      monthlyBufferMinor: 5_000,
      incomes: [{ id: "i1", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
      payments: [
        {
          id: "phone",
          name: "Phone",
          category: "monthly_recurring",
          amountMinor: 4_500,
          priority: 1,
        },
        {
          id: "holiday",
          name: "Holiday",
          category: "fixed_point",
          amountMinor: 120_000,
          dueDate: "2026-09-01",
          priority: 2,
          tag: "fun",
        },
        {
          id: "car",
          name: "Car insurance",
          category: "yearly_recurring",
          amountMinor: 32_000,
          dueDate: "2026-06-01",
          priority: 3,
        },
      ],
    };
    expect(computeAccountPlan(account, AS_OF)).toEqual({
      accountId: "solo",
      asOfDate: AS_OF,
      currency: "GBP",
      monthlyIncomeMinor: 100_000,
      allocatedInflowMinor: 0,
      confirmedInflowMinor: 0,
      bufferMinor: 5_000,
      totalRequiredMinor: 25_900,
      totalFundedMinor: 25_900,
      leftoverMinor: 69_100,
      shortfallMinor: 0,
      internalInflowUsedMinor: 0,
      inflowArrivals: [],
      outboundInflowMinor: 0,
      outboundInflows: [],
      fundingCycleAccountIds: undefined,
      lines: [
        {
          paymentId: "phone",
          name: "Phone",
          category: "monthly_recurring",
          amountMinor: 4_500,
          dueDate: AS_OF,
          targetDate: AS_OF,
          dueDateIsDerived: false,
          monthsUntilDue: 1,
          requiredMonthlyMinor: 4_500,
          fundedMonthlyMinor: 4_500,
          fundedFromOwnMinor: 4_500,
          fundedFromInflowMinor: 0,
          alreadySavedMinor: 0,
          occurrencesThisMonth: 1,
          onTrack: true,
          status: "funded",
          projectedCompletionDate: undefined,
          fixedMonthlyMinor: null,
          tag: null,
        },
        {
          paymentId: "holiday",
          name: "Holiday",
          category: "fixed_point",
          amountMinor: 120_000,
          dueDate: "2026-09-01",
          targetDate: "2026-09-01",
          dueDateIsDerived: false,
          monthsUntilDue: 8,
          requiredMonthlyMinor: 15_000,
          fundedMonthlyMinor: 15_000,
          fundedFromOwnMinor: 15_000,
          fundedFromInflowMinor: 0,
          alreadySavedMinor: 0,
          occurrencesThisMonth: 1,
          onTrack: true,
          status: "funded",
          projectedCompletionDate: undefined,
          fixedMonthlyMinor: null,
          tag: "fun",
        },
        {
          paymentId: "car",
          name: "Car insurance",
          category: "yearly_recurring",
          amountMinor: 32_000,
          dueDate: "2026-06-01",
          targetDate: "2026-06-01",
          dueDateIsDerived: false,
          monthsUntilDue: 5,
          requiredMonthlyMinor: 6_400,
          fundedMonthlyMinor: 6_400,
          fundedFromOwnMinor: 6_400,
          fundedFromInflowMinor: 0,
          alreadySavedMinor: 0,
          occurrencesThisMonth: 1,
          onTrack: true,
          status: "funded",
          projectedCompletionDate: undefined,
          fixedMonthlyMinor: null,
          tag: null,
        },
      ],
    });
  });

  it("treats an absent inflow and a zero one identically", () => {
    expect(computeAccountPlan(pot(), AS_OF)).toEqual(
      computeAccountPlan(pot({ allocatedMinor: 0, confirmedMinor: 0 }), AS_OF),
    );
  });

  it("funds nothing without an inflow — the defect this exists to fix", () => {
    const plan = computeAccountPlan(pot(), AS_OF);
    expect(plan.shortfallMinor).toBe(TOTAL);
    expect(statuses(pot())).toEqual(["at_risk", "at_risk", "at_risk"]);
  });

  it("a fully confirmed inflow funds every line and clears the shortfall", () => {
    const plan = computeAccountPlan(pot({ allocatedMinor: TOTAL, confirmedMinor: TOTAL }), AS_OF);
    expect(plan.monthlyIncomeMinor).toBe(0); // own income, and only own income
    expect(plan.allocatedInflowMinor).toBe(TOTAL);
    expect(plan.confirmedInflowMinor).toBe(TOTAL);
    expect(plan.totalFundedMinor).toBe(TOTAL);
    expect(plan.shortfallMinor).toBe(0);
    expect(plan.lines.map((l) => l.status)).toEqual(["funded", "funded", "funded"]);
    expect(plan.lines.map((l) => l.fundedFromInflowMinor)).toEqual([10_000, 15_000, 5_300]);
    expect(plan.lines.map((l) => l.fundedFromOwnMinor)).toEqual([0, 0, 0]);
    expect(plan.lines.every((l) => l.onTrack)).toBe(true);
  });

  it("an unconfirmed inflow still funds, but every line says so", () => {
    const plan = computeAccountPlan(pot({ allocatedMinor: TOTAL, confirmedMinor: 0 }), AS_OF);
    expect(plan.shortfallMinor).toBe(0);
    expect(plan.lines.every((l) => l.onTrack)).toBe(true); // the plan covers them…
    expect(plan.lines.map((l) => l.status)).toEqual([
      "awaiting_transfer", // …the money just has not moved
      "awaiting_transfer",
      "awaiting_transfer",
    ]);
  });

  it("spends confirmed money before promised money, in priority order", () => {
    // 25000 confirmed covers b1 and b2 exactly; b3 runs past the mark.
    const plan = computeAccountPlan(pot({ allocatedMinor: TOTAL, confirmedMinor: 25_000 }), AS_OF);
    expect(plan.lines.map((l) => l.status)).toEqual(["funded", "funded", "awaiting_transfer"]);
  });

  it("only the uncovered lines are at risk when the inflow falls short", () => {
    const plan = computeAccountPlan(pot({ allocatedMinor: 20_000, confirmedMinor: 20_000 }), AS_OF);
    expect(plan.lines.map((l) => l.status)).toEqual(["funded", "at_risk", "at_risk"]);
    expect(plan.lines.map((l) => l.fundedMonthlyMinor)).toEqual([10_000, 10_000, 0]);
    expect(plan.shortfallMinor).toBe(TOTAL - 20_000);
  });

  it("a part-funded line is at risk, not merely awaiting a transfer", () => {
    // b2 draws on unconfirmed inflow *and* comes up short. "You are short" is
    // the louder fact and the one with a different remedy, so it wins.
    expect(statuses(pot({ allocatedMinor: 20_000, confirmedMinor: 0 }))).toEqual([
      "awaiting_transfer",
      "at_risk",
      "at_risk",
    ]);
  });

  it("spends own income before inflow, splitting the line that straddles", () => {
    const account = pot(
      { allocatedMinor: 20_000, confirmedMinor: 0 },
      {
        incomes: [{ id: "i", amountMinor: 12_000, frequency: "monthly", anchorDate: AS_OF }],
      },
    );
    const plan = computeAccountPlan(account, AS_OF);
    expect(plan.lines.map((l) => l.fundedFromOwnMinor)).toEqual([10_000, 2_000, 0]);
    expect(plan.lines.map((l) => l.fundedFromInflowMinor)).toEqual([0, 13_000, 5_300]);
    expect(plan.lines.map((l) => l.status)).toEqual([
      "funded", // own money only
      "awaiting_transfer", // straddles the boundary
      "awaiting_transfer",
    ]);
    expect(plan.shortfallMinor).toBe(0);
  });

  it("the own/inflow split sums to fundedMonthlyMinor on every line", () => {
    for (const inflow of [
      undefined,
      { allocatedMinor: 8_000, confirmedMinor: 3_000 },
      { allocatedMinor: 20_000, confirmedMinor: 20_000 },
      { allocatedMinor: 90_000, confirmedMinor: 0 },
    ]) {
      const account = pot(inflow, {
        incomes: [{ id: "i", amountMinor: 12_000, frequency: "monthly", anchorDate: AS_OF }],
      });
      const plan = computeAccountPlan(account, AS_OF);
      for (const line of plan.lines) {
        expect(line.fundedFromOwnMinor + line.fundedFromInflowMinor).toBe(line.fundedMonthlyMinor);
      }
      expect(plan.totalFundedMinor).toBe(plan.lines.reduce((s, l) => s + l.fundedMonthlyMinor, 0));
    }
  });

  it("leftover is the account's own surplus — never inflow it did not spend", () => {
    // The account that sent the money still reports it as *its* leftover, so
    // counting it here too would double it in any cross-account total.
    const plan = computeAccountPlan(pot({ allocatedMinor: 50_000, confirmedMinor: 50_000 }), AS_OF);
    expect(plan.leftoverMinor).toBe(0);
    // …and the unspent portion is still recoverable, just not as this account's.
    const spentFromInflow = plan.lines.reduce((s, l) => s + l.fundedFromInflowMinor, 0);
    expect(plan.allocatedInflowMinor - spentFromInflow).toBe(19_700);
  });

  it("own income still becomes leftover, undisturbed by an inflow", () => {
    const account = pot(
      { allocatedMinor: 50_000, confirmedMinor: 50_000 },
      {
        incomes: [{ id: "i", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
      },
    );
    const plan = computeAccountPlan(account, AS_OF);
    // Own income funds all three bills first, so the whole inflow goes unspent.
    expect(plan.leftoverMinor).toBe(100_000 - TOTAL);
    expect(plan.lines.every((l) => l.fundedFromInflowMinor === 0)).toBe(true);
  });

  it("reserves the buffer out of own income only, not out of the inflow", () => {
    // A shared pot's buffer is already funded as an obligation in the household
    // plan, so charging it against the arriving money would reserve it twice.
    const plan = computeAccountPlan(
      pot({ allocatedMinor: TOTAL, confirmedMinor: TOTAL }, { monthlyBufferMinor: 10_000 }),
      AS_OF,
    );
    expect(plan.bufferMinor).toBe(10_000);
    expect(plan.shortfallMinor).toBe(0);
    expect(plan.lines.every((l) => l.status === "funded")).toBe(true);
  });

  it("clamps an inflow that claims more confirmed than allocated", () => {
    const plan = computeAccountPlan(
      pot({ allocatedMinor: 10_000, confirmedMinor: 999_999 }),
      AS_OF,
    );
    expect(plan.confirmedInflowMinor).toBe(10_000);
    expect(plan.totalFundedMinor).toBe(10_000);
  });

  it("clamps negative inflow figures to nothing arriving", () => {
    const plan = computeAccountPlan(pot({ allocatedMinor: -5_000, confirmedMinor: -1 }), AS_OF);
    expect(plan.allocatedInflowMinor).toBe(0);
    expect(plan.confirmedInflowMinor).toBe(0);
    expect(plan.shortfallMinor).toBe(TOTAL);
  });
});

// =============================================================================
// The account plan, as a view of the one pass
// =============================================================================

/**
 * The account plan stops being a computation and becomes a projection.
 *
 * The pin below is the regression this whole package has to be provably free
 * of, taken one level further than WP-P took it: not only must the *pass* plan a
 * solo user's month exactly as the account engine did, the `AccountPlan` the
 * view builds out of it must be the same object, field for field — statuses,
 * completion dates, passthroughs and all. Anything less and "the account page
 * shows the same numbers because they are the same numbers" is a claim about
 * arithmetic nobody checked.
 */
describe("accountPlanFromScope — a solo user with one account does not move", () => {
  /** Deliberately hostile: the budget runs out mid-order, two payments tie on
   *  priority with sort keys the two engines used to disagree about, a buffer
   *  bites, one payment is retired, and one goal is contribution-capped. */
  const soloAccount: AccountInput = {
    accountId: "current",
    currency: "GBP",
    monthlyBufferMinor: 20_000,
    incomes: [{ id: "inc", amountMinor: 150_000, frequency: "monthly", anchorDate: AS_OF }],
    payments: [
      {
        id: "rent",
        name: "rent",
        category: "monthly_recurring",
        amountMinor: 120_000,
        dueDate: "2026-01-15",
        priority: 1,
      },
      {
        id: "holiday",
        name: "holiday",
        category: "fixed_point",
        amountMinor: 240_000,
        targetDate: "2027-02-01",
        priority: 50,
      },
      { id: "gym", name: "gym", category: "monthly_recurring", amountMinor: 5_000, priority: 50 },
      {
        id: "laptop",
        name: "laptop",
        category: "fixed_point",
        amountMinor: 90_000,
        fixedMonthlyMinor: 20_000,
        dueDate: "2026-02-01",
        priority: 60,
      },
      {
        id: "retired",
        name: "retired",
        category: "monthly_recurring",
        amountMinor: 99_000,
        priority: 2,
        active: false,
      },
    ],
  };

  const soloScope: ScopeInput = {
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      {
        ...soloAccount,
        role: "personal",
        memberUserId: "owner",
        payments: soloAccount.payments.map((p) => ({ ...p, scope: "personal" as const })),
      },
    ],
  };

  const engine = computeAccountPlan(soloAccount, AS_OF);
  const view = accountPlanFromScope(soloScope, computeScopePlan(soloScope, AS_OF), "current");

  it("builds byte-identically the same AccountPlan, field for field", () => {
    // Every field the account engine published, in its order, to the byte.
    const same = { ...view };
    delete same.residualMinor;
    expect(JSON.stringify(same)).toBe(JSON.stringify(engine));
  });

  it("adds the residual alongside, changing nothing that was already there", () => {
    // The decision-13 pattern. `leftoverMinor` is the account's own surplus
    // after its own obligations and is zero here — the buffer ate it. The
    // residual is what is really in the account at the end of the month, which
    // is the buffer, and it is a different question with a different answer.
    expect(view.leftoverMinor).toBe(0);
    expect(view.residualMinor).toBe(20_000);
    expect(engine.residualMinor).toBeUndefined();
  });

  it("runs out of money in the same place, on the same bill", () => {
    // Named, so the pin above cannot pass by two identical wrong answers: the
    // budget really does run out, and it runs out on the holiday.
    expect(view.lines.map((l) => l.paymentId)).toEqual(["rent", "holiday", "gym", "laptop"]);
    expect(view.lines.map((l) => l.fundedMonthlyMinor)).toEqual([120_000, 10_000, 0, 0]);
    expect(view.lines.map((l) => l.status)).toEqual(["funded", "at_risk", "at_risk", "at_risk"]);
    expect(view.leftoverMinor).toBe(0);
  });

  it("carries the passthroughs the pass has no reason to hold", () => {
    // `fixedMonthlyMinor` never changes an answer, so it is not in the pass —
    // the view reads it off the input, which is the only thing it reads there.
    expect(view.lines.map((l) => l.fixedMonthlyMinor)).toEqual([null, null, null, 20_000]);
  });
});

describe("accountPlanFromScope — a goal on pace but late", () => {
  it("reports the finish date the cap really lands on", () => {
    const scope: ScopeInput = {
      scopeId: "owner",
      members: [{ userId: "owner", shareBp: 10_000 }],
      accounts: [
        {
          accountId: "current",
          role: "personal",
          memberUserId: "owner",
          currency: "GBP",
          incomes: [{ id: "inc", amountMinor: 500_000, frequency: "monthly", anchorDate: AS_OF }],
          payments: [
            {
              id: "car",
              name: "car",
              category: "fixed_point",
              scope: "personal",
              amountMinor: 90_000,
              fixedMonthlyMinor: 20_000,
              dueDate: "2026-03-01",
            },
          ],
        },
      ],
    };
    const line = accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "current").lines[0]!;
    // Fully funded every month at the cap, and still five months out — the plan
    // says "on pace, but late" rather than pretending the date is kept.
    expect(line.status).toBe("funded");
    expect(line.fundedMonthlyMinor).toBe(20_000);
    expect(line.projectedCompletionDate).toBe("2026-06-01");
  });
});

describe("accountPlanFromScope — arriving money and what it funds", () => {
  const scopeWith = (confirmedMinor?: number): ScopeInput => ({
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      {
        accountId: "current",
        role: "personal",
        memberUserId: "owner",
        currency: "GBP",
        incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
        payments: [],
      },
      {
        accountId: "pot",
        role: "personal",
        memberUserId: "owner",
        currency: "GBP",
        incomes: [],
        payments: [
          {
            id: "rent",
            name: "rent",
            category: "monthly_recurring",
            scope: "personal",
            amountMinor: 60_000,
            priority: 1,
          },
          {
            id: "council",
            name: "council",
            category: "monthly_recurring",
            scope: "personal",
            amountMinor: 20_000,
            priority: 2,
          },
        ],
      },
    ],
    ...(confirmedMinor === undefined
      ? {}
      : {
          confirmedTransfers: [
            {
              fromAccountId: "current",
              toAccountId: "pot",
              memberUserId: "owner",
              confirmedMinor,
            },
          ],
        }),
  });

  it("says a derived transfer paid the bills, and that nobody has moved it", () => {
    const scope = scopeWith();
    const plan = accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "pot");
    expect(plan.monthlyIncomeMinor).toBe(0);
    expect(plan.allocatedInflowMinor).toBe(80_000);
    expect(plan.confirmedInflowMinor).toBe(0);
    expect(plan.totalFundedMinor).toBe(80_000);
    expect(plan.lines.map((l) => l.fundedFromInflowMinor)).toEqual([60_000, 20_000]);
    expect(plan.lines.map((l) => l.status)).toEqual(["awaiting_transfer", "awaiting_transfer"]);
    // Every arriving pound came from another account of the scope, so the whole
    // of what the bills consumed is intra-scope movement — read off the pass,
    // not reconstructed from an assumption about spending order.
    expect(plan.internalInflowUsedMinor).toBe(80_000);
  });

  it("marks only the line that runs past the confirmed mark", () => {
    const scope = scopeWith(60_000);
    const plan = accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "pot");
    expect(plan.confirmedInflowMinor).toBe(60_000);
    expect(plan.lines.map((l) => l.status)).toEqual(["funded", "awaiting_transfer"]);
  });

  it("leaves the sending account's own surplus short of what it holds", () => {
    const scope = scopeWith();
    const plan = accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "current");
    // £1,000 in, £800 promised to the pot: the account's own surplus is £200,
    // and nothing about the pot's bills is counted here twice.
    expect(plan.leftoverMinor).toBe(20_000);
    expect(plan.totalRequiredMinor).toBe(0);
    expect(plan.internalInflowUsedMinor).toBe(0);
  });
});

describe("accountPlanFromScope — savings movements out", () => {
  const withMovements = (): ScopeInput => ({
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      {
        accountId: "current",
        role: "personal",
        memberUserId: "owner",
        currency: "GBP",
        incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
        payments: [],
        outboundInflows: [
          {
            id: "to-isa",
            toAccountId: "isa",
            amountMinor: 30_000,
            frequency: "monthly",
            anchorDate: AS_OF,
            priority: 20,
          },
          {
            id: "to-pot",
            toAccountId: "pot",
            amountMinor: 90_000,
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
        payments: [],
      },
      {
        accountId: "isa",
        role: "personal",
        memberUserId: "owner",
        currency: "GBP",
        incomes: [],
        payments: [],
      },
    ],
  });

  it("reports them in their own priority order, with what each could afford", () => {
    const scope = withMovements();
    const plan = accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "current");
    expect(plan.outboundInflows).toEqual([
      {
        inflowId: "to-pot",
        toAccountId: "pot",
        requiredMonthlyMinor: 90_000,
        fundedMonthlyMinor: 90_000,
        fundedFromOwnMinor: 90_000,
        fundedFromInflowMinor: 0,
        onTrack: true,
      },
      {
        inflowId: "to-isa",
        toAccountId: "isa",
        requiredMonthlyMinor: 30_000,
        fundedMonthlyMinor: 10_000,
        fundedFromOwnMinor: 10_000,
        fundedFromInflowMinor: 0,
        onTrack: false,
      },
    ]);
    // `leftoverMinor` keeps its meaning: the account's own surplus before the
    // movements leave. What they take is `outboundInflowMinor` (decision 13).
    expect(plan.leftoverMinor).toBe(100_000);
    expect(plan.outboundInflowMinor).toBe(100_000);
  });

  it("leaves out the edge a loop was broken at — it is not happening", () => {
    const scope: ScopeInput = {
      scopeId: "owner",
      members: [{ userId: "owner", shareBp: 10_000 }],
      accounts: [
        {
          accountId: "a",
          role: "personal",
          memberUserId: "owner",
          currency: "GBP",
          incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
          payments: [],
          outboundInflows: [
            {
              id: "a-to-b",
              toAccountId: "b",
              amountMinor: 30_000,
              frequency: "monthly",
              anchorDate: AS_OF,
            },
          ],
        },
        {
          accountId: "b",
          role: "personal",
          memberUserId: "owner",
          currency: "GBP",
          incomes: [],
          payments: [],
          outboundInflows: [
            {
              id: "b-to-a",
              toAccountId: "a",
              amountMinor: 10_000,
              frequency: "monthly",
              anchorDate: AS_OF,
            },
          ],
        },
      ],
    };
    const plan = computeScopePlan(scope, AS_OF);
    const b = accountPlanFromScope(scope, plan, "b");
    expect(plan.cycles).toHaveLength(1);
    expect(b.outboundInflows).toEqual([]);
    expect(b.fundingCycleAccountIds).toEqual(["a", "b"]);
    expect(b.fundingCycleBrokenInflowId).toBe("b-to-a");
  });

  it("never reports a movement whose sender the pass could not see", () => {
    // Two currencies, and a dollar account naming a sterling one as its source.
    // The pass says `unknown_source` in the dollar partition; without the guard
    // the sterling account's plan would claim a movement it never makes.
    const scope: ScopeInput = {
      scopeId: "owner",
      members: [{ userId: "owner", shareBp: 10_000 }],
      accounts: [
        {
          accountId: "gbp",
          role: "personal",
          memberUserId: "owner",
          currency: "GBP",
          incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
          payments: [],
        },
        {
          accountId: "usd",
          role: "personal",
          memberUserId: "owner",
          currency: "USD",
          incomes: [],
          payments: [],
          inflows: [
            {
              id: "gbp-to-usd",
              amountMinor: 20_000,
              frequency: "monthly",
              anchorDate: AS_OF,
              source: "account",
              sourceAccountId: "gbp",
            },
          ],
        },
      ],
    };
    const plan = computeScopePlan(scope, AS_OF);
    expect(plan.movements.map((m) => m.status)).toEqual(["unknown_source"]);
    expect(accountPlanFromScope(scope, plan, "gbp").outboundInflows).toEqual([]);
    expect(accountPlanFromScope(scope, plan, "gbp").outboundInflowMinor).toBe(0);
  });
});

describe("accountPlanFromScope — an account the pass never planned", () => {
  it("refuses rather than inventing an empty month", () => {
    const scope: ScopeInput = { scopeId: "owner", members: [], accounts: [] };
    expect(() => accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "ghost")).toThrow(
      /not in the planned scope/,
    );
  });
});

describe("accountPlanFromScope — a plan and an input that are not the same scope", () => {
  const payment = (id: string): ScopeInput["accounts"][number]["payments"][number] => ({
    id,
    name: id,
    category: "monthly_recurring",
    scope: "personal",
    amountMinor: 10_000,
  });

  const scopeWith = (...ids: string[]): ScopeInput => ({
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      {
        accountId: "current",
        role: "personal",
        memberUserId: "owner",
        currency: "GBP",
        incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
        payments: ids.map(payment),
      },
    ],
  });

  it("refuses rather than publishing a line it cannot describe", () => {
    // The passthroughs come from the input and the decisions from the plan, so
    // the two have to be the same scope. Handed a line whose payment the input
    // has never heard of, the view says so instead of emitting a null cap and
    // letting a contribution-first goal read as an ordinary one.
    expect(() =>
      accountPlanFromScope(
        scopeWith("rent"),
        computeScopePlan(scopeWith("rent", "gym"), AS_OF),
        "current",
      ),
    ).toThrow(/gym is not a payment of current/);
  });
});

describe("accountPlanFromScope — movements that tie", () => {
  it("orders them by destination, then by the row, never by load order", () => {
    const move = (id: string, toAccountId: string) => ({
      id,
      toAccountId,
      amountMinor: 1_000,
      frequency: "monthly" as const,
      anchorDate: AS_OF,
      priority: 10,
    });
    const scope: ScopeInput = {
      scopeId: "owner",
      members: [{ userId: "owner", shareBp: 10_000 }],
      accounts: [
        {
          accountId: "current",
          role: "personal",
          memberUserId: "owner",
          currency: "GBP",
          incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
          payments: [],
          outboundInflows: [move("z-row", "b-pot"), move("a-row", "b-pot"), move("m-row", "a-pot")],
        },
        ...["a-pot", "b-pot"].map((accountId) => ({
          accountId,
          role: "personal" as const,
          memberUserId: "owner",
          currency: "GBP",
          incomes: [],
          payments: [],
        })),
      ],
    };
    const plan = accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "current");
    expect(plan.outboundInflows.map((o) => o.inflowId)).toEqual(["m-row", "a-row", "z-row"]);
  });
});
