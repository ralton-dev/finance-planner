import { describe, expect, it } from "vitest";
import { computeAccountPlan, computeOverview, monthlyIncomeMinor } from "./engine.js";
import type { AccountInput, InflowInput, PaymentInput } from "./types.js";

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
 * Evidence for WP-G, not a defect this work fixes.
 *
 * `computeOverview` sums `totalFundedMinor` (which includes inflow-funded
 * amounts) and `leftoverMinor` (which, by WP-A's deliberate choice, still counts
 * the paying account's money as its own surplus). Per account both are right.
 * Summed, the same pounds are counted at both ends, and the chain does it once
 * per hop.
 *
 * The overstatement is exactly `Σ allocatedInflowMinor` — pinned below so WP-G
 * can see the number move when it decides what to do.
 */
describe("the rollup double-flavour (WP-G's decision, pinned here)", () => {
  const allocatedChain = (): AccountInput[] => {
    const [current, pot, savings, isa] = chain();
    return [
      current!,
      { ...pot!, inflow: { allocatedMinor: 300_000, confirmedMinor: 300_000 } },
      { ...savings!, inflow: { allocatedMinor: 200_000, confirmedMinor: 200_000 } },
      { ...isa!, inflow: { allocatedMinor: 100_000, confirmedMinor: 100_000 } },
    ];
  };

  it("overstates the estate by the allocated inflow, once per hop", () => {
    const accounts = allocatedChain();
    const plans = accounts.map((a) => computeAccountPlan(a, ASOF));
    const bucket = computeOverview(plans, ASOF).perCurrency[0]!;

    const allocated = plans.reduce((sum, p) => sum + p.allocatedInflowMinor, 0);
    expect(allocated).toBe(600_000);

    // Income is right. Everything derived from it is not.
    expect(bucket.monthlyIncomeMinor).toBe(500_000);
    expect(bucket.totalFundedMinor).toBe(700_000);
    // The current account still reports the money it is sending as its own
    // surplus — it has no idea the money left.
    expect(bucket.leftoverMinor).toBe(400_000);

    // £11,000 accounted for out of £5,000 earned. The gap is the allocation,
    // counted once at each end of every hop.
    expect(bucket.totalFundedMinor + bucket.leftoverMinor).toBe(1_100_000);
    expect(bucket.totalFundedMinor + bucket.leftoverMinor - bucket.monthlyIncomeMinor).toBe(
      allocated,
    );

    // What a netted rollup would say — and what makes it add up: money in is
    // funded plus left over, no more.
    expect(bucket.totalFundedMinor + bucket.leftoverMinor - allocated).toBe(
      bucket.monthlyIncomeMinor,
    );
  });
});
