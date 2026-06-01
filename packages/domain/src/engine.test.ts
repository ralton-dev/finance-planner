import { describe, expect, it } from "vitest";
import { computeAccountPlan, monthlyIncomeMinor, requiredMonthlyForPayment } from "./engine.js";
import { parseISODate } from "./dates.js";
import type { AccountInput, IncomeInput, PaymentInput } from "./types.js";

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
