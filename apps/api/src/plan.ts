import type { CreateIncomeBody, CreatePaymentBody } from "@finance-planner/contracts";
import {
  type AccountInput,
  type AccountPlan,
  computeAccountPlan,
  computeEstatePlan,
  computeHouseholdPlan,
  type ConfirmedArrival,
  type EstatePlan,
  type FlowAllocation,
  type HouseholdAccountInput,
  type HouseholdInput,
  type HouseholdPlan,
  type IncomeInput,
  type InflowInput,
  type MemberPaydaySchedule,
  type OutboundInflowInput,
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

/** An authored inflow, carried through to the engine whole. The estate pass
 *  reads the account-sourced ones to work out what has to be planned first. */
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

/** The same row read from the account the money leaves: `accountId` is where it
 *  arrives, which from this end is the destination. */
function toOutboundInflowInput(i: Inflow): OutboundInflowInput {
  return {
    id: i.id,
    toAccountId: i.accountId,
    amountMinor: i.amountMinor,
    frequency: i.frequency,
    recurrence: i.recurrence,
    anchorDate: i.anchorDate,
    active: i.active,
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
  /** Engine inputs before the estate pass, keyed `accountId@date`. Planning one
   *  account now reads its senders too, and a chain's accounts share senders. */
  readonly accountInputs: Map<string, Promise<AccountInput>>;
  /** Accounts fetched while walking a funding chain upstream. */
  readonly accounts: Map<string, Promise<Account | null>>;
  /** Estate passes, keyed by the set of accounts they cover. */
  readonly estatePlans: Map<string, Promise<EstatePlan>>;
}

/** A fresh memo. One per request; `buildAccountInput` makes its own when a
 *  caller has nothing to share, so a single-account read needs no ceremony. */
export function createPlanContext(): PlanContext {
  return {
    householdPlans: new Map(),
    confirmations: new Map(),
    inflows: new Map(),
    accountInputs: new Map(),
    accounts: new Map(),
    estatePlans: new Map(),
  };
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
 * How much of each movement into `accountId` has been confirmed as actually
 * moved this month, one entry per authored inflow.
 *
 * Only the arriving side counts. The store answers with every confirmation
 * touching the account, because a movement is one row read from both ends — but
 * confirming money *out* of here says nothing about what came *in*, and summing
 * both would credit an account for its own outgoings.
 *
 * Sorted, so an input built twice is byte-identical twice.
 */
async function loadConfirmedArrivals(
  store: Store,
  accountId: string,
  month: string,
): Promise<ConfirmedArrival[]> {
  const rows = await store.listTransferConfirmationsForAccount(accountId, month);
  const byInflow = new Map<string, number>();
  for (const c of rows) {
    if (!c.inflowId || c.toAccountId !== accountId) continue;
    byInflow.set(c.inflowId, (byInflow.get(c.inflowId) ?? 0) + c.amountMinor);
  }
  return [...byInflow.entries()]
    .map(([inflowId, confirmedMinor]) => ({ inflowId, confirmedMinor }))
    .sort((a, b) => (a.inflowId < b.inflowId ? -1 : 1));
}

/**
 * Load one account's incomes, payments and movements as engine input, before
 * anything is known about the accounts around it.
 *
 * The household's allocation is filled in here — an account inside a household
 * is not funded by its own income alone, and a bills pot has none at all — but
 * what *another account you own* sends is not, because that depends on how the
 * sender's own month works out. `buildAccountInput` adds it.
 *
 * What *has* moved is read here too, for both producers: the household's
 * confirmations come through `resolveAccountInflow`, and a movement between two
 * of your own accounts through `loadConfirmedArrivals`. Without the second, a
 * standalone movement you confirmed months ago would still report
 * `awaiting_transfer` for ever.
 */
async function loadAccountInput(
  store: Store,
  account: Account,
  asOfDate: string,
  ctx: PlanContext,
): Promise<AccountInput> {
  return memo(ctx.accountInputs, `${account.id}@${asOfDate}`, async () => {
    const [inflows, outbound, payments, saved, inflow] = await Promise.all([
      store.listInflows(account.id),
      store.listOutboundInflows(account.id),
      store.listPayments(account.id),
      savedByPayment(store, account.id),
      resolveAccountInflow(store, account, asOfDate, ctx),
    ]);

    // Nothing can be confirmed as arriving at an account nothing moves into, so
    // an account with no account-sourced inflow — every account in the estate,
    // until the user authors one — does not pay for the question.
    const receives = inflows.some((i) => i.source === "account" && i.active !== false);
    const confirmedArrivals = receives
      ? await loadConfirmedArrivals(store, account.id, monthStart(asOfDate))
      : [];

    return {
      accountId: account.id,
      currency: account.currency,
      monthlyBufferMinor: account.monthlyBufferMinor,
      incomes: externalOf(inflows),
      inflows: inflows.map(toInflowInput),
      outboundInflows: outbound.map(toOutboundInflowInput),
      payments: payments.map((p) => toPaymentInput(p, saved)),
      // Only the amounts: the engine never learns who sent it, so no plan
      // response can leak a household member's name by accident. The same holds
      // of `confirmedArrivals`, which names inflows and nobody else.
      inflow: inflow
        ? { allocatedMinor: inflow.allocatedMinor, confirmedMinor: inflow.confirmedMinor }
        : null,
      confirmedArrivals,
    };
  });
}

/**
 * Every account whose month has to be worked out before these ones' can be.
 *
 * Walks the authored inflows upstream — the seeds' senders, their senders, and
 * so on — because an account's funding is the surplus of whatever pays into it.
 * Downstream accounts are deliberately absent unless they were seeded: what an
 * account sends *out* is decided by its own bills, so nothing below it can
 * change its plan.
 *
 * The walk is iterative and guarded by the set it is building, so a circular
 * estate terminates here rather than in the engine; the loop is then named and
 * broken by `computeEstatePlan`, which is the thing that can see the whole shape.
 *
 * Deliberately does not check the caller's access to the accounts it loads. An
 * account you can see may be fed by one you cannot, and the amount arriving is
 * a fact about *your* account — the same reasoning `householdPlanningAccount`
 * uses to plan a household the caller may not be in. Only the seeded accounts'
 * plans are ever returned to a caller; the senders' plans stay inside the pass.
 *
 * Exported as well as used here because this is the estate **as authored** —
 * the array `computeEstatePlan` and `computeEstateProjection` both take, before
 * either has merged anything into it. A caller wanting to simulate the estate
 * forward needs exactly this and must not be handed a completed pass's
 * `inputs`, which already carry the arrivals and would gain them again in every
 * simulated month.
 */
export async function fundingClosure(
  store: Store,
  seeds: readonly Account[],
  asOfDate: string,
  ctx: PlanContext = createPlanContext(),
): Promise<AccountInput[]> {
  const inputs = new Map<string, AccountInput>();
  const queue: Account[] = [...seeds];

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (inputs.has(next.id)) continue;
    const input = await loadAccountInput(store, next, asOfDate, ctx);
    inputs.set(next.id, input);
    for (const row of input.inflows ?? []) {
      if (row.source !== "account" || row.active === false || !row.sourceAccountId) continue;
      if (inputs.has(row.sourceAccountId)) continue;
      const sender = await memo(ctx.accounts, row.sourceAccountId, () =>
        store.getAccount(row.sourceAccountId!),
      );
      if (sender) queue.push(sender);
    }
  }

  // Sorted so the key below identifies the pass and the pass itself is
  // reproducible: two accounts of the same estate must not order the same set
  // differently and disagree about which edge of a loop was broken.
  return [...inputs.values()].sort((a, b) => (a.accountId < b.accountId ? -1 : 1));
}

/**
 * The one ordered pass covering `accounts` and everything that funds them.
 *
 * Taking a *set* of accounts rather than one is what makes an estate-wide read
 * a single pass. A caller that plans every account it can see — the overview,
 * the upcoming feed, the digest — would otherwise run one pass per account,
 * each over that account's own funding closure: quadratic work, and a rollup
 * assembled from plans no two of which were computed together. One pass over
 * the union settles the whole graph once.
 *
 * Which accounts a *caller* may see is not this function's business and must
 * not become it: the closure deliberately reaches accounts the caller cannot,
 * because that is where the money comes from. Filtering happens where the plans
 * are handed out.
 */
export async function computeEstateFor(
  store: Store,
  accounts: readonly Account[],
  asOfDate: string,
  ctx: PlanContext = createPlanContext(),
): Promise<EstatePlan> {
  const closure = await fundingClosure(store, accounts, asOfDate, ctx);
  const key = `${closure.map((a) => a.accountId).join(",")}@${asOfDate}`;
  return memo(ctx.estatePlans, key, async () => computeEstatePlan(closure, asOfDate));
}

/**
 * An account's engine input, with everything arriving into it settled: the
 * household's allocation and whatever the accounts feeding it could actually
 * afford to send.
 *
 * Shared by every read that reasons about the account's money — the plan, the
 * projection, the upcoming feed — so they all see the same derived already-saved
 * *and* the same money coming in. Doing it here rather than per call site is the
 * point: every such read comes through this function, so none of them can be
 * left planning the account as if the money were not coming.
 *
 * The input handed back is the one the ordered pass planned from, not a
 * reconstruction of it, so a caller that plans it again gets the pass's answer
 * to the penny.
 */
export async function buildAccountInput(
  store: Store,
  account: Account,
  asOfDate: string,
  ctx: PlanContext = createPlanContext(),
): Promise<AccountInput> {
  const estate = await computeEstateFor(store, [account], asOfDate, ctx);
  // Always present: an account is in its own funding closure.
  return estate.inputs.find((i) => i.accountId === account.id)!;
}

/**
 * Compute an account's savings plan, as one slice of the ordered pass over
 * every account that funds it.
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
  const estate = await computeEstateFor(store, [account], asOfDate, ctx);
  return estate.plans.find((p) => p.accountId === account.id)!;
}

/**
 * Who is sending the money each of `accounts` has arriving from a household.
 *
 * The two derivations of money crossing an account boundary are disjoint: the
 * ordered pass settles movements the user *authored*, and a household plan
 * settles what each *member* must move. A diagram over a set of accounts needs
 * both, or a shared pot fills up out of nowhere while the account paying for it
 * shows the money still sitting there.
 *
 * This adds nothing to either. `HouseholdPlan.transfers` is already the answer;
 * all that happens here is looking it up per account and pairing it with the
 * account it lands in. The household plan is the one the account's own inflow
 * resolution already computed — same memo, same request, no second pass.
 *
 * **Names are gated, amounts are not**, the same rule the plan endpoint's
 * `inflowSources` applies: an account can be shared with someone outside the
 * household funding it, and how much arrives is a fact about the account while
 * who sent it is a fact about a household they may not be in.
 */
export async function householdAllocations(
  store: Store,
  userId: string,
  accounts: readonly Account[],
  asOfDate: string,
  ctx: PlanContext = createPlanContext(),
): Promise<FlowAllocation[]> {
  const allocations: FlowAllocation[] = [];
  for (const account of accounts) {
    const inflow = await resolveAccountInflow(store, account, asOfDate, ctx);
    if (!inflow) continue;
    const [plan, membership] = await Promise.all([
      memo(ctx.householdPlans, `${inflow.householdId}@${asOfDate}`, () =>
        computeHouseholdPlanFor(store, inflow.householdId, asOfDate),
      ),
      store.getMembership(inflow.householdId, userId),
    ]);
    for (const transfer of plan.transfers) {
      if (transfer.toAccountId !== account.id) continue;
      const name = plan.members.find((m) => m.userId === transfer.memberUserId)?.displayName;
      allocations.push({
        toAccountId: account.id,
        fromAccountId: transfer.fromAccountId,
        memberUserId: transfer.memberUserId,
        ...(membership && name !== undefined ? { memberName: name } : {}),
        amountMinor: transfer.amountMinor,
      });
    }
  }
  return allocations;
}

/**
 * Every account the user can see, loaded once. The order `listAccessibleAccounts`
 * returns them in is kept — it is the order the overview's rows come back in,
 * and it must not start depending on the shape of the funding graph.
 */
export async function accessibleAccounts(store: Store, userId: string): Promise<Account[]> {
  const access = await store.listAccessibleAccounts(userId);
  const accounts = await Promise.all(access.map((a) => store.getAccount(a.accountId)));
  return accounts.filter((a): a is Account => a !== null);
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
  const accounts = await accessibleAccounts(store, userId);
  const items: UpcomingItem[] = [];
  // One pass over the whole estate rather than one per account: the feed asks
  // the same question of every account the caller can see, and asking it
  // account by account settles the same funding graph once per account.
  const estate = await computeEstateFor(store, accounts, asOfDate);
  const inputById = new Map(estate.inputs.map((i) => [i.accountId, i]));
  for (const account of accounts) {
    // Always present: every seeded account is in the pass.
    const input = inputById.get(account.id)!;
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
