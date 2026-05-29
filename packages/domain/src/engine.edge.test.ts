import { describe, expect, it } from "vitest";
import { monthlyIncomeMinor, requiredMonthlyForPayment } from "./engine.js";
import { parseISODate } from "./dates.js";
import type { IncomeInput, PaymentInput } from "./types.js";

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
