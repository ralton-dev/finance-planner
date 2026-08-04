import type { FlowAccountDto, FlowDto, FlowEdgeDto, HouseholdPlanDto } from "./types.js";

/**
 * The diagram's model, and the two things a browser does to it: read a
 * household plan as one, and hide accounts from one.
 *
 * A scope is a **set of accounts**. `GET /api/flow?accounts=…` answers for any
 * set, off the ordered pass over the estate. A household is one convenient
 * preset over that set — and the household plan a household page has already
 * fetched *is* the flow, in a shape of its own, so `householdFlow` reshapes it
 * here rather than asking the server the same question twice.
 *
 * Both projections, and only these two, because there are exactly two
 * derivations of money crossing an account boundary and neither is written
 * here: `EstatePlan.movements` for movements the user authored, and
 * `HouseholdPlan.transfers` for what each member must move. See
 * `packages/domain/src/flow.ts`.
 */

/**
 * A household plan as a flow.
 *
 * Every figure is the household plan's own, which is what makes a household
 * preset draw *exactly* today's diagram: `HouseholdAccountPlan.leftoverMinor` is
 * already the residual `income + in − out − spending`, so the nodes balance for
 * the same reason the estate's do.
 *
 * The estate pass could plan the same accounts, and deliberately is not asked
 * to: inside a household the money is attributed to *people*, and only this plan
 * knows which member moves what. That attribution is the whole point of the
 * household view, and it is not recoverable from account plans.
 */
export function householdFlow(plan: HouseholdPlanDto): FlowDto {
  const memberName = new Map(plan.members.map((m) => [m.userId, m.displayName]));
  return {
    asOfDate: plan.asOfDate,
    currency: plan.currency,
    accounts: plan.accounts.map((a) => ({
      accountId: a.accountId,
      name: a.name ?? "account",
      incomeMinor: a.monthlyIncomeMinor,
      spendingMinor: a.fundedOutflowMinor,
      leftoverMinor: a.leftoverMinor,
      shortfallMinor: a.shortfallMinor,
    })),
    edges: plan.transfers.map((t) => ({
      fromAccountId: t.fromAccountId,
      toAccountId: t.toAccountId,
      amountMinor: t.amountMinor,
      requestedMinor: t.amountMinor,
      // A derived transfer is a funded obligation by construction — the
      // household engine drops the ones nobody can pay for.
      status: "funded" as const,
      memberUserId: t.memberUserId,
      ...(memberName.get(t.memberUserId) !== undefined
        ? { memberName: memberName.get(t.memberUserId)! }
        : {}),
    })),
    // Total household income, which is what money entering from outside means
    // here: every transfer is between two of the household's own accounts.
    totalInflowMinor: plan.monthlyIncomeMinor,
  };
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
