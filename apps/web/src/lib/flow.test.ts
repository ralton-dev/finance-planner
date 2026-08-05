import { describe, expect, it } from "vitest";
import { householdFlow, parseAccountIds, totalInflowMinor, visibleFlow } from "./flow.js";
import type { FlowDto, HouseholdPlanDto } from "./types.js";

/** current ─▶ pot ─▶ isa, plus a household's rent arriving from off-scope. */
const flow: FlowDto = {
  asOfDate: "2026-08-04",
  currency: "GBP",
  accounts: [
    {
      accountId: "current",
      name: "current",
      incomeMinor: 400_000,
      spendingMinor: 100_000,
      leftoverMinor: 200_000,
      shortfallMinor: 0,
    },
    {
      accountId: "pot",
      name: "pot",
      incomeMinor: 0,
      spendingMinor: 60_000,
      leftoverMinor: 80_000,
      shortfallMinor: 0,
    },
    {
      accountId: "isa",
      name: "isa",
      incomeMinor: 0,
      spendingMinor: 0,
      leftoverMinor: 40_000,
      shortfallMinor: 0,
    },
  ],
  edges: [
    {
      fromAccountId: "current",
      toAccountId: "pot",
      amountMinor: 100_000,
      requestedMinor: 100_000,
      status: "funded",
      inflowId: "to-pot",
    },
    {
      fromAccountId: "pot",
      toAccountId: "isa",
      amountMinor: 40_000,
      requestedMinor: 40_000,
      status: "funded",
      inflowId: "to-isa",
    },
    {
      fromAccountId: null,
      toAccountId: "pot",
      amountMinor: 80_000,
      requestedMinor: 80_000,
      status: "funded",
      memberUserId: "bob",
    },
  ],
  totalInflowMinor: 480_000,
};

describe("visibleFlow", () => {
  /**
   * The promise excludability rests on. Hiding an account is a way of looking at
   * a diagram, not a way of narrowing the plan — so every account still drawn
   * keeps every figure it arrived with, to the penny, and the snapshot either
   * side of a toggle is byte-identical.
   */
  it("changes only the picture, and provably not one figure", () => {
    const before = JSON.stringify(flow);

    const hidden = visibleFlow(flow, new Set(["pot"]));
    // The picture changed.
    expect(hidden.accounts.map((a) => a.accountId)).toEqual(["current", "isa"]);
    // ...and unhiding gets back exactly what was there.
    expect(visibleFlow(hidden, new Set())).toEqual(hidden);
    expect(JSON.stringify(visibleFlow(flow, new Set()))).toBe(before);

    // No figure moved: the remaining nodes are the very same objects.
    expect(hidden.accounts[0]).toBe(flow.accounts[0]);
    expect(hidden.accounts[1]).toBe(flow.accounts[2]);
    // ...and the flow that was passed in was not touched.
    expect(JSON.stringify(flow)).toBe(before);
  });

  it("keeps money crossing into the picture when its other end is hidden", () => {
    const hidden = visibleFlow(flow, new Set(["pot"]));
    // The money still leaves the current account and still reaches the ISA;
    // both now cross the edge of what is drawn, exactly as an account outside
    // the scope's would. Hiding the middle of a chain must not make either end
    // look richer than it is.
    expect(hidden.edges).toEqual([
      expect.objectContaining({
        fromAccountId: "current",
        toAccountId: null,
        amountMinor: 100_000,
      }),
      expect.objectContaining({ fromAccountId: null, toAccountId: "isa", amountMinor: 40_000 }),
    ]);
    // The household's £800 into the hidden pot has nothing to say about this
    // picture at all: neither end of it is drawn.
    expect(hidden.edges.some((e) => e.memberUserId === "bob")).toBe(false);
  });

  it("measures shares against the money entering what is drawn", () => {
    expect(visibleFlow(flow, new Set(["current"])).totalInflowMinor).toBe(
      // The pot's £1,000 from the current account and £800 from the household,
      // both now arriving from off-picture. No income of their own.
      180_000,
    );
    expect(visibleFlow(flow, new Set()).totalInflowMinor).toBe(480_000);
  });

  it("hides everything without dividing by nothing", () => {
    const empty = visibleFlow(flow, new Set(["current", "pot", "isa"]));
    expect(empty).toMatchObject({ accounts: [], edges: [], totalInflowMinor: 0 });
  });
});

describe("householdFlow", () => {
  const plan: HouseholdPlanDto = {
    householdId: "hh",
    asOfDate: "2026-08-04",
    currency: "GBP",
    monthlyIncomeMinor: 300_000,
    totalRequiredMinor: 100_000,
    totalFundedMinor: 100_000,
    leftoverMinor: 200_000,
    shortfallMinor: 0,
    members: [
      {
        userId: "alice",
        shareBp: 10_000,
        monthlyIncomeMinor: 300_000,
        obligationMinor: 100_000,
        fundedMinor: 100_000,
        leftoverMinor: 200_000,
        shortfallMinor: 0,
      },
    ],
    // Both ends of the transfer below, because a household plan holds both:
    // `transfers` lists what arrives at the household's *own* accounts (WP-X),
    // so a row whose destination is missing from `accounts` is a plan that
    // cannot exist — and it was the fixture's way of hiding that a ribbon with
    // one end off the picture is not drawn at all.
    accounts: [
      {
        accountId: "cur",
        name: "current",
        role: "personal",
        memberUserId: "alice",
        currency: "GBP",
        monthlyIncomeMinor: 300_000,
        requiredOutflowMinor: 0,
        fundedOutflowMinor: 0,
        transferInMinor: 0,
        transferOutMinor: 100_000,
        leftoverMinor: 200_000,
        shortfallMinor: 0,
      },
      {
        accountId: "bills",
        name: "bills",
        role: "shared",
        memberUserId: null,
        currency: "GBP",
        monthlyIncomeMinor: 0,
        requiredOutflowMinor: 100_000,
        fundedOutflowMinor: 100_000,
        transferInMinor: 100_000,
        transferOutMinor: 0,
        leftoverMinor: 0,
        shortfallMinor: 0,
      },
    ],
    lines: [],
    transfers: [
      { fromAccountId: "cur", toAccountId: "bills", memberUserId: "alice", amountMinor: 100_000 },
    ],
  };

  it("reads the plan's own figures, and names the member who moves the money", () => {
    const derived = householdFlow(plan);
    expect(derived.accounts).toEqual([
      {
        accountId: "cur",
        name: "current",
        incomeMinor: 300_000,
        spendingMinor: 0,
        leftoverMinor: 200_000,
        shortfallMinor: 0,
      },
      {
        accountId: "bills",
        name: "bills",
        incomeMinor: 0,
        spendingMinor: 100_000,
        leftoverMinor: 0,
        shortfallMinor: 0,
      },
    ]);
    expect(derived.edges[0]).toMatchObject({ memberUserId: "alice", status: "funded" });
    // No display name to give: the edge says who, not what to call them.
    expect(derived.edges[0]).not.toHaveProperty("memberName");
    expect(derived.totalInflowMinor).toBe(300_000);
  });

  it("falls back to a name for an account the plan left unnamed", () => {
    const unnamed = householdFlow({
      ...plan,
      accounts: [{ ...plan.accounts[0]!, name: undefined }],
    });
    expect(unnamed.accounts[0]!.name).toBe("account");
  });

  it("takes the committed savings out of what stays put, and gives them a ribbon", () => {
    // £3,000 in, £1,000 derived away to the bills pot, £500 swept to an ISA
    // outside the household. `leftoverMinor` keeps its meaning on the wire
    // (decision 13); what stays put is what is left after the sweep.
    const saving = householdFlow({
      ...plan,
      committedMinor: 50_000,
      accounts: [{ ...plan.accounts[0]!, committedMinor: 50_000 }, plan.accounts[1]!],
    });

    expect(saving.accounts[0]!.leftoverMinor).toBe(150_000);
    expect(saving.edges).toContainEqual({
      fromAccountId: "cur",
      toAccountId: null,
      amountMinor: 50_000,
      requestedMinor: 50_000,
      status: "funded",
    });
  });

  it("reads an authored arrival back out of the plan's own identity", () => {
    // A household plan has no row for a movement landing in one of its
    // accounts — it reports the effect and not the cause — so the pot's
    // left-over is larger than income, transfers and spending explain, and the
    // difference is what arrived.
    const fed = householdFlow({
      ...plan,
      accounts: [
        ...plan.accounts,
        {
          accountId: "holiday",
          name: "holiday",
          role: "shared",
          memberUserId: null,
          currency: "GBP",
          monthlyIncomeMinor: 0,
          requiredOutflowMinor: 0,
          fundedOutflowMinor: 0,
          transferInMinor: 0,
          transferOutMinor: 0,
          leftoverMinor: 50_000,
          shortfallMinor: 0,
        },
      ],
    });

    expect(fed.edges).toContainEqual({
      fromAccountId: null,
      toAccountId: "holiday",
      amountMinor: 50_000,
      requestedMinor: 50_000,
      status: "funded",
    });
  });

  it("draws neither extra ribbon for a household nobody has authored a movement in", () => {
    // The ordinary case, and the one every existing figure has to survive: no
    // committed bucket, nothing arriving, and the picture as it always was.
    expect(householdFlow(plan).edges).toHaveLength(1);
  });

  /**
   * WP-X. `HouseholdPlan.transfers` lists what arrives at the household's own
   * accounts, so both of these are transport with one end off the picture: the
   * £300 Alice sends on to a pot of her own has **no row at all**, and the £250
   * arriving from a private account of hers has a row whose sender is not a node
   * here. `transferOutMinor` and `transferInMinor` count both, because the money
   * really does move — so drawn from the rows alone each node would be short by
   * exactly that, which is a picture that lies about an account's balance.
   */
  it("sends the transport it has no row for to elsewhere, at either end", () => {
    const wider = householdFlow({
      ...plan,
      accounts: [
        // Alice sends £1,000 to the bills pot and £300 on to a pot of her own.
        { ...plan.accounts[0]!, transferOutMinor: 130_000, leftoverMinor: 170_000 },
        // …and £250 of the pot's feed comes from an account nobody assigned here.
        { ...plan.accounts[1]!, transferInMinor: 125_000, leftoverMinor: 25_000 },
      ],
      transfers: [
        ...plan.transfers,
        {
          fromAccountId: "alice-private",
          toAccountId: "bills",
          memberUserId: "alice",
          amountMinor: 25_000,
        },
      ],
    });

    expect(wider.edges).toContainEqual({
      fromAccountId: "cur",
      toAccountId: null,
      amountMinor: 30_000,
      requestedMinor: 30_000,
      status: "funded",
    });
    expect(wider.edges).toContainEqual({
      fromAccountId: null,
      toAccountId: "bills",
      amountMinor: 25_000,
      requestedMinor: 25_000,
      status: "funded",
    });
    // The row whose sender is off the picture is not drawn as a ribbon — there
    // is no node to draw it from — and is not counted twice either.
    expect(wider.edges.filter((e) => e.memberUserId !== undefined)).toHaveLength(1);

    // The property the whole thing exists for: every account node balances.
    for (const a of wider.accounts) {
      const inMinor =
        a.incomeMinor +
        wider.edges.reduce((s, e) => s + (e.toAccountId === a.accountId ? e.amountMinor : 0), 0);
      const outMinor =
        a.spendingMinor +
        Math.max(0, a.leftoverMinor) +
        wider.edges.reduce((s, e) => s + (e.fromAccountId === a.accountId ? e.amountMinor : 0), 0);
      expect([a.accountId, inMinor]).toEqual([a.accountId, outMinor]);
    }
  });
});

describe("totalInflowMinor", () => {
  it("counts own income and everything crossing the edge, and nothing else", () => {
    expect(totalInflowMinor(flow.accounts, flow.edges)).toBe(480_000);
  });
});

describe("parseAccountIds", () => {
  it("keeps the user's order, drops the blanks, and takes a repeat once", () => {
    expect(parseAccountIds("b, a ,,b,")).toEqual(["b", "a"]);
    expect(parseAccountIds(null)).toEqual([]);
  });
});
