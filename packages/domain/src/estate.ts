import type { OutboundInflowInput } from "./types.js";

/**
 * The funding graph, and the order money has to be planned in.
 *
 * No account is closed: an account's funding can be another account's surplus,
 * so accounts cannot be planned independently — they have to be planned in
 * dependency order, senders before receivers, in a single pass. This module owns
 * the graph and that order; `computeScopePlan`'s savings phase is what walks it.
 * The pass that used to live here, `computeEstatePlan`, planned the accounts one
 * person owns from a total another engine worked out, and was deleted with the
 * split it belonged to (ONE-ENGINE.md, WP-S).
 *
 * ## Cycles
 *
 * A → B → C → A is a user error, and it is detected **here, at compute time**,
 * not refused at authoring time. Three reasons:
 *
 *  1. A cycle is a property of the *estate*, not of the record that completes
 *     it. Whichever inflow is saved last takes the blame, which is arbitrary,
 *     and the user is told to fix the one edge they happened to type rather than
 *     shown the loop.
 *  2. Authoring-time refusal cannot be the guarantee even if it is also offered.
 *     Rows arrive by import and by restore, and an account can be deleted and
 *     re-created underneath a graph that was legal when it was written. The plan
 *     must never hang, so the thing that must never hang is where the guarantee
 *     has to live.
 *  3. Refusing to compute would take a user's whole plan away over one bad edge.
 *
 * So the pass **breaks** each loop at exactly one edge, plans everything, and
 * reports the loop: `ScopeCurrencyPlan.cycles` names the accounts in travel
 * order and the inflows on the loop, and every plan of an account on a loop
 * carries `fundingCycleAccountIds` so a caller holding one plan can still say
 * which accounts are involved. The broken edge shows up in `movements` with status
 * `"broken_cycle"` and funds nothing — pretending it moved money would be a
 * silent truncation, which is the other thing that must not happen.
 *
 * Traversal is iterative throughout: a deep chain is a long estate, not a stack
 * overflow.
 */

/** What became of one movement between two accounts. */
export type EstateMovementStatus =
  | "funded"
  | "short"
  | "unfunded"
  /** Ignored to break a funding loop — see the module comment. */
  | "broken_cycle"
  /** The sending account is not part of this pass, so what it can afford to
   *  send is unknown and nothing is credited to the receiver. */
  | "unknown_source";

/** A funding loop, in the order money would travel round it. */
export interface EstateCycle {
  /** `["a", "b", "c"]` means a funds b funds c funds a. Never empty. */
  accountIds: string[];
  /** Every inflow on the loop, in the same order. */
  inflowIds: string[];
  /** The one the pass ignored to break the loop: the edge back to
   *  `accountIds[0]`, and the last entry of `inflowIds`. */
  brokenInflowId: string;
}

const DEFAULT_PRIORITY = 100;

/** An edge of the funding graph: money leaves `from` and arrives at `to`. */
export interface FundingEdge {
  inflowId: string;
  from: string;
  to: string;
  priority: number;
  row: OutboundInflowInput;
}

/** The least an account has to be for its movements to be graphed: an id and the
 *  movements leaving it. `AccountInput` satisfies it, and so does the scope
 *  pass's account — one graph builder, not two. */
export interface FundingNode {
  accountId: string;
  outboundInflows?: OutboundInflowInput[];
}

/**
 * The graph, from the **leaving** face of each account's inflows.
 *
 * The sending side is authoritative because it is the side that has to afford
 * the movement. The arriving side is read too, but only to notice a movement
 * whose sender is not in this pass at all — that is worth reporting, and
 * inferring it from the receiver is the only way to see it.
 */
export function buildFundingEdges(accounts: readonly FundingNode[]): FundingEdge[] {
  const edges: FundingEdge[] = [];
  for (const account of accounts) {
    for (const row of account.outboundInflows ?? []) {
      if (row.active === false) continue;
      edges.push({
        inflowId: row.id,
        from: account.accountId,
        to: row.toAccountId,
        priority: row.priority ?? DEFAULT_PRIORITY,
        row,
      });
    }
  }
  return edges.sort(
    (a, b) =>
      (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
      a.priority - b.priority ||
      (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) ||
      (a.inflowId < b.inflowId ? -1 : a.inflowId > b.inflowId ? 1 : 0),
  );
}

const WHITE = 0;
const GREY = 1;
const BLACK = 2;

interface Frame {
  accountId: string;
  /** Index of the next out-edge to walk. */
  next: number;
  /** The edge that led here, so a loop can name its inflows. */
  viaInflowId: string | null;
}

/**
 * Depth-first order over the funding graph, breaking every loop it finds.
 *
 * Explicitly iterative: an estate is a chain as deep as the user cares to make
 * it, and "detected, not stack-overflowed" is the whole promise. Reverse
 * postorder of a DFS is a topological order, and a grey target is a back edge —
 * so one traversal gives the planning order, the loops, and the edges to drop.
 *
 * Deterministic: roots are visited in the caller's account order and out-edges
 * in (priority, destination, id) order, so the same estate always breaks the
 * same edge and reports the same loop.
 */
export function orderAccounts(
  accountIds: readonly string[],
  edges: readonly FundingEdge[],
): { order: string[]; cycles: EstateCycle[]; broken: Set<string> } {
  const out = new Map<string, FundingEdge[]>(accountIds.map((id) => [id, []]));
  for (const edge of edges) {
    // An edge out of the estate does not order anything inside it.
    if (out.has(edge.to)) out.get(edge.from)?.push(edge);
  }

  const colour = new Map<string, number>(accountIds.map((id) => [id, WHITE]));
  const postorder: string[] = [];
  const cycles: EstateCycle[] = [];
  const broken = new Set<string>();

  for (const root of accountIds) {
    if (colour.get(root) !== WHITE) continue;
    colour.set(root, GREY);
    const stack: Frame[] = [{ accountId: root, next: 0, viaInflowId: null }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const outEdges = out.get(frame.accountId)!;
      if (frame.next >= outEdges.length) {
        colour.set(frame.accountId, BLACK);
        postorder.push(frame.accountId);
        stack.pop();
        continue;
      }
      const edge = outEdges[frame.next++]!;
      const target = colour.get(edge.to);
      if (target === BLACK) continue; // already planned; nothing to order
      if (target === GREY) {
        // A back edge: `edge.to` is somewhere below us on the current path, so
        // following it would go round for ever. Name the loop and drop it.
        const start = stack.findIndex((f) => f.accountId === edge.to);
        const loop = stack.slice(start);
        cycles.push({
          accountIds: loop.map((f) => f.accountId),
          inflowIds: [...loop.slice(1).map((f) => f.viaInflowId!), edge.inflowId],
          brokenInflowId: edge.inflowId,
        });
        broken.add(edge.inflowId);
        continue;
      }
      colour.set(edge.to, GREY);
      stack.push({ accountId: edge.to, next: 0, viaInflowId: edge.inflowId });
    }
  }

  return { order: postorder.reverse(), cycles, broken };
}
