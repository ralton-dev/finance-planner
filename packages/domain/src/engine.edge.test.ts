import { describe, expect, it } from "vitest";
import {
  computeAccountPlan,
  computeOverview,
  monthlyIncomeMinor,
  requiredMonthlyForPayment,
} from "./engine.js";
import { parseISODate } from "./dates.js";
import type { AccountInput, IncomeInput, PaymentInput } from "./types.js";

const now = parseISODate("2026-01-01");

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

describe("computeAccountPlan — savings buffer", () => {
  it("reserves the buffer off the top before funding goals", () => {
    const account: AccountInput = {
      accountId: "a",
      currency: "GBP",
      monthlyBufferMinor: 20_000,
      incomes: [{ id: "i", amountMinor: 100_000, frequency: "monthly", anchorDate: "2026-01-01" }],
      payments: [{ id: "p", name: "Phone", category: "monthly_recurring", amountMinor: 50_000 }],
    };
    const plan = computeAccountPlan(account, "2026-01-01");
    expect(plan.bufferMinor).toBe(20_000);
    // 100k income - 20k buffer = 80k available; 50k funded; 30k leftover.
    expect(plan.leftoverMinor).toBe(30_000);
    expect(plan.shortfallMinor).toBe(0);
  });

  it("can cause a shortfall when the buffer starves a goal", () => {
    const account: AccountInput = {
      accountId: "a",
      currency: "GBP",
      monthlyBufferMinor: 70_000,
      incomes: [{ id: "i", amountMinor: 100_000, frequency: "monthly", anchorDate: "2026-01-01" }],
      payments: [{ id: "p", name: "Phone", category: "monthly_recurring", amountMinor: 50_000 }],
    };
    const plan = computeAccountPlan(account, "2026-01-01");
    // 100k - 70k = 30k available, goal needs 50k → 20k shortfall.
    expect(plan.shortfallMinor).toBe(20_000);
    expect(plan.leftoverMinor).toBe(0);
  });
});

describe("computeOverview", () => {
  it("aggregates per currency without FX conversion", () => {
    const gbp = computeAccountPlan(
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
    const usd = computeAccountPlan(
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
    const overview = computeOverview([usd, gbp], "2026-01-01");
    expect(overview.perCurrency.map((c) => c.currency)).toEqual(["GBP", "USD"]);
    const gbpBucket = overview.perCurrency.find((c) => c.currency === "GBP");
    expect(gbpBucket?.leftoverMinor).toBe(60_000);
    const usdBucket = overview.perCurrency.find((c) => c.currency === "USD");
    expect(usdBucket?.accounts[0]?.atRiskCount).toBe(1);
  });
});
