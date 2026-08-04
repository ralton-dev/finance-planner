import { parseISODate } from "./dates.js";
import { computeAccountPlan, monthlyIncomeMinor } from "./engine.js";
import type { AccountInput, AccountPlan, InflowArrival, OutboundInflowInput } from "./types.js";

/**
 * The estate graph: one ordered pass over the accounts a person owns.
 *
 * `computeAccountPlan` treats an account as closed. That is a view, not the
 * calculation — no account is closed. An account's funding can be another
 * account's surplus, so the accounts cannot be planned independently: they have
 * to be planned in dependency order, senders before receivers, in a single pass.
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
 * reports the loop: `EstatePlan.cycles` names the accounts in travel order and
 * the inflows on the loop, and every plan of an account on a loop carries
 * `fundingCycleAccountIds` so a caller holding one plan can still say which
 * accounts are involved. The broken edge shows up in `movements` with status
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

/** One account-sourced inflow, as the pass resolved it. */
export interface EstateMovement {
  /** The authored inflow's id — one row, read from both ends. */
  inflowId: string;
  fromAccountId: string;
  toAccountId: string;
  priority: number;
  /** The movement's monthly amount as authored. */
  requestedMinor: number;
  /** What the sending account could actually afford, after its own bills. */
  fundedMinor: number;
  status: EstateMovementStatus;
}

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

export interface EstatePlan {
  asOfDate: string;
  /** The order the accounts were planned in — a topological order of the
   *  funding graph, with any loops already broken. */
  order: string[];
  /**
   * The inputs actually planned from, in `order`: the caller's inputs with the
   * arriving money merged in and the broken edges removed. Exposed so a caller
   * that needs an `AccountInput` (a projection, a what-if overlay) can take the
   * one the pass used rather than rebuild it and risk drifting from it.
   */
  inputs: AccountInput[];
  /** One plan per input, in `order`. */
  plans: AccountPlan[];
  /** Every account-sourced movement the pass knows of, sorted by sender then
   *  receiver then inflow id. */
  movements: EstateMovement[];
  /** Empty in the overwhelmingly normal case. */
  cycles: EstateCycle[];
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

/**
 * Plan every account in one dependency-ordered pass, moving money between them
 * as the inflows say.
 *
 * Each account is planned once, after every account that funds it. What arrives
 * is what the senders could actually afford — an authored movement of £300 out
 * of an account with £120 left after its bills moves £120, and says so. Money
 * therefore cannot be spent twice anywhere in a chain, however deep.
 *
 * A single standalone account is planned exactly as `computeAccountPlan` would
 * plan it alone: no edges, no arrivals, nothing merged.
 *
 * `accounts` is taken in the caller's order, which fixes the tie-breaks; it is
 * not mutated, and neither are its inputs.
 */
export function computeEstatePlan(accounts: AccountInput[], asOfDate: string): EstatePlan {
  const now = parseISODate(asOfDate);
  const byId = new Map(accounts.map((a) => [a.accountId, a]));
  const edges = buildFundingEdges(accounts);
  const { order, cycles, broken } = orderAccounts([...byId.keys()], edges);

  const cycleFor = new Map<string, string[]>();
  const brokenFor = new Map<string, string>();
  for (const cycle of cycles) {
    for (const accountId of cycle.accountIds) {
      if (!cycleFor.has(accountId)) cycleFor.set(accountId, cycle.accountIds);
      if (!brokenFor.has(accountId)) brokenFor.set(accountId, cycle.brokenInflowId);
    }
  }

  const outByAccount = new Map<string, FundingEdge[]>();
  for (const edge of edges) {
    const list = outByAccount.get(edge.from) ?? [];
    list.push(edge);
    outByAccount.set(edge.from, list);
  }

  const arriving = new Map<string, InflowArrival[]>();
  const movements: EstateMovement[] = [];
  const inputs: AccountInput[] = [];
  const plans: AccountPlan[] = [];

  for (const accountId of order) {
    const account = byId.get(accountId)!;
    // Sorted rather than left in the order the senders happened to be planned:
    // which of two independent senders a depth-first walk reaches first is an
    // accident of the graph, and a plan that reorders its own arrivals for no
    // visible reason is a plan nobody can diff.
    const confirmedByInflow = new Map(
      (account.confirmedArrivals ?? []).map((c) => [c.inflowId, Math.max(0, c.confirmedMinor)]),
    );
    const sources = (arriving.get(accountId) ?? [])
      // Clamped to what this movement actually delivered. A confirmation
      // deliberately outlives the plan that derived it, so one taken in a month
      // the sender could spare £300 must not still credit £300 in a month it can
      // only spare £120 — the same rule the household path applies per member,
      // applied here per inflow.
      .map((a) => ({
        ...a,
        confirmedMinor: Math.min(a.amountMinor, confirmedByInflow.get(a.inflowId) ?? 0),
      }))
      .sort(
        (a, b) =>
          (a.fromAccountId < b.fromAccountId ? -1 : a.fromAccountId > b.fromAccountId ? 1 : 0) ||
          (a.inflowId < b.inflowId ? -1 : a.inflowId > b.inflowId ? 1 : 0),
      );
    const internal = sources.reduce((sum, s) => sum + s.amountMinor, 0);
    const internalConfirmed = sources.reduce((sum, s) => sum + s.confirmedMinor, 0);
    const household = account.inflow ?? null;
    const allocated = Math.max(0, household?.allocatedMinor ?? 0) + internal;

    // A movement the pass has decided to ignore must not eat the sender's money
    // on its way past: it is not happening, so it costs nothing. Everything
    // else stays, including movements to accounts outside this pass — that
    // money really does leave, and it has to keep its place in the queue or the
    // movements behind it would be funded with money already spoken for.
    const outbound = (outByAccount.get(accountId) ?? [])
      .filter((e) => !broken.has(e.inflowId))
      .map((e) => e.row);

    const input: AccountInput = {
      ...account,
      inflow:
        allocated > 0 || household
          ? {
              allocatedMinor: allocated,
              // Money nobody has said they moved arrives planned-but-unconfirmed
              // and the lines leaning on it read `awaiting_transfer` — which is
              // exactly what it is. Both producers can be confirmed: a household
              // member's transfer, and a movement between two of your own
              // accounts.
              confirmedMinor: Math.max(0, household?.confirmedMinor ?? 0) + internalConfirmed,
              sources,
            }
          : null,
      outboundInflows: outbound,
      fundingCycleAccountIds: cycleFor.get(accountId),
      fundingCycleBrokenInflowId: brokenFor.get(accountId),
    };
    const plan = computeAccountPlan(input, asOfDate);
    inputs.push(input);
    plans.push(plan);

    const fundedById = new Map(plan.outboundInflows.map((o) => [o.inflowId, o]));
    for (const edge of outByAccount.get(accountId) ?? []) {
      const funded = fundedById.get(edge.inflowId);
      const requested = Math.max(0, monthlyIncomeMinor(edge.row, now));
      if (!funded) {
        movements.push({
          inflowId: edge.inflowId,
          fromAccountId: edge.from,
          toAccountId: edge.to,
          priority: edge.priority,
          requestedMinor: requested,
          fundedMinor: 0,
          status: "broken_cycle",
        });
        continue;
      }
      if (byId.has(edge.to) && funded.fundedMonthlyMinor > 0) {
        const list = arriving.get(edge.to) ?? [];
        list.push({
          inflowId: edge.inflowId,
          fromAccountId: edge.from,
          amountMinor: funded.fundedMonthlyMinor,
        });
        arriving.set(edge.to, list);
      }
      movements.push({
        inflowId: edge.inflowId,
        fromAccountId: edge.from,
        toAccountId: edge.to,
        priority: edge.priority,
        requestedMinor: requested,
        fundedMinor: funded.fundedMonthlyMinor,
        status: funded.onTrack ? "funded" : funded.fundedMonthlyMinor > 0 ? "short" : "unfunded",
      });
    }
  }

  // Movements this pass can see arriving but not leaving: their sending account
  // is outside it. Reported so the gap is visible rather than looking like an
  // inflow of zero that nobody authored.
  const known = new Set(movements.map((m) => m.inflowId));
  for (const account of accounts) {
    for (const row of account.inflows ?? []) {
      if (row.source !== "account" || row.active === false || !row.sourceAccountId) continue;
      if (known.has(row.id)) continue;
      movements.push({
        inflowId: row.id,
        fromAccountId: row.sourceAccountId,
        toAccountId: account.accountId,
        priority: row.priority ?? DEFAULT_PRIORITY,
        requestedMinor: Math.max(0, monthlyIncomeMinor(row, now)),
        fundedMinor: 0,
        status: "unknown_source",
      });
    }
  }

  return {
    asOfDate,
    order,
    inputs,
    plans,
    movements: movements.sort(
      (a, b) =>
        (a.fromAccountId < b.fromAccountId ? -1 : a.fromAccountId > b.fromAccountId ? 1 : 0) ||
        (a.toAccountId < b.toAccountId ? -1 : a.toAccountId > b.toAccountId ? 1 : 0) ||
        (a.inflowId < b.inflowId ? -1 : a.inflowId > b.inflowId ? 1 : 0),
    ),
    cycles,
  };
}

/**
 * One of the pass's inputs with a single movement's money taken back out: the
 * arrival dropped from `sources`, and its amount off the allocated and confirmed
 * totals.
 *
 * "What did *this* movement pay for" has no answer without it. The pass has
 * already delivered the money, so the input as it stands is the *after* — a plan
 * handed the money cannot be diffed against itself, and adding the amount a
 * second time diffs against a movement that does not exist. This is the before.
 *
 * Everything not about that movement is left exactly as it was: the household's
 * allocation, the other arrivals, and every movement leaving. Unknown inflow id
 * — or no arriving money at all — hands the input straight back, so a caller
 * need not check first.
 */
export function withoutArrival(input: AccountInput, inflowId: string): AccountInput {
  const inflow = input.inflow;
  const arrival = inflow?.sources?.find((s) => s.inflowId === inflowId);
  if (!inflow || !arrival) return input;
  return {
    ...input,
    inflow: {
      ...inflow,
      allocatedMinor: Math.max(0, inflow.allocatedMinor - arrival.amountMinor),
      confirmedMinor: Math.max(0, inflow.confirmedMinor - (arrival.confirmedMinor ?? 0)),
      sources: inflow.sources!.filter((s) => s !== arrival),
    },
  };
}
