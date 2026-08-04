import { describe, expect, it } from "vitest";
import { accountPlanFromScope } from "./engine.js";
import { flowFromScope, totalInflow, type Flow, type FlowScopeAccount } from "./flow.js";
import {
  computeScopePlan,
  type ScopeAccountInput,
  type ScopeInput,
  type ScopePaymentInput,
} from "./scope.js";
import type { OutboundInflowInput } from "./types.js";

const ASOF = "2026-08-04";

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

const scopeOf = (...ids: string[]): FlowScopeAccount[] =>
  ids.map((accountId) => ({ accountId, name: accountId }));

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
 * The superseded `flowFromEstate` allowed an account to be over-committed and
 * stop balancing, because two plans could promise the same pound, and floored
 * the residual to cope. There is one plan now, so this is an equality and a
 * negative residual is a fact rather than a symptom: it says a member must
 * consolidate before the month works.
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
 * figure for an account, the flow residual, and the account plan — and was
 * landed `it.fails` against the two engines it names, which could not agree.
 * Here the same figures come off one pass, through the three views this builds,
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
