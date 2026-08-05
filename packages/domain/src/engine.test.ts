import { describe, expect, it } from "vitest";
import { accountPlanFromScope, monthlyIncomeMinor, requiredMonthlyForPayment } from "./engine.js";
import { parseISODate } from "./dates.js";
import { computeScopePlan, type ScopeInput } from "./scope.js";
import type { AccountPlan, IncomeInput, PaymentInput } from "./types.js";

const AS_OF = "2026-01-01";
const now = parseISODate(AS_OF);

describe("monthlyIncomeMinor", () => {
  it("passes monthly income through unchanged", () => {
    const income: IncomeInput = {
      id: "i1",
      amountMinor: 200_000,
      frequency: "monthly",
      anchorDate: AS_OF,
    };
    expect(monthlyIncomeMinor(income, now)).toBe(200_000);
  });

  it("spreads yearly income over 12 months", () => {
    const income: IncomeInput = {
      id: "i2",
      amountMinor: 120_000,
      frequency: "yearly",
      anchorDate: AS_OF,
    };
    expect(monthlyIncomeMinor(income, now)).toBe(10_000);
  });

  it("excludes inactive income", () => {
    const income: IncomeInput = {
      id: "i3",
      amountMinor: 999_999,
      frequency: "monthly",
      anchorDate: AS_OF,
      active: false,
    };
    expect(monthlyIncomeMinor(income, now)).toBe(0);
  });
});

describe("requiredMonthlyForPayment", () => {
  it("fixed_point: spreads remaining over months until target", () => {
    const p: PaymentInput = {
      id: "p1",
      name: "Holiday",
      category: "fixed_point",
      amountMinor: 120_000,
      dueDate: "2026-09-01",
    };
    // 8 months out → 120000 / 8 = 15000
    expect(requiredMonthlyForPayment(p, now).requiredMinor).toBe(15_000);
  });

  it("fixed_point: accounts for already-saved amount", () => {
    const p: PaymentInput = {
      id: "p1",
      name: "Holiday",
      category: "fixed_point",
      amountMinor: 120_000,
      alreadySavedMinor: 40_000,
      dueDate: "2026-09-01",
    };
    // (120000 - 40000) / 8 = 10000
    expect(requiredMonthlyForPayment(p, now).requiredMinor).toBe(10_000);
  });

  it("yearly_recurring: saves toward the next occurrence", () => {
    const p: PaymentInput = {
      id: "p2",
      name: "Car insurance",
      category: "yearly_recurring",
      amountMinor: 32_000,
      dueDate: "2026-06-01",
    };
    // 5 months out → 32000 / 5 = 6400
    expect(requiredMonthlyForPayment(p, now).requiredMinor).toBe(6_400);
  });

  it("monthly_recurring: full amount due each month", () => {
    const p: PaymentInput = {
      id: "p3",
      name: "Phone",
      category: "monthly_recurring",
      amountMinor: 4_500,
    };
    const r = requiredMonthlyForPayment(p, now);
    expect(r.requiredMinor).toBe(4_500);
    expect(r.monthsUntilDue).toBe(1);
    expect(r.occurrencesThisMonth).toBe(1);
  });

  it("custom_recurring: spreads over months until next occurrence", () => {
    const p: PaymentInput = {
      id: "p4",
      name: "Water",
      category: "custom_recurring",
      amountMinor: 9_000,
      dueDate: "2026-03-01",
      recurrence: { interval: 3, unit: "month", anchor: "2026-03-01" },
    };
    // next due 2026-03-01, 2 months out → 9000 / 2 = 4500; nothing falls in Jan.
    const r = requiredMonthlyForPayment(p, now);
    expect(r.requiredMinor).toBe(4_500);
    expect(r.occurrencesThisMonth).toBe(1);
  });

  it("custom_recurring: charges every occurrence that lands this month", () => {
    const p: PaymentInput = {
      id: "p4b",
      name: "Butternut",
      category: "custom_recurring",
      amountMinor: 8_213,
      dueDate: "2026-01-08",
      recurrence: { interval: 2, unit: "week", anchor: "2026-01-08" },
    };
    // 01-08 and 01-22 both fall in January → 2 × 8213, due this month.
    const r = requiredMonthlyForPayment(p, now);
    expect(r.requiredMinor).toBe(16_426);
    expect(r.monthsUntilDue).toBe(1);
    expect(r.effectiveDate).toBe("2026-01-08");
    expect(r.occurrencesThisMonth).toBe(2);
  });

  it("custom_recurring: counts three occurrences in a straddling month", () => {
    const p: PaymentInput = {
      id: "p4c",
      name: "Fortnightly",
      category: "custom_recurring",
      amountMinor: 1_000,
      dueDate: "2026-01-01",
      recurrence: { interval: 2, unit: "week", anchor: "2026-01-01" },
    };
    // 01-01, 01-15, 01-29 → 3 × 1000.
    expect(requiredMonthlyForPayment(p, now).requiredMinor).toBe(3_000);
  });

  it("target date in the past requires the full remaining now", () => {
    const p: PaymentInput = {
      id: "p5",
      name: "Overdue",
      category: "fixed_point",
      amountMinor: 50_000,
      dueDate: "2025-01-01",
    };
    const r = requiredMonthlyForPayment(p, now);
    expect(r.monthsUntilDue).toBe(1);
    expect(r.requiredMinor).toBe(50_000);
  });
});

// =============================================================================
// The account plan, as a view of the one pass
// =============================================================================

/**
 * The account plan stops being a computation and becomes a projection.
 *
 * The pin below is the regression this whole package has to be provably free
 * of, taken one level further than WP-P took it: not only must the *pass* plan a
 * solo user's month exactly as the account engine did, the `AccountPlan` the
 * view builds out of it must be the same object, field for field — statuses,
 * completion dates, passthroughs and all. Anything less and "the account page
 * shows the same numbers because they are the same numbers" is a claim about
 * arithmetic nobody checked.
 */
/**
 * The `AccountPlan` `computeAccountPlan` produced for the fixture below, at
 * `40f65d8` — the commit before it was deleted.
 *
 * Captured rather than recomputed, because the engine it came from is gone: a
 * pin against a function you also deleted is no pin at all, and re-deriving the
 * expectation from the code under test would make it agree with itself. The one
 * field dropped is `internalInflowUsedMinor`, which existed solely to feed the
 * rollup netting deleted with it (see `overviewFromPlans`).
 *
 * Three fields have been *added* since. `confirmedTransferMinor` is the derived
 * half of `confirmedInflowMinor`, which line statuses are now decided against
 * (WP-V); `transferOutMinor` is the derived transport leaving, published rather
 * than left for the account page to recover from `leftoverMinor`'s identity
 * (WP-Y); `transferDepartures` is that same transport itemised by far end
 * (WP-AH). Nothing arrives at this account and nothing is derived out of it, so
 * all three are empty or zero and no figure here moves; the pin is otherwise
 * untouched.
 *
 * Two more were added **alongside** rather than into it, and the type names them
 * rather than leaving a reader to notice: `residualMinor`, what is really in the
 * account at the end of the month (a different question from `leftoverMinor` —
 * see below), and `ownerUserId`, whose account it is, which is the boundary
 * every personal figure is now counted on (`MINE-AND-OURS.md`, decision 20).
 * The photograph predates both, so it is typed as the plan without them and the
 * comparison strips them off the view — which is the pin's claim exactly: every
 * field the account engine produced, byte for byte, and nothing quietly moved
 * underneath the ones that were added since.
 */
const ACCOUNT_ENGINE_AT_40F65D8: Omit<AccountPlan, "ownerUserId" | "residualMinor"> = {
  accountId: "current",
  asOfDate: "2026-01-01",
  currency: "GBP",
  monthlyIncomeMinor: 150000,
  allocatedInflowMinor: 0,
  confirmedInflowMinor: 0,
  confirmedTransferMinor: 0,
  bufferMinor: 20000,
  totalRequiredMinor: 163462,
  totalFundedMinor: 130000,
  leftoverMinor: 0,
  shortfallMinor: 33462,
  inflowArrivals: [],
  outboundInflowMinor: 0,
  transferOutMinor: 0,
  transferDepartures: [],
  outboundInflows: [],
  lines: [
    {
      paymentId: "rent",
      name: "rent",
      category: "monthly_recurring",
      amountMinor: 120000,
      dueDate: "2026-01-15",
      targetDate: "2026-01-15",
      dueDateIsDerived: false,
      monthsUntilDue: 1,
      requiredMonthlyMinor: 120000,
      fundedMonthlyMinor: 120000,
      fundedFromOwnMinor: 120000,
      fundedFromInflowMinor: 0,
      alreadySavedMinor: 0,
      occurrencesThisMonth: 1,
      onTrack: true,
      status: "funded",
      fixedMonthlyMinor: null,
      tag: null,
    },
    {
      paymentId: "holiday",
      name: "holiday",
      category: "fixed_point",
      amountMinor: 240000,
      dueDate: "2027-02-01",
      targetDate: "2027-02-01",
      dueDateIsDerived: false,
      monthsUntilDue: 13,
      requiredMonthlyMinor: 18462,
      fundedMonthlyMinor: 10000,
      fundedFromOwnMinor: 10000,
      fundedFromInflowMinor: 0,
      alreadySavedMinor: 0,
      occurrencesThisMonth: 1,
      onTrack: false,
      status: "at_risk",
      projectedCompletionDate: "2028-01-01",
      fixedMonthlyMinor: null,
      tag: null,
    },
    {
      paymentId: "gym",
      name: "gym",
      category: "monthly_recurring",
      amountMinor: 5000,
      dueDate: "2026-01-01",
      targetDate: "2026-01-01",
      dueDateIsDerived: false,
      monthsUntilDue: 1,
      requiredMonthlyMinor: 5000,
      fundedMonthlyMinor: 0,
      fundedFromOwnMinor: 0,
      fundedFromInflowMinor: 0,
      alreadySavedMinor: 0,
      occurrencesThisMonth: 1,
      onTrack: false,
      status: "at_risk",
      projectedCompletionDate: "2442-09-01",
      fixedMonthlyMinor: null,
      tag: null,
    },
    {
      paymentId: "laptop",
      name: "laptop",
      category: "fixed_point",
      amountMinor: 90000,
      dueDate: "2026-02-01",
      targetDate: "2026-02-01",
      dueDateIsDerived: false,
      monthsUntilDue: 1,
      requiredMonthlyMinor: 20000,
      fundedMonthlyMinor: 0,
      fundedFromOwnMinor: 0,
      fundedFromInflowMinor: 0,
      alreadySavedMinor: 0,
      occurrencesThisMonth: 1,
      onTrack: false,
      status: "at_risk",
      projectedCompletionDate: "9526-01-01",
      fixedMonthlyMinor: 20000,
      tag: null,
    },
  ],
};

describe("accountPlanFromScope — a solo user with one account does not move", () => {
  /** Deliberately hostile: the budget runs out mid-order, two payments tie on
   *  priority with sort keys the two engines used to disagree about, a buffer
   *  bites, one payment is retired, and one goal is contribution-capped. */
  const soloScope: ScopeInput = {
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      {
        accountId: "current",
        currency: "GBP",
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        monthlyBufferMinor: 20_000,
        incomes: [{ id: "inc", amountMinor: 150_000, frequency: "monthly", anchorDate: AS_OF }],
        payments: [
          {
            id: "rent",
            name: "rent",
            category: "monthly_recurring",
            scope: "personal",
            amountMinor: 120_000,
            dueDate: "2026-01-15",
            priority: 1,
          },
          {
            id: "holiday",
            name: "holiday",
            category: "fixed_point",
            scope: "personal",
            amountMinor: 240_000,
            targetDate: "2027-02-01",
            priority: 50,
          },
          {
            id: "gym",
            name: "gym",
            category: "monthly_recurring",
            scope: "personal",
            amountMinor: 5_000,
            priority: 50,
          },
          {
            id: "laptop",
            name: "laptop",
            category: "fixed_point",
            scope: "personal",
            amountMinor: 90_000,
            fixedMonthlyMinor: 20_000,
            dueDate: "2026-02-01",
            priority: 60,
          },
          {
            id: "retired",
            name: "retired",
            category: "monthly_recurring",
            scope: "personal",
            amountMinor: 99_000,
            priority: 2,
            active: false,
          },
        ],
      },
    ],
  };

  const view = accountPlanFromScope(soloScope, computeScopePlan(soloScope, AS_OF), "current");

  it("builds byte-identically the AccountPlan the account engine built", () => {
    // `computeAccountPlan` is deleted (ONE-ENGINE.md, WP-S), so the thing to
    // compare against is its answer rather than another call to it: this is the
    // plan it produced for this fixture at `40f65d8`, captured verbatim, less
    // the `internalInflowUsedMinor` field that died with the rollup netting it
    // existed to feed. The comparison the pin used to make is preserved exactly
    // — the same fixture, the same date, the same bytes — and it now survives
    // the deletion of the engine it was pinning against, which a call could not.
    // Typed `Partial` so both additive fields can be deleted: they are required
    // on the plan now, and `delete` wants an optional operand. Deleting leaves
    // the insertion order of everything else alone, which is what the second
    // assertion checks.
    const same: Partial<AccountPlan> = { ...view };
    delete same.ownerUserId;
    delete same.residualMinor;
    expect(same).toEqual(ACCOUNT_ENGINE_AT_40F65D8);
    // Deep-equal is not the claim; the serialised plan is, field order included.
    expect(JSON.stringify(same)).toBe(JSON.stringify(ACCOUNT_ENGINE_AT_40F65D8));
  });

  it("adds the residual alongside, changing nothing that was already there", () => {
    // The decision-13 pattern. `leftoverMinor` is the account's own surplus
    // after its own obligations and is zero here — the buffer ate it. The
    // residual is what is really in the account at the end of the month, which
    // is the buffer, and it is a different question with a different answer.
    expect(view.leftoverMinor).toBe(0);
    expect(view.residualMinor).toBe(20_000);
    expect("residualMinor" in ACCOUNT_ENGINE_AT_40F65D8).toBe(false);
    // And whose account it is, off the pass rather than looked up beside it:
    // the boundary a personal figure is counted on (decision 20).
    expect(view.ownerUserId).toBe("owner");
    expect("ownerUserId" in ACCOUNT_ENGINE_AT_40F65D8).toBe(false);
  });

  it("runs out of money in the same place, on the same bill", () => {
    // Named, so the pin above cannot pass by two identical wrong answers: the
    // budget really does run out, and it runs out on the holiday.
    expect(view.lines.map((l) => l.paymentId)).toEqual(["rent", "holiday", "gym", "laptop"]);
    expect(view.lines.map((l) => l.fundedMonthlyMinor)).toEqual([120_000, 10_000, 0, 0]);
    expect(view.lines.map((l) => l.status)).toEqual(["funded", "at_risk", "at_risk", "at_risk"]);
    expect(view.leftoverMinor).toBe(0);
  });

  it("carries the passthroughs the pass has no reason to hold", () => {
    // `fixedMonthlyMinor` never changes an answer, so it is not in the pass —
    // the view reads it off the input, which is the only thing it reads there.
    expect(view.lines.map((l) => l.fixedMonthlyMinor)).toEqual([null, null, null, 20_000]);
  });
});

describe("accountPlanFromScope — a goal on pace but late", () => {
  it("reports the finish date the cap really lands on", () => {
    const scope: ScopeInput = {
      scopeId: "owner",
      members: [{ userId: "owner", shareBp: 10_000 }],
      accounts: [
        {
          accountId: "current",
          role: "personal",
          memberUserId: "owner",
          ownerUserId: "owner",
          currency: "GBP",
          incomes: [{ id: "inc", amountMinor: 500_000, frequency: "monthly", anchorDate: AS_OF }],
          payments: [
            {
              id: "car",
              name: "car",
              category: "fixed_point",
              scope: "personal",
              amountMinor: 90_000,
              fixedMonthlyMinor: 20_000,
              dueDate: "2026-03-01",
            },
          ],
        },
      ],
    };
    const line = accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "current").lines[0]!;
    // Fully funded every month at the cap, and still five months out — the plan
    // says "on pace, but late" rather than pretending the date is kept.
    expect(line.status).toBe("funded");
    expect(line.fundedMonthlyMinor).toBe(20_000);
    expect(line.projectedCompletionDate).toBe("2026-06-01");
  });
});

describe("accountPlanFromScope — arriving money and what it funds", () => {
  const scopeWith = (confirmedMinor?: number): ScopeInput => ({
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      {
        accountId: "current",
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        currency: "GBP",
        incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
        payments: [],
      },
      {
        accountId: "pot",
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        currency: "GBP",
        incomes: [],
        payments: [
          {
            id: "rent",
            name: "rent",
            category: "monthly_recurring",
            scope: "personal",
            amountMinor: 60_000,
            priority: 1,
          },
          {
            id: "council",
            name: "council",
            category: "monthly_recurring",
            scope: "personal",
            amountMinor: 20_000,
            priority: 2,
          },
        ],
      },
    ],
    ...(confirmedMinor === undefined
      ? {}
      : {
          confirmedTransfers: [
            {
              fromAccountId: "current",
              toAccountId: "pot",
              memberUserId: "owner",
              confirmedMinor,
            },
          ],
        }),
  });

  it("says a derived transfer paid the bills, and that nobody has moved it", () => {
    const scope = scopeWith();
    const plan = accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "pot");
    expect(plan.monthlyIncomeMinor).toBe(0);
    expect(plan.allocatedInflowMinor).toBe(80_000);
    expect(plan.confirmedInflowMinor).toBe(0);
    expect(plan.totalFundedMinor).toBe(80_000);
    expect(plan.lines.map((l) => l.fundedFromInflowMinor)).toEqual([60_000, 20_000]);
    expect(plan.lines.map((l) => l.status)).toEqual(["awaiting_transfer", "awaiting_transfer"]);
    // Every arriving pound came from another account of the scope, and it is
    // already gone from that account's own surplus — which is why a rollup over
    // both is a plain sum with nothing left to net (see `overviewFromPlans`).
    expect(plan.lines.reduce((s, l) => s + l.fundedFromInflowMinor, 0)).toBe(80_000);
  });

  it("marks only the line that runs past the confirmed mark", () => {
    const scope = scopeWith(60_000);
    const plan = accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "pot");
    expect(plan.confirmedInflowMinor).toBe(60_000);
    expect(plan.lines.map((l) => l.status)).toEqual(["funded", "awaiting_transfer"]);
  });

  it("leaves the sending account's own surplus short of what it holds", () => {
    const scope = scopeWith();
    const plan = accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "current");
    // £1,000 in, £800 promised to the pot: the account's own surplus is £200,
    // and nothing about the pot's bills is counted here twice.
    expect(plan.leftoverMinor).toBe(20_000);
    expect(plan.totalRequiredMinor).toBe(0);
    expect(plan.lines).toEqual([]);
    // …and says so by name (WP-Y). The account page needs the £800 to explain
    // why LEFT OVER is smaller than the income above it, and used to recover it
    // by rearranging `residualMinor`'s identity — right arithmetic over terms
    // whose meanings this work has already changed twice. The identity still
    // holds; the page no longer depends on it.
    expect(plan.transferOutMinor).toBe(80_000);
    expect(plan.leftoverMinor + plan.transferOutMinor).toBe(plan.monthlyIncomeMinor);
    // …and says *where* it goes (WP-AH). One destination here, so the list is
    // the scalar with an address on it; the interesting case is below.
    expect(plan.transferDepartures).toEqual([
      { toAccountId: "pot", memberUserId: "owner", amountMinor: 80_000, confirmedMinor: 0 },
    ]);
  });
});

/**
 * The defect the owner found on the deployed build: three transfers, one row.
 *
 * `transferOutMinor` is a scalar, so a page standing on the sending account
 * could only draw a single synthetic line for it and had to name a far end that
 * was a *set* of accounts — "£2,585.84 → your bills", over a bills pot and two
 * shared pots. And its settled state was a hardcoded `false`, because a scalar
 * has no confirmation of its own: a transfer ticked where it lands could never
 * read as moved from the account it leaves.
 *
 * So: three destinations, three different amounts, and confirmations covering
 * one fully, one partly and one not at all. The identity against the scalar is
 * asserted here rather than assumed — both are read off the same `transfers`,
 * and this is what says so.
 */
describe("accountPlanFromScope — what leaves, itemised by where it goes", () => {
  const THREE: ScopeInput = {
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      {
        accountId: "current",
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        currency: "GBP",
        incomes: [{ id: "inc", amountMinor: 300_000, frequency: "monthly", anchorDate: AS_OF }],
        payments: [],
      },
      {
        accountId: "bills",
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        currency: "GBP",
        incomes: [],
        payments: [
          {
            id: "rent",
            name: "rent",
            category: "monthly_recurring",
            scope: "personal",
            amountMinor: 120_000,
            priority: 1,
          },
        ],
      },
      {
        accountId: "car",
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        currency: "GBP",
        incomes: [],
        payments: [
          {
            id: "insurance",
            name: "insurance",
            category: "monthly_recurring",
            scope: "personal",
            amountMinor: 8_000,
            priority: 2,
          },
        ],
      },
      {
        accountId: "holiday",
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        currency: "GBP",
        incomes: [],
        payments: [
          {
            id: "flights",
            name: "flights",
            category: "monthly_recurring",
            scope: "personal",
            amountMinor: 45_000,
            priority: 3,
          },
        ],
      },
    ],
    confirmedTransfers: [
      // Moved in full.
      {
        fromAccountId: "current",
        toAccountId: "bills",
        memberUserId: "owner",
        confirmedMinor: 120_000,
      },
      // Part of it moved — enough to be a different state from either of the
      // others, and not enough to read as done.
      {
        fromAccountId: "current",
        toAccountId: "holiday",
        memberUserId: "owner",
        confirmedMinor: 20_000,
      },
    ],
  };

  it("itemises every destination, and sums to the scalar exactly", () => {
    const plan = accountPlanFromScope(THREE, computeScopePlan(THREE, AS_OF), "current");
    expect(plan.transferDepartures).toEqual([
      {
        toAccountId: "bills",
        memberUserId: "owner",
        amountMinor: 120_000,
        confirmedMinor: 120_000,
      },
      {
        toAccountId: "holiday",
        memberUserId: "owner",
        amountMinor: 45_000,
        confirmedMinor: 20_000,
      },
      { toAccountId: "car", memberUserId: "owner", amountMinor: 8_000, confirmedMinor: 0 },
    ]);
    // The identity, asserted rather than assumed. Nothing else may be added to
    // one of these two without moving the other.
    expect(plan.transferDepartures.reduce((s, d) => s + d.amountMinor, 0)).toBe(
      plan.transferOutMinor,
    );
    expect(plan.transferOutMinor).toBe(173_000);
  });

  it("gives each destination its own settled state, not one for the lot", () => {
    const plan = accountPlanFromScope(THREE, computeScopePlan(THREE, AS_OF), "current");
    expect(plan.transferDepartures.map((d) => d.confirmedMinor >= d.amountMinor)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("is empty exactly when nothing is derived out", () => {
    const plan = accountPlanFromScope(THREE, computeScopePlan(THREE, AS_OF), "bills");
    expect(plan.transferOutMinor).toBe(0);
    expect(plan.transferDepartures).toEqual([]);
  });

  it("orders two equal amounts by the pass's own order, not by luck", () => {
    // The comparator sorts on amount alone and leans on `Array.prototype.sort`
    // being stable over an input `computeScopePlan` already sorted by
    // `(from, to, member)`. Two identical amounts are what tests that: `car`
    // before `holiday` is the pass's order, and a second `.sort` key would be
    // spelling it out again.
    const tied: ScopeInput = {
      ...THREE,
      accounts: THREE.accounts.map((a) =>
        a.accountId === "holiday" || a.accountId === "car"
          ? { ...a, payments: a.payments.map((p) => ({ ...p, amountMinor: 25_000 })) }
          : a,
      ),
      confirmedTransfers: [],
    };
    const plan = accountPlanFromScope(tied, computeScopePlan(tied, AS_OF), "current");
    expect(plan.transferDepartures.map((d) => [d.toAccountId, d.amountMinor])).toEqual([
      ["bills", 120_000],
      ["car", 25_000],
      ["holiday", 25_000],
    ]);
  });
});

/**
 * Two arrivals, two confirmations, and a status that must only answer to one.
 *
 * Money reaches this pot both ways: the £600 transfer the pass derives for the
 * rent, and a £200 movement authored as savings on top of it (decision 12). A
 * line is only ever funded from the first — every expense is paid out of member
 * budgets before a single savings movement runs (decision 8) — and `status` was
 * being decided against the total of both, so confirming the savings declared
 * the rent's transfer made.
 */
describe("accountPlanFromScope — the two confirmations are not one figure", () => {
  const scopeWith = (over: {
    transferConfirmedMinor?: number;
    movementConfirmedMinor?: number;
  }): ScopeInput => ({
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      {
        accountId: "current",
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        currency: "GBP",
        incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
        payments: [],
        outboundInflows: [
          {
            id: "topup",
            toAccountId: "pot",
            amountMinor: 20_000,
            frequency: "monthly",
            anchorDate: AS_OF,
            priority: 10,
          },
        ],
      },
      {
        accountId: "pot",
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        currency: "GBP",
        incomes: [],
        payments: [
          {
            id: "rent",
            name: "rent",
            category: "monthly_recurring",
            scope: "personal",
            amountMinor: 60_000,
            priority: 1,
          },
        ],
        confirmedArrivals:
          over.movementConfirmedMinor === undefined
            ? []
            : [{ inflowId: "topup", confirmedMinor: over.movementConfirmedMinor }],
      },
    ],
    ...(over.transferConfirmedMinor === undefined
      ? {}
      : {
          confirmedTransfers: [
            {
              fromAccountId: "current",
              toAccountId: "pot",
              memberUserId: "owner",
              confirmedMinor: over.transferConfirmedMinor,
            },
          ],
        }),
  });

  const planOf = (over: Parameters<typeof scopeWith>[0]) => {
    const scope = scopeWith(over);
    return accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "pot");
  };

  it("splits the confirmed total into the transfer's part and the movement's", () => {
    const plan = planOf({});
    expect(plan.allocatedInflowMinor).toBe(80_000);
    expect(plan.confirmedInflowMinor).toBe(0);
    expect(plan.confirmedTransferMinor).toBe(0);
    expect(plan.lines[0]!.status).toBe("awaiting_transfer");
  });

  it("leaves the line awaiting when only the savings movement has moved", () => {
    const plan = planOf({ movementConfirmedMinor: 20_000 });
    expect(plan.confirmedInflowMinor).toBe(20_000);
    // None of it is the money the rent is funded with.
    expect(plan.confirmedTransferMinor).toBe(0);
    expect(plan.lines[0]!.fundedFromInflowMinor).toBe(60_000);
    expect(plan.lines[0]!.status).toBe("awaiting_transfer");
  });

  it("settles the line on the derived transfer alone, savings untouched", () => {
    const plan = planOf({ transferConfirmedMinor: 60_000 });
    expect(plan.confirmedInflowMinor).toBe(60_000);
    expect(plan.confirmedTransferMinor).toBe(60_000);
    expect(plan.lines[0]!.status).toBe("funded");
  });
});

describe("accountPlanFromScope — savings movements out", () => {
  const withMovements = (): ScopeInput => ({
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      {
        accountId: "current",
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        currency: "GBP",
        incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
        payments: [],
        outboundInflows: [
          {
            id: "to-isa",
            toAccountId: "isa",
            amountMinor: 30_000,
            frequency: "monthly",
            anchorDate: AS_OF,
            priority: 20,
          },
          {
            id: "to-pot",
            toAccountId: "pot",
            amountMinor: 90_000,
            frequency: "monthly",
            anchorDate: AS_OF,
            priority: 10,
          },
        ],
      },
      {
        accountId: "pot",
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        currency: "GBP",
        incomes: [],
        payments: [],
      },
      {
        accountId: "isa",
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        currency: "GBP",
        incomes: [],
        payments: [],
      },
    ],
  });

  it("reports them in their own priority order, with what each could afford", () => {
    const scope = withMovements();
    const plan = accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "current");
    expect(plan.outboundInflows).toEqual([
      {
        inflowId: "to-pot",
        toAccountId: "pot",
        requiredMonthlyMinor: 90_000,
        fundedMonthlyMinor: 90_000,
        fundedFromOwnMinor: 90_000,
        fundedFromInflowMinor: 0,
        onTrack: true,
      },
      {
        inflowId: "to-isa",
        toAccountId: "isa",
        requiredMonthlyMinor: 30_000,
        fundedMonthlyMinor: 10_000,
        fundedFromOwnMinor: 10_000,
        fundedFromInflowMinor: 0,
        onTrack: false,
      },
    ]);
    // `leftoverMinor` keeps its meaning: the account's own surplus before the
    // movements leave. What they take is `outboundInflowMinor` (decision 13).
    expect(plan.leftoverMinor).toBe(100_000);
    expect(plan.outboundInflowMinor).toBe(100_000);
  });

  it("leaves out the edge a loop was broken at — it is not happening", () => {
    const scope: ScopeInput = {
      scopeId: "owner",
      members: [{ userId: "owner", shareBp: 10_000 }],
      accounts: [
        {
          accountId: "a",
          role: "personal",
          memberUserId: "owner",
          ownerUserId: "owner",
          currency: "GBP",
          incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
          payments: [],
          outboundInflows: [
            {
              id: "a-to-b",
              toAccountId: "b",
              amountMinor: 30_000,
              frequency: "monthly",
              anchorDate: AS_OF,
            },
          ],
        },
        {
          accountId: "b",
          role: "personal",
          memberUserId: "owner",
          ownerUserId: "owner",
          currency: "GBP",
          incomes: [],
          payments: [],
          outboundInflows: [
            {
              id: "b-to-a",
              toAccountId: "a",
              amountMinor: 10_000,
              frequency: "monthly",
              anchorDate: AS_OF,
            },
          ],
        },
      ],
    };
    const plan = computeScopePlan(scope, AS_OF);
    const b = accountPlanFromScope(scope, plan, "b");
    expect(plan.cycles).toHaveLength(1);
    expect(b.outboundInflows).toEqual([]);
    expect(b.fundingCycleAccountIds).toEqual(["a", "b"]);
    expect(b.fundingCycleBrokenInflowId).toBe("b-to-a");
  });

  it("never reports a movement whose sender the pass could not see", () => {
    // Two currencies, and a dollar account naming a sterling one as its source.
    // The pass says `unknown_source` in the dollar partition; without the guard
    // the sterling account's plan would claim a movement it never makes.
    const scope: ScopeInput = {
      scopeId: "owner",
      members: [{ userId: "owner", shareBp: 10_000 }],
      accounts: [
        {
          accountId: "gbp",
          role: "personal",
          memberUserId: "owner",
          ownerUserId: "owner",
          currency: "GBP",
          incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
          payments: [],
        },
        {
          accountId: "usd",
          role: "personal",
          memberUserId: "owner",
          ownerUserId: "owner",
          currency: "USD",
          incomes: [],
          payments: [],
          inflows: [
            {
              id: "gbp-to-usd",
              amountMinor: 20_000,
              frequency: "monthly",
              anchorDate: AS_OF,
              source: "account",
              sourceAccountId: "gbp",
            },
          ],
        },
      ],
    };
    const plan = computeScopePlan(scope, AS_OF);
    expect(plan.movements.map((m) => m.status)).toEqual(["unknown_source"]);
    expect(accountPlanFromScope(scope, plan, "gbp").outboundInflows).toEqual([]);
    expect(accountPlanFromScope(scope, plan, "gbp").outboundInflowMinor).toBe(0);
  });
});

describe("accountPlanFromScope — an account the pass never planned", () => {
  it("refuses rather than inventing an empty month", () => {
    const scope: ScopeInput = { scopeId: "owner", members: [], accounts: [] };
    expect(() => accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "ghost")).toThrow(
      /not in the planned scope/,
    );
  });
});

describe("accountPlanFromScope — a plan and an input that are not the same scope", () => {
  const payment = (id: string): ScopeInput["accounts"][number]["payments"][number] => ({
    id,
    name: id,
    category: "monthly_recurring",
    scope: "personal",
    amountMinor: 10_000,
  });

  const scopeWith = (...ids: string[]): ScopeInput => ({
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      {
        accountId: "current",
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        currency: "GBP",
        incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
        payments: ids.map(payment),
      },
    ],
  });

  it("refuses rather than publishing a line it cannot describe", () => {
    // The passthroughs come from the input and the decisions from the plan, so
    // the two have to be the same scope. Handed a line whose payment the input
    // has never heard of, the view says so instead of emitting a null cap and
    // letting a contribution-first goal read as an ordinary one.
    expect(() =>
      accountPlanFromScope(
        scopeWith("rent"),
        computeScopePlan(scopeWith("rent", "gym"), AS_OF),
        "current",
      ),
    ).toThrow(/gym is not a payment of current/);
  });
});

describe("accountPlanFromScope — movements that tie", () => {
  it("orders them by destination, then by the row, never by load order", () => {
    const move = (id: string, toAccountId: string) => ({
      id,
      toAccountId,
      amountMinor: 1_000,
      frequency: "monthly" as const,
      anchorDate: AS_OF,
      priority: 10,
    });
    const scope: ScopeInput = {
      scopeId: "owner",
      members: [{ userId: "owner", shareBp: 10_000 }],
      accounts: [
        {
          accountId: "current",
          role: "personal",
          memberUserId: "owner",
          ownerUserId: "owner",
          currency: "GBP",
          incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: AS_OF }],
          payments: [],
          outboundInflows: [move("z-row", "b-pot"), move("a-row", "b-pot"), move("m-row", "a-pot")],
        },
        ...["a-pot", "b-pot"].map((accountId) => ({
          accountId,
          role: "personal" as const,
          memberUserId: "owner",
          ownerUserId: "owner",
          currency: "GBP",
          incomes: [],
          payments: [],
        })),
      ],
    };
    const plan = accountPlanFromScope(scope, computeScopePlan(scope, AS_OF), "current");
    expect(plan.outboundInflows.map((o) => o.inflowId)).toEqual(["m-row", "a-row", "z-row"]);
  });
});
