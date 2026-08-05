import { describe, expect, it } from "vitest";
import {
  accountPlanFromScope,
  monthlyIncomeMinor,
  overviewFromPlans,
  requiredMonthlyForPayment,
} from "./engine.js";
import { parseISODate } from "./dates.js";
import { computeScopePlan, type ScopeAccountInput, type ScopeInput } from "./scope.js";
import type { AccountPlan, IncomeInput, PaymentInput } from "./types.js";

const now = parseISODate("2026-01-01");

/** One account, owned outright by one member — the degenerate scope a solo user
 *  is planned as (ONE-ENGINE.md, "the reframing"). */
function soloScope(
  account: Omit<ScopeAccountInput, "role" | "memberUserId" | "ownerUserId" | "payments"> & {
    payments: PaymentInput[];
  },
): ScopeInput {
  return {
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      {
        ...account,
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        payments: account.payments.map((p) => ({ ...p, scope: "personal" as const })),
      },
    ],
  };
}

/** That account's plan, as the one pass settles it and the view reports it. */
function soloPlan(
  account: Omit<ScopeAccountInput, "role" | "memberUserId" | "ownerUserId" | "payments"> & {
    payments: PaymentInput[];
  },
  asOfDate: string,
): AccountPlan {
  const scope = soloScope(account);
  return accountPlanFromScope(scope, computeScopePlan(scope, asOfDate), account.accountId);
}

describe("monthlyIncomeMinor — frequency branches", () => {
  it("custom with a recurrence spreads over the interval", () => {
    const income: IncomeInput = {
      id: "i",
      amountMinor: 30_000,
      frequency: "custom",
      recurrence: { interval: 3, unit: "month", anchor: "2026-01-01" },
      anchorDate: "2026-01-01",
    };
    expect(monthlyIncomeMinor(income, now)).toBe(10_000);
  });

  it("custom without a recurrence falls back to the raw amount", () => {
    const income: IncomeInput = {
      id: "i",
      amountMinor: 5_000,
      frequency: "custom",
      anchorDate: "2026-01-01",
    };
    expect(monthlyIncomeMinor(income, now)).toBe(5_000);
  });

  it("one_off in the future spreads over months until the anchor", () => {
    const income: IncomeInput = {
      id: "i",
      amountMinor: 40_000,
      frequency: "one_off",
      anchorDate: "2026-05-01",
    };
    expect(monthlyIncomeMinor(income, now)).toBe(10_000);
  });

  it("one_off in the past contributes nothing", () => {
    const income: IncomeInput = {
      id: "i",
      amountMinor: 40_000,
      frequency: "one_off",
      anchorDate: "2025-01-01",
    };
    expect(monthlyIncomeMinor(income, now)).toBe(0);
  });
});

describe("requiredMonthlyForPayment — recurring edge cases", () => {
  it("custom_recurring advances a past due date to the next occurrence", () => {
    const p: PaymentInput = {
      id: "p",
      name: "Water",
      category: "custom_recurring",
      amountMinor: 9_000,
      dueDate: "2025-12-01",
      recurrence: { interval: 3, unit: "month", anchor: "2025-12-01" },
    };
    // next occurrence on/after 2026-01-01 is 2026-03-01 → 2 months → 9000/2
    const r = requiredMonthlyForPayment(p, now);
    expect(r.effectiveDate).toBe("2026-03-01");
    expect(r.requiredMinor).toBe(4_500);
  });

  it("monthly_recurring without a due date uses the reference date", () => {
    const p: PaymentInput = {
      id: "p",
      name: "Phone",
      category: "monthly_recurring",
      amountMinor: 4_500,
    };
    const r = requiredMonthlyForPayment(p, now);
    expect(r.effectiveDate).toBe("2026-01-01");
    expect(r.monthsUntilDue).toBe(1);
  });

  it("yearly_recurring derives its recurrence from the due date", () => {
    const p: PaymentInput = {
      id: "p",
      name: "Insurance",
      category: "yearly_recurring",
      amountMinor: 24_000,
      dueDate: "2025-07-01",
    };
    // next 2026-07-01 → 6 months → 24000/6 = 4000
    const r = requiredMonthlyForPayment(p, now);
    expect(r.effectiveDate).toBe("2026-07-01");
    expect(r.requiredMinor).toBe(4_000);
  });
});

// --- contribution-first goals (fixed_point + fixedMonthlyMinor) --------------

/** A £1,200 goal, funded at whatever pace the test sets. */
function goal(over: Partial<PaymentInput> = {}): PaymentInput {
  return {
    id: "goal",
    name: "New bike",
    category: "fixed_point",
    amountMinor: 120_000,
    ...over,
  };
}

describe("requiredMonthlyForPayment — contribution-first goals", () => {
  it("dateless: asks for the cap and derives the finish date from the pace", () => {
    const r = requiredMonthlyForPayment(goal({ fixedMonthlyMinor: 20_000 }), now);
    expect(r.requiredMinor).toBe(20_000);
    // 120000 / 20000 = 6 whole months from the as-of date.
    expect(r.monthsUntilDue).toBe(6);
    expect(r.effectiveDate).toBe("2026-07-01");
    expect(r.occurrencesThisMonth).toBe(1);
  });

  it("dateless: rounds the pace up, so a ragged last month still counts", () => {
    const r = requiredMonthlyForPayment(
      goal({ amountMinor: 125_000, fixedMonthlyMinor: 20_000 }),
      now,
    );
    // ceil(125000 / 20000) = 7 months, the last of them a part month.
    expect(r.monthsUntilDue).toBe(7);
    expect(r.effectiveDate).toBe("2026-08-01");
  });

  it("dateless: the final month asks only for what is left, not the full cap", () => {
    const r = requiredMonthlyForPayment(
      goal({ alreadySavedMinor: 110_000, fixedMonthlyMinor: 20_000 }),
      now,
    );
    expect(r.requiredMinor).toBe(10_000);
    expect(r.monthsUntilDue).toBe(1);
    expect(r.effectiveDate).toBe("2026-02-01");
  });

  it("already saved beyond the target asks for nothing more", () => {
    const r = requiredMonthlyForPayment(
      goal({ alreadySavedMinor: 130_000, fixedMonthlyMinor: 20_000 }),
      now,
    );
    expect(r.requiredMinor).toBe(0);
    expect(r.monthsUntilDue).toBe(1); // floored, never zero
    expect(r.effectiveDate).toBe("2026-02-01");
  });

  it("dated: a cap below what the date demands wins — the date does not", () => {
    const p = goal({ dueDate: "2026-09-01", fixedMonthlyMinor: 10_000 });
    // Uncapped this would be 120000/8 = 15000 a month.
    expect(requiredMonthlyForPayment(goal({ dueDate: "2026-09-01" }), now).requiredMinor).toBe(
      15_000,
    );
    const r = requiredMonthlyForPayment(p, now);
    expect(r.requiredMinor).toBe(10_000);
    expect(r.effectiveDate).toBe("2026-09-01"); // the promised date survives
    expect(r.monthsUntilDue).toBe(8);
  });

  it("dated: a cap above what the date demands also wins — it just finishes early", () => {
    const r = requiredMonthlyForPayment(
      goal({ dueDate: "2026-09-01", fixedMonthlyMinor: 50_000 }),
      now,
    );
    expect(r.requiredMinor).toBe(50_000);
    expect(r.effectiveDate).toBe("2026-09-01");
  });

  it("a targetDate override is honoured ahead of the due date", () => {
    const r = requiredMonthlyForPayment(
      goal({ dueDate: "2026-09-01", targetDate: "2026-04-01", fixedMonthlyMinor: 10_000 }),
      now,
    );
    expect(r.effectiveDate).toBe("2026-04-01");
    expect(r.monthsUntilDue).toBe(3);
  });

  it("a zero or negative cap is treated as no cap at all", () => {
    const r = requiredMonthlyForPayment(goal({ dueDate: "2026-09-01", fixedMonthlyMinor: 0 }), now);
    expect(r.requiredMinor).toBe(15_000); // the date drives it again
  });

  it("ignores the cap on monthly_recurring — a bill has a real deadline", () => {
    const p: PaymentInput = {
      id: "p",
      name: "Phone",
      category: "monthly_recurring",
      amountMinor: 4_500,
      fixedMonthlyMinor: 1_000,
    };
    expect(requiredMonthlyForPayment(p, now).requiredMinor).toBe(4_500);
  });

  it("ignores the cap on yearly_recurring", () => {
    const p: PaymentInput = {
      id: "p",
      name: "Insurance",
      category: "yearly_recurring",
      amountMinor: 32_000,
      dueDate: "2026-06-01",
      fixedMonthlyMinor: 1_000,
    };
    expect(requiredMonthlyForPayment(p, now).requiredMinor).toBe(6_400); // 32000/5
  });

  it("ignores the cap on custom_recurring", () => {
    const p: PaymentInput = {
      id: "p",
      name: "Water",
      category: "custom_recurring",
      amountMinor: 9_000,
      dueDate: "2026-03-01",
      recurrence: { interval: 3, unit: "month", anchor: "2026-03-01" },
      fixedMonthlyMinor: 1_000,
    };
    expect(requiredMonthlyForPayment(p, now).requiredMinor).toBe(4_500); // 9000/2
  });
});

describe("contribution-first goals, through the pass", () => {
  const fund = (payments: PaymentInput[], amountMinor = 500_000) => ({
    accountId: "a",
    currency: "GBP",
    incomes: [{ id: "i", amountMinor, frequency: "monthly" as const, anchorDate: "2026-01-01" }],
    payments,
  });

  it("funds the cap and carries it back on the line", () => {
    const plan = soloPlan(fund([goal({ fixedMonthlyMinor: 20_000, tag: "toys" })]), "2026-01-01");
    const line = plan.lines[0]!;
    expect(line.requiredMonthlyMinor).toBe(20_000);
    expect(line.fundedMonthlyMinor).toBe(20_000);
    expect(line.onTrack).toBe(true);
    expect(line.fixedMonthlyMinor).toBe(20_000);
    expect(line.tag).toBe("toys");
    expect(line.targetDate).toBe("2026-07-01");
  });

  it("reports null passthroughs for a payment carrying neither", () => {
    const plan = soloPlan(fund([goal({ dueDate: "2026-09-01" })]), "2026-01-01");
    expect(plan.lines[0]?.fixedMonthlyMinor).toBeNull();
    expect(plan.lines[0]?.tag).toBeNull();
  });

  describe("dueDateIsDerived", () => {
    const derived = (over: Partial<PaymentInput>): boolean =>
      soloPlan(fund([goal(over)]), "2026-01-01").lines[0]!.dueDateIsDerived;

    it("is true only for a capped goal with no date of its own", () => {
      expect(derived({ fixedMonthlyMinor: 20_000 })).toBe(true);
    });

    it("is false when a capped goal also carries a deadline", () => {
      // The case the UI could not see: paced *and* dated. `dueDate` on the wire
      // is the user's date either way, so nothing downstream can tell.
      expect(derived({ fixedMonthlyMinor: 20_000, dueDate: "2026-09-01" })).toBe(false);
      expect(derived({ fixedMonthlyMinor: 20_000, targetDate: "2026-09-01" })).toBe(false);
    });

    it("is false for a dated goal with no cap", () => {
      expect(derived({ dueDate: "2026-09-01" })).toBe(false);
    });

    it("is false when the cap is zero, which is no cap at all", () => {
      expect(derived({ fixedMonthlyMinor: 0 })).toBe(false);
    });

    it("is false for every category a cap does not apply to", () => {
      const plan = soloPlan(
        fund([
          {
            id: "bill",
            name: "Phone",
            category: "monthly_recurring",
            amountMinor: 4_500,
            fixedMonthlyMinor: 1_000,
          },
        ]),
        "2026-01-01",
      );
      expect(plan.lines[0]?.dueDateIsDerived).toBe(false);
    });
  });

  it("a dateless goal on pace has no projected completion date to add", () => {
    // The pace already *is* the target date, so there is nothing extra to say.
    const plan = soloPlan(fund([goal({ fixedMonthlyMinor: 20_000 })]), "2026-01-01");
    expect(plan.lines[0]?.projectedCompletionDate).toBeUndefined();
  });

  it("flags a fully funded goal that will still miss its date", () => {
    // 120000 at 10000/month = 12 months → 2027-01, well past the June date.
    const plan = soloPlan(
      fund([goal({ dueDate: "2026-06-01", fixedMonthlyMinor: 10_000 })]),
      "2026-01-01",
    );
    const line = plan.lines[0]!;
    expect(line.onTrack).toBe(true); // the money asked for is there…
    expect(line.projectedCompletionDate).toBe("2027-01-01"); // …but the date is not
    expect(line.targetDate).toBe("2026-06-01");
  });

  it("stays quiet when the pace comfortably beats the date", () => {
    // 120000 at 30000/month = 4 months → 2026-05, inside the September date.
    const plan = soloPlan(
      fund([goal({ dueDate: "2026-09-01", fixedMonthlyMinor: 30_000 })]),
      "2026-01-01",
    );
    expect(plan.lines[0]?.projectedCompletionDate).toBeUndefined();
  });

  it("an underfunded capped goal still projects off what is actually funded", () => {
    const plan = soloPlan(fund([goal({ fixedMonthlyMinor: 20_000 })], 5_000), "2026-01-01");
    const line = plan.lines[0]!;
    expect(line.fundedMonthlyMinor).toBe(5_000);
    expect(line.onTrack).toBe(false);
    expect(line.projectedCompletionDate).toBe("2028-01-01"); // 120000/5000 = 24 months
    expect(plan.shortfallMinor).toBe(15_000);
  });

  it("a completed goal asks for nothing and leaves the money as leftover", () => {
    const plan = soloPlan(
      fund([goal({ alreadySavedMinor: 120_000, fixedMonthlyMinor: 20_000 })]),
      "2026-01-01",
    );
    expect(plan.totalRequiredMinor).toBe(0);
    expect(plan.leftoverMinor).toBe(500_000);
    expect(plan.lines[0]?.onTrack).toBe(true);
    expect(plan.lines[0]?.projectedCompletionDate).toBeUndefined();
  });
});

describe("the savings buffer, through the pass", () => {
  it("reserves the buffer off the top before funding goals", () => {
    const plan = soloPlan(
      {
        accountId: "a",
        currency: "GBP",
        monthlyBufferMinor: 20_000,
        incomes: [
          { id: "i", amountMinor: 100_000, frequency: "monthly", anchorDate: "2026-01-01" },
        ],
        payments: [{ id: "p", name: "Phone", category: "monthly_recurring", amountMinor: 50_000 }],
      },
      "2026-01-01",
    );
    expect(plan.bufferMinor).toBe(20_000);
    // 100k income - 20k buffer = 80k available; 50k funded; 30k leftover.
    expect(plan.leftoverMinor).toBe(30_000);
    expect(plan.shortfallMinor).toBe(0);
  });

  it("can cause a shortfall when the buffer starves a goal", () => {
    const plan = soloPlan(
      {
        accountId: "a",
        currency: "GBP",
        monthlyBufferMinor: 70_000,
        incomes: [
          { id: "i", amountMinor: 100_000, frequency: "monthly", anchorDate: "2026-01-01" },
        ],
        payments: [{ id: "p", name: "Phone", category: "monthly_recurring", amountMinor: 50_000 }],
      },
      "2026-01-01",
    );
    // 100k - 70k = 30k available, goal needs 50k → 20k shortfall.
    expect(plan.shortfallMinor).toBe(20_000);
    expect(plan.leftoverMinor).toBe(0);
  });
});

describe("overviewFromPlans", () => {
  it("aggregates per currency without FX conversion", () => {
    const gbp = soloPlan(
      {
        accountId: "gbp",
        currency: "GBP",
        incomes: [
          { id: "i", amountMinor: 100_000, frequency: "monthly", anchorDate: "2026-01-01" },
        ],
        payments: [{ id: "p", name: "Phone", category: "monthly_recurring", amountMinor: 40_000 }],
      },
      "2026-01-01",
    );
    const usd = soloPlan(
      {
        accountId: "usd",
        currency: "USD",
        incomes: [{ id: "i", amountMinor: 50_000, frequency: "monthly", anchorDate: "2026-01-01" }],
        payments: [
          {
            id: "p",
            name: "Trip",
            category: "fixed_point",
            amountMinor: 600_000,
            dueDate: "2026-02-01",
          },
        ],
      },
      "2026-01-01",
    );
    const overview = overviewFromPlans([usd, gbp], "2026-01-01");
    expect(overview.perCurrency.map((c) => c.currency)).toEqual(["GBP", "USD"]);
    const gbpBucket = overview.perCurrency.find((c) => c.currency === "GBP");
    expect(gbpBucket?.leftoverMinor).toBe(60_000);
    const usdBucket = overview.perCurrency.find((c) => c.currency === "USD");
    expect(usdBucket?.accounts[0]?.atRiskCount).toBe(1);
  });

  /**
   * The two fields a rollup needs to be about a **person** rather than about a
   * set of accounts somebody can see (`MINE-AND-OURS.md`, decisions 19 and 20).
   *
   * Both are passthroughs of the plan, which is the point: an account's left
   * over is decided once, by the pass, and a summary that recomputed either
   * would be a fourth derivation of a figure this work exists to make singular.
   */
  it("says whose each account is, and what is actually in it", () => {
    const gbp = soloPlan(
      {
        accountId: "gbp",
        currency: "GBP",
        monthlyBufferMinor: 30_000,
        incomes: [
          { id: "i", amountMinor: 100_000, frequency: "monthly", anchorDate: "2026-01-01" },
        ],
        payments: [{ id: "p", name: "Phone", category: "monthly_recurring", amountMinor: 40_000 }],
      },
      "2026-01-01",
    );
    const summary = overviewFromPlans([gbp], "2026-01-01").perCurrency[0]!.accounts[0]!;
    expect(summary.ownerUserId).toBe("owner");
    expect(summary.ownerUserId).toBe(gbp.ownerUserId);
    // `leftoverMinor` is the account's own income after its own bills — £300 of
    // buffer excluded, because a buffer is not spent. `residualMinor` is what is
    // really in the account when the month has happened, buffer included. Two
    // questions, two answers, and two lists printed the first under a label that
    // meant the second.
    expect(summary.leftoverMinor).toBe(30_000);
    expect(summary.residualMinor).toBe(60_000);
    expect(summary.residualMinor).toBe(gbp.residualMinor);
  });
});
