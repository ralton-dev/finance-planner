import {
  type AccountInput,
  type AccountPlan,
  computeAccountPlan,
  computeHouseholdPlan,
  type HouseholdAccountInput,
  type HouseholdPlan,
} from "@finance-planner/domain";
import type { Account, Store } from "@finance-planner/data";

/**
 * A payment's effective already-saved: its manual base plus every contribution
 * recorded against it. Contributions are the ledger of money actually set
 * aside, so the plan tracks reality without the payment being edited.
 */
async function savedByPayment(store: Store, accountId: string): Promise<Map<string, number>> {
  const totals = await store.sumContributionsByPayment(accountId);
  return new Map(totals.map((t) => [t.paymentId, t.totalMinor]));
}

/**
 * Load an account's incomes + payments and compute its savings plan.
 *
 * Snapshot persistence is intentionally NOT performed here. The plan endpoint
 * is read-only on every browser refresh; writing a row each call turned an
 * inert read into an unbounded insert. Snapshots are still useful for audit
 * history — when wired, write them from mutation handlers (account /
 * income / payment CUD) or a scheduled recompute job, not from the read path.
 */
export async function computePlanForAccount(
  store: Store,
  account: Account,
  asOfDate: string,
): Promise<AccountPlan> {
  const [incomes, payments, saved] = await Promise.all([
    store.listIncomes(account.id),
    store.listPayments(account.id),
    savedByPayment(store, account.id),
  ]);

  const input: AccountInput = {
    accountId: account.id,
    currency: account.currency,
    monthlyBufferMinor: account.monthlyBufferMinor,
    incomes: incomes.map((i) => ({
      id: i.id,
      amountMinor: i.amountMinor,
      frequency: i.frequency,
      recurrence: i.recurrence,
      anchorDate: i.anchorDate,
      active: i.active,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      amountMinor: p.amountMinor,
      dueDate: p.dueDate,
      recurrence: p.recurrence,
      targetDate: p.targetDate,
      priority: p.priority,
      alreadySavedMinor: p.alreadySavedMinor + (saved.get(p.id) ?? 0),
      autoRenew: p.autoRenew,
      active: p.active,
    })),
  };

  return computeAccountPlan(input, asOfDate);
}

/**
 * Assemble and compute a household's pooled plan: its members (with their
 * contribution shares), the accounts assigned to the household (with their
 * roles), and every income + payment on those accounts. The engine then splits
 * shared costs by share, funds across accounts by priority, and derives the
 * transfers needed between accounts. Read-only; no snapshot persistence.
 */
export async function computeHouseholdPlanFor(
  store: Store,
  householdId: string,
  asOfDate: string,
): Promise<HouseholdPlan> {
  const [memberships, assignments] = await Promise.all([
    store.listMembersForHousehold(householdId),
    store.listAccountAssignments(householdId),
  ]);

  const members = await Promise.all(
    memberships.map(async (m) => {
      const user = await store.getUserById(m.userId);
      return { userId: m.userId, displayName: user?.displayName, shareBp: m.contributionShareBp };
    }),
  );

  const accounts: HouseholdAccountInput[] = [];
  for (const asg of assignments) {
    const account = await store.getAccount(asg.accountId);
    if (!account) continue;
    const [incomes, payments, saved] = await Promise.all([
      store.listIncomes(account.id),
      store.listPayments(account.id),
      savedByPayment(store, account.id),
    ]);
    accounts.push({
      accountId: account.id,
      name: account.name,
      role: asg.role,
      memberUserId: asg.memberUserId,
      currency: account.currency,
      monthlyBufferMinor: account.monthlyBufferMinor,
      incomes: incomes.map((i) => ({
        id: i.id,
        amountMinor: i.amountMinor,
        frequency: i.frequency,
        recurrence: i.recurrence,
        anchorDate: i.anchorDate,
        active: i.active,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        amountMinor: p.amountMinor,
        dueDate: p.dueDate,
        recurrence: p.recurrence,
        targetDate: p.targetDate,
        priority: p.priority,
        alreadySavedMinor: p.alreadySavedMinor + (saved.get(p.id) ?? 0),
        autoRenew: p.autoRenew,
        active: p.active,
        scope: p.scope,
        bearerUserId: p.bearerUserId,
      })),
    });
  }

  const currency = accounts[0]?.currency ?? "GBP";
  return computeHouseholdPlan({ householdId, currency, members, accounts }, asOfDate);
}
