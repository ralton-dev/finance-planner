import type {
  FlowAccountDto,
  FlowDto,
  FlowEdgeDto,
  HouseholdAccountPlanDto,
  HouseholdPlanDto,
} from "./types.js";

/**
 * The diagram's model, and the two things a browser does to it: read a
 * household plan as one, and hide accounts from one.
 *
 * A scope is a **set of accounts**. `GET /api/flow?accounts=…` answers for any
 * set, off the one funding pass. A household is one convenient preset over that
 * set — and the household plan a household page has already fetched *is* the
 * flow, in a shape of its own, so `householdFlow` reshapes it here rather than
 * asking the server the same question twice.
 *
 * There is one derivation of money crossing an account boundary now, and it is
 * not written here: `computeScopePlan` funds expenses, derives the transfers
 * that carry them, and funds authored savings movements out of what is left.
 * `HouseholdPlan` reports the first as `transfers` and the second as a
 * per-account `committedMinor` bucket (decision 13). See
 * `packages/domain/src/scope.ts`.
 */

/**
 * A household plan as a flow.
 *
 * ## Why the picture changed
 *
 * `HouseholdAccountPlan.leftoverMinor` used to be drawn straight as "stays put",
 * and for as long as a household plan had never heard of a movement leaving one
 * of its accounts that was right. It is now the residual **before** the savings
 * leaving — the field keeps its meaning to the penny (decision 13) — so drawing
 * it unchanged would over-draw every sending node by its `committedMinor` and
 * put the household page back to disagreeing with the account page by exactly
 * one movement, which is the defect ONE-ENGINE.md exists to end. What stays put
 * is `leftoverMinor − committedMinor`, and the committed money gets a ribbon.
 *
 * ## The two ribbons a household plan cannot itemise
 *
 * A household shows its accounts' movements as **one committed bucket, not
 * itemised** — that is the household view's job, and the flow page's job is the
 * itemisation (`GET /api/flow`, which draws movement by movement). So the money
 * committed to savings leaves for `elsewhere`, and the money authored movements
 * delivered arrives from `elsewhere`, both with no far end named. When the far
 * end happens to be another household account the picture says so twice rather
 * than drawing a direct ribbon it has no row for; both halves are true and the
 * node balances, which is the property that matters.
 *
 * `arrivingMinor` is the household plan's own published identity rearranged,
 * not a second derivation:
 *
 *     leftoverMinor = income + transferIn + arriving − spending − transferOut
 *
 * — see `ScopeAccountPlan.leftoverMinor`, of which `HouseholdAccountPlan`'s is
 * that figure plus `committedMinor`. Reporting it directly would be better and
 * the DTO does not; see the note routed with this package.
 */
export function householdFlow(plan: HouseholdPlanDto): FlowDto {
  const memberName = new Map(plan.members.map((m) => [m.userId, m.displayName]));
  const edges: FlowEdgeDto[] = plan.transfers.map((t) => ({
    fromAccountId: t.fromAccountId,
    toAccountId: t.toAccountId,
    amountMinor: t.amountMinor,
    requestedMinor: t.amountMinor,
    // A derived transfer is a funded obligation by construction — the pass
    // drops the ones nobody can pay for.
    status: "funded" as const,
    memberUserId: t.memberUserId,
    ...(memberName.get(t.memberUserId) !== undefined
      ? { memberName: memberName.get(t.memberUserId)! }
      : {}),
  }));

  for (const a of plan.accounts) {
    const committed = a.committedMinor ?? 0;
    if (committed > 0) {
      edges.push({
        fromAccountId: a.accountId,
        toAccountId: null,
        amountMinor: committed,
        requestedMinor: committed,
        status: "funded",
      });
    }
    const arriving = arrivingMinor(a);
    if (arriving > 0) {
      edges.push({
        fromAccountId: null,
        toAccountId: a.accountId,
        amountMinor: arriving,
        requestedMinor: arriving,
        status: "funded",
      });
    }
  }

  return {
    asOfDate: plan.asOfDate,
    currency: plan.currency,
    accounts: plan.accounts.map((a) => ({
      accountId: a.accountId,
      name: a.name ?? "account",
      incomeMinor: a.monthlyIncomeMinor,
      spendingMinor: a.fundedOutflowMinor,
      // Free after committed: the figure the account page prints as its
      // residual and the flow endpoint draws for the same account.
      leftoverMinor: a.leftoverMinor - (a.committedMinor ?? 0),
      shortfallMinor: a.shortfallMinor,
    })),
    edges,
    // Total household income, which is what money entering from outside means
    // here: every derived transfer is between two of its own accounts, and an
    // authored movement arriving is somebody's surplus, not new money.
    totalInflowMinor: plan.monthlyIncomeMinor,
  };
}

/** What authored movements delivered into one household account, recovered from
 *  the plan's own identity — see `householdFlow`. */
export function arrivingMinor(a: HouseholdAccountPlanDto): number {
  return (
    a.leftoverMinor +
    a.fundedOutflowMinor +
    a.transferOutMinor -
    a.monthlyIncomeMinor -
    a.transferInMinor
  );
}

/** Money entering from outside — own income, plus everything crossing the edge
 *  of what is drawn. The share denominator; see `visibleFlow`. */
export function totalInflowMinor(
  accounts: readonly FlowAccountDto[],
  edges: readonly FlowEdgeDto[],
): number {
  return (
    accounts.reduce((sum, a) => sum + a.incomeMinor, 0) +
    edges.reduce((sum, e) => sum + (e.fromAccountId === null ? e.amountMinor : 0), 0)
  );
}

/**
 * The same flow with some accounts left out of the picture.
 *
 * **Presentation, and nothing but.** Every account still in the diagram keeps
 * the figures it arrived with, to the penny — this returns the very same
 * objects. Hiding an account is not narrowing the scope: the scope is what the
 * server planned, and dropping an account from *that* would take its money out
 * of everyone else's plan, which is the bug this rule exists to prevent. So a
 * hidden account's money keeps arriving; it simply arrives from off-picture,
 * exactly as an account outside the scope's does, and the nodes still balance.
 *
 * The share denominator is recomputed over what is left, so a percentage always
 * reads as a share of the money entering *the picture you are looking at*
 * rather than of a total half of which is not on screen.
 */
export function visibleFlow(flow: FlowDto, hidden: ReadonlySet<string>): FlowDto {
  if (hidden.size === 0) return flow;
  const accounts = flow.accounts.filter((a) => !hidden.has(a.accountId));
  const shown = new Set(accounts.map((a) => a.accountId));
  const inPicture = (id: string | null): boolean => id !== null && shown.has(id);

  const edges = flow.edges
    // An edge with neither end in the picture has nothing to say about it.
    .filter((e) => inPicture(e.fromAccountId) || inPicture(e.toAccountId))
    .map((e) => ({
      ...e,
      fromAccountId: inPicture(e.fromAccountId) ? e.fromAccountId : null,
      toAccountId: inPicture(e.toAccountId) ? e.toAccountId : null,
    }));

  return { ...flow, accounts, edges, totalInflowMinor: totalInflowMinor(accounts, edges) };
}

/** A scope as it travels in the URL: the account ids in the order the user
 *  chose them, de-duplicated, and nothing else. */
export function parseAccountIds(value: string | null): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
