import { describe, expect, it } from "vitest";
import { computeEstatePlan } from "./estate.js";
import { accountPlanFromScope } from "./engine.js";
import {
  flowFromEstate,
  flowFromScope,
  totalInflow,
  type Flow,
  type FlowScopeAccount,
} from "./flow.js";
import {
  computeScopePlan,
  type ScopeAccountInput,
  type ScopeInput,
  type ScopePaymentInput,
} from "./scope.js";
import type { AccountInput, InflowInput, OutboundInflowInput, PaymentInput } from "./types.js";

const ASOF = "2026-08-04";

const external = (id: string, amountMinor: number): InflowInput => ({
  id,
  amountMinor,
  frequency: "monthly",
  recurrence: null,
  anchorDate: "2026-08-25",
  active: true,
  source: "external",
  sourceAccountId: null,
});

const arriving = (
  id: string,
  amountMinor: number,
  sourceAccountId: string,
  priority = 10,
): InflowInput => ({
  id,
  amountMinor,
  frequency: "monthly",
  recurrence: null,
  anchorDate: "2026-08-25",
  active: true,
  source: "account",
  sourceAccountId,
  priority,
});

const leaving = (
  id: string,
  amountMinor: number,
  toAccountId: string,
  priority = 10,
): OutboundInflowInput => ({
  id,
  toAccountId,
  amountMinor,
  frequency: "monthly",
  recurrence: null,
  anchorDate: "2026-08-25",
  active: true,
  priority,
});

const bill = (id: string, amountMinor: number, priority = 1): PaymentInput => ({
  id,
  name: id,
  category: "monthly_recurring",
  amountMinor,
  dueDate: null,
  recurrence: null,
  targetDate: null,
  priority,
  alreadySavedMinor: 0,
  autoRenew: true,
  active: true,
});

const account = (accountId: string, over: Partial<AccountInput> = {}): AccountInput => ({
  accountId,
  currency: "GBP",
  incomes: [],
  payments: [],
  ...over,
});

const scopeOf = (...ids: string[]): FlowScopeAccount[] =>
  ids.map((accountId) => ({ accountId, name: accountId }));

/** Every node's ribbons meet: what comes in is what goes out. */
function expectBalanced(
  flow: ReturnType<typeof flowFromEstate>,
  { allowUnfunded = false }: { allowUnfunded?: boolean } = {},
): void {
  for (const node of flow.accounts) {
    const incoming = flow.edges
      .filter((e) => e.toAccountId === node.accountId)
      .reduce((sum, e) => sum + e.amountMinor, 0);
    const outgoing = flow.edges
      .filter((e) => e.fromAccountId === node.accountId)
      .reduce((sum, e) => sum + e.amountMinor, 0);
    expect({
      account: node.accountId,
      total: node.incomeMinor + incoming,
    }).toEqual({
      account: node.accountId,
      total: node.spendingMinor + outgoing + node.leftoverMinor,
    });
  }
  if (!allowUnfunded) {
    expect(flow.edges.every((e) => e.status === "funded")).toBe(true);
  }
}

describe("flowFromEstate", () => {
  it("draws a chain spanning three accounts, and balances at every node", () => {
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 500_000)],
          inflows: [external("salary", 500_000)],
          outboundInflows: [leaving("to-pot", 300_000, "pot")],
          payments: [bill("rent", 100_000)],
        }),
        account("pot", {
          inflows: [arriving("to-pot", 300_000, "current")],
          outboundInflows: [leaving("to-isa", 200_000, "isa")],
          payments: [bill("bills", 50_000)],
        }),
        account("isa", { inflows: [arriving("to-isa", 200_000, "pot")] }),
      ],
      ASOF,
    );

    const flow = flowFromEstate(estate, scopeOf("current", "pot", "isa"), "GBP");

    expect(flow.accounts.map((a) => a.accountId)).toEqual(["current", "pot", "isa"]);
    expect(flow.edges).toEqual([
      {
        fromAccountId: "current",
        toAccountId: "pot",
        amountMinor: 300_000,
        requestedMinor: 300_000,
        status: "funded",
        inflowId: "to-pot",
      },
      {
        fromAccountId: "pot",
        toAccountId: "isa",
        amountMinor: 200_000,
        requestedMinor: 200_000,
        status: "funded",
        inflowId: "to-isa",
      },
    ]);
    // The salary is counted once, at the top of the chain — not again at each
    // hop, which is the whole reason the denominator is money from outside.
    expect(flow.totalInflowMinor).toBe(500_000);
    expectBalanced(flow);
  });

  it("keeps the scope's order rather than the pass's planning order", () => {
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 100_000)],
          inflows: [external("salary", 100_000)],
          outboundInflows: [leaving("to-pot", 40_000, "pot")],
        }),
        account("pot", { inflows: [arriving("to-pot", 40_000, "current")] }),
      ],
      ASOF,
    );
    // The pass plans the sender first; the user asked for the pot first.
    expect(estate.order).toEqual(["current", "pot"]);
    expect(flowFromEstate(estate, scopeOf("pot", "current"), "GBP").accounts.map((a) => a.name)) //
      .toEqual(["pot", "current"]);
  });

  it("draws money crossing the scope's edge, in both directions", () => {
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 400_000)],
          inflows: [external("salary", 400_000)],
          outboundInflows: [leaving("to-pot", 100_000, "pot")],
        }),
        account("pot", {
          inflows: [arriving("to-pot", 100_000, "current")],
          outboundInflows: [leaving("to-isa", 60_000, "isa")],
        }),
        account("isa", { inflows: [arriving("to-isa", 60_000, "pot")] }),
      ],
      ASOF,
    );

    // Only the pot is in scope: money arrives from outside it and leaves it.
    const flow = flowFromEstate(estate, scopeOf("pot"), "GBP");
    expect(flow.edges).toEqual([
      {
        fromAccountId: null,
        toAccountId: "pot",
        amountMinor: 100_000,
        requestedMinor: 100_000,
        status: "funded",
        inflowId: "to-pot",
      },
      {
        fromAccountId: "pot",
        toAccountId: null,
        amountMinor: 60_000,
        requestedMinor: 60_000,
        status: "funded",
        inflowId: "to-isa",
      },
    ]);
    // The pot has no income of its own; everything it holds came from outside.
    expect(flow.totalInflowMinor).toBe(100_000);
    expectBalanced(flow);
  });

  it("leaves out movements between two accounts the scope does not contain", () => {
    const estate = computeEstatePlan(
      [
        account("solo", { incomes: [external("salary", 100_000)] }),
        account("current", {
          incomes: [external("wages", 200_000)],
          inflows: [external("wages", 200_000)],
          outboundInflows: [leaving("to-pot", 50_000, "pot")],
        }),
        account("pot", { inflows: [arriving("to-pot", 50_000, "current")] }),
      ],
      ASOF,
    );
    expect(flowFromEstate(estate, scopeOf("solo"), "GBP").edges).toEqual([]);
  });

  it("draws what a household allocated as arriving from outside the scope", () => {
    const estate = computeEstatePlan(
      [
        account("bills-pot", {
          payments: [bill("rent", 90_000)],
          inflow: { allocatedMinor: 120_000, confirmedMinor: 60_000 },
        }),
      ],
      ASOF,
    );

    const flow = flowFromEstate(estate, scopeOf("bills-pot"), "GBP");
    expect(flow.edges).toEqual([
      {
        fromAccountId: null,
        toAccountId: "bills-pot",
        amountMinor: 120_000,
        requestedMinor: 120_000,
        status: "funded",
      },
    ]);
    // No income of its own, and £1,200 arriving: the denominator is the arrival.
    expect(flow.totalInflowMinor).toBe(120_000);
    // £900 of bills paid, £300 still sitting there.
    expect(flow.accounts[0]).toMatchObject({ spendingMinor: 90_000, leftoverMinor: 30_000 });
    expectBalanced(flow);
  });

  it("counts a household allocation once when a movement arrives alongside it", () => {
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 300_000)],
          inflows: [external("salary", 300_000)],
          outboundInflows: [leaving("to-pot", 50_000, "pot")],
        }),
        account("pot", {
          inflows: [arriving("to-pot", 50_000, "current")],
          inflow: { allocatedMinor: 80_000, confirmedMinor: 0 },
          payments: [bill("bills", 100_000)],
        }),
      ],
      ASOF,
    );

    const flow = flowFromEstate(estate, scopeOf("current", "pot"), "GBP");
    const fromOutside = flow.edges.filter((e) => e.fromAccountId === null);
    // The movement's £500 is itemised and drawn account-to-account; only the
    // household's £800 crosses the scope's edge.
    expect(fromOutside).toEqual([
      {
        fromAccountId: null,
        toAccountId: "pot",
        amountMinor: 80_000,
        requestedMinor: 80_000,
        status: "funded",
      },
    ]);
    expect(flow.totalInflowMinor).toBe(380_000);
    expectBalanced(flow);
  });

  it("keeps a short movement, and says what it asked for", () => {
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 100_000)],
          inflows: [external("salary", 100_000)],
          outboundInflows: [leaving("to-pot", 90_000, "pot")],
          payments: [bill("rent", 60_000)],
        }),
        account("pot", { inflows: [arriving("to-pot", 90_000, "current")] }),
      ],
      ASOF,
    );

    const flow = flowFromEstate(estate, scopeOf("current", "pot"), "GBP");
    expect(flow.edges[0]).toMatchObject({
      amountMinor: 40_000,
      requestedMinor: 90_000,
      status: "short",
    });
    expectBalanced(flow, { allowUnfunded: true });
  });

  /**
   * The edge that funds nothing. It is kept in the model with its status, so a
   * diagram can say the loop is there instead of drawing a ribbon of width zero
   * — or, worse, a full-width one that moves no money at all.
   */
  it("keeps the movement a loop was broken at, at zero", () => {
    const estate = computeEstatePlan(
      [
        account("a", {
          incomes: [external("salary", 100_000)],
          inflows: [external("salary", 100_000), arriving("b-to-a", 10_000, "b")],
          outboundInflows: [leaving("a-to-b", 30_000, "b")],
        }),
        account("b", {
          inflows: [arriving("a-to-b", 30_000, "a")],
          outboundInflows: [leaving("b-to-a", 10_000, "a")],
        }),
      ],
      ASOF,
    );
    expect(estate.cycles).toHaveLength(1);

    const flow = flowFromEstate(estate, scopeOf("a", "b"), "GBP");
    const broken = flow.edges.find((e) => e.status === "broken_cycle");
    expect(broken).toMatchObject({ amountMinor: 0, requestedMinor: 10_000 });
    // Every plan on the loop names the edge that was dropped, so a caller
    // holding one account's plan can explain it.
    expect(estate.plans.map((p) => p.fundingCycleBrokenInflowId)).toEqual([
      broken?.inflowId,
      broken?.inflowId,
    ]);
    expectBalanced(flow, { allowUnfunded: true });
  });

  /**
   * The other derivation. A household plan settles what each *member* moves,
   * which no authored row exists for — so without its attribution the pot fills
   * up out of nowhere and the account paying for it shows the money still there.
   */
  it("draws a household's transfer as the ribbon it is when the sender is in scope", () => {
    const estate = computeEstatePlan(
      [
        account("alice-cur", { incomes: [external("salary", 300_000)] }),
        account("bills", {
          payments: [bill("rent", 100_000)],
          inflow: { allocatedMinor: 100_000, confirmedMinor: 0 },
        }),
      ],
      ASOF,
    );

    const flow = flowFromEstate(estate, scopeOf("alice-cur", "bills"), "GBP", [
      {
        toAccountId: "bills",
        fromAccountId: "alice-cur",
        memberUserId: "alice",
        memberName: "Alice",
        amountMinor: 100_000,
      },
    ]);

    expect(flow.edges).toEqual([
      {
        fromAccountId: "alice-cur",
        toAccountId: "bills",
        amountMinor: 100_000,
        requestedMinor: 100_000,
        status: "funded",
        memberUserId: "alice",
        memberName: "Alice",
      },
    ]);
    // The rent leaves the account that pays it, so the sender's left over is
    // £2,000 and not £3,000 — a figure the estate pass alone cannot reach,
    // because it has never heard of the household.
    expect(flow.accounts.map((a) => a.leftoverMinor)).toEqual([200_000, 0]);
    // Counted once: it is the salary that enters the scope, not the transfer.
    expect(flow.totalInflowMinor).toBe(300_000);
    expectBalanced(flow);
  });

  it("leaves a household transfer crossing the scope's edge unattributed", () => {
    const estate = computeEstatePlan(
      [
        account("bills", {
          payments: [bill("rent", 100_000)],
          inflow: { allocatedMinor: 100_000, confirmedMinor: 0 },
        }),
      ],
      ASOF,
    );
    const flow = flowFromEstate(estate, scopeOf("bills"), "GBP", [
      {
        toAccountId: "bills",
        fromAccountId: "somebody-elses-account",
        memberUserId: "bob",
        amountMinor: 100_000,
      },
    ]);
    expect(flow.edges[0]).toMatchObject({ fromAccountId: null, memberUserId: "bob" });
    expect(flow.edges[0]).not.toHaveProperty("memberName");
    expect(flow.totalInflowMinor).toBe(100_000);
  });

  it("never draws more arriving than arrived, however the attribution reads", () => {
    const estate = computeEstatePlan(
      [account("bills", { inflow: { allocatedMinor: 60_000, confirmedMinor: 0 } })],
      ASOF,
    );
    // A stale attribution asking for more than the plan now allocates.
    const flow = flowFromEstate(estate, scopeOf("bills"), "GBP", [
      { toAccountId: "bills", fromAccountId: "a", memberUserId: "alice", amountMinor: 50_000 },
      { toAccountId: "bills", fromAccountId: "b", memberUserId: "bob", amountMinor: 50_000 },
      // Nothing left for this one: an edge of zero would draw a member sending
      // money nobody received.
      { toAccountId: "bills", fromAccountId: "c", memberUserId: "carol", amountMinor: 50_000 },
    ]);
    expect(flow.edges.map((e) => e.amountMinor)).toEqual([50_000, 10_000]);
    expect(flow.edges[1]).toMatchObject({ requestedMinor: 50_000 });
    expect(flow.accounts[0]!.leftoverMinor).toBe(60_000);
  });

  /**
   * Two plans can promise the same pound: the household asks a member to move
   * their share without knowing what their own account has already committed to
   * a movement. The node floors at nothing left over rather than going negative
   * — and stops balancing, which is what over-committing actually looks like.
   */
  it("floors an over-committed account at nothing left over", () => {
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 100_000)],
          inflows: [external("salary", 100_000)],
          outboundInflows: [leaving("to-pot", 90_000, "pot")],
        }),
        account("pot", {
          inflows: [arriving("to-pot", 90_000, "current")],
          // ...and the household asks the same account for £400 on top.
          inflow: { allocatedMinor: 40_000, confirmedMinor: 0 },
        }),
      ],
      ASOF,
    );
    const flow = flowFromEstate(estate, scopeOf("current", "pot"), "GBP", [
      { toAccountId: "pot", fromAccountId: "current", memberUserId: "alice", amountMinor: 40_000 },
    ]);
    expect(flow.accounts[0]!.leftoverMinor).toBe(0);
    // £1,000 of income against £1,300 of promises: the pot's ribbons no longer
    // meet its neighbour's, which is what promising twice looks like.
    expect(flow.accounts[1]!.leftoverMinor).toBe(130_000);
  });

  it("draws nothing for an account the pass never planned", () => {
    const estate = computeEstatePlan([account("known", { incomes: [external("s", 1000)] })], ASOF);
    const flow = flowFromEstate(estate, scopeOf("known", "stranger"), "GBP");
    expect(flow.accounts.map((a) => a.accountId)).toEqual(["known"]);
  });

  it("has nothing to divide by for an empty scope", () => {
    const estate = computeEstatePlan([], ASOF);
    const flow = flowFromEstate(estate, [], "GBP");
    expect(flow).toMatchObject({ accounts: [], edges: [], totalInflowMinor: 0 });
    expect(flow.asOfDate).toBe(ASOF);
  });
});

describe("totalInflow", () => {
  it("counts own income and everything crossing the scope's edge, and nothing else", () => {
    expect(
      totalInflow(
        [
          {
            accountId: "a",
            name: "a",
            incomeMinor: 100,
            spendingMinor: 0,
            leftoverMinor: 0,
            shortfallMinor: 0,
          },
          {
            accountId: "b",
            name: "b",
            incomeMinor: 50,
            spendingMinor: 0,
            leftoverMinor: 0,
            shortfallMinor: 0,
          },
        ],
        [
          {
            fromAccountId: "a",
            toAccountId: "b",
            amountMinor: 40,
            requestedMinor: 40,
            status: "funded",
          },
          {
            fromAccountId: null,
            toAccountId: "b",
            amountMinor: 25,
            requestedMinor: 25,
            status: "funded",
          },
          {
            fromAccountId: "b",
            toAccountId: null,
            amountMinor: 10,
            requestedMinor: 10,
            status: "funded",
          },
        ],
      ),
    ).toBe(175);
  });
});

// =============================================================================
// The flow, read off the one pass
// =============================================================================

const scopeAccount = (
  accountId: string,
  over: Partial<ScopeAccountInput> = {},
): ScopeAccountInput => ({
  accountId,
  name: accountId,
  role: "personal",
  memberUserId: "owner",
  currency: "GBP",
  incomes: [],
  payments: [],
  ...over,
});

const salary = (amountMinor: number, id = "inc") => [
  { id, amountMinor, frequency: "monthly" as const, anchorDate: "2026-08-25" },
];

const owed = (
  id: string,
  amountMinor: number,
  over: Partial<ScopePaymentInput> = {},
): ScopePaymentInput => ({
  id,
  name: id,
  category: "monthly_recurring",
  scope: "personal",
  amountMinor,
  priority: 1,
  ...over,
});

const solo = (...accounts: ScopeAccountInput[]): ScopeInput => ({
  scopeId: "owner",
  members: [{ userId: "owner", shareBp: 10_000 }],
  accounts,
});

/**
 * Every node's ribbons meet **exactly** — no floor, and none needed.
 *
 * `flowFromEstate`'s sibling above allows the account to be over-committed and
 * stop balancing, because two plans could promise the same pound. There is one
 * plan now, so this is an equality and a negative residual is a fact rather than
 * a symptom: it says a member must consolidate before the month works.
 */
function expectExactlyBalanced(flow: Flow): void {
  for (const node of flow.accounts) {
    const incoming = flow.edges
      .filter((e) => e.toAccountId === node.accountId)
      .reduce((sum, e) => sum + e.amountMinor, 0);
    const outgoing = flow.edges
      .filter((e) => e.fromAccountId === node.accountId)
      .reduce((sum, e) => sum + e.amountMinor, 0);
    expect({ account: node.accountId, total: node.incomeMinor + incoming }).toEqual({
      account: node.accountId,
      total: node.spendingMinor + outgoing + node.leftoverMinor,
    });
  }
}

describe("flowFromScope", () => {
  it("draws a chain spanning three accounts, and balances at every node", () => {
    const scope = solo(
      scopeAccount("current", {
        incomes: salary(500_000),
        payments: [owed("rent", 100_000)],
        outboundInflows: [leaving("to-pot", 300_000, "pot")],
      }),
      scopeAccount("pot", { outboundInflows: [leaving("to-isa", 200_000, "isa")] }),
      scopeAccount("isa"),
    );

    const flow = flowFromScope(
      computeScopePlan(scope, ASOF),
      scopeOf("current", "pot", "isa"),
      "GBP",
    );

    expect(flow.accounts.map((a) => a.accountId)).toEqual(["current", "pot", "isa"]);
    expect(flow.edges).toEqual([
      {
        fromAccountId: "current",
        toAccountId: "pot",
        amountMinor: 300_000,
        requestedMinor: 300_000,
        status: "funded",
        inflowId: "to-pot",
      },
      {
        fromAccountId: "pot",
        toAccountId: "isa",
        amountMinor: 200_000,
        requestedMinor: 200_000,
        status: "funded",
        inflowId: "to-isa",
      },
    ]);
    // The salary is counted once, at the top of the chain — not again at each
    // hop, which is the whole reason the denominator is money from outside.
    expect(flow.totalInflowMinor).toBe(500_000);
    expectExactlyBalanced(flow);
  });

  it("keeps the scope's order rather than the pass's planning order", () => {
    const scope = solo(
      scopeAccount("current", {
        incomes: salary(100_000),
        outboundInflows: [leaving("to-pot", 40_000, "pot")],
      }),
      scopeAccount("pot"),
    );
    const flow = flowFromScope(computeScopePlan(scope, ASOF), scopeOf("pot", "current"), "GBP");
    expect(flow.accounts.map((a) => a.name)).toEqual(["pot", "current"]);
  });

  it("draws money crossing the scope's edge, in both directions", () => {
    const scope = solo(
      scopeAccount("current", {
        incomes: salary(400_000),
        outboundInflows: [leaving("to-pot", 100_000, "pot")],
      }),
      scopeAccount("pot", { outboundInflows: [leaving("to-isa", 60_000, "isa")] }),
      scopeAccount("isa"),
    );

    // Only the pot is in the picture: money arrives from outside it and leaves.
    const flow = flowFromScope(computeScopePlan(scope, ASOF), scopeOf("pot"), "GBP");
    expect(flow.edges).toEqual([
      {
        fromAccountId: null,
        toAccountId: "pot",
        amountMinor: 100_000,
        requestedMinor: 100_000,
        status: "funded",
        inflowId: "to-pot",
      },
      {
        fromAccountId: "pot",
        toAccountId: null,
        amountMinor: 60_000,
        requestedMinor: 60_000,
        status: "funded",
        inflowId: "to-isa",
      },
    ]);
    expect(flow.totalInflowMinor).toBe(100_000);
    expectExactlyBalanced(flow);
  });

  it("leaves out movements between two accounts the picture does not contain", () => {
    const scope = solo(
      scopeAccount("solo-acc", { incomes: salary(100_000) }),
      scopeAccount("current", {
        incomes: salary(200_000, "wages"),
        outboundInflows: [leaving("to-pot", 50_000, "pot")],
      }),
      scopeAccount("pot"),
    );
    const flow = flowFromScope(computeScopePlan(scope, ASOF), scopeOf("solo-acc"), "GBP");
    expect(flow.edges).toEqual([]);
  });

  it("keeps a short movement, and says what it asked for", () => {
    const scope = solo(
      scopeAccount("current", {
        incomes: salary(100_000),
        payments: [owed("rent", 60_000)],
        outboundInflows: [leaving("to-pot", 90_000, "pot")],
      }),
      scopeAccount("pot"),
    );
    const flow = flowFromScope(computeScopePlan(scope, ASOF), scopeOf("current", "pot"), "GBP");
    expect(flow.edges[0]).toMatchObject({
      amountMinor: 40_000,
      requestedMinor: 90_000,
      status: "short",
    });
    expectExactlyBalanced(flow);
  });

  it("keeps the movement a loop was broken at, at zero", () => {
    const scope = solo(
      scopeAccount("a", {
        incomes: salary(100_000),
        outboundInflows: [leaving("a-to-b", 30_000, "b")],
      }),
      scopeAccount("b", { outboundInflows: [leaving("b-to-a", 10_000, "a")] }),
    );
    const plan = computeScopePlan(scope, ASOF);
    expect(plan.cycles).toHaveLength(1);

    const flow = flowFromScope(plan, scopeOf("a", "b"), "GBP");
    expect(flow.edges.find((e) => e.status === "broken_cycle")).toMatchObject({
      amountMinor: 0,
      requestedMinor: 10_000,
    });
    expectExactlyBalanced(flow);
  });

  it("has nothing to draw for a currency the scope does not hold", () => {
    const flow = flowFromScope(
      computeScopePlan(solo(scopeAccount("a", { incomes: salary(1_000) })), ASOF),
      scopeOf("a"),
      "USD",
    );
    expect(flow).toMatchObject({ accounts: [], edges: [], totalInflowMinor: 0, currency: "USD" });
  });

  it("draws nothing for an account the pass never planned", () => {
    const flow = flowFromScope(
      computeScopePlan(solo(scopeAccount("known", { incomes: salary(1_000) })), ASOF),
      scopeOf("known", "stranger"),
      "GBP",
    );
    expect(flow.accounts.map((a) => a.accountId)).toEqual(["known"]);
  });
});

// --- derived transfers: the ribbon nobody authored ---------------------------

/** Alice and Bob, a shared bills pot, and whatever else a test needs. */
function household(over: Partial<ScopeInput> = {}): ScopeInput {
  return {
    scopeId: "h1",
    householdId: "h1",
    members: [
      { userId: "alice", displayName: "Alice", shareBp: 6_000 },
      { userId: "bob", displayName: "Bob", shareBp: 4_000 },
    ],
    accounts: [],
    ...over,
  };
}

describe("flowFromScope — a transfer the pass derived", () => {
  const scope = household({
    accounts: [
      scopeAccount("alice-cur", { memberUserId: "alice", incomes: salary(300_000) }),
      scopeAccount("bills", {
        role: "shared",
        memberUserId: null,
        payments: [owed("rent", 100_000, { scope: "shared" })],
      }),
    ],
  });

  it("draws it as the ribbon it is, named when the caller may be told", () => {
    const flow = flowFromScope(
      computeScopePlan(scope, ASOF),
      scopeOf("alice-cur", "bills"),
      "GBP",
      new Map([["alice", "Alice"]]),
    );
    expect(flow.edges).toEqual([
      {
        fromAccountId: "alice-cur",
        toAccountId: "bills",
        amountMinor: 60_000,
        requestedMinor: 60_000,
        status: "funded",
        memberUserId: "alice",
        memberName: "Alice",
      },
    ]);
    // Alice's 60% share, and only hers. Bob has no personal account in this
    // scope, so his 40% has no source to leave and is reported as the shortfall
    // it is rather than quietly charged to Alice's account.
    expect(flow.accounts.find((a) => a.accountId === "bills")!.shortfallMinor).toBe(40_000);
    expect(flow.totalInflowMinor).toBe(300_000);
    expectExactlyBalanced(flow);
  });

  it("leaves the ribbon unnamed when the caller may not be told", () => {
    const flow = flowFromScope(computeScopePlan(scope, ASOF), scopeOf("alice-cur", "bills"), "GBP");
    expect(flow.edges[0]).not.toHaveProperty("memberName");
    expect(flow.edges[0]).toMatchObject({ memberUserId: "alice" });
  });

  it("draws a transfer from outside the picture as crossing its edge", () => {
    const flow = flowFromScope(computeScopePlan(scope, ASOF), scopeOf("bills"), "GBP");
    expect(flow.edges.every((e) => e.fromAccountId === null)).toBe(true);
    expect(flow.totalInflowMinor).toBe(60_000);
    expectExactlyBalanced(flow);
  });
});

/**
 * The residual goes negative, and says something.
 *
 * A member's transfers all leave the personal account with the most external
 * income (decision 11). Spread their income across two accounts and the source
 * can owe more than reaches it — which means "consolidate first", and is the one
 * thing flooring the residual at zero would hide.
 */
describe("flowFromScope — a member who has to consolidate first", () => {
  const scope = household({
    accounts: [
      scopeAccount("alice-save", { memberUserId: "alice", incomes: salary(300_000) }),
      scopeAccount("alice-cur", { memberUserId: "alice", incomes: salary(200_000, "inc2") }),
      scopeAccount("bills", {
        role: "shared",
        memberUserId: null,
        payments: [owed("rent", 450_000, { scope: "personal", bearerUserId: "alice" })],
      }),
    ],
  });

  it("says the source account owes more than it holds, rather than flooring at nothing", () => {
    const flow = flowFromScope(
      computeScopePlan(scope, ASOF),
      scopeOf("alice-save", "alice-cur", "bills"),
      "GBP",
    );
    expect(flow.accounts.map((a) => a.leftoverMinor)).toEqual([-150_000, 200_000, 0]);
    // And it still balances: the negative is the honest arithmetic, not a break.
    expectExactlyBalanced(flow);
  });
});

// =============================================================================
// One account, three surfaces, one number
// =============================================================================

/**
 * The specification of `parity.test.ts`, satisfied.
 *
 * That file asserts three figures equal to the penny — the household plan's
 * figure for an account, the flow residual, and the account plan — and is landed
 * `it.fails` against the two engines it names, which cannot agree. Here the same
 * three figures come off one pass, through the three views this package builds,
 * and they are the same number because they *are* the same number.
 *
 * Both directions are pinned, because the disagreement had two of them:
 *
 *  - **money leaving on an authored movement**, which a household plan has no
 *    term for (`household.ts:38-48`) — the £2,793-against-£2,093 defect;
 *  - **money arriving as an allocation**, which the account engine spends after
 *    its own income (`engine.ts:240-241`), so the account figure diverged from
 *    the flow residual by the allocation *as well as* by the movement. WP-O
 *    identified this case and deliberately left it unpinned, because pinning a
 *    three-way disagreement with two different deltas would have made the
 *    specification unfalsifiable. It is coherent now, so it is pinned now.
 */
describe("one account, three surfaces, one number", () => {
  /** The three figures, from the three views, for one account. */
  function surfaces(scope: ScopeInput, accountId: string, pictureOf: string[]) {
    const plan = computeScopePlan(scope, ASOF);
    const householdPage = plan.accounts.find((a) => a.accountId === accountId)!.leftoverMinor;
    const flowDiagram = flowFromScope(plan, scopeOf(...pictureOf), "GBP").accounts.find(
      (a) => a.accountId === accountId,
    )!.leftoverMinor;
    const accountPage = accountPlanFromScope(scope, plan, accountId).residualMinor;
    return { householdPage, flowDiagram, accountPage };
  }

  /**
   * The defect's own fixture, as one scope.
   *
   * £3,500 of salary arrives, £1,200 of rent leaves, £700 a month is committed
   * to the ISA: £1,600 is free. The ISA is outside the household and inside the
   * scope, which is exactly the shape a household plan could not see.
   */
  const movementDirection = household({
    accounts: [
      scopeAccount("alex-current", {
        memberUserId: "alex",
        incomes: salary(350_000),
        payments: [owed("rent", 120_000, { bearerUserId: "alex" })],
        outboundInflows: [leaving("alex-isa", 70_000, "isa")],
      }),
      scopeAccount("isa", { memberUserId: "alex" }),
      scopeAccount("bob-current", {
        memberUserId: "bob",
        incomes: salary(240_000, "bob-salary"),
        payments: [owed("bob rent", 90_000, { bearerUserId: "bob" })],
      }),
    ],
    members: [
      { userId: "alex", displayName: "Alex", shareBp: 6_000 },
      { userId: "bob", displayName: "Bob", shareBp: 4_000 },
    ],
  });

  it("agrees, to the penny, on what an account with a standing order has left", () => {
    expect(surfaces(movementDirection, "alex-current", ["alex-current", "isa"])).toEqual({
      householdPage: 160_000,
      flowDiagram: 160_000,
      accountPage: 160_000,
    });
  });

  it("keeps the account page's old arithmetic true where it was ever true", () => {
    const plan = computeScopePlan(movementDirection, ASOF);
    const account = accountPlanFromScope(movementDirection, plan, "alex-current");
    // `leftoverMinor − outboundInflowMinor` is what `AccountMovements.tsx` spells
    // out today, and it is right for an account nothing arrives at.
    expect(account.leftoverMinor - account.outboundInflowMinor).toBe(160_000);
  });

  /**
   * The direction the pin above does not cover: an account that is *sent* money
   * and does not spend all of it, and sends some of what it has on.
   *
   * The pot earns £200 of its own, is owed £1,000 of rent that its members'
   * transfers cover, and forwards £100 a month to an ISA. It keeps £100.
   */
  const allocationDirection = household({
    accounts: [
      scopeAccount("alice-cur", {
        memberUserId: "alice",
        incomes: salary(300_000),
        payments: [owed("gym", 50_000, { bearerUserId: "alice", priority: 50 })],
      }),
      scopeAccount("bob-cur", { memberUserId: "bob", incomes: salary(200_000, "inc2") }),
      scopeAccount("bills", {
        role: "shared",
        memberUserId: null,
        incomes: salary(20_000, "rebate"),
        payments: [owed("rent", 100_000, { scope: "shared" })],
        outboundInflows: [leaving("bills-isa", 10_000, "isa")],
      }),
      scopeAccount("isa", { memberUserId: "alice" }),
    ],
  });

  it("agrees, to the penny, on what an account that was sent money has left", () => {
    expect(
      surfaces(allocationDirection, "bills", ["alice-cur", "bob-cur", "bills", "isa"]),
    ).toEqual({
      householdPage: 10_000,
      flowDiagram: 10_000,
      accountPage: 10_000,
    });
  });

  it("shows why the old arithmetic could not reach it", () => {
    const plan = computeScopePlan(allocationDirection, ASOF);
    const account = accountPlanFromScope(allocationDirection, plan, "bills");
    // The account's *own* surplus is nothing — its £200 rebate went on the rent —
    // and £100 is committed out, so the pre-pass formula reads minus £100 for an
    // account that ends the month holding £100. Two deltas, one figure: the
    // allocation it did not spend, and the movement it did make.
    expect(account.leftoverMinor).toBe(0);
    expect(account.outboundInflowMinor).toBe(10_000);
    expect(account.leftoverMinor - account.outboundInflowMinor).toBe(-10_000);
    expect(account.residualMinor).toBe(10_000);
  });

  it("draws the picture the three figures describe, with every node meeting", () => {
    const flow = flowFromScope(
      computeScopePlan(allocationDirection, ASOF),
      scopeOf("alice-cur", "bob-cur", "bills", "isa"),
      "GBP",
    );
    expectExactlyBalanced(flow);
    // Derived transports first, then the savings movement — the order the pass
    // funded them in, and the order decision 8 puts them in.
    expect(flow.edges.map((e) => [e.fromAccountId, e.toAccountId, e.amountMinor])).toEqual([
      ["alice-cur", "bills", 60_000],
      ["bob-cur", "bills", 40_000],
      ["bills", "isa", 10_000],
    ]);
    // Money in is the three accounts' own income and nothing else: a transfer is
    // redistribution, and counting it again at each hop is the old error.
    expect(flow.totalInflowMinor).toBe(520_000);
  });
});

describe("flowFromScope — a picture narrower than the scope", () => {
  const scope = household({
    accounts: [
      scopeAccount("alice-cur", { memberUserId: "alice", incomes: salary(300_000) }),
      scopeAccount("bob-cur", { memberUserId: "bob", incomes: salary(200_000, "inc2") }),
      scopeAccount("bills", {
        role: "shared",
        memberUserId: null,
        payments: [owed("rent", 100_000, { scope: "shared" })],
      }),
    ],
  });

  it("draws one member's transfer leaving, and the other's not at all", () => {
    // Alice alone in the picture: her transfer leaves it, and Bob's — between
    // two accounts the picture does not contain — is none of its business.
    const flow = flowFromScope(computeScopePlan(scope, ASOF), scopeOf("alice-cur"), "GBP");
    expect(flow.edges).toEqual([
      {
        fromAccountId: "alice-cur",
        toAccountId: null,
        amountMinor: 60_000,
        requestedMinor: 60_000,
        status: "funded",
        memberUserId: "alice",
      },
    ]);
    expect(flow.totalInflowMinor).toBe(300_000);
    expectExactlyBalanced(flow);
  });
});
