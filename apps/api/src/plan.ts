import {
  type AccountInput,
  type AccountPlan,
  computeAccountPlan,
  toISODate,
} from "@finance-planner/domain";
import type { Account, Store } from "@finance-planner/data";
import { sha256 } from "@finance-planner/security";

/** Load an account's incomes + payments and compute its savings plan. */
export async function computePlanForAccount(
  store: Store,
  account: Account,
  asOfDate: string = toISODate(new Date()),
  persist = true,
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

  const plan = computeAccountPlan(input, asOfDate);

  if (persist) {
    await store.saveSnapshot({
      accountId: account.id,
      asOfDate,
      inputsHash: sha256(JSON.stringify(input)),
      detail: plan,
    });
  }

  return plan;
}
