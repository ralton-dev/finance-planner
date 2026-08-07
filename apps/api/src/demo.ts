import type { Store } from "@finance-planner/data";
import { toISODate } from "@finance-planner/domain";

/** What the demo seed created. */
export interface DemoSeedCounts {
  users: number;
  households: number;
  householdMemberships: number;
  accounts: number;
  accountShares: number;
  accountAssignments: number;
  incomes: number;
  accountInflows: number;
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
 * Plant a worked example for a brand-new user, so first-run exploration shows a
 * plan with something in it rather than an empty screen. It deliberately spans
 * one two-person household and four accounts: salary lands in each person's
 * current account, bills live in a shared household pot that the engine must
 * fund with derived transfers from both members, and savings receives an
 * authored account-to-account sweep. That gives the visible app useful data and
 * gives the hidden engine debug page real transfers, rankings, household
 * attribution and movement funding to explain.
 *
 * Dates are computed from `asOfDate` rather than hard-coded, so the plan is
 * always live. Fixed seed dates go stale the moment the calendar passes them,
 * which is exactly the wrong first impression.
 */
export async function seedDemoData(
  store: Store,
  userId: string,
  asOfDate: string,
): Promise<DemoSeedCounts> {
  // Always its own household, never one that already exists. The caller has
  // checked there isn't one — and if that check ever slips, failing loudly here
  // beats quietly adding a fabricated member to somebody's real household and
  // rewriting the shares underneath them.
  const household = await store.createHousehold("Demo Household", userId);
  const partnerEmail = `demo-partner-${userId}@example.com`;
  const existingPartner = await store.getUserByEmail(partnerEmail);
  const partner =
    existingPartner ??
    (await store.createUser({
      email: partnerEmail,
      passwordHash: null,
      displayName: "Demo Partner",
    }));
  await store.addMembership(household.id, partner.id, "member");
  await store.updateMembershipShare(household.id, userId, 6_000);
  await store.updateMembershipShare(household.id, partner.id, 4_000);

  const everyday = await store.createAccount({
    ownerUserId: userId,
    name: "Everyday Account",
    description: "Salary arrives here and funds the other pots",
    currency: "GBP",
    openingBalanceMinor: 250_000,
    monthlyBufferMinor: 20_000,
  });
  const bills = await store.createAccount({
    ownerUserId: userId,
    name: "Bills Pot",
    description: "Shared expenses are paid here, funded from both current accounts",
    currency: "GBP",
    openingBalanceMinor: 50_000,
    monthlyBufferMinor: 0,
  });
  const savings = await store.createAccount({
    ownerUserId: userId,
    name: "Savings Pot",
    description: "Receives an explicit monthly sweep from the everyday account",
    currency: "GBP",
    openingBalanceMinor: 120_000,
    monthlyBufferMinor: 0,
  });
  const partnerCurrent = await store.createAccount({
    ownerUserId: partner.id,
    name: "Partner Current",
    description: "Partner salary arrives here and funds their household share",
    currency: "GBP",
    openingBalanceMinor: 180_000,
    monthlyBufferMinor: 10_000,
  });

  await store.createAccountShare(partnerCurrent.id, household.id, "view");

  await store.upsertAccountAssignment({
    householdId: household.id,
    accountId: everyday.id,
    role: "personal",
    memberUserId: userId,
  });
  await store.upsertAccountAssignment({
    householdId: household.id,
    accountId: bills.id,
    role: "shared",
    memberUserId: null,
  });
  await store.upsertAccountAssignment({
    householdId: household.id,
    accountId: savings.id,
    role: "personal",
    memberUserId: userId,
  });
  await store.upsertAccountAssignment({
    householdId: household.id,
    accountId: partnerCurrent.id,
    role: "personal",
    memberUserId: partner.id,
  });

  await store.createIncome({
    accountId: everyday.id,
    name: "Salary",
    amountMinor: 250_000,
    frequency: "monthly",
    recurrence: null,
    // Paid on the 25th, anchored in the current month so paydays land sensibly.
    anchorDate: `${asOfDate.slice(0, 7)}-25`,
    active: true,
  });
  await store.createIncome({
    accountId: partnerCurrent.id,
    name: "Partner salary",
    amountMinor: 180_000,
    frequency: "monthly",
    recurrence: null,
    anchorDate: `${asOfDate.slice(0, 7)}-28`,
    active: true,
  });

  await store.createInflow({
    accountId: savings.id,
    name: "Savings sweep",
    source: "account",
    sourceAccountId: everyday.id,
    amountMinor: 40_000,
    frequency: "monthly",
    recurrence: null,
    anchorDate: `${asOfDate.slice(0, 7)}-28`,
    priority: 40,
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
      accountId: bills.id,
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
    accountId: bills.id,
    userId,
    month: `${asOfDate.slice(0, 7)}-01`,
    amountMinor: 20_000,
    note: "Demo contribution",
    transferConfirmationId: null,
  });

  await store.upsertBalanceSnapshot({
    accountId: everyday.id,
    asOfDate,
    balanceMinor: 250_000,
  });
  await store.upsertBalanceSnapshot({
    accountId: bills.id,
    asOfDate,
    balanceMinor: 50_000,
  });
  await store.upsertBalanceSnapshot({
    accountId: savings.id,
    asOfDate,
    balanceMinor: 120_000,
  });
  await store.upsertBalanceSnapshot({
    accountId: partnerCurrent.id,
    asOfDate,
    balanceMinor: 180_000,
  });

  return {
    users: existingPartner ? 0 : 1,
    households: 1,
    // The creator's, from `createHousehold`, plus the partner's.
    householdMemberships: 2,
    accounts: 4,
    accountShares: 1,
    accountAssignments: 4,
    incomes: 2,
    accountInflows: 1,
    payments: payments.length,
    contributions: 1,
    balanceSnapshots: 4,
  };
}
