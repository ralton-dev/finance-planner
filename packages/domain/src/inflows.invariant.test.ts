import { describe, expect, it } from "vitest";
import { accountPlanFromScope, monthlyIncomeMinor, overviewFromPlans } from "./engine.js";
import {
  computeScopePlan,
  type ScopeAccountInput,
  type ScopeInput,
  type ScopePaymentInput,
} from "./scope.js";
import type { AccountPlan, InflowInput, OutboundInflowInput } from "./types.js";

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

const bill = (id: string, amountMinor: number, priority: number): ScopePaymentInput => ({
  id,
  name: id,
  category: "monthly_recurring",
  scope: "personal",
  amountMinor,
  dueDate: null,
  recurrence: null,
  targetDate: null,
  priority,
  alreadySavedMinor: 0,
  autoRenew: true,
  active: true,
});

const owned = (over: Partial<ScopeAccountInput> & { accountId: string }): ScopeAccountInput => ({
  currency: "GBP",
  role: "personal",
  memberUserId: "owner",
  // The name says it: these accounts are owned, and by the one member of a solo
  // scope unless a case names another (decision 15).
  ownerUserId: over.memberUserId ?? "owner",
  incomes: [],
  payments: [],
  ...over,
});

const solo = (...accounts: ScopeAccountInput[]): ScopeInput => ({
  scopeId: "owner",
  members: [{ userId: "owner", shareBp: 10_000 }],
  accounts,
});

/**
 * What the estate actually earns this month: external inflows only.
 *
 * This is the rule every cross-account figure has to obey. `InflowInput` is
 * structurally an `IncomeInput`, so the engine's own normalisation does the
 * arithmetic — no second implementation to drift.
 */
function estateMoneyInMinor(accounts: readonly ScopeAccountInput[], asOfDate: string): number {
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
function chain(): ScopeAccountInput[] {
  return [
    owned({
      accountId: "current",
      incomes: [external("salary", 500_000)],
      inflows: [external("salary", 500_000)],
      payments: [bill("rent", 100_000, 1)],
    }),
    owned({
      accountId: "pot",
      inflows: [fromAccount("current->pot", 300_000, "current", 10)],
      payments: [bill("bills", 300_000, 1)],
    }),
    owned({
      accountId: "savings",
      inflows: [fromAccount("pot->savings", 200_000, "pot", 10)],
      payments: [bill("emergency fund", 200_000, 1)],
    }),
    owned({
      accountId: "isa",
      inflows: [fromAccount("savings->isa", 100_000, "savings", 10)],
      payments: [bill("stocks", 100_000, 1)],
    }),
  ];
}

/**
 * The same chain with both faces of every movement, and a bill at each stop
 * small enough that money reaches the end of it. This is the shape the pass
 * plans: one salary, three hops, every pound spent exactly once.
 */
function sendingChain(): ScopeAccountInput[] {
  const [current, pot, savings, isa] = chain();
  return [
    { ...current!, outboundInflows: [leaving("current->pot", 300_000, "pot")] },
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

/** Every seeded account's plan, as the pass settled it and the view reports it. */
function plansOf(accounts: ScopeAccountInput[]): AccountPlan[] {
  const scope = solo(...accounts);
  const plan = computeScopePlan(scope, ASOF);
  return accounts.map((a) => accountPlanFromScope(scope, plan, a.accountId));
}

describe("the estate-wide money-in invariant", () => {
  it("counts only external inflows, at every depth of the chain", () => {
    const accounts = chain();
    expect(estateMoneyInMinor(accounts, ASOF)).toBe(500_000);

    // The whole point: adding account-sourced inflows — any number of them, at
    // any depth — cannot move the figure. Three more hops, same answer.
    const deeper = [
      ...accounts,
      owned({
        accountId: "isa-2",
        inflows: [
          fromAccount("isa->isa2", 50_000, "isa", 10),
          fromAccount("current->isa2", 25_000, "current", 20),
          fromAccount("pot->isa2", 10_000, "pot", 30),
        ],
      }),
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
    const asItWas = owned({
      accountId: "current",
      incomes: [external("salary", 500_000)],
      payments: [bill("rent", 100_000, 1)],
    });
    const [asItIs] = chain();
    expect(plansOf([asItIs!])[0]).toEqual(plansOf([asItWas])[0]);
    // Deep-equal is not the claim; the serialised plan is.
    expect(JSON.stringify(plansOf([asItIs!])[0])).toBe(JSON.stringify(plansOf([asItWas])[0]));

    // And an account-sourced inflow authored on it changes nothing either: the
    // arriving face names a sender the scope cannot see, which is reported as an
    // unsourced movement and funds no part of this account's month.
    const sending: ScopeAccountInput = {
      ...asItIs!,
      inflows: [...asItIs!.inflows!, fromAccount("current->pot", 300_000, "elsewhere", 10)],
    };
    expect(JSON.stringify(plansOf([sending])[0])).toBe(JSON.stringify(plansOf([asItWas])[0]));
  });

  it("keeps the currency rollup's income honest across the chain", () => {
    // The pass plans from `incomes`, and `plan.ts` puts only external rows
    // there. So no account-sourced inflow — however deep — can reach
    // `monthlyIncomeMinor`, in one plan or in the rollup over four.
    const overview = overviewFromPlans(plansOf(sendingChain()), ASOF);
    expect(overview.perCurrency).toHaveLength(1);
    expect(overview.perCurrency[0]!.monthlyIncomeMinor).toBe(500_000);
  });
});

/**
 * The rollup double-flavour, and the pass that dissolved it.
 *
 * `computeOverview` used to sum `totalFundedMinor` (which includes what arriving
 * money paid for) and `leftoverMinor` (which counted the *sending* account's
 * money as its own surplus even after it left). Per account both were right.
 * Summed, the same pounds were counted at both ends, once per hop of the chain —
 * £8,000 accounted for out of £5,000 earned, at depth three — and WP-G netted the
 * difference back out at rollup time.
 *
 * There is one pass now, and the sending account's surplus is already net of what
 * leaves it, so there is nothing left to net. The netting term is deleted with
 * the engine that needed it (ONE-ENGINE.md, WP-S), and these are the assertions
 * that say the identity survived its removal.
 */
describe("the rollup adds up without netting anything", () => {
  const rolled = (accounts = sendingChain()) => overviewFromPlans(plansOf(accounts), ASOF);

  it("still counts income from external inflows alone", () => {
    expect(rolled().perCurrency[0]!.monthlyIncomeMinor).toBe(500_000);
  });

  it("counts every pound exactly once, with no term left over to subtract", () => {
    const bucket = rolled().perCurrency[0]!;
    const raw = plansOf(sendingChain()).reduce((sum, p) => sum + p.leftoverMinor, 0);
    // Each stop's bill is covered by the transfer the pass derives for it; the
    // authored movements carry the surplus on afterwards, as savings.
    expect(bucket.totalFundedMinor).toBe(400_000);
    expect(raw).toBe(100_000);
    expect(bucket.leftoverMinor).toBe(100_000);
    // £5,000 accounted for out of £5,000 earned — no netting anywhere.
    expect(bucket.totalFundedMinor + bucket.leftoverMinor).toBe(bucket.monthlyIncomeMinor);
  });

  it("holds at every depth of the chain, not just the end of it", () => {
    // Two hops and four: the same identity, so the error cannot be hiding in
    // the fixture's length.
    for (const depth of [2, 3, 4]) {
      const bucket = rolled(sendingChain().slice(0, depth)).perCurrency[0]!;
      expect(bucket.totalFundedMinor + bucket.leftoverMinor).toBe(bucket.monthlyIncomeMinor);
    }
  });

  it("does not subtract a co-member's transfer from a rollup that never counted it", () => {
    // The trap the old netting term walked into. `internalInflowUsedMinor` meant
    // "inflow the bills consumed that came from another account of the *scope*",
    // and a scope contains Bob's account while Alice's rollup does not. Netted,
    // Bob's £400 would come off Alice's surplus — money she never had, taken from
    // a total it was never in.
    const shared: ScopeInput = {
      scopeId: "hh",
      householdId: "hh",
      members: [
        { userId: "alice", shareBp: 5_000 },
        { userId: "bob", shareBp: 5_000 },
      ],
      accounts: [
        owned({
          accountId: "alice-cur",
          memberUserId: "alice",
          incomes: [external("alice-pay", 300_000)],
        }),
        owned({
          accountId: "bob-cur",
          memberUserId: "bob",
          incomes: [external("bob-pay", 300_000)],
        }),
        owned({
          accountId: "bills",
          role: "shared",
          memberUserId: null,
          payments: [{ ...bill("rent", 80_000, 1), scope: "shared" }],
        }),
      ],
    };
    const plan = computeScopePlan(shared, ASOF);
    // Alice's rollup: her own account and the shared pot she can see. Bob's is
    // in the scope — it has to be, his money pays half the rent — and out of the
    // rollup, because it is not hers.
    const bucket = overviewFromPlans(
      ["alice-cur", "bills"].map((id) => accountPlanFromScope(shared, plan, id)),
      ASOF,
    ).perCurrency[0]!;
    expect(bucket.monthlyIncomeMinor).toBe(300_000);
    expect(bucket.totalFundedMinor).toBe(80_000);
    // £3,000 in, £400 of rent gone: £2,600 left, and not a penny of Bob's
    // transfer subtracted from it.
    expect(bucket.leftoverMinor).toBe(260_000);
  });
});

/**
 * The transfer that funded nothing — WP-AA's repro, and WP-AB's completion
 * signal.
 *
 * Alice has a current account her £3,000 salary lands in (her source account,
 * decision 11) and a savings account earning £50 a month with a £40 subscription
 * on it. Nothing here is exotic. The pass derived `current → savings £40`
 * anyway, because phase 3 emitted transport for **every** funded obligation
 * whose account was not the member's source account, and never asked whether the
 * destination already held the money.
 *
 * It did. Phase 4 funded the subscription out of savings' own income
 * (`fundedFromOwn 4000, fundedFromInflow 0`), the £40 arrived and sat, and two
 * things were wrong with it: `needsYou` and the transfer checklist asked Alice
 * to move £40 that paid for nothing, and the rollup identity came out at
 * £3,010 against £3,050 — short by exactly the transfer, which
 * `ownLeftoverMinor` subtracted at the sender and no account counted at the
 * destination.
 *
 * Decision 9 always said transport was for "an in-scope account with obligations
 * **and no income**". The netting was in the wording and not in the code.
 */
describe("the transfer nobody needed to make", () => {
  const repro = solo(
    owned({ accountId: "current", incomes: [external("salary", 300_000)] }),
    owned({
      accountId: "savings",
      incomes: [external("interest", 5_000)],
      payments: [bill("subscription", 4_000, 10)],
    }),
  );

  it("derives no transport for an account already holding the money", () => {
    const plan = computeScopePlan(repro, ASOF);
    expect(plan.transfers).toEqual([]);
    // Funded exactly as it was — out of savings' own income, which is the whole
    // reason the transfer was never needed.
    const line = plan.lines.find((l) => l.paymentId === "subscription")!;
    expect(line.fundedMonthlyMinor).toBe(4_000);
    expect(line.fundedFromOwnMinor).toBe(4_000);
    expect(line.fundedFromInflowMinor).toBe(0);
  });

  it("adds up: funded plus left over is what came in", () => {
    const plan = computeScopePlan(repro, ASOF);
    const bucket = overviewFromPlans(
      ["current", "savings"].map((id) => accountPlanFromScope(repro, plan, id)),
      ASOF,
    ).perCurrency[0]!;
    expect(bucket.monthlyIncomeMinor).toBe(305_000);
    expect(bucket.bufferMinor).toBe(0);
    expect(bucket.totalFundedMinor).toBe(4_000);
    // £3,010 before: £2,960 of it in the current account, the £40 gone.
    expect(bucket.leftoverMinor).toBe(301_000);
    expect(bucket.totalFundedMinor + bucket.leftoverMinor).toBe(
      bucket.monthlyIncomeMinor - bucket.bufferMinor,
    );
  });

  it("still transports what the destination's own income cannot reach", () => {
    // The same fixture with the subscription raised past the interest: £30 of it
    // is the account's own money, £10 has to travel. Netting is not a switch.
    const short = solo(
      owned({ accountId: "current", incomes: [external("salary", 300_000)] }),
      owned({
        accountId: "savings",
        incomes: [external("interest", 3_000)],
        payments: [bill("subscription", 4_000, 10)],
      }),
    );
    const plan = computeScopePlan(short, ASOF);
    expect(plan.transfers).toMatchObject([
      { fromAccountId: "current", toAccountId: "savings", amountMinor: 1_000 },
    ]);
    const bucket = overviewFromPlans(
      ["current", "savings"].map((id) => accountPlanFromScope(short, plan, id)),
      ASOF,
    ).perCurrency[0]!;
    expect(bucket.totalFundedMinor + bucket.leftoverMinor).toBe(bucket.monthlyIncomeMinor);
  });
});
