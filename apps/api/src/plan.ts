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
  type InflowInput,
  type MemberPaydaySchedule,
  type PaymentInput,
  splitTransfersByPayday,
  type UpcomingPayment,
  upcomingPayments,
} from "@finance-planner/domain";
import type { Account, Inflow, Payment, Store, TransferConfirmation } from "@finance-planner/data";

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
 * The engine's income input, read off an inflow record.
 *
 * Every read of "what arrives here" now comes from `inflows`; `core.incomes` is
 * a table nothing consults. Only `source: "external"` reaches this — an inflow
 * out of another account you own is not income, and counting it as such would
 * inflate the estate's money in by every internal movement.
 */
function toIncomeInput(i: Inflow): IncomeInput {
  return {
    id: i.id,
    amountMinor: i.amountMinor,
    frequency: i.frequency,
    recurrence: i.recurrence,
    anchorDate: i.anchorDate,
    active: i.active,
  };
}

/** An authored inflow, carried through to the engine whole. Inert until WP-G
 *  reads it; the external ones are what `toIncomeInput` plans from today. */
function toInflowInput(i: Inflow): InflowInput {
  return {
    id: i.id,
    amountMinor: i.amountMinor,
    frequency: i.frequency,
    recurrence: i.recurrence,
    anchorDate: i.anchorDate,
    active: i.active,
    source: i.source,
    sourceAccountId: i.sourceAccountId,
    priority: i.priority,
  };
}

/** External inflows only — see `toIncomeInput`. */
const externalOf = (inflows: Inflow[]): IncomeInput[] =>
  inflows.filter((i) => i.source === "external").map(toIncomeInput);

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

// ---------------------------------------------------------------------------
// Allocated inflow: what a household has earmarked into one of its accounts
// ---------------------------------------------------------------------------

/** ISO date of the first day of the month a date falls in. Transfer
 *  confirmations are keyed by that, the same as everywhere else. */
const monthStart = (isoDate: string): string => `${isoDate.slice(0, 7)}-01`;

/** One member's slice of the money arriving into an account this month. */
export interface InflowSource {
  memberUserId: string;
  displayName?: string;
  /** What the household plan asks this member to move in. */
  amountMinor: number;
  /** How much of it they have confirmed moving (<= `amountMinor`). */
  confirmedMinor: number;
}

/**
 * What a household has allocated into one account for the month, and who is
 * sending it.
 *
 * The **amount** is a fact about the account: anyone who can see the account can
 * already see the bills it pays and that they are covered, so it travels into
 * the plan unconditionally. **`sources` names household members**, and an
 * account can be shared with someone who is not one — so the plan endpoint only
 * attaches them for a caller who can see the household.
 */
export interface AccountInflow {
  householdId: string;
  allocatedMinor: number;
  confirmedMinor: number;
  sources: InflowSource[];
}

/**
 * Per-request memo for the household work an account plan now needs.
 *
 * Planning an account in a household means planning the whole household, and
 * some reads plan many accounts at once: the overview plans every account the
 * caller can see, and the upcoming feed builds an input per account. Without
 * this, an estate of one household would recompute the identical household plan
 * once per account. One context per request collapses that to one.
 *
 * Deliberately request-scoped and handed in by the call site: it is a memo, not
 * a cache, so there is nothing to invalidate and no way for a mutation in one
 * request to be served stale results in the next. Keys carry the as-of date, so
 * a request that plans two dates cannot cross them.
 */
export interface PlanContext {
  readonly householdPlans: Map<string, Promise<HouseholdPlan>>;
  readonly confirmations: Map<string, Promise<TransferConfirmation[]>>;
  readonly inflows: Map<string, Promise<AccountInflow | null>>;
}

/** A fresh memo. One per request; `buildAccountInput` makes its own when a
 *  caller has nothing to share, so a single-account read needs no ceremony. */
export function createPlanContext(): PlanContext {
  return { householdPlans: new Map(), confirmations: new Map(), inflows: new Map() };
}

/** Memoised `f`, keyed in `map`. Promises are cached rather than values, so two
 *  concurrent askers share one computation instead of racing to do it twice. */
function memo<T>(map: Map<string, Promise<T>>, key: string, f: () => Promise<T>): Promise<T> {
  const hit = map.get(key);
  if (hit) return hit;
  const pending = f();
  map.set(key, pending);
  return pending;
}

/**
 * Which household plans this account, independent of who is asking.
 *
 * There is no account → household index in the Store, and this deliberately
 * does not ask the *caller* which households they are in: the account may be
 * shared with someone outside the household that funds it, and their view of it
 * must still add up. So it looks from the account outwards — the households its
 * owner belongs to, then the households it is shared into — and takes the first
 * that has actually assigned it a role. Households come back in a stable order,
 * so the answer is deterministic, matching `accountPlacements`' rule of taking
 * the first when an account is assigned in two.
 */
async function householdPlanningAccount(store: Store, account: Account): Promise<string | null> {
  const [owned, shares] = await Promise.all([
    store.listHouseholdsForUser(account.ownerUserId),
    store.listSharesForAccount(account.id),
  ]);
  const seen = new Set<string>();
  for (const householdId of [...owned.map((h) => h.id), ...shares.map((s) => s.householdId)]) {
    if (seen.has(householdId)) continue;
    seen.add(householdId);
    if (await store.getAccountAssignment(householdId, account.id)) return householdId;
  }
  return null;
}

/**
 * The money a household has allocated into `account` this month, or null when
 * no household plans it.
 *
 * `allocatedMinor` is the household plan's derived transfers into the account —
 * the same figure `HouseholdAccountPlan.transferInMinor` reports, taken off the
 * transfers so it can be attributed per member. `confirmedMinor` is how much of
 * it has actually moved, from the confirmations already stored for the month.
 *
 * A member's confirmation is clamped to what the plan currently asks of *that
 * member*: a confirmation outlives the plan that derived it (deliberately — see
 * the confirm handler's idempotency guard), so a stale one must not credit
 * another member's slice.
 */
export async function resolveAccountInflow(
  store: Store,
  account: Account,
  asOfDate: string,
  ctx: PlanContext = createPlanContext(),
): Promise<AccountInflow | null> {
  return memo(ctx.inflows, `${account.id}@${asOfDate}`, async () => {
    const householdId = await householdPlanningAccount(store, account);
    if (!householdId) return null;

    const [plan, confirmations] = await Promise.all([
      memo(ctx.householdPlans, `${householdId}@${asOfDate}`, () =>
        computeHouseholdPlanFor(store, householdId, asOfDate),
      ),
      memo(ctx.confirmations, `${householdId}@${monthStart(asOfDate)}`, () =>
        store.listTransferConfirmations(householdId, monthStart(asOfDate)),
      ),
    ]);

    const confirmedByMember = new Map<string, number>();
    for (const c of confirmations) {
      if (c.toAccountId !== account.id) continue;
      confirmedByMember.set(
        c.memberUserId,
        (confirmedByMember.get(c.memberUserId) ?? 0) + c.amountMinor,
      );
    }

    const byMember = new Map<string, number>();
    for (const t of plan.transfers) {
      if (t.toAccountId !== account.id) continue;
      byMember.set(t.memberUserId, (byMember.get(t.memberUserId) ?? 0) + t.amountMinor);
    }

    const sources: InflowSource[] = [...byMember.entries()]
      .map(([memberUserId, amountMinor]) => ({
        memberUserId,
        displayName: plan.members.find((m) => m.userId === memberUserId)?.displayName,
        amountMinor,
        confirmedMinor: Math.min(amountMinor, confirmedByMember.get(memberUserId) ?? 0),
      }))
      .sort(
        (a, b) => b.amountMinor - a.amountMinor || a.memberUserId.localeCompare(b.memberUserId),
      );

    return {
      householdId,
      allocatedMinor: sources.reduce((sum, s) => sum + s.amountMinor, 0),
      confirmedMinor: sources.reduce((sum, s) => sum + s.confirmedMinor, 0),
      sources,
    };
  });
}

/**
 * Load an account's incomes + payments as engine input. Shared by every read
 * that reasons about the account's money — the plan, the projection, the
 * upcoming feed — so they all see the same derived already-saved.
 *
 * It also fills in what a household has allocated into the account, which is why
 * it needs the as-of date: an account inside a household is not funded by its
 * own income alone, and a bills pot has none at all. Doing it here rather than
 * per call site is the point — every read that reasons about the account's money
 * comes through this function, so none of them can be left planning the account
 * as if the money were not coming.
 */
export async function buildAccountInput(
  store: Store,
  account: Account,
  asOfDate: string,
  ctx: PlanContext = createPlanContext(),
): Promise<AccountInput> {
  const [inflows, payments, saved, inflow] = await Promise.all([
    store.listInflows(account.id),
    store.listPayments(account.id),
    savedByPayment(store, account.id),
    resolveAccountInflow(store, account, asOfDate, ctx),
  ]);

  return {
    accountId: account.id,
    currency: account.currency,
    monthlyBufferMinor: account.monthlyBufferMinor,
    incomes: externalOf(inflows),
    inflows: inflows.map(toInflowInput),
    payments: payments.map((p) => toPaymentInput(p, saved)),
    // Only the amounts: the engine never learns who sent it, so no plan
    // response can leak a household member's name by accident.
    inflow: inflow
      ? { allocatedMinor: inflow.allocatedMinor, confirmedMinor: inflow.confirmedMinor }
      : null,
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
  ctx: PlanContext = createPlanContext(),
): Promise<AccountPlan> {
  return computeAccountPlan(await buildAccountInput(store, account, asOfDate, ctx), asOfDate);
}

// ---------------------------------------------------------------------------
// Upcoming feed
// ---------------------------------------------------------------------------

/** An upcoming due date, carrying the account it belongs to. */
export interface UpcomingItem extends UpcomingPayment {
  accountId: string;
  accountName: string;
  currency: string;
}

/**
 * What falls due for one user in the next `days` days, across every account
 * they can see, merged into one dated feed and sorted (date, then name, then
 * account). Shared by GET /api/upcoming and the daily digest so the two can
 * never disagree about what is coming up. Uncapped — the caller decides how
 * many rows it wants.
 */
export async function upcomingForUser(
  store: Store,
  userId: string,
  asOfDate: string,
  days: number,
): Promise<UpcomingItem[]> {
  const access = await store.listAccessibleAccounts(userId);
  const items: UpcomingItem[] = [];
  // One memo for the whole feed: an estate is usually one household, so its
  // accounts would otherwise each recompute the same household plan.
  const ctx = createPlanContext();
  for (const a of access) {
    const account = await store.getAccount(a.accountId);
    if (!account) continue;
    const input = await buildAccountInput(store, account, asOfDate, ctx);
    for (const row of upcomingPayments(input.payments, asOfDate, days)) {
      items.push({
        ...row,
        accountId: account.id,
        accountName: account.name,
        currency: account.currency,
      });
    }
  }
  return items.sort(
    (x, y) =>
      (x.dueDate < y.dueDate ? -1 : x.dueDate > y.dueDate ? 1 : 0) ||
      x.name.localeCompare(y.name) ||
      x.accountName.localeCompare(y.accountName),
  );
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
 *
 * Both sides carry the household's *current* allocation. A hypothetical payment
 * added to a shared pot therefore shows as a shortfall rather than being quietly
 * covered — which is the honest answer: nobody has agreed to send more yet.
 */
export async function previewPlanForAccount(
  store: Store,
  account: Account,
  asOfDate: string,
  overlay: PlanOverlay,
): Promise<PlanPreview> {
  const input = await buildAccountInput(store, account, asOfDate);
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
    const [inflows, payments, saved] = await Promise.all([
      store.listInflows(account.id),
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
      incomes: externalOf(inflows),
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
