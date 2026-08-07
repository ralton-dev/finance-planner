import type { CreateIncomeBody, CreatePaymentBody } from "@finance-planner/contracts";
import {
  type AccountPlan,
  accountPlanFromScope,
  type ConfirmedArrival,
  type ConfirmedTransfer,
  computeScopePlan,
  type HouseholdMemberPlan,
  type HouseholdPlan,
  householdPlanFromScope,
  type IncomeInput,
  type InflowInput,
  type MemberPaydaySchedule,
  type OutboundInflowInput,
  type PaymentInput,
  type ScopeAccountInput,
  type ScopeInput,
  type ScopeMemberInput,
  type ScopePaymentInput,
  type ScopePlan,
  splitTransfersByPayday,
  type Transfer,
  type UpcomingPayment,
  upcomingPayments,
} from "@finance-planner/domain";
import type {
  Account,
  Household,
  Inflow,
  Payment,
  Store,
  TransferConfirmation,
} from "@finance-planner/data";

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
 * out of another account is not income, and counting it as such would inflate
 * the estate's money in by every internal movement. **Not "another account you
 * own":** authoring one takes `requireAccess(..., "edit")` on the sender
 * (`server.ts:1241`), so it may be a co-member's account shared to you. What
 * disqualifies it as income is that the money is already inside, not whose it
 * is.
 */
function toIncomeInput(i: Inflow): IncomeInput {
  return {
    id: i.id,
    name: i.name,
    amountMinor: i.amountMinor,
    frequency: i.frequency,
    recurrence: i.recurrence,
    anchorDate: i.anchorDate,
    active: i.active,
  };
}

/** An authored inflow, carried through to the pass whole. It reads the
 *  account-sourced ones only to notice a sender the scope never loaded. */
function toInflowInput(i: Inflow): InflowInput {
  return {
    id: i.id,
    name: i.name,
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
    name: i.name,
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

/** ISO date of the first day of the month a date falls in. Transfer
 *  confirmations are keyed by that, the same as everywhere else. */
const monthStart = (isoDate: string): string => `${isoDate.slice(0, 7)}-01`;

// ---------------------------------------------------------------------------
// One scope loader
// ---------------------------------------------------------------------------

/** One member's slice of the money arriving into an account this month. */
export interface InflowSource {
  memberUserId: string;
  displayName?: string;
  /**
   * The account the plan asks them to move it **out of** — their source account
   * for this currency (decision 11).
   *
   * Ungated, like the `account` variant's `fromAccountId` beside it: the gate
   * `planInflowSources` applies is on *names*, and an account id is not a name.
   * The rows that reach a caller are already gated — your own always, everyone's
   * only when you can see the household — and a household member can read the
   * same id off `GET /households/:id/plan` (`transfers[].fromAccountId`), so
   * nothing here is a fact they did not have. Without it the browser knew a
   * person and `POST /accounts/:id/transfers/confirm` wanted an account, which
   * left the derived-transfer confirmation with no client that could reach it.
   */
  fromAccountId: string;
  /** What the plan asks this member to move in. */
  amountMinor: number;
  /** How much of it they have confirmed moving (<= `amountMinor`). */
  confirmedMinor: number;
}

/**
 * A scope, planned: what was handed to the pass, what the pass answered, and the
 * few facts about the accounts and people in it that a *view* needs and the
 * engine is deliberately never told.
 *
 * The engine is never told who sent money, so no plan response can leak a name
 * by accident; `memberNames` lives here instead, and the endpoints gate it.
 */
export interface PlannedScope {
  input: ScopeInput;
  plan: ScopePlan;
  /** The household planning each account, for the accounts one plans. */
  householdOf: ReadonlyMap<string, string>;
  /** Display names of the scope's members. */
  memberNames: ReadonlyMap<string, string>;
  /** The accounts in this scope, in the order they were handed to the pass. */
  accountIds: readonly string[];
}

/** Everything one account contributes to a scope, loaded once. */
interface LoadedAccount {
  account: Account;
  /** Accounts that send money here, and accounts this one sends to: the funding
   *  graph, walked in both directions. */
  senders: string[];
  receivers: string[];
  incomes: IncomeInput[];
  inflows: InflowInput[];
  outboundInflows: OutboundInflowInput[];
  payments: ScopePaymentInput[];
  confirmedArrivals: ConfirmedArrival[];
  /** Confirmations of a transfer nobody authored — the derived-solo shape 0010
   *  made storable, and the household rows, read from this account's end. */
  derivedConfirmations: TransferConfirmation[];
}

/** A household as the scope loader needs it: who is in it, and what it plans. */
interface LoadedHousehold {
  members: ScopeMemberInput[];
  roles: Map<string, { role: "shared" | "personal"; memberUserId: string | null }>;
  accountIds: string[];
}

/**
 * Per-request memo for the scope work every read now needs.
 *
 * Planning an account means planning its scope, and some reads plan many
 * accounts at once: the overview plans every account the caller can see, and the
 * digest walks the same set. Without this, an estate of one household would
 * settle the identical scope once per account. One context per request collapses
 * that to one.
 *
 * Deliberately request-scoped and handed in by the call site: it is a memo, not
 * a cache, so there is nothing to invalidate and no way for a mutation in one
 * request to be served stale results in the next. Keys carry the as-of date, so
 * a request that plans two dates cannot cross them.
 *
 * **Re-keyed by scope** (ONE-ENGINE.md, WP-S). The old context memoised
 * household plans by `householdId@month` and account inputs by `accountId@date`,
 * which is two keys for one question and neither of them a key a solo user has.
 * A scope is keyed by the accounts it contains, and every account of one resolves
 * to the same key.
 */
export interface PlanContext {
  readonly accounts: Map<string, Promise<Account | null>>;
  /** Per owner: the accounts they hold, and the households they are in. Asked
   *  once per account by the closure, so memoised once per person. */
  readonly ownedAccounts: Map<string, Promise<Account[]>>;
  readonly userHouseholds: Map<string, Promise<Household[]>>;
  readonly loaded: Map<string, Promise<LoadedAccount>>;
  readonly households: Map<string, Promise<LoadedHousehold>>;
  /** Which household plans an account, independent of who is asking. */
  readonly accountHousehold: Map<string, Promise<string | null>>;
  /** Planned scopes, keyed by the accounts they cover. */
  readonly scopes: Map<string, Promise<PlannedScope>>;
  /** `accountId@date` → the key of the scope that account belongs to. */
  readonly scopeOf: Map<string, string>;
}

/** A fresh memo. One per request; every entry point makes its own when a caller
 *  has nothing to share, so a single-account read needs no ceremony. */
export function createPlanContext(): PlanContext {
  return {
    accounts: new Map(),
    ownedAccounts: new Map(),
    userHouseholds: new Map(),
    loaded: new Map(),
    households: new Map(),
    accountHousehold: new Map(),
    scopes: new Map(),
    scopeOf: new Map(),
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

const getAccount = (store: Store, ctx: PlanContext, id: string): Promise<Account | null> =>
  memo(ctx.accounts, id, () => store.getAccount(id));

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
 *
 * **This is what keeps a scope's member vector single-valued** (WP-W). A user
 * belongs to exactly one household, sharing an account requires membership of
 * the household shared into, and assigning one requires access to it — so an
 * account's owner is always a member of any household that has assigned it, and
 * the answer is always *the owner's* household. Every account reachable from
 * another through a funding edge is editable by one person, who is in one
 * household, so a closure can only ever collect that one roster.
 *
 * The loop stays because the rule is enforced from
 * `0011_one_household_per_user.sql` forward and never retroactively. On data
 * written before it, a second membership can still exist; first-wins over a
 * stable order is what keeps that case deterministic rather than arbitrary.
 */
async function householdPlanningAccount(
  store: Store,
  ctx: PlanContext,
  account: Account,
): Promise<string | null> {
  return memo(ctx.accountHousehold, account.id, async () => {
    const [owned, shares] = await Promise.all([
      memo(ctx.userHouseholds, account.ownerUserId, () =>
        store.listHouseholdsForUser(account.ownerUserId),
      ),
      store.listSharesForAccount(account.id),
    ]);
    const seen = new Set<string>();
    for (const householdId of [...owned.map((h) => h.id), ...shares.map((s) => s.householdId)]) {
      if (seen.has(householdId)) continue;
      seen.add(householdId);
      if (await store.getAccountAssignment(householdId, account.id)) return householdId;
    }
    return null;
  });
}

async function loadHousehold(
  store: Store,
  ctx: PlanContext,
  householdId: string,
): Promise<LoadedHousehold> {
  return memo(ctx.households, householdId, async () => {
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
    return {
      members,
      roles: new Map(
        assignments.map((a) => [a.accountId, { role: a.role, memberUserId: a.memberUserId }]),
      ),
      accountIds: assignments.map((a) => a.accountId),
    };
  });
}

/**
 * One account's contribution to a scope: what it earns, what it owes, what moves
 * in and out of it, and what somebody has said actually moved.
 *
 * Loaded once per account per request, whichever scope asks for it.
 */
async function loadAccount(
  store: Store,
  ctx: PlanContext,
  account: Account,
  asOfDate: string,
): Promise<LoadedAccount> {
  return memo(ctx.loaded, `${account.id}@${asOfDate}`, async () => {
    const month = monthStart(asOfDate);
    const [inflows, outbound, payments, saved, derived] = await Promise.all([
      store.listInflows(account.id),
      store.listOutboundInflows(account.id),
      store.listPayments(account.id),
      savedByPayment(store, account.id),
      store.listDerivedTransferConfirmationsForAccount(account.id, month),
    ]);

    // Nothing can be confirmed as arriving at an account nothing moves into, so
    // an account with no account-sourced inflow — every account in the estate,
    // until the user authors one — does not pay for the question.
    const receives = inflows.some((i) => i.source === "account" && i.active !== false);
    const confirmedArrivals = receives ? await loadConfirmedArrivals(store, account.id, month) : [];

    return {
      account,
      senders: inflows
        .filter((i) => i.source === "account" && i.active !== false && i.sourceAccountId)
        .map((i) => i.sourceAccountId!),
      receivers: outbound.filter((i) => i.active !== false).map((i) => i.accountId),
      incomes: externalOf(inflows),
      inflows: inflows.map(toInflowInput),
      outboundInflows: outbound.map(toOutboundInflowInput),
      payments: payments.map((p) => ({
        ...toPaymentInput(p, saved),
        scope: p.scope,
        bearerUserId: p.bearerUserId,
      })),
      confirmedArrivals,
      derivedConfirmations: derived,
    };
  });
}

/**
 * How much of each **authored** movement into `accountId` has been confirmed as
 * actually moved this month, one entry per inflow.
 *
 * Only the arriving side counts. The store answers with every confirmation
 * touching the account, because a movement is one row read from both ends — but
 * confirming money *out* of here says nothing about what came *in*, and summing
 * both would credit an account for its own outgoings.
 *
 * A confirmation with no `inflowId` is not one of these: it confirms a transfer
 * the pass derived, which no row authors, and it travels as a
 * `ConfirmedTransfer` instead. That is the split WP-R's third store path exists
 * for — before it, a derived feed read as never-confirmed for ever.
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
 * Everything that has to be planned together with `seeds`.
 *
 * Three relations close the set, and they all run **in both directions**:
 *
 *  - **Household assignment.** An account assigned to a household is planned
 *    with the household's other accounts, because its bills are attributed to
 *    members whose budgets pay for other accounts' bills too.
 *  - **Common ownership.** A member's budget is their income across the accounts
 *    that are theirs, and their obligations are the bills on those accounts — so
 *    a holiday pot with a bill and no income of its own is planned beside the
 *    current account that will feed it, and the pass derives the feed (decision
 *    9) without anybody authoring a movement.
 *  - **Funding edges.** An account's money can be another account's surplus, so
 *    a sender has to be planned; and an account's surplus can be committed to a
 *    movement out, so a *receiver* has to be planned as well.
 *
 * The first two run **unconditionally**, on every account visited, and that is
 * load-bearing. They used to be alternatives — an account a household planned
 * took the roster, an account it did not took its owner's siblings *minus* any a
 * household planned — which made them mutually exclusive and left a household
 * member's private pot unable to reach their salary in either direction. Decision
 * 9's derived feed was reachable only for users with no household assignments at
 * all, which is every fixture and not the user who reported it: their bills pot
 * read `unfunded · £303.20` while the household's own pots were fed beside it.
 * Dropping the exclusion alone would not do — it would let the pot reach the
 * salary while the salary still never reached the pot, so the scope would depend
 * on which end you seeded. Running both closes ownership and assignment into one
 * equivalence relation, and every account of every member of one household lands
 * in one scope whatever you seed from.
 *
 * The consequence is deliberate and was accepted (Ben, 2026-08-04): a member's
 * private-account income joins the budget that pays their household share, so
 * `HouseholdMemberPlan.monthlyIncomeMinor` includes it and co-members can see it.
 * *"If you don't want them to see it, simply don't include it"* — the account, in
 * the household. There is no split field and no gate; the arithmetic and the
 * disclosure both stand.
 *
 * The old `fundingClosure` walked senders only, on the sound reasoning that
 * nothing downstream changes what an account can afford. That is still true of
 * the money — but it is no longer true of the *scope*, and the scope is what
 * fixes the answer: two endpoints that closed over different sets would attribute
 * a member's income differently and print two figures for one account, which is
 * the class of defect this package exists to end. Closing symmetrically makes the
 * scope a property of the account rather than of the question asked about it.
 *
 * Deliberately does not check the caller's access to the accounts it loads. An
 * account you can see may be fed by one you cannot, and the amount arriving is a
 * fact about *your* account. Only seeded accounts' plans are ever returned to a
 * caller; the rest stay inside the pass.
 */
async function closeScope(
  store: Store,
  seeds: readonly Account[],
  asOfDate: string,
  ctx: PlanContext,
): Promise<{ accounts: LoadedAccount[]; households: Map<string, LoadedHousehold> }> {
  const loaded = new Map<string, LoadedAccount>();
  const households = new Map<string, LoadedHousehold>();
  const queue: Account[] = [...seeds];

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (loaded.has(next.id)) continue;
    const entry = await loadAccount(store, ctx, next, asOfDate);
    loaded.set(next.id, entry);

    const neighbours = [...entry.senders, ...entry.receivers];
    const householdId = await householdPlanningAccount(store, ctx, next);
    if (householdId) {
      const household = await loadHousehold(store, ctx, householdId);
      households.set(householdId, household);
      neighbours.push(...household.accountIds);
    }
    const siblings = await memo(ctx.ownedAccounts, next.ownerUserId, () =>
      store.listAccountsForOwner(next.ownerUserId),
    );
    neighbours.push(...siblings.map((s) => s.id));
    for (const id of neighbours) {
      if (loaded.has(id)) continue;
      const neighbour = await getAccount(store, ctx, id);
      if (neighbour) queue.push(neighbour);
    }
  }

  // Sorted so the scope's key identifies it and the pass is reproducible: two
  // accounts of the same scope must not order the same set differently and
  // disagree about which edge of a loop was broken.
  return {
    accounts: [...loaded.values()].sort((a, b) => (a.account.id < b.account.id ? -1 : 1)),
    households,
  };
}

/**
 * The members whose money a scope is.
 *
 * A household contributes its roster with its contribution shares. An account
 * nobody has assigned to a household is its owner's, and the owner joins the
 * scope as a member — at a 100% share when no household applies at all (the solo
 * case: a household of one, planned by the same pass), and at **zero** when one
 * does, so that a sender pulled in from outside the household cannot take a slice
 * of its shared rent. Their own personal bills are still attributed to them,
 * which is what they were pulled in for.
 *
 * ## A scope is not a roster (decision 41)
 *
 * That outsider branch is why this set is **wider than any roster**: `closeScope`
 * walks funding edges, so one authored inflow from an outside account is enough
 * to put a stranger in a household's scope. Right for the arithmetic — their
 * money is genuinely in the picture — and wrong for their **name**, which no
 * household here has any licence to publish. So when a household applies, an
 * outsider joins with a share of zero and no `displayName` at all.
 *
 * Everything downstream reads this one set. `memberNames` is built from it and
 * is gated by the endpoints on **household visibility**, never on membership —
 * `/api/flow`'s ribbons, `planInflowSources` and `inflowSourcesFor` all read it
 * that way — and `input.members` carries the name on into `labels.users`,
 * `trace.members` and `ScopeMemberPlan.displayName`. Withholding it here is what
 * makes those five surfaces right at once instead of five times over.
 *
 * **No figure moves.** The pass is never told a name for any purpose but
 * carrying it back out (`scope.ts`'s two `displayName:` sites are both writes
 * into output), and the member row itself is untouched: `leftoverMinor` and
 * `membersLeftoverMinor` are sums over these rows and decision 13 fixes their
 * meaning to the penny, so dropping the row — rather than the name — would be a
 * different decision from this one.
 *
 * When no household applies there is nobody to withhold from: the scope's
 * members are the owners of its own accounts, at 100%, and the endpoints publish
 * only the caller's own name out of it. The solo case keeps its name.
 */
async function scopeMembers(
  store: Store,
  accounts: readonly LoadedAccount[],
  households: ReadonlyMap<string, LoadedHousehold>,
  householdOf: ReadonlyMap<string, string>,
): Promise<ScopeMemberInput[]> {
  const members = new Map<string, ScopeMemberInput>();
  for (const household of households.values()) {
    for (const m of household.members) {
      if (!members.has(m.userId)) members.set(m.userId, m);
    }
  }
  // One fact, read once, deciding both halves of what an outsider is: a share
  // they cannot spend and a name nobody may be told. Reading the share back as
  // the condition would tie the name to a number that is free to change.
  const householdApplies = households.size > 0;
  for (const entry of accounts) {
    if (householdOf.has(entry.account.id)) continue;
    const owner = entry.account.ownerUserId;
    if (members.has(owner)) continue;
    const user = householdApplies ? null : await store.getUserById(owner);
    members.set(owner, {
      userId: owner,
      ...(user?.displayName === undefined ? {} : { displayName: user.displayName }),
      shareBp: householdApplies ? 0 : 10_000,
    });
  }
  return [...members.values()];
}

/** Every derived transfer somebody has said they made this month, from both the
 *  household rows and the household-free ones 0010 made storable. */
function confirmedTransfers(
  accounts: readonly LoadedAccount[],
  householdRows: readonly TransferConfirmation[],
): ConfirmedTransfer[] {
  const byId = new Map<string, TransferConfirmation>();
  for (const row of [...householdRows, ...accounts.flatMap((a) => a.derivedConfirmations)]) {
    // A household row confirms a transfer the plan derived; an authored movement
    // has its own row and its own clamp (`confirmedArrivals`).
    if (row.inflowId) continue;
    byId.set(row.id, row);
  }
  return [...byId.values()]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c) => ({
      fromAccountId: c.fromAccountId,
      toAccountId: c.toAccountId,
      memberUserId: c.memberUserId,
      confirmedMinor: c.amountMinor,
    }));
}

/**
 * Plan the scope `seeds` belong to — one closure, one pass, one answer.
 *
 * Seeds spanning two unconnected scopes get one `PlannedScope` each: two sets of
 * accounts with no household and no funding edge between them share no money, so
 * planning them together would only pool members who have nothing to do with one
 * another. Every seed is in exactly one of the results.
 */
export async function scopesFor(
  store: Store,
  seeds: readonly Account[],
  asOfDate: string,
  ctx: PlanContext = createPlanContext(),
): Promise<PlannedScope[]> {
  const scopes: PlannedScope[] = [];
  const done = new Set<string>();
  for (const seed of seeds) {
    if (done.has(seed.id)) continue;
    const scope = await scopeForAccount(store, seed, asOfDate, ctx);
    for (const id of scope.accountIds) done.add(id);
    scopes.push(scope);
  }
  return scopes;
}

/** The planned scope one account belongs to. */
export async function scopeForAccount(
  store: Store,
  account: Account,
  asOfDate: string,
  ctx: PlanContext = createPlanContext(),
): Promise<PlannedScope> {
  const known = ctx.scopeOf.get(`${account.id}@${asOfDate}`);
  if (known) return ctx.scopes.get(known)!;
  return planScope(store, [account], asOfDate, ctx);
}

/**
 * The planned scope a household's accounts belong to.
 *
 * Seeded from the roster rather than from one account, so a household whose
 * accounts are in no funding relationship with each other still plans as one.
 * A household with nothing assigned to it plans an empty scope, which is the
 * honest answer rather than an error: it has no accounts to be wrong about.
 */
export async function scopeForHousehold(
  store: Store,
  householdId: string,
  asOfDate: string,
  ctx: PlanContext = createPlanContext(),
): Promise<{
  scope: PlannedScope;
  accountIds: string[];
  memberUserIds: string[];
  currency: string;
}> {
  const household = await loadHousehold(store, ctx, householdId);
  const accounts = (
    await Promise.all(household.accountIds.map((id) => getAccount(store, ctx, id)))
  ).filter((a): a is Account => a !== null);
  const scope = accounts[0]
    ? await scopeForAccount(store, accounts[0], asOfDate, ctx)
    : await planScope(store, [], asOfDate, ctx);
  return {
    scope,
    accountIds: accounts.map((a) => a.id),
    // The roster's **people**, beside the roster's accounts, and for the same
    // reason: `scope.input.members` is who the scope is about, which a funding
    // edge can widen to somebody this household has never heard of.
    memberUserIds: household.members.map((m) => m.userId),
    // A household is single-currency by assumption (see BACKLOG); the roster's
    // first account is what the plan is denominated in.
    currency: accounts[0]?.currency ?? "GBP",
  };
}

async function planScope(
  store: Store,
  seeds: readonly Account[],
  asOfDate: string,
  ctx: PlanContext,
): Promise<PlannedScope> {
  const { accounts, households } = await closeScope(store, seeds, asOfDate, ctx);
  const key = `${accounts.map((a) => a.account.id).join(",")}@${asOfDate}`;
  for (const entry of accounts) ctx.scopeOf.set(`${entry.account.id}@${asOfDate}`, key);

  return memo(ctx.scopes, key, async () => {
    const householdOf = new Map<string, string>();
    for (const [householdId, household] of households) {
      for (const id of household.accountIds) {
        if (!householdOf.has(id)) householdOf.set(id, householdId);
      }
    }

    const members = await scopeMembers(store, accounts, households, householdOf);
    const memberNames = new Map<string, string>();
    for (const m of members) if (m.displayName) memberNames.set(m.userId, m.displayName);

    const scopeAccounts: ScopeAccountInput[] = accounts.map((entry) => {
      const householdId = householdOf.get(entry.account.id);
      const assigned = householdId
        ? households.get(householdId)!.roles.get(entry.account.id)
        : null;
      return {
        accountId: entry.account.id,
        name: entry.account.name,
        // An account nobody assigned is its owner's, which is what makes a solo
        // user a household of one at a 100% share rather than a special case.
        role: assigned?.role ?? "personal",
        memberUserId: assigned ? assigned.memberUserId : entry.account.ownerUserId,
        // Whose account it is, which is a different question and always
        // answerable: `core.accounts.owner_user_id` is `NOT NULL`, so there is
        // never an orphan and never an excuse. The pass attributes external
        // income by it (decision 15), so a household's shared pot earning its
        // own lodger rent earns it for the person whose account it is rather
        // than for nobody.
        ownerUserId: entry.account.ownerUserId,
        currency: entry.account.currency,
        monthlyBufferMinor: entry.account.monthlyBufferMinor,
        incomes: entry.incomes,
        inflows: entry.inflows,
        outboundInflows: entry.outboundInflows,
        // **Cost-sharing is a household concept.** `Payment.scope` defaults to
        // "shared", which meant nothing at all while an unassigned account was
        // planned alone — and would now mean "split it across every member of
        // the scope", including somebody who merely happens to send money into
        // one of these accounts and never agreed to pay for anything. So an
        // account no household plans bears its own payments, whatever the column
        // says: there is no household for them to be shared within.
        payments: assigned
          ? entry.payments
          : entry.payments.map((p) => ({
              ...p,
              scope: "personal" as const,
              bearerUserId: p.bearerUserId ?? entry.account.ownerUserId,
            })),
        confirmedArrivals: entry.confirmedArrivals,
      };
    });

    const householdRows = (
      await Promise.all(
        [...households.keys()].map((id) =>
          store.listTransferConfirmations(id, monthStart(asOfDate)),
        ),
      )
    ).flat();

    const input: ScopeInput = {
      // The household's id when exactly one applies, so a view can say so; the
      // accounts otherwise, which is what the scope actually is.
      scopeId: households.size === 1 ? [...households.keys()][0]! : key,
      householdId: households.size === 1 ? [...households.keys()][0]! : null,
      members,
      accounts: scopeAccounts,
      confirmedTransfers: confirmedTransfers(accounts, householdRows),
    };

    return {
      input,
      plan: computeScopePlan(input, asOfDate),
      householdOf,
      memberNames,
      accountIds: scopeAccounts.map((a) => a.accountId),
    };
  });
}

/**
 * Compute an account's savings plan, as one view of the pass over the scope it
 * belongs to.
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
  const scope = await scopeForAccount(store, account, asOfDate, ctx);
  return accountPlanFromScope(scope.input, scope.plan, account.id);
}

/**
 * Who is being asked to move money into `account` this month, and how much of it
 * they have said they moved.
 *
 * Straight off the pass's derived transfers: nothing is re-derived and nothing
 * is attributed here. The clamp is the pass's own — a confirmation outlives the
 * plan that derived it, so a stale one credits only what this month's transfer
 * actually comes to.
 */
export function inflowSourcesFor(
  scope: PlannedScope,
  accountId: string,
  currency: string,
): InflowSource[] {
  const partition = scope.plan.partitions.find((p) => p.currency === currency);
  return (partition?.transfers ?? [])
    .filter((t) => t.toAccountId === accountId)
    .map((t) => ({
      memberUserId: t.memberUserId,
      displayName: scope.memberNames.get(t.memberUserId),
      fromAccountId: t.fromAccountId,
      amountMinor: t.amountMinor,
      confirmedMinor: t.confirmedMinor,
    }))
    .sort((a, b) => b.amountMinor - a.amountMinor || a.memberUserId.localeCompare(b.memberUserId));
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

/**
 * One plan per account the caller named, all read off however many scopes those
 * accounts span. The order is the caller's.
 */
export async function plansForAccounts(
  store: Store,
  accounts: readonly Account[],
  asOfDate: string,
  ctx: PlanContext = createPlanContext(),
): Promise<Map<string, AccountPlan>> {
  const scopes = await scopesFor(store, accounts, asOfDate, ctx);
  const byAccount = new Map<string, PlannedScope>();
  for (const scope of scopes) for (const id of scope.accountIds) byAccount.set(id, scope);
  const plans = new Map<string, AccountPlan>();
  for (const account of accounts) {
    const scope = byAccount.get(account.id)!;
    plans.set(account.id, accountPlanFromScope(scope.input, scope.plan, account.id));
  }
  return plans;
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
  ctx: PlanContext = createPlanContext(),
): Promise<UpcomingItem[]> {
  const accounts = await accessibleAccounts(store, userId);
  const scopes = await scopesFor(store, accounts, asOfDate, ctx);
  const paymentsFor = new Map<string, PaymentInput[]>();
  for (const scope of scopes) {
    for (const acc of scope.input.accounts) paymentsFor.set(acc.accountId, acc.payments);
  }

  const items: UpcomingItem[] = [];
  for (const account of accounts) {
    // Always present: every seeded account is in the scope it seeded.
    for (const row of upcomingPayments(paymentsFor.get(account.id)!, asOfDate, days)) {
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
    name: i.name,
    amountMinor: i.amountMinor,
    frequency: i.frequency,
    recurrence: i.recurrence ?? null,
    anchorDate: i.anchorDate,
    active: i.active,
  };
}

function toOverlayPayment(p: CreatePaymentBody, index: number): ScopePaymentInput {
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
    scope: p.scope,
    bearerUserId: p.bearerUserId ?? null,
  };
}

/**
 * "What would this do to my plan?" — the account's current plan alongside the
 * plan it would have with `overlay` added, both computed for the same as-of date
 * so the two are directly comparable.
 *
 * Strictly read-only: the overlay never reaches the store, and the store is only
 * queried for the account's real inflows, payments and contributions.
 *
 * Both sides are planned over the **whole scope**, which is what makes the
 * comparison mean anything now: a hypothetical bill on a shared pot is funded
 * from the members' budgets in one global priority order, so it can push a real
 * bill somewhere else off the end of the month, and the preview shows that. The
 * overlay reaching only this account would have shown a shortfall on the pot and
 * left the rest of the scope pretending nothing had happened.
 */
export async function previewPlanForAccount(
  store: Store,
  account: Account,
  asOfDate: string,
  overlay: PlanOverlay,
  ctx: PlanContext = createPlanContext(),
): Promise<PlanPreview> {
  const scope = await scopeForAccount(store, account, asOfDate, ctx);
  const withOverlay: ScopeInput = {
    ...scope.input,
    accounts: scope.input.accounts.map((a) =>
      a.accountId === account.id
        ? {
            ...a,
            incomes: [...a.incomes, ...(overlay.addIncomes ?? []).map(toOverlayIncome)],
            payments: [...a.payments, ...(overlay.addPayments ?? []).map(toOverlayPayment)],
          }
        : a,
    ),
  };
  return {
    base: accountPlanFromScope(scope.input, scope.plan, account.id),
    preview: accountPlanFromScope(withOverlay, computeScopePlan(withOverlay, asOfDate), account.id),
  };
}

// ---------------------------------------------------------------------------
// The household plan
// ---------------------------------------------------------------------------

/**
 * Somebody else's money, sitting in accounts one member owns.
 *
 * `personalLeftoverMinor` is the residuals of the accounts a member owns added
 * up, and a residual counts what **arrived** as much as what was earned — so a
 * co-member's authored movement into a pot you own is in your figure, genuinely
 * in your account and genuinely not your money (`scope.ts:1171–1179` states the
 * case and declines to net it, rightly: the total is unaffected either way,
 * because the pound is added to your figure and subtracted from theirs).
 *
 * Reporting the place is the whole of decision 19. Saying *whose* it is, is
 * decision 25, and this is what the sentence is made of.
 */
export interface ArrivedFromOwner {
  /** Whose account sent it. A household member, in every case the page can
   *  name; anybody else's id reads as "outside the household" and never as a
   *  name — an owner id is not one. */
  ownerUserId: string;
  amountMinor: number;
}

export interface HouseholdMemberPlanWithArrivals extends HouseholdMemberPlan {
  /**
   * Of this member's left over, what arrived from an account somebody else
   * owns, by that owner. Absent when none did, which is the ordinary case.
   *
   * Read straight off the pass's `inflowArrivals` — the itemisation of what
   * each authored movement delivered — and never recomputed from totals. The
   * arithmetic of the figure it annotates is untouched.
   */
  arrivedFromOthers?: ArrivedFromOwner[];
}

export interface HouseholdPlanWithSchedule extends HouseholdPlan {
  /** When each member should move their transfers, anchored to their paydays. */
  paydaySchedule: MemberPaydaySchedule[];
  members: HouseholdMemberPlanWithArrivals[];
}

/**
 * For each member, the money in their own accounts that came out of somebody
 * else's — grouped by the sender's owner, biggest first.
 *
 * Summed over exactly the set `leftoverForUser` sums, and for the same reason:
 * ownership, never access. An arrival whose sender the pass did not plan is
 * left out rather than guessed at — with no owner for the far end there is no
 * claim to make.
 */
function arrivalsFromOtherOwners(
  scope: PlannedScope,
  currency: string,
): Map<string, ArrivedFromOwner[]> {
  const partition = scope.plan.partitions.find((p) => p.currency === currency);
  const ownerOf = new Map((partition?.accounts ?? []).map((a) => [a.accountId, a.ownerUserId]));
  /** receiving owner → sending owner → amount. */
  const byReceiver = new Map<string, Map<string, number>>();

  for (const account of partition?.accounts ?? []) {
    for (const arrival of account.inflowArrivals) {
      const sender = ownerOf.get(arrival.fromAccountId);
      if (sender === undefined || sender === account.ownerUserId) continue;
      const senders = byReceiver.get(account.ownerUserId) ?? new Map<string, number>();
      senders.set(sender, (senders.get(sender) ?? 0) + arrival.amountMinor);
      byReceiver.set(account.ownerUserId, senders);
    }
  }

  return new Map(
    [...byReceiver].map(([receiver, senders]) => [
      receiver,
      [...senders]
        .map(([ownerUserId, amountMinor]) => ({ ownerUserId, amountMinor }))
        .sort(
          (a, b) => b.amountMinor - a.amountMinor || a.ownerUserId.localeCompare(b.ownerUserId),
        ),
    ]),
  );
}

/**
 * The household plan plus the payday schedule for its derived transfers. A
 * member's paydays come from the incomes on their personal accounts — the same
 * member→accounts mapping the pass uses (role "personal", matching
 * memberUserId) — read off the scope already planned rather than refetched.
 */
export async function computeHouseholdPlanWithSchedule(
  store: Store,
  householdId: string,
  asOfDate: string,
  ctx: PlanContext = createPlanContext(),
): Promise<HouseholdPlanWithSchedule> {
  const { scope, accountIds, memberUserIds, currency } = await scopeForHousehold(
    store,
    householdId,
    asOfDate,
    ctx,
  );
  const plan = householdPlanFromScope(scope.plan, householdId, accountIds, currency, memberUserIds);
  // Whose money is in whose accounts, annotated onto the rows that report it.
  // Nothing here changes a figure: `personalLeftoverMinor` is what it was, and
  // this only says what part of it arrived from somebody else (decision 25).
  const arrived = arrivalsFromOtherOwners(scope, currency);
  return {
    ...plan,
    members: plan.members.map((m) => {
      const from = arrived.get(m.userId);
      return from ? { ...m, arrivedFromOthers: from } : m;
    }),
    paydaySchedule: paydayScheduleFor(scope, plan.transfers, asOfDate),
  };
}

/**
 * When the scope's members should make the transfers it derived.
 *
 * Household or not: a solo user's derived feed into a bills pot is a transfer
 * with a member and a source account like any other, so the payday schedule
 * serves them for free — which it could not when the only producer of a transfer
 * was a household plan.
 */
export function paydayScheduleFor(
  scope: PlannedScope,
  transfers: Transfer[],
  asOfDate: string,
): MemberPaydaySchedule[] {
  const memberIncomes = scope.input.members.map((m) => ({
    memberUserId: m.userId,
    incomes: scope.input.accounts
      .filter((a) => a.role === "personal" && a.memberUserId === m.userId)
      .flatMap((a) => a.incomes),
  }));
  return splitTransfersByPayday(transfers, memberIncomes, asOfDate);
}
