import type { EstatePlan, EstateMovementStatus } from "./estate.js";
import type { ScopePlan } from "./scope.js";

/**
 * The money-flow picture, over **any set of accounts**.
 *
 * A diagram of where money goes is not a household feature. It was one only
 * because `HouseholdPlan.transfers` was the single derivation of "money crossing
 * an account boundary" that anything had, and a household was the only thing
 * that produced one. `computeEstatePlan` already derives the same fact for an
 * arbitrary set — `EstateMovement` is the household-free twin of `Transfer` — so
 * nothing here derives flows a second time. This is a **projection**: the pass's
 * answer, reshaped into the one thing a diagram needs.
 *
 * ## What a scope is
 *
 * A user-defined set of accounts. A household is one convenient preset over that
 * set, not the mechanism — see `apps/web/src/lib/flow.ts` for the household
 * projection, which reshapes a `HouseholdPlan` into this identical model so the
 * two open the same picture.
 *
 * ## Why it balances
 *
 * Every account's `leftoverMinor` here is a **residual**, not
 * `AccountPlan.leftoverMinor`:
 *
 *     leftover = income + arriving − spending − leaving
 *
 * The plan's own `leftoverMinor` is deliberately a different figure — the
 * account's *own* income after its *own* obligations, neither reduced by what it
 * sends on nor raised by inflow it never spent, so that summing it across an
 * estate does not double-count (see `AccountPlan.leftoverMinor`). That is the
 * right answer for a rollup and the wrong one for a Sankey, where a node whose
 * ribbons do not meet is a drawing that lies.
 *
 * Read off the one pass (`flowFromScope`) the residual is
 * `ScopeAccountPlan.leftoverMinor` verbatim, and it is **signed**: see that
 * field, and this module's note on the floor below.
 *
 * ## The scope has an edge, and money crosses it
 *
 * `null` at either end of a `FlowEdge` means "an account outside this scope".
 * Money arriving from outside — another of your accounts you did not include, or
 * a household member's transfer — is drawn arriving, and money leaving the scope
 * is drawn leaving. Silently dropping either would make the picture balance by
 * hiding the very thing the diagram exists to show.
 */

/** What became of one edge — `EstateMovement`'s status, unchanged. */
export type FlowEdgeStatus = EstateMovementStatus;

/** One account as the diagram draws it. */
export interface FlowAccount {
  accountId: string;
  name: string;
  /** Money entering from outside the estate — the account's own income, never
   *  what arrived from another account. */
  incomeMinor: number;
  /** Obligations funded out of this account this month. */
  spendingMinor: number;
  /** What stays put — see the module comment. A residual, so the node balances. */
  leftoverMinor: number;
  /** What the month could not cover. Not drawn as a ribbon; a node's colour. */
  shortfallMinor: number;
}

/** One movement of money, between two accounts or across the scope's edge. */
export interface FlowEdge {
  /** The sending account, or null when it is outside the scope. */
  fromAccountId: string | null;
  /** The receiving account, or null when it is outside the scope. */
  toAccountId: string | null;
  /** What actually moves. Zero for an edge that was planned and did not happen —
   *  kept, with its status, rather than dropped: a movement the pass ignored is
   *  a thing the user has to be told about, not a ribbon of width nothing. */
  amountMinor: number;
  /** What the row asked for, which is more than `amountMinor` when the sending
   *  account could not afford it. */
  requestedMinor: number;
  status: FlowEdgeStatus;
  /** The authored inflow, when this edge is one. Absent for a household
   *  transfer, which is derived from obligations rather than authored. */
  inflowId?: string;
  /** The member whose money moves, when this edge is a household transfer. */
  memberUserId?: string;
  /** That member's name, when the caller may be told it. */
  memberName?: string;
}

export interface Flow {
  asOfDate: string;
  currency: string;
  /** In the caller's scope order — an account set is a list the user made, and
   *  it must not start reordering itself by the shape of the funding graph. */
  accounts: FlowAccount[];
  edges: FlowEdge[];
  /**
   * Money entering the scope from outside it: every account's own income, plus
   * everything arriving across the scope's edge.
   *
   * This is the denominator "38.5%" is measured against. It is the only figure
   * that means the same thing for every scope — a scope spanning two households
   * and a standalone pot has no "total household income", and summing what each
   * account holds would count a pound again at every hop of a chain. Money in
   * comes only from outside; everything else is redistribution (see the invariant
   * in INFLOWS.md). For a single household it reduces to exactly
   * `HouseholdPlan.monthlyIncomeMinor`, so today's percentages are unchanged.
   */
  totalInflowMinor: number;
}

/** An account in the scope, as the caller names it. */
export interface FlowScopeAccount {
  accountId: string;
  name: string;
}

/**
 * One member's transfer into an account, as a household plan derived it.
 *
 * ## Superseded by `flowFromScope` (ONE-ENGINE.md, WP-Q)
 *
 * This type exists only because there were two derivations of "money crossing
 * an account boundary" and `flowFromEstate` had to merge them. There is now
 * one: `computeScopePlan` emits `DerivedTransfer` carrying the member, the
 * currency and the confirmed amount directly, so there is nothing to attribute
 * and nothing to clamp. Kept until WP-S deletes its last producer,
 * `householdAllocations` (`apps/api/src/plan.ts:517`).
 *
 * The two derivations of "money crossing an account boundary" are disjoint by
 * construction, so a scope containing both needs both. `computeEstatePlan`
 * settles movements the user *authored* between their own accounts; a household
 * plan settles what each *member* must move to cover their share, which no
 * authored row exists for and the estate pass therefore cannot see — it only
 * sees the total landing in the account (`AllocatedInflow.allocatedMinor`).
 * Handing that total's attribution in here draws it as the ribbons it is,
 * instead of money appearing out of thin air. It is still `HouseholdPlan
 * .transfers`; nothing re-derives it.
 */
export interface FlowAllocation {
  /** The account the money arrives in — one of the scope's. */
  toAccountId: string;
  /** The member's own account it leaves, in scope or not. */
  fromAccountId: string;
  memberUserId: string;
  /** Only when the caller may be told it. */
  memberName?: string;
  amountMinor: number;
}

/**
 * The ordered pass's answer as a flow over `scope`.
 *
 * `estate` is expected to cover at least the scope — it normally covers more,
 * because the pass reaches upstream to whatever funds the scope's accounts, and
 * that is the point: an arrival from an account the user did not include is
 * still money arriving, and it is drawn crossing the scope's edge.
 *
 * Nothing is derived here that `computeEstatePlan` or a household plan has not
 * already decided.
 *
 * ## Superseded by `flowFromScope` (ONE-ENGINE.md, WP-Q)
 *
 * Everything below the accounts loop is two-engine machinery: the `allocations`
 * parameter, the unattributed remainder it is clamped against, and the floor on
 * the residual that copes with an account promised to two plans at once. All
 * three dissolve when there is one plan. Kept, unchanged, only because its last
 * caller is `apps/api/src/server.ts:1230`, which WP-S rewrites.
 */
export function flowFromEstate(
  estate: EstatePlan,
  scope: readonly FlowScopeAccount[],
  currency: string,
  allocations: readonly FlowAllocation[] = [],
): Flow {
  const planById = new Map(estate.plans.map((p) => [p.accountId, p]));
  const inScope = new Set(scope.map((s) => s.accountId));

  const accounts: FlowAccount[] = [];
  const edges: FlowEdge[] = [];

  for (const entry of scope) {
    const plan = planById.get(entry.accountId);
    // An account the pass did not plan cannot be drawn. It should not happen —
    // every scoped account is seeded into the pass — but a node made of guesses
    // would be worse than a node that is absent.
    if (!plan) continue;
    accounts.push({
      accountId: entry.accountId,
      name: entry.name,
      incomeMinor: plan.monthlyIncomeMinor,
      spendingMinor: plan.totalFundedMinor,
      // Filled in once every edge is known — see below.
      leftoverMinor: 0,
      shortfallMinor: plan.shortfallMinor,
    });
  }

  for (const movement of estate.movements) {
    const from = inScope.has(movement.fromAccountId);
    const to = inScope.has(movement.toAccountId);
    // Two accounts the scope does not contain move money that is none of this
    // diagram's business, however visible they are to the pass.
    if (!from && !to) continue;
    edges.push({
      fromAccountId: from ? movement.fromAccountId : null,
      toAccountId: to ? movement.toAccountId : null,
      amountMinor: movement.fundedMinor,
      requestedMinor: movement.requestedMinor,
      status: movement.status,
      inflowId: movement.inflowId,
    });
  }

  // Money a household allocated into a scoped account: whatever is arriving that
  // no authored movement itemises. `allocations` say who is sending it, when the
  // caller could find out; without them it simply crosses the scope's edge from
  // an unnamed source, which is what an arrival nobody can attribute is.
  const allocationsFor = new Map<string, FlowAllocation[]>();
  for (const allocation of allocations) {
    const list = allocationsFor.get(allocation.toAccountId) ?? [];
    list.push(allocation);
    allocationsFor.set(allocation.toAccountId, list);
  }

  for (const entry of accounts) {
    const plan = planById.get(entry.accountId)!;
    const itemised = plan.inflowArrivals.reduce((sum, a) => sum + a.amountMinor, 0);
    let unattributed = Math.max(0, plan.allocatedInflowMinor - itemised);
    for (const allocation of allocationsFor.get(entry.accountId) ?? []) {
      if (unattributed <= 0) break;
      // Clamped to what is actually arriving. An attribution is derived from a
      // plan of its own and can outrun the arrival it explains; drawing more
      // than arrived would put money into the account that is not there.
      const amountMinor = Math.min(allocation.amountMinor, unattributed);
      unattributed -= amountMinor;
      edges.push({
        fromAccountId: inScope.has(allocation.fromAccountId) ? allocation.fromAccountId : null,
        toAccountId: entry.accountId,
        amountMinor,
        requestedMinor: allocation.amountMinor,
        status: "funded",
        memberUserId: allocation.memberUserId,
        ...(allocation.memberName !== undefined ? { memberName: allocation.memberName } : {}),
      });
    }
    if (unattributed <= 0) continue;
    edges.push({
      fromAccountId: null,
      toAccountId: entry.accountId,
      amountMinor: unattributed,
      requestedMinor: unattributed,
      status: "funded",
    });
  }

  // Recomputed once every edge is known, because a household transfer *out* of
  // a scoped account is money the pass never subtracted: the estate plan does
  // not know its owner has agreed to fund somebody's rent. An account promised
  // to two plans at once can therefore be over-committed, and floors here at
  // nothing left over — at which point its ribbons stop meeting, which is the
  // honest picture of the same pound being spoken for twice.
  const withResiduals = accounts.map((entry) => ({
    ...entry,
    leftoverMinor: Math.max(
      0,
      entry.incomeMinor +
        edges.reduce((sum, e) => sum + (e.toAccountId === entry.accountId ? e.amountMinor : 0), 0) -
        entry.spendingMinor -
        edges.reduce(
          (sum, e) => sum + (e.fromAccountId === entry.accountId ? e.amountMinor : 0),
          0,
        ),
    ),
  }));

  return {
    asOfDate: estate.asOfDate,
    currency,
    accounts: withResiduals,
    edges,
    totalInflowMinor: totalInflow(withResiduals, edges),
  };
}

/**
 * The one pass's answer as a flow over `scope`.
 *
 * One derivation, so nothing is merged, attributed or clamped. A
 * `DerivedTransfer` is expense transport the pass worked out (decision 9) and
 * carries the member whose money it is; a `ScopeMovement` is a savings movement
 * the user authored and carries the row's id. They are drawn in that order,
 * which is the order the pass funded them in: every expense, then everything
 * left over.
 *
 * `plan` normally covers more than `scope` — planning one account can mean
 * planning its household and its senders — and that is the point: an arrival
 * from an account the user did not include in the picture is still money
 * arriving, and it is drawn crossing the scope's edge with a `null` end.
 *
 * `memberNames` supplies display names for the members whose transfers are
 * drawn, and only for those the caller may be told about: **names are gated,
 * amounts are not**, which is the rule the API applies everywhere. Omit it and
 * the ribbons are unnamed, which is what an arrival nobody may attribute is.
 *
 * ## No floor, on purpose
 *
 * `flowFromEstate` floors each node's residual at zero, because an account
 * promised to two plans at once could be committed to sending more than it has.
 * There is one plan now, and `ScopeAccountPlan.leftoverMinor` is already the
 * signed residual `income + arriving − spending − leaving` — so for an account
 * of a scope the ribbons meet exactly, by construction, and the floor could only
 * ever fire on a figure that is *meaningful*: a negative residual means a member
 * holds income in a personal account other than the one their transfers leave
 * (decision 11) and must consolidate before the month works. Flooring hides the
 * one thing the user has to do. The tests assert the balance directly instead.
 */
export function flowFromScope(
  plan: ScopePlan,
  scope: readonly FlowScopeAccount[],
  currency: string,
  memberNames?: ReadonlyMap<string, string>,
): Flow {
  const partition = plan.partitions.find((p) => p.currency === currency);
  const planById = new Map((partition?.accounts ?? []).map((a) => [a.accountId, a]));
  const inScope = new Set(scope.map((s) => s.accountId));

  const accounts: FlowAccount[] = [];
  for (const entry of scope) {
    const account = planById.get(entry.accountId);
    // An account the pass did not plan cannot be drawn — a node made of guesses
    // would be worse than a node that is absent.
    if (!account) continue;
    accounts.push({
      accountId: entry.accountId,
      name: entry.name,
      incomeMinor: account.monthlyIncomeMinor,
      spendingMinor: account.fundedOutflowMinor,
      leftoverMinor: account.leftoverMinor,
      shortfallMinor: account.shortfallMinor,
    });
  }

  const edges: FlowEdge[] = [];
  const touches = (from: string, to: string): boolean => inScope.has(from) || inScope.has(to);

  for (const transfer of partition?.transfers ?? []) {
    // Two accounts the scope does not contain move money that is none of this
    // diagram's business, however visible it is to the pass.
    if (!touches(transfer.fromAccountId, transfer.toAccountId)) continue;
    const name = memberNames?.get(transfer.memberUserId);
    edges.push({
      fromAccountId: inScope.has(transfer.fromAccountId) ? transfer.fromAccountId : null,
      toAccountId: inScope.has(transfer.toAccountId) ? transfer.toAccountId : null,
      amountMinor: transfer.amountMinor,
      // A derived transfer is only ever derived at what it is needed for, so
      // what it asks for and what it moves are the same figure by construction.
      requestedMinor: transfer.amountMinor,
      status: "funded",
      memberUserId: transfer.memberUserId,
      ...(name !== undefined ? { memberName: name } : {}),
    });
  }

  for (const movement of partition?.movements ?? []) {
    if (!touches(movement.fromAccountId, movement.toAccountId)) continue;
    edges.push({
      fromAccountId: inScope.has(movement.fromAccountId) ? movement.fromAccountId : null,
      toAccountId: inScope.has(movement.toAccountId) ? movement.toAccountId : null,
      amountMinor: movement.fundedMinor,
      requestedMinor: movement.requestedMinor,
      status: movement.status,
      inflowId: movement.inflowId,
    });
  }

  return {
    asOfDate: plan.asOfDate,
    currency,
    accounts,
    edges,
    totalInflowMinor: totalInflow(accounts, edges),
  };
}

/** Money entering the scope from outside it — see `Flow.totalInflowMinor`. */
export function totalInflow(accounts: readonly FlowAccount[], edges: readonly FlowEdge[]): number {
  return (
    accounts.reduce((sum, a) => sum + a.incomeMinor, 0) +
    edges.reduce((sum, e) => sum + (e.fromAccountId === null ? e.amountMinor : 0), 0)
  );
}
