import type { Store } from "@finance-planner/data";
import { toISODate } from "@finance-planner/domain";

/** What the demo seed created. */
export interface DemoSeedCounts {
  accounts: number;
  incomes: number;
  payments: number;
  contributions: number;
  balanceSnapshots: number;
}

const MS_PER_DAY = 86_400_000;

/** `days` after an ISO date, as an ISO date. */
function shift(asOfDate: string, days: number): string {
  return toISODate(new Date(Date.parse(`${asOfDate}T00:00:00.000Z`) + days * MS_PER_DAY));
}

/**
 * Plant a worked example in a brand-new account, so first-run exploration shows
 * a plan with something in it rather than an empty screen. It is the same
 * dataset as db/seed/seed.sql — one everyday account, a salary, and four bills
 * with different shapes (monthly, yearly, custom cadence, dated goal) — with the
 * later features layered on: a tag, a recorded contribution, and a balance
 * check-in.
 *
 * Dates are computed from `asOfDate` rather than hard-coded, so the plan is
 * always live: the SQL seed's fixed 2026 dates go stale the moment the calendar
 * passes them, which is exactly the wrong first impression.
 */
export async function seedDemoData(
  store: Store,
  userId: string,
  asOfDate: string,
): Promise<DemoSeedCounts> {
  const account = await store.createAccount({
    ownerUserId: userId,
    name: "Everyday Account",
    description: "Primary current account",
    currency: "GBP",
    openingBalanceMinor: 250_000,
    monthlyBufferMinor: 0,
  });

  await store.createIncome({
    accountId: account.id,
    name: "Salary",
    amountMinor: 250_000,
    frequency: "monthly",
    recurrence: null,
    // Paid on the 25th, anchored in the current month so paydays land sensibly.
    anchorDate: `${asOfDate.slice(0, 7)}-25`,
    active: true,
  });

  const payment = (input: {
    name: string;
    category: "monthly_recurring" | "yearly_recurring" | "custom_recurring" | "fixed_point";
    amountMinor: number;
    dueDate: string | null;
    recurrence?: { interval: number; unit: "day" | "week" | "month" | "year"; anchor: string };
    priority: number;
    tag?: string;
  }) =>
    store.createPayment({
      accountId: account.id,
      name: input.name,
      category: input.category,
      amountMinor: input.amountMinor,
      dueDate: input.dueDate,
      recurrence: input.recurrence ?? null,
      targetDate: null,
      priority: input.priority,
      alreadySavedMinor: 0,
      autoRenew: true,
      active: true,
      notes: null,
      projectId: null,
      scope: "shared",
      bearerUserId: null,
      fixedMonthlyMinor: null,
      tag: input.tag ?? null,
    });

  const waterAnchor = shift(asOfDate, 10);
  const payments = [
    await payment({
      name: "Phone bill",
      category: "monthly_recurring",
      amountMinor: 4_500,
      dueDate: shift(asOfDate, 5),
      priority: 10,
      tag: "utilities", // one tagged payment, so the grouping views have something to show
    }),
    await payment({
      name: "Car insurance",
      category: "yearly_recurring",
      amountMinor: 32_000,
      dueDate: shift(asOfDate, 60),
      priority: 20,
    }),
    await payment({
      name: "Water bill",
      category: "custom_recurring",
      amountMinor: 9_000,
      dueDate: waterAnchor,
      recurrence: { interval: 3, unit: "month", anchor: waterAnchor },
      priority: 30,
    }),
    await payment({
      name: "Summer holiday",
      category: "fixed_point",
      amountMinor: 120_000,
      dueDate: shift(asOfDate, 180),
      priority: 5,
    }),
  ];

  // A little money already set aside toward the holiday, so plan-vs-reality has
  // a reality to show.
  await store.createContribution({
    paymentId: payments[3]!.id,
    accountId: account.id,
    userId,
    month: `${asOfDate.slice(0, 7)}-01`,
    amountMinor: 20_000,
    note: "Demo contribution",
    transferConfirmationId: null,
  });

  await store.upsertBalanceSnapshot({
    accountId: account.id,
    asOfDate,
    balanceMinor: 250_000,
  });

  return {
    accounts: 1,
    incomes: 1,
    payments: payments.length,
    contributions: 1,
    balanceSnapshots: 1,
  };
}
