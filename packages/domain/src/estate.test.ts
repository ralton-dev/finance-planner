import { describe, expect, it } from "vitest";
import { computeAccountPlan, computeOverview } from "./engine.js";
import { computeEstatePlan, withoutArrival } from "./estate.js";
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

/** The arriving face of a movement, as the receiving account stores it. */
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

/** The leaving face of the same row. */
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

/** current → pot → isa, one salary at the top and a bill at every stop. */
function chain(): AccountInput[] {
  return [
    account("current", {
      incomes: [external("salary", 500_000)],
      inflows: [external("salary", 500_000)],
      outboundInflows: [leaving("to-pot", 300_000, "pot")],
      payments: [bill("rent", 100_000)],
    }),
    account("pot", {
      inflows: [arriving("to-pot", 300_000, "current")],
      outboundInflows: [leaving("to-isa", 200_000, "isa")],
      payments: [bill("bills", 120_000)],
    }),
    account("isa", {
      inflows: [arriving("to-isa", 200_000, "pot")],
      payments: [bill("stocks", 150_000)],
    }),
  ];
}

const planOf = (estate: ReturnType<typeof computeEstatePlan>, accountId: string) =>
  estate.plans.find((p) => p.accountId === accountId)!;

describe("computeEstatePlan — a chain funds in one ordered pass", () => {
  it("plans every account after the accounts that fund it", () => {
    const estate = computeEstatePlan(chain(), ASOF);
    expect(estate.order).toEqual(["current", "pot", "isa"]);
    expect(estate.cycles).toEqual([]);
  });

  it("plans senders before receivers whatever order the accounts arrive in", () => {
    const [current, pot, isa] = chain();
    // Reversed, and shuffled: the graph decides the order, not the array.
    expect(computeEstatePlan([isa!, pot!, current!], ASOF).order).toEqual([
      "current",
      "pot",
      "isa",
    ]);
    expect(computeEstatePlan([pot!, isa!, current!], ASOF).order).toEqual([
      "current",
      "pot",
      "isa",
    ]);
  });

  it("moves the money down the chain, one hop at a time", () => {
    const estate = computeEstatePlan(chain(), ASOF);

    // £5,000 in, £1,000 of rent, £3,000 moved on.
    const current = planOf(estate, "current");
    expect(current.monthlyIncomeMinor).toBe(500_000);
    expect(current.totalFundedMinor).toBe(100_000);
    expect(current.outboundInflowMinor).toBe(300_000);
    expect(current.outboundInflows[0]).toMatchObject({
      inflowId: "to-pot",
      toAccountId: "pot",
      requiredMonthlyMinor: 300_000,
      fundedMonthlyMinor: 300_000,
      fundedFromOwnMinor: 300_000,
      fundedFromInflowMinor: 0,
      onTrack: true,
    });

    // The pot has no income of its own; the £3,000 arriving pays its bills and
    // £1,800 of the £2,000 it promised the ISA.
    const pot = planOf(estate, "pot");
    expect(pot.monthlyIncomeMinor).toBe(0);
    expect(pot.allocatedInflowMinor).toBe(300_000);
    expect(pot.totalFundedMinor).toBe(120_000);
    expect(pot.shortfallMinor).toBe(0);
    expect(pot.outboundInflowMinor).toBe(180_000);
    expect(pot.outboundInflows[0]).toMatchObject({
      fundedMonthlyMinor: 180_000,
      fundedFromOwnMinor: 0,
      fundedFromInflowMinor: 180_000,
      onTrack: false,
    });

    // Which is what the ISA gets — not the £2,000 the record asks for. Money
    // cannot be spent twice however long the chain.
    const isa = planOf(estate, "isa");
    expect(isa.allocatedInflowMinor).toBe(180_000);
    expect(isa.totalFundedMinor).toBe(150_000);
    expect(isa.shortfallMinor).toBe(0);
    expect(isa.lines[0]!.fundedMonthlyMinor).toBe(150_000);
    // £300 of the £1,800 arrived and was never needed: it is not the ISA's
    // surplus to claim, and the current account still counts it as its own.
    expect(isa.leftoverMinor).toBe(0);
    expect(isa.internalInflowUsedMinor).toBe(150_000);
  });

  it("reports each hop as a movement, short ones included", () => {
    const estate = computeEstatePlan(chain(), ASOF);
    expect(estate.movements).toEqual([
      {
        inflowId: "to-pot",
        fromAccountId: "current",
        toAccountId: "pot",
        priority: 10,
        requestedMinor: 300_000,
        fundedMinor: 300_000,
        status: "funded",
      },
      {
        inflowId: "to-isa",
        fromAccountId: "pot",
        toAccountId: "isa",
        priority: 10,
        requestedMinor: 200_000,
        fundedMinor: 180_000,
        status: "short",
      },
    ]);
  });

  it("marks lines leaning on a movement nobody has confirmed", () => {
    const estate = computeEstatePlan(chain(), ASOF);
    // Nothing confirms an account-sourced movement yet (WP-H), so the pot's
    // bills are covered but waiting on the transfer — not at risk.
    expect(planOf(estate, "pot").lines[0]!.status).toBe("awaiting_transfer");
    expect(planOf(estate, "pot").lines[0]!.onTrack).toBe(true);
    expect(planOf(estate, "current").lines[0]!.status).toBe("funded");
  });

  it("keeps the estate's money in equal to what it earns", () => {
    const estate = computeEstatePlan(chain(), ASOF);
    const bucket = computeOverview(estate.plans, ASOF).perCurrency[0]!;
    expect(bucket.monthlyIncomeMinor).toBe(500_000);
    expect(bucket.totalFundedMinor + bucket.leftoverMinor).toBe(500_000);
  });
});

describe("computeEstatePlan — decision 6: expenses beat movements out", () => {
  /** A bill ranked *worse* than the movement, numerically, on both accounts. */
  const senderFirst = (): AccountInput[] => [
    account("current", {
      incomes: [external("salary", 100_000)],
      inflows: [external("salary", 100_000)],
      // Priority 1 — the best number in the estate — and still funded last.
      outboundInflows: [leaving("to-pot", 100_000, "pot", 1)],
      payments: [bill("rent", 80_000, 99)],
    }),
    account("pot", { inflows: [arriving("to-pot", 100_000, "current")] }),
  ];

  it("funds every expense before any outbound movement, whatever the priority", () => {
    const estate = computeEstatePlan(senderFirst(), ASOF);
    const current = planOf(estate, "current");

    expect(current.lines[0]!.fundedMonthlyMinor).toBe(80_000);
    expect(current.lines[0]!.onTrack).toBe(true);
    // Only the £200 the rent left over goes to the pot, not the £1,000 asked.
    expect(current.outboundInflows[0]!.fundedMonthlyMinor).toBe(20_000);
    expect(current.outboundInflows[0]!.onTrack).toBe(false);
    expect(planOf(estate, "pot").allocatedInflowMinor).toBe(20_000);
  });

  it("would have starved the bill if the movement had been interleaved", () => {
    // The counterfactual, spelled out: rank them together and priority 1 takes
    // the lot. This is the outcome decision 6 exists to forbid.
    const interleaved = computeAccountPlan(
      account("current", {
        incomes: [external("salary", 100_000)],
        payments: [bill("movement-as-a-payment", 100_000, 1), bill("rent", 80_000, 99)],
      }),
      ASOF,
    );
    expect(interleaved.lines.find((l) => l.paymentId === "rent")!.fundedMonthlyMinor).toBe(0);
  });

  it("ranks movements against each other, best number first", () => {
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 100_000)],
          outboundInflows: [
            leaving("to-isa", 60_000, "isa", 20),
            leaving("to-pot", 60_000, "pot", 10),
          ],
          payments: [bill("rent", 10_000)],
        }),
        account("pot", { inflows: [arriving("to-pot", 60_000, "current")] }),
        account("isa", { inflows: [arriving("to-isa", 60_000, "current")] }),
      ],
      ASOF,
    );
    // £900 left after the rent: the pot's £600 first, the ISA gets the £300 left.
    expect(planOf(estate, "pot").allocatedInflowMinor).toBe(60_000);
    expect(planOf(estate, "isa").allocatedInflowMinor).toBe(30_000);
  });

  it("lets a movement out of the estate keep its place in the queue", () => {
    // "Somewhere else" is not in this pass, but the money still leaves — and
    // still leaves before the movement ranked behind it.
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 100_000)],
          outboundInflows: [
            leaving("to-elsewhere", 70_000, "elsewhere", 10),
            leaving("to-pot", 70_000, "pot", 20),
          ],
        }),
        account("pot", { inflows: [arriving("to-pot", 70_000, "current")] }),
      ],
      ASOF,
    );
    expect(planOf(estate, "current").outboundInflowMinor).toBe(100_000);
    expect(planOf(estate, "pot").allocatedInflowMinor).toBe(30_000);
    expect(estate.movements.find((m) => m.toAccountId === "elsewhere")).toMatchObject({
      fundedMinor: 70_000,
      status: "funded",
    });
  });
});

describe("computeEstatePlan — cycles are reported, never deadlocked", () => {
  /** a funds b funds c funds a. */
  const loop = (): AccountInput[] => [
    account("a", {
      incomes: [external("salary", 100_000)],
      inflows: [external("salary", 100_000), arriving("c-a", 50_000, "c")],
      outboundInflows: [leaving("a-b", 50_000, "b")],
    }),
    account("b", {
      inflows: [arriving("a-b", 50_000, "a")],
      outboundInflows: [leaving("b-c", 50_000, "c")],
      payments: [bill("b-bill", 10_000)],
    }),
    account("c", {
      inflows: [arriving("b-c", 50_000, "b")],
      outboundInflows: [leaving("c-a", 50_000, "a")],
      payments: [bill("c-bill", 10_000)],
    }),
  ];

  it("names the accounts in the loop, in the order money travels", () => {
    const estate = computeEstatePlan(loop(), ASOF);
    expect(estate.cycles).toHaveLength(1);
    expect(estate.cycles[0]!.accountIds).toEqual(["a", "b", "c"]);
    expect(estate.cycles[0]!.inflowIds).toEqual(["a-b", "b-c", "c-a"]);
    expect(estate.cycles[0]!.brokenInflowId).toBe("c-a");
  });

  it("still plans every account, in a real order", () => {
    const estate = computeEstatePlan(loop(), ASOF);
    expect(estate.order).toEqual(["a", "b", "c"]);
    expect(estate.plans.map((p) => p.accountId)).toEqual(["a", "b", "c"]);
    expect(planOf(estate, "b").allocatedInflowMinor).toBe(50_000);
    expect(planOf(estate, "c").allocatedInflowMinor).toBe(40_000);
  });

  it("funds nothing along the edge it broke, and says so", () => {
    const estate = computeEstatePlan(loop(), ASOF);
    const broken = estate.movements.find((m) => m.inflowId === "c-a")!;
    expect(broken).toMatchObject({
      fromAccountId: "c",
      toAccountId: "a",
      requestedMinor: 50_000,
      fundedMinor: 0,
      status: "broken_cycle",
    });
    // And it costs `c` nothing: an ignored movement must not quietly eat money.
    expect(planOf(estate, "c").outboundInflowMinor).toBe(0);
    expect(planOf(estate, "a").allocatedInflowMinor).toBe(0);
  });

  it("tells every account on the loop that it is on one", () => {
    const estate = computeEstatePlan(loop(), ASOF);
    for (const id of ["a", "b", "c"]) {
      expect(planOf(estate, id).fundingCycleAccountIds).toEqual(["a", "b", "c"]);
    }
  });

  it("leaves accounts off the loop unmarked", () => {
    const estate = computeEstatePlan(
      [
        ...loop(),
        account("d", {
          incomes: [external("d-salary", 10_000)],
          inflows: [external("d-salary", 10_000)],
        }),
      ],
      ASOF,
    );
    expect(planOf(estate, "d").fundingCycleAccountIds).toBeUndefined();
  });

  it("handles a two-account loop", () => {
    const estate = computeEstatePlan(
      [
        account("x", {
          incomes: [external("salary", 100_000)],
          inflows: [arriving("y-x", 10_000, "y")],
          outboundInflows: [leaving("x-y", 40_000, "y")],
        }),
        account("y", {
          inflows: [arriving("x-y", 40_000, "x")],
          outboundInflows: [leaving("y-x", 10_000, "x")],
        }),
      ],
      ASOF,
    );
    expect(estate.cycles).toEqual([
      { accountIds: ["x", "y"], inflowIds: ["x-y", "y-x"], brokenInflowId: "y-x" },
    ]);
    expect(estate.order).toEqual(["x", "y"]);
  });

  it("reports two independent loops separately", () => {
    const pair = (a: string, b: string): AccountInput[] => [
      account(a, {
        incomes: [external(`${a}-salary`, 100_000)],
        outboundInflows: [leaving(`${a}-${b}`, 10_000, b)],
      }),
      account(b, {
        inflows: [arriving(`${a}-${b}`, 10_000, a)],
        outboundInflows: [leaving(`${b}-${a}`, 10_000, a)],
      }),
    ];
    const estate = computeEstatePlan([...pair("a", "b"), ...pair("c", "d")], ASOF);
    expect(estate.cycles.map((c) => c.accountIds)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("breaks the same edge every time, whatever order the accounts arrive in", () => {
    const [a, b, c] = loop();
    const orders = [
      [a!, b!, c!],
      [c!, b!, a!],
      [b!, c!, a!],
    ];
    for (const accounts of orders) {
      const estate = computeEstatePlan(accounts, ASOF);
      expect(estate.cycles).toHaveLength(1);
      // The loop is the same loop however it is entered; the accounts named are
      // the same set, and one edge — exactly one — is dropped.
      expect([...estate.cycles[0]!.accountIds].sort()).toEqual(["a", "b", "c"]);
      expect(estate.movements.filter((m) => m.status === "broken_cycle")).toHaveLength(1);
    }
  });

  it("survives a loop far deeper than the call stack", () => {
    const size = 20_000;
    const accounts: AccountInput[] = [];
    for (let i = 0; i < size; i++) {
      const id = `a${String(i).padStart(6, "0")}`;
      const nextId = `a${String((i + 1) % size).padStart(6, "0")}`;
      const prevId = `a${String((i + size - 1) % size).padStart(6, "0")}`;
      accounts.push(
        account(id, {
          inflows: [arriving(`${prevId}-${id}`, 1_000, prevId)],
          outboundInflows: [leaving(`${id}-${nextId}`, 1_000, nextId)],
        }),
      );
    }
    const estate = computeEstatePlan(accounts, ASOF);
    expect(estate.order).toHaveLength(size);
    expect(estate.cycles).toHaveLength(1);
    expect(estate.cycles[0]!.accountIds).toHaveLength(size);
  });

  it("survives a chain far deeper than the call stack", () => {
    const size = 20_000;
    const accounts: AccountInput[] = [];
    for (let i = 0; i < size; i++) {
      const id = `a${String(i).padStart(6, "0")}`;
      const nextId = `a${String(i + 1).padStart(6, "0")}`;
      accounts.push(
        account(id, {
          incomes: i === 0 ? [external("salary", 1_000_000)] : [],
          outboundInflows: i === size - 1 ? [] : [leaving(`${id}-${nextId}`, 1_000, nextId)],
        }),
      );
    }
    const estate = computeEstatePlan(accounts, ASOF);
    expect(estate.cycles).toEqual([]);
    expect(estate.order[0]).toBe("a000000");
    expect(estate.order.at(-1)).toBe(`a${String(size - 1).padStart(6, "0")}`);
  });
});

describe("computeEstatePlan — the edges of the graph", () => {
  it("leaves a single standalone account exactly as it was", () => {
    const solo = account("solo", {
      incomes: [external("salary", 200_000)],
      inflows: [external("salary", 200_000)],
      payments: [bill("rent", 90_000)],
    });
    const estate = computeEstatePlan([solo], ASOF);
    expect(estate.order).toEqual(["solo"]);
    expect(estate.movements).toEqual([]);
    expect(JSON.stringify(estate.plans[0])).toBe(JSON.stringify(computeAccountPlan(solo, ASOF)));
  });

  it("plans a standalone pot with no income of its own, which is the bug", () => {
    // No household anywhere — the account is fed by one authored movement, and
    // that is enough to make it part of the plan.
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 200_000)],
          outboundInflows: [leaving("to-pot", 50_000, "pot")],
        }),
        account("pot", {
          inflows: [arriving("to-pot", 50_000, "current")],
          payments: [bill("holiday", 50_000)],
        }),
      ],
      ASOF,
    );
    const pot = planOf(estate, "pot");
    expect(pot.shortfallMinor).toBe(0);
    expect(pot.lines[0]!.onTrack).toBe(true);
    expect(pot.lines[0]!.fundedFromInflowMinor).toBe(50_000);
  });

  it("reports a movement whose sender is outside the pass instead of hiding it", () => {
    const estate = computeEstatePlan(
      [account("pot", { inflows: [arriving("in", 50_000, "somebody-elses-account")] })],
      ASOF,
    );
    expect(estate.movements).toEqual([
      {
        inflowId: "in",
        fromAccountId: "somebody-elses-account",
        toAccountId: "pot",
        priority: 10,
        requestedMinor: 50_000,
        fundedMinor: 0,
        status: "unknown_source",
      },
    ]);
    expect(planOf(estate, "pot").allocatedInflowMinor).toBe(0);
  });

  it("ignores an inactive movement at both ends", () => {
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 100_000)],
          outboundInflows: [{ ...leaving("to-pot", 50_000, "pot"), active: false }],
        }),
        account("pot", { inflows: [{ ...arriving("to-pot", 50_000, "current"), active: false }] }),
      ],
      ASOF,
    );
    expect(estate.movements).toEqual([]);
    expect(planOf(estate, "pot").allocatedInflowMinor).toBe(0);
    expect(planOf(estate, "current").outboundInflowMinor).toBe(0);
  });

  it("normalises a movement's cadence the way it normalises income", () => {
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 100_000)],
          outboundInflows: [{ ...leaving("yearly", 120_000, "pot"), frequency: "yearly" as const }],
        }),
        account("pot", { inflows: [arriving("yearly", 120_000, "current")] }),
      ],
      ASOF,
    );
    expect(planOf(estate, "pot").allocatedInflowMinor).toBe(10_000);
  });

  it("adds a movement to a household's allocation rather than replacing it", () => {
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 100_000)],
          outboundInflows: [leaving("to-pot", 30_000, "pot")],
        }),
        account("pot", {
          inflows: [arriving("to-pot", 30_000, "current")],
          inflow: { allocatedMinor: 40_000, confirmedMinor: 40_000 },
          payments: [bill("bills", 70_000)],
        }),
      ],
      ASOF,
    );
    const pot = planOf(estate, "pot");
    expect(pot.allocatedInflowMinor).toBe(70_000);
    expect(pot.confirmedInflowMinor).toBe(40_000);
    // The household's £400 is treated as spent first — it was earmarked for
    // these bills — so only the £300 that moved between the user's own accounts
    // is intra-estate money the rollup has to net.
    expect(pot.internalInflowUsedMinor).toBe(30_000);
    expect(pot.lines[0]!.status).toBe("awaiting_transfer");
  });

  it("does not count money merely passing through as spent", () => {
    // The pot forwards everything and spends none of it: the pounds are used
    // where they land, and netting them at both stops would net them twice.
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 100_000)],
          outboundInflows: [leaving("to-pot", 50_000, "pot")],
        }),
        account("pot", {
          inflows: [arriving("to-pot", 50_000, "current")],
          outboundInflows: [leaving("to-isa", 50_000, "isa")],
        }),
        account("isa", {
          inflows: [arriving("to-isa", 50_000, "pot")],
          payments: [bill("stocks", 50_000)],
        }),
      ],
      ASOF,
    );
    expect(planOf(estate, "pot").internalInflowUsedMinor).toBe(0);
    expect(planOf(estate, "isa").internalInflowUsedMinor).toBe(50_000);
    const bucket = computeOverview(estate.plans, ASOF).perCurrency[0]!;
    expect(bucket.intraEstateMovementMinor).toBe(50_000);
    expect(bucket.totalFundedMinor + bucket.leftoverMinor).toBe(bucket.monthlyIncomeMinor);
  });

  it("hands back the inputs it planned from, so replanning agrees to the penny", () => {
    const estate = computeEstatePlan(chain(), ASOF);
    estate.inputs.forEach((input, i) => {
      expect(JSON.stringify(computeAccountPlan(input, ASOF))).toBe(JSON.stringify(estate.plans[i]));
    });
  });

  it("itemises what each movement delivered, so one can be taken back out", () => {
    const estate = computeEstatePlan(chain(), ASOF);
    const pot = planOf(estate, "pot");
    expect(pot.inflowArrivals).toEqual([
      { inflowId: "to-pot", fromAccountId: "current", amountMinor: 300_000, confirmedMinor: 0 },
    ]);

    // The question "what did *this* movement pay for" only has an answer if the
    // plan without it can be built — and a plan handed the money already cannot
    // be diffed against itself. The itemisation is what makes the base
    // reconstructible.
    const withoutIt = computeAccountPlan(
      { ...estate.inputs[estate.order.indexOf("pot")]!, inflow: null },
      ASOF,
    );
    expect(withoutIt.lines[0]!.fundedFromInflowMinor).toBe(0);
    expect(pot.lines[0]!.fundedFromInflowMinor).toBe(120_000);
  });

  it("itemises several movements arriving at one account", () => {
    const estate = computeEstatePlan(
      [
        account("a", {
          incomes: [external("a-pay", 100_000)],
          outboundInflows: [leaving("a-pot", 30_000, "pot")],
        }),
        account("b", {
          incomes: [external("b-pay", 100_000)],
          outboundInflows: [leaving("b-pot", 40_000, "pot")],
        }),
        account("pot", {
          inflows: [arriving("a-pot", 30_000, "a"), arriving("b-pot", 40_000, "b")],
          payments: [bill("bills", 70_000)],
        }),
      ],
      ASOF,
    );
    const pot = planOf(estate, "pot");
    expect(pot.inflowArrivals).toEqual([
      { inflowId: "a-pot", fromAccountId: "a", amountMinor: 30_000, confirmedMinor: 0 },
      { inflowId: "b-pot", fromAccountId: "b", amountMinor: 40_000, confirmedMinor: 0 },
    ]);
    expect(pot.internalInflowUsedMinor).toBe(70_000);
  });

  it("orders two movements to the same account by row when they tie on priority", () => {
    const estate = computeEstatePlan(
      [
        account("current", {
          incomes: [external("salary", 50_000)],
          outboundInflows: [
            leaving("z-second", 40_000, "pot", 10),
            leaving("a-first", 40_000, "pot", 10),
          ],
        }),
        account("pot", {
          inflows: [
            arriving("a-first", 40_000, "current"),
            arriving("z-second", 40_000, "current"),
          ],
        }),
      ],
      ASOF,
    );
    const current = planOf(estate, "current");
    // Same destination, same priority: the row id breaks the tie, so the £500
    // splits the same way on every run.
    expect(current.outboundInflows.map((o) => o.inflowId)).toEqual(["a-first", "z-second"]);
    expect(current.outboundInflows.map((o) => o.fundedMonthlyMinor)).toEqual([40_000, 10_000]);
    expect(planOf(estate, "pot").inflowArrivals.map((a) => a.inflowId)).toEqual([
      "a-first",
      "z-second",
    ]);
    expect(estate.movements.map((m) => m.inflowId)).toEqual(["a-first", "z-second"]);
  });

  it("puts an account in two overlapping loops in the first of them", () => {
    // a → b → a and a → c → a: two loops sharing an account. Both are named,
    // and the shared account reports the loop it was first found on.
    const estate = computeEstatePlan(
      [
        account("a", {
          incomes: [external("salary", 100_000)],
          outboundInflows: [leaving("a-b", 10_000, "b", 10), leaving("a-c", 10_000, "c", 20)],
        }),
        account("b", { outboundInflows: [leaving("b-a", 10_000, "a")] }),
        account("c", { outboundInflows: [leaving("c-a", 10_000, "a")] }),
      ],
      ASOF,
    );
    expect(estate.cycles.map((c) => c.accountIds)).toEqual([
      ["a", "b"],
      ["a", "c"],
    ]);
    expect(planOf(estate, "a").fundingCycleAccountIds).toEqual(["a", "b"]);
    expect(planOf(estate, "c").fundingCycleAccountIds).toEqual(["a", "c"]);
    expect(estate.movements.filter((m) => m.status === "broken_cycle")).toHaveLength(2);
  });

  it("plans an empty estate without complaint", () => {
    expect(computeEstatePlan([], ASOF)).toMatchObject({ order: [], plans: [], cycles: [] });
  });
});

describe("computeEstatePlan — money somebody has said they moved", () => {
  /** current → pot, £300 authored, and a £300 bill in the pot for it to pay. */
  const pair = (over: Partial<AccountInput> = {}): AccountInput[] => [
    account("current", {
      incomes: [external("salary", 100_000)],
      outboundInflows: [leaving("to-pot", 30_000, "pot")],
    }),
    account("pot", {
      inflows: [arriving("to-pot", 30_000, "current")],
      payments: [bill("bills", 30_000)],
      ...over,
    }),
  ];

  it("counts a confirmed movement as money that has actually arrived", () => {
    const estate = computeEstatePlan(
      pair({ confirmedArrivals: [{ inflowId: "to-pot", confirmedMinor: 30_000 }] }),
      ASOF,
    );
    const pot = planOf(estate, "pot");
    expect(pot.allocatedInflowMinor).toBe(30_000);
    expect(pot.confirmedInflowMinor).toBe(30_000);
    expect(pot.inflowArrivals[0]!.confirmedMinor).toBe(30_000);
    // The money is here, so the line is funded rather than waiting on a
    // transfer — the whole point of being able to say you moved it.
    expect(pot.lines[0]!.status).toBe("funded");
  });

  it("leaves an unconfirmed movement awaiting its transfer", () => {
    const pot = planOf(computeEstatePlan(pair(), ASOF), "pot");
    expect(pot.confirmedInflowMinor).toBe(0);
    expect(pot.inflowArrivals[0]!.confirmedMinor).toBe(0);
    expect(pot.lines[0]!.status).toBe("awaiting_transfer");
  });

  it("will not let a stale confirmation credit more than the movement delivered", () => {
    // Confirmed when the sender could spare £300; this month a rent bill leaves
    // it £100. A confirmation deliberately outlives the plan that derived it, so
    // the clamp is what keeps it honest.
    const [current, pot] = pair({
      confirmedArrivals: [{ inflowId: "to-pot", confirmedMinor: 30_000 }],
    });
    const estate = computeEstatePlan(
      [{ ...current!, payments: [bill("rent", 90_000)] }, pot!],
      ASOF,
    );
    const receiver = planOf(estate, "pot");
    expect(receiver.allocatedInflowMinor).toBe(10_000);
    expect(receiver.confirmedInflowMinor).toBe(10_000);
    expect(receiver.inflowArrivals[0]!.confirmedMinor).toBe(10_000);
  });

  it("ignores a confirmation of a movement that delivered nothing", () => {
    // The sender's bills eat everything, so nothing arrived to confirm.
    const [current, pot] = pair({
      confirmedArrivals: [{ inflowId: "to-pot", confirmedMinor: 30_000 }],
    });
    const estate = computeEstatePlan(
      [{ ...current!, payments: [bill("rent", 100_000)] }, pot!],
      ASOF,
    );
    expect(planOf(estate, "pot").allocatedInflowMinor).toBe(0);
    expect(planOf(estate, "pot").confirmedInflowMinor).toBe(0);
    expect(planOf(estate, "pot").inflowArrivals).toEqual([]);
  });

  it("adds a confirmed movement to a household's confirmed allocation", () => {
    const estate = computeEstatePlan(
      pair({
        inflow: { allocatedMinor: 40_000, confirmedMinor: 20_000 },
        confirmedArrivals: [{ inflowId: "to-pot", confirmedMinor: 30_000 }],
      }),
      ASOF,
    );
    const pot = planOf(estate, "pot");
    expect(pot.allocatedInflowMinor).toBe(70_000);
    // £200 of the household's £400, plus the whole £300 that moved internally.
    expect(pot.confirmedInflowMinor).toBe(50_000);
  });

  it("leaves a household's account exactly as it planned it before", () => {
    // A household bills pot receives no authored movement, so none of this
    // machinery touches it: its allocation and its confirmations are attributed
    // per member, elsewhere, and stay to the penny what they were.
    const bills = (over: Partial<AccountInput> = {}): AccountInput[] => [
      account("bills", {
        inflow: { allocatedMinor: 70_000, confirmedMinor: 40_000 },
        payments: [bill("rent", 30_000), bill("water", 40_000, 2)],
        ...over,
      }),
    ];
    const plain = computeEstatePlan(bills(), ASOF);
    const withRows = computeEstatePlan(
      bills({ confirmedArrivals: [{ inflowId: "not-here", confirmedMinor: 99_000 }] }),
      ASOF,
    );
    // The plan, to the penny — the input echo differs only by the rows handed
    // in, which is the caller's own copy coming back.
    expect(JSON.stringify(withRows.plans)).toBe(JSON.stringify(plain.plans));
    expect(JSON.stringify(withRows.movements)).toBe(JSON.stringify(plain.movements));
    expect(planOf(plain, "bills").confirmedInflowMinor).toBe(40_000);
    expect(planOf(plain, "bills").lines.map((l) => l.status)).toEqual([
      "funded",
      "awaiting_transfer",
    ]);
  });

  it("ignores a confirmation naming an inflow that arrives nowhere near here", () => {
    const estate = computeEstatePlan(
      pair({ confirmedArrivals: [{ inflowId: "some-other-row", confirmedMinor: 30_000 }] }),
      ASOF,
    );
    expect(planOf(estate, "pot").confirmedInflowMinor).toBe(0);
  });
});

describe("withoutArrival — taking one movement's money back out", () => {
  it("rebuilds the plan the account would have had without the movement", () => {
    const estate = computeEstatePlan(chain(), ASOF);
    const planned = estate.inputs[estate.order.indexOf("pot")]!;
    const before = computeAccountPlan(withoutArrival(planned, "to-pot"), ASOF);
    const after = computeAccountPlan(planned, ASOF);

    expect(before.allocatedInflowMinor).toBe(0);
    expect(before.lines[0]!.fundedFromInflowMinor).toBe(0);
    // The difference is what the movement paid for, and it is the movement's
    // own money — not a second copy of it.
    expect(after.lines[0]!.fundedFromInflowMinor - before.lines[0]!.fundedFromInflowMinor).toBe(
      120_000,
    );
  });

  it("leaves the household's allocation and the other movements alone", () => {
    const estate = computeEstatePlan(
      [
        account("a", {
          incomes: [external("a-pay", 100_000)],
          outboundInflows: [leaving("a-pot", 30_000, "pot")],
        }),
        account("b", {
          incomes: [external("b-pay", 100_000)],
          outboundInflows: [leaving("b-pot", 40_000, "pot")],
        }),
        account("pot", {
          inflows: [arriving("a-pot", 30_000, "a"), arriving("b-pot", 40_000, "b")],
          inflow: { allocatedMinor: 50_000, confirmedMinor: 50_000 },
          confirmedArrivals: [{ inflowId: "a-pot", confirmedMinor: 30_000 }],
          payments: [bill("bills", 120_000)],
        }),
      ],
      ASOF,
    );
    const planned = estate.inputs[estate.order.indexOf("pot")]!;
    const without = withoutArrival(planned, "a-pot");
    expect(without.inflow!.allocatedMinor).toBe(90_000);
    expect(without.inflow!.confirmedMinor).toBe(50_000);
    expect(without.inflow!.sources!.map((s) => s.inflowId)).toEqual(["b-pot"]);
  });

  it("takes an arrival out of an input nobody's pass built", () => {
    // Hand-built rather than taken off the pass: an arrival is allowed to say
    // nothing about what has been confirmed, and the amounts still come out.
    const without = withoutArrival(
      account("pot", {
        inflow: {
          allocatedMinor: 30_000,
          confirmedMinor: 0,
          sources: [{ inflowId: "to-pot", fromAccountId: "current", amountMinor: 30_000 }],
        },
      }),
      "to-pot",
    );
    expect(without.inflow).toEqual({ allocatedMinor: 0, confirmedMinor: 0, sources: [] });
  });

  it("hands an input straight back when the movement is not one of its arrivals", () => {
    const planned = { ...account("solo"), incomes: [external("salary", 100_000)] };
    expect(withoutArrival(planned, "nothing")).toBe(planned);
    const estate = computeEstatePlan(chain(), ASOF);
    const pot = estate.inputs[estate.order.indexOf("pot")]!;
    expect(withoutArrival(pot, "not-a-movement")).toBe(pot);
  });
});
