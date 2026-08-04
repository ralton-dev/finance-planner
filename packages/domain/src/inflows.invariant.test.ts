import { describe, expect, it } from "vitest";
import { computeAccountPlan, computeOverview, monthlyIncomeMinor } from "./engine.js";
import { computeEstatePlan } from "./estate.js";
import type { AccountInput, InflowInput, OutboundInflowInput, PaymentInput } from "./types.js";

/**
 * The invariant, asserted rather than assumed:
 *
 * > Total money in comes only from `source: "external"`. Everything else is
 * > redistribution of money already counted.
 *
 * It is asserted over a **chain** — current → bills pot → savings → ISA — and
 * not over a pair, because that is where getting it wrong actually shows. Two
 * accounts inflate the estate's income once and the figure still looks plausible;
 * a chain inflates it at every hop, and a fixture with one account cannot lie
 * about it at all.
 */

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

const fromAccount = (
  id: string,
  amountMinor: number,
  sourceAccountId: string,
  priority: number,
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

const bill = (id: string, amountMinor: number, priority: number): PaymentInput => ({
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

/**
 * What the estate actually earns this month: external inflows only.
 *
 * This is the rule every cross-account figure has to obey. `InflowInput` is
 * structurally an `IncomeInput`, so the engine's own normalisation does the
 * arithmetic — no second implementation to drift.
 */
function estateMoneyInMinor(accounts: AccountInput[], asOfDate: string): number {
  const now = new Date(`${asOfDate}T00:00:00.000Z`);
  return accounts
    .flatMap((a) => a.inflows ?? [])
    .filter((i) => i.source === "external")
    .reduce((sum, i) => sum + monthlyIncomeMinor(i, now), 0);
}

/**
 * Four accounts, one salary, and money walking three hops down the chain — the
 * shape `apps/api/src/plan.ts` now loads out of `core.inflows`: external rows
 * become `incomes`, account-sourced rows travel on `inflows` and reach no
 * income figure.
 */
function chain(): AccountInput[] {
  const current: AccountInput = {
    accountId: "current",
    currency: "GBP",
    incomes: [external("salary", 500_000)],
    inflows: [external("salary", 500_000)],
    payments: [bill("rent", 100_000, 1)],
  };
  const pot: AccountInput = {
    accountId: "pot",
    currency: "GBP",
    incomes: [],
    inflows: [fromAccount("current->pot", 300_000, "current", 10)],
    payments: [bill("bills", 300_000, 1)],
  };
  const savings: AccountInput = {
    accountId: "savings",
    currency: "GBP",
    incomes: [],
    inflows: [fromAccount("pot->savings", 200_000, "pot", 10)],
    payments: [bill("emergency fund", 200_000, 1)],
  };
  const isa: AccountInput = {
    accountId: "isa",
    currency: "GBP",
    incomes: [],
    inflows: [fromAccount("savings->isa", 100_000, "savings", 10)],
    payments: [bill("stocks", 100_000, 1)],
  };
  return [current, pot, savings, isa];
}

/** The leaving face of a movement — the same row, read from the sender. */
const leaving = (id: string, amountMinor: number, toAccountId: string): OutboundInflowInput => ({
  id,
  toAccountId,
  amountMinor,
  frequency: "monthly",
  recurrence: null,
  anchorDate: "2026-08-25",
  active: true,
  priority: 10,
});

/**
 * The same chain with both faces of every movement, and a bill at each stop
 * small enough that money reaches the end of it. This is the shape the estate
 * pass plans: one salary, three hops, every pound spent exactly once.
 */
function sendingChain(): AccountInput[] {
  const [current, pot, savings, isa] = chain();
  return [
    {
      ...current!,
      outboundInflows: [leaving("current->pot", 300_000, "pot")],
    },
    {
      ...pot!,
      payments: [bill("bills", 100_000, 1)],
      outboundInflows: [leaving("pot->savings", 200_000, "savings")],
    },
    {
      ...savings!,
      payments: [bill("emergency fund", 100_000, 1)],
      outboundInflows: [leaving("savings->isa", 100_000, "isa")],
    },
    isa!,
  ];
}

describe("the estate-wide money-in invariant", () => {
  it("counts only external inflows, at every depth of the chain", () => {
    const accounts = chain();
    expect(estateMoneyInMinor(accounts, ASOF)).toBe(500_000);

    // The whole point: adding account-sourced inflows — any number of them, at
    // any depth — cannot move the figure. Three more hops, same answer.
    const deeper = [
      ...accounts,
      {
        accountId: "isa-2",
        currency: "GBP",
        incomes: [],
        inflows: [
          fromAccount("isa->isa2", 50_000, "isa", 10),
          fromAccount("current->isa2", 25_000, "current", 20),
          fromAccount("pot->isa2", 10_000, "pot", 30),
        ],
        payments: [],
      } satisfies AccountInput,
    ];
    expect(estateMoneyInMinor(deeper, ASOF)).toBe(500_000);
  });

  it("would inflate income once per hop if account-sourced rows were counted", () => {
    // The failure being guarded against, spelled out so it is unmistakable: fold
    // every inflow into "money in" and one salary reads as £11,000 of income.
    const naive = chain()
      .flatMap((a) => a.inflows ?? [])
      .reduce((sum, i) => sum + i.amountMinor, 0);
    expect(naive).toBe(1_100_000);
    expect(naive).toBeGreaterThan(estateMoneyInMinor(chain(), ASOF));
  });

  it("plans an externally-funded account byte-identically to before inflows existed", () => {
    // The account as the engine has always been handed it: incomes, payments,
    // and no notion of an inflow record.
    const asItWas: AccountInput = {
      accountId: "current",
      currency: "GBP",
      incomes: [external("salary", 500_000)],
      payments: [bill("rent", 100_000, 1)],
    };
    const [asItIs] = chain();
    expect(computeAccountPlan(asItIs!, ASOF)).toEqual(computeAccountPlan(asItWas, ASOF));
    // Deep-equal is not the claim; the serialised plan is.
    expect(JSON.stringify(computeAccountPlan(asItIs!, ASOF))).toBe(
      JSON.stringify(computeAccountPlan(asItWas, ASOF)),
    );

    // And an account-sourced inflow authored on it changes nothing either: the
    // records are stored and carried, and the engine does not read them yet.
    const sending: AccountInput = {
      ...asItIs!,
      inflows: [...asItIs!.inflows!, fromAccount("current->pot", 300_000, "current", 10)],
    };
    expect(JSON.stringify(computeAccountPlan(sending, ASOF))).toBe(
      JSON.stringify(computeAccountPlan(asItWas, ASOF)),
    );
  });

  it("keeps the currency rollup's income honest across the chain", () => {
    // The engine plans from `incomes`, and `plan.ts` puts only external rows
    // there. So no account-sourced inflow — however deep — can reach
    // `monthlyIncomeMinor`, in one plan or in the rollup over four.
    const plans = chain().map((a) => computeAccountPlan(a, ASOF));
    const overview = computeOverview(plans, ASOF);
    expect(overview.perCurrency).toHaveLength(1);
    expect(overview.perCurrency[0]!.monthlyIncomeMinor).toBe(500_000);
  });
});

/**
 * The rollup double-flavour, and its fix.
 *
 * `computeOverview` sums `totalFundedMinor` (which includes inflow-funded
 * amounts) and `leftoverMinor` (which, by WP-A's deliberate choice, still counts
 * the paying account's money as its own surplus). Per account both are right.
 * Summed, the same pounds were counted at both ends, once per hop of the chain —
 * £11,000 accounted for out of £5,000 earned, at depth three.
 *
 * WP-G nets the intra-estate movement out at rollup time. The netted term is the
 * inflow the receiving accounts actually **spent**, not the whole allocation:
 * allocation that arrived and was never needed is still sitting where it landed
 * and is still counted once, in the sending account's leftover.
 */
describe("the rollup nets money moving between your own accounts", () => {
  /** The chain planned as one estate, which is the only way the pass can know
   *  the movements are internal. Each stop spends exactly what reaches it. */
  const rolled = () => {
    const estate = computeEstatePlan(sendingChain(), ASOF);
    return { estate, bucket: computeOverview(estate.plans, ASOF).perCurrency[0]! };
  };

  it("still counts income from external inflows alone", () => {
    expect(rolled().bucket.monthlyIncomeMinor).toBe(500_000);
  });

  it("names the double-counted amount instead of absorbing it", () => {
    const { estate, bucket } = rolled();
    const raw = estate.plans.reduce((sum, p) => sum + p.leftoverMinor, 0);

    // The un-netted figures, unchanged: every per-account number is still right
    // on its own, which is why the fix belongs in the rollup and nowhere else.
    // The current account still reports the money it sent as its own surplus.
    expect(bucket.totalFundedMinor).toBe(400_000);
    expect(raw).toBe(400_000);
    // £8,000 accounted for out of £5,000 earned — the old answer.
    expect(bucket.totalFundedMinor + raw).toBe(800_000);

    // And the gap is exactly what moved between the user's own accounts: £1,000
    // spent at each of the three stops down the chain.
    expect(bucket.intraEstateMovementMinor).toBe(300_000);
    expect(bucket.totalFundedMinor + raw - bucket.intraEstateMovementMinor).toBe(
      bucket.monthlyIncomeMinor,
    );
  });

  it("makes the estate add up: funded plus left over is what came in", () => {
    const { bucket } = rolled();
    expect(bucket.leftoverMinor).toBe(100_000);
    expect(bucket.totalFundedMinor + bucket.leftoverMinor).toBe(bucket.monthlyIncomeMinor);
  });

  it("holds at every depth of the chain, not just the end of it", () => {
    // Two hops and four: the same identity, so the error cannot be hiding in
    // the fixture's length.
    for (const depth of [2, 3, 4]) {
      const estate = computeEstatePlan(sendingChain().slice(0, depth), ASOF);
      const bucket = computeOverview(estate.plans, ASOF).perCurrency[0]!;
      expect(bucket.totalFundedMinor + bucket.leftoverMinor).toBe(bucket.monthlyIncomeMinor);
    }
  });

  it("leaves a household allocation alone, because it is not the estate's money", () => {
    // Nothing in this rollup sent it, so there is nothing to net: a pot funded
    // by a partner's account rolls up exactly as it did before WP-G.
    const [current, pot] = chain();
    const plans = [
      computeAccountPlan(current!, ASOF),
      computeAccountPlan(
        { ...pot!, inflow: { allocatedMinor: 300_000, confirmedMinor: 300_000 } },
        ASOF,
      ),
    ];
    const bucket = computeOverview(plans, ASOF).perCurrency[0]!;
    expect(bucket.intraEstateMovementMinor).toBe(0);
    expect(bucket.leftoverMinor).toBe(400_000);
    expect(bucket.totalFundedMinor).toBe(400_000);
  });
});
