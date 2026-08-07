import type { FlowAccountDto, FlowDto, FlowEdgeDto } from "./types.js";

/**
 * The diagram's model, and the one thing a browser does to it: hide accounts
 * from a picture the server drew.
 *
 * A scope is a **set of accounts**, and `GET /api/flow?accounts=…` answers for
 * any set off the one funding pass, movement by movement. A household is one
 * convenient preset over that set: its roster, asked of the same endpoint.
 *
 * ## Why there is no `householdFlow` here any more
 *
 * There used to be. A household page has already fetched a `HouseholdPlan`, and
 * reshaping the plan it holds looked cheaper than asking the server a question
 * it had already answered — so this module read one into a `FlowDto` itself.
 *
 * It could not do it. A household plan reports its accounts' authored movements
 * as **one anonymous bucket at each end** — `committedMinor` leaving,
 * `movementInMinor` arriving — because itemising them is the flow endpoint's
 * job, not the household view's. So the reshaping had no row to draw a ribbon
 * from, and sent both ends of every authored movement to `elsewhere`: a reader
 * looking at a household whose two accounts were both on the screen was told
 * the money went somewhere else, twice. Each half balanced its own node, and
 * the picture was still a lie (issue #43).
 *
 * The fix is not a better reshaping. Reading a plan's *records* back as the
 * *events* they record is the two-engine split `ONE-ENGINE.md` exists to end
 * (decision 31), so the derivation is gone and every caller asks `api.flow()`.
 * There is one derivation of money crossing an account boundary and it is on the
 * server: `computeScopePlan` funds expenses, derives the transfers that carry
 * them, and funds authored savings movements out of what is left. See
 * `packages/domain/src/scope.ts`.
 */

/**
 * What a node the caller may not see is called.
 *
 * A household's roster can hold an account assigned to it and shared with
 * nobody, and a member opening that household's picture is entitled to the
 * money in it and not to the name on it — so the endpoint sends the node with
 * its figures and without its `name`, and this is the word the diagram puts
 * there instead (decision 36). Anonymised, never dropped: an omitted node would
 * unbalance every total on the screen, which is the lie `elsewhere` exists to
 * avoid at the scope's edge.
 *
 * The absence is the server's; this only reads it. `PlanTable` prints "another
 * account" for a sender it may not name and `TransferChecklist` prints exactly
 * this phrase for a source off its page, both for the same reason.
 */
export const UNNAMED_ACCOUNT = "other account";

/** An account as the diagram labels it — its name, or `UNNAMED_ACCOUNT`. */
export function accountLabel(account: { name?: string }): string {
  return account.name ?? UNNAMED_ACCOUNT;
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
