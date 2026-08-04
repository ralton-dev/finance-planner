import { describe, expect, it } from "vitest";
import { computeEstatePlan } from "./estate.js";
import { flowFromEstate, totalInflow, type FlowScopeAccount } from "./flow.js";
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
