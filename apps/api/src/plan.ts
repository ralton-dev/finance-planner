import { type AccountInput, type AccountPlan, computeAccountPlan } from "@finance-planner/domain";
import type { Account, Store } from "@finance-planner/data";

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
  const [incomes, payments] = await Promise.all([
    store.listIncomes(account.id),
    store.listPayments(account.id),
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
      alreadySavedMinor: p.alreadySavedMinor,
      autoRenew: p.autoRenew,
      active: p.active,
    })),
  };

  return computeAccountPlan(input, asOfDate);
}
