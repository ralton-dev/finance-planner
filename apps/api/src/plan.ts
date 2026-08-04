import type { CreateIncomeBody, CreatePaymentBody } from "@finance-planner/contracts";
import {
  type AccountInput,
  type AccountPlan,
  computeAccountPlan,
  computeHouseholdPlan,
  type HouseholdAccountInput,
  type HouseholdInput,
  type HouseholdPlan,
  type IncomeInput,
  type MemberPaydaySchedule,
  type PaymentInput,
  splitTransfersByPayday,
} from "@finance-planner/domain";
import type { Account, Income, Payment, Store } from "@finance-planner/data";

/**
 * A payment's effective already-saved: its manual base plus every contribution
 * recorded against it. Contributions are the ledger of money actually set
 * aside, so the plan tracks reality without the payment being edited.
 */
async function savedByPayment(store: Store, accountId: string): Promise<Map<string, number>> {
  const totals = await store.sumContributionsByPayment(accountId);
  return new Map(totals.map((t) => [t.paymentId, t.totalMinor]));
}

function toIncomeInput(i: Income): IncomeInput {
  return {
    id: i.id,
    amountMinor: i.amountMinor,
    frequency: i.frequency,
    recurrence: i.recurrence,
    anchorDate: i.anchorDate,
    active: i.active,
  };
}

function toPaymentInput(p: Payment, saved: Map<string, number>): PaymentInput {
  return {
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
    fixedMonthlyMinor: p.fixedMonthlyMinor,
    tag: p.tag,
  };
}

/**
 * Load an account's incomes + payments as engine input. Shared by every read
 * that reasons about the account's money — the plan, the projection, the
 * upcoming feed — so they all see the same derived already-saved.
 */
export async function buildAccountInput(store: Store, account: Account): Promise<AccountInput> {
  const [incomes, payments, saved] = await Promise.all([
    store.listIncomes(account.id),
    store.listPayments(account.id),
    savedByPayment(store, account.id),
  ]);

  return {
    accountId: account.id,
    currency: account.currency,
    monthlyBufferMinor: account.monthlyBufferMinor,
    incomes: incomes.map(toIncomeInput),
    payments: payments.map((p) => toPaymentInput(p, saved)),
  };
}

/**
 * Compute an account's savings plan.
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
  return computeAccountPlan(await buildAccountInput(store, account), asOfDate);
}

// ---------------------------------------------------------------------------
// What-if preview
// ---------------------------------------------------------------------------

/** Hypothetical additions to overlay on an account before computing its plan. */
export interface PlanOverlay {
  addPayments?: CreatePaymentBody[];
  addIncomes?: CreateIncomeBody[];
}

/** The same account, planned twice: as it is, and as it would be. */
export interface PlanPreview {
  base: AccountPlan;
  preview: AccountPlan;
}

/** Overlay ids are synthetic and local to the request — nothing is stored, so
 *  they only need to be unique within the computation. */
function toOverlayIncome(i: CreateIncomeBody, index: number): IncomeInput {
  return {
    id: `preview-income-${index + 1}`,
    amountMinor: i.amountMinor,
    frequency: i.frequency,
    recurrence: i.recurrence ?? null,
    anchorDate: i.anchorDate,
    active: i.active,
  };
}

function toOverlayPayment(p: CreatePaymentBody, index: number): PaymentInput {
  return {
    id: `preview-payment-${index + 1}`,
    name: p.name,
    category: p.category,
    amountMinor: p.amountMinor,
    dueDate: p.dueDate ?? null,
    recurrence: p.recurrence ?? null,
    targetDate: p.targetDate ?? null,
    priority: p.priority,
    alreadySavedMinor: p.alreadySavedMinor,
    autoRenew: p.autoRenew,
    active: p.active,
    fixedMonthlyMinor: p.fixedMonthlyMinor ?? null,
    tag: p.tag ?? null,
  };
}

/**
 * "What would this do to my plan?" — the account's current plan alongside the
 * plan it would have with `overlay` added, both computed for the same as-of date
 * so the two are directly comparable.
 *
 * Strictly read-only: the overlay never reaches the store, and the store is only
 * queried for the account's real incomes, payments and contributions.
 */
export async function previewPlanForAccount(
  store: Store,
  account: Account,
  asOfDate: string,
  overlay: PlanOverlay,
): Promise<PlanPreview> {
  const input = await buildAccountInput(store, account);
  const withOverlay: AccountInput = {
    ...input,
    incomes: [...input.incomes, ...(overlay.addIncomes ?? []).map(toOverlayIncome)],
    payments: [...input.payments, ...(overlay.addPayments ?? []).map(toOverlayPayment)],
  };
  return {
    base: computeAccountPlan(input, asOfDate),
    preview: computeAccountPlan(withOverlay, asOfDate),
  };
}

/**
 * Assemble a household's engine input: its members (with their contribution
 * shares), the accounts assigned to the household (with their roles), and every
 * income + payment on those accounts. Shared by the household plan and the
 * household projection. Read-only; no snapshot persistence.
 */
export async function buildHouseholdInput(
  store: Store,
  householdId: string,
): Promise<HouseholdInput> {
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
      incomes: incomes.map(toIncomeInput),
      payments: payments.map((p) => ({
        ...toPaymentInput(p, saved),
        scope: p.scope,
        bearerUserId: p.bearerUserId,
      })),
    });
  }

  const currency = accounts[0]?.currency ?? "GBP";
  return { householdId, currency, members, accounts };
}

/**
 * Compute a household's pooled plan: the engine splits shared costs by share,
 * funds across accounts by priority, and derives the transfers needed between
 * accounts.
 */
export async function computeHouseholdPlanFor(
  store: Store,
  householdId: string,
  asOfDate: string,
): Promise<HouseholdPlan> {
  return computeHouseholdPlan(await buildHouseholdInput(store, householdId), asOfDate);
}

export interface HouseholdPlanWithSchedule extends HouseholdPlan {
  /** When each member should move their transfers, anchored to their paydays. */
  paydaySchedule: MemberPaydaySchedule[];
}

/**
 * The household plan plus the payday schedule for its derived transfers. A
 * member's paydays come from the incomes on their personal accounts — the same
 * member→accounts mapping the engine uses (role "personal", matching
 * memberUserId) — read off the input already loaded rather than refetched.
 */
export async function computeHouseholdPlanWithSchedule(
  store: Store,
  householdId: string,
  asOfDate: string,
): Promise<HouseholdPlanWithSchedule> {
  const input = await buildHouseholdInput(store, householdId);
  const plan = computeHouseholdPlan(input, asOfDate);
  const memberIncomes = input.members.map((m) => ({
    memberUserId: m.userId,
    incomes: input.accounts
      .filter((a) => a.role === "personal" && a.memberUserId === m.userId)
      .flatMap((a) => a.incomes),
  }));
  return {
    ...plan,
    paydaySchedule: splitTransfersByPayday(plan.transfers, memberIncomes, asOfDate),
  };
}
