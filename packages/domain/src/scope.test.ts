import { describe, expect, it } from "vitest";
import {
  computeScopePlan,
  explainScopePlan,
  type ScopeAccountInput,
  type ScopeCurrencyPlan,
  type ScopeInput,
  type ScopePaymentInput,
} from "./scope.js";
import type { IncomeInput, OutboundInflowInput, PaymentInput } from "./types.js";

const ASOF = "2026-08-04";

// --- factories ---------------------------------------------------------------

function pay(
  over: Partial<ScopePaymentInput> & { id: string; amountMinor: number },
): ScopePaymentInput {
  return {
    name: over.id,
    category: "monthly_recurring",
    scope: "shared",
    priority: 100,
    ...over,
  };
}

function acc(over: Partial<ScopeAccountInput> & { accountId: string }): ScopeAccountInput {
  return {
    name: over.accountId,
    role: "shared",
    // Every account has an owner — `core.accounts.owner_user_id` is `NOT NULL`
    // and a shared pot is still somebody's account (decision 15). These are one
    // person's estate unless a case says otherwise, so it is the member the
    // roster names, and the scope's sole member when it names nobody.
    ownerUserId: over.memberUserId ?? "owner",
    currency: "GBP",
    incomes: [],
    payments: [],
    ...over,
  };
}

const income = (amountMinor: number, id = "inc") => [
  { id, amountMinor, frequency: "monthly" as const, anchorDate: ASOF },
];

const leaving = (
  id: string,
  amountMinor: number,
  toAccountId: string,
  priority = 100,
): OutboundInflowInput => ({
  id,
  toAccountId,
  amountMinor,
  frequency: "monthly",
  recurrence: null,
  anchorDate: ASOF,
  active: true,
  priority,
});

function scope(over: Partial<ScopeInput> & { accounts: ScopeAccountInput[] }): ScopeInput {
  return { scopeId: "scope", members: [{ userId: "owner", shareBp: 10_000 }], ...over };
}

function plan(over: Partial<ScopeInput> & { accounts: ScopeAccountInput[] }) {
  return computeScopePlan(scope(over), ASOF);
}

/** The one partition of a single-currency scope. */
function only(p: ReturnType<typeof plan>): ScopeCurrencyPlan {
  expect(p.partitions).toHaveLength(1);
  return p.partitions[0]!;
}

const accountOf = (p: ScopeCurrencyPlan, id: string) => p.accounts.find((a) => a.accountId === id)!;
const lineOf = (p: ScopeCurrencyPlan, id: string) => p.lines.find((l) => l.paymentId === id)!;
const memberOf = (p: ScopeCurrencyPlan, id: string) => p.members.find((m) => m.userId === id)!;

const transfer = (p: ScopeCurrencyPlan, from: string, to: string) =>
  p.transfers
    .filter((t) => t.fromAccountId === from && t.toAccountId === to)
    .reduce((s, t) => s + t.amountMinor, 0);

// =============================================================================
// The pin: a solo user must not move at all
// =============================================================================

/**
 * The regression this whole package has to be provably free of.
 *
 * Generalising the funding loop moves accounts from their own local priority
 * order onto the member's global one, and on a tight month a *different bill*
 * goes short than before. That is the feature — for anything that shares money.
 * A solo user with one account shares nothing, so nothing about their month may
 * move by a penny.
 *
 * The fixture is deliberately hostile to the change: the budget runs out
 * mid-order, and two payments tie on priority with sort keys that the two
 * engines disagreed about — a dateless monthly gym membership (which the account
 * engine ranks last, on `targetDate ?? dueDate ?? never`) against a dated
 * holiday goal (which the household engine ranked *after* the gym, on the
 * payment's computed next occurrence). Ranked the household way, the gym is
 * funded and the holiday is £5,000 shorter. So this fixture pins the tie-break
 * as well as the arithmetic.
 */
function soloAccount() {
  return {
    accountId: "current",
    currency: "GBP",
    monthlyBufferMinor: 20_000,
    incomes: income(150_000),
    payments: [
      {
        id: "rent",
        name: "rent",
        category: "monthly_recurring",
        amountMinor: 120_000,
        dueDate: "2026-08-15",
        priority: 1,
      },
      {
        id: "holiday",
        name: "holiday",
        category: "fixed_point",
        amountMinor: 240_000,
        targetDate: "2027-02-01",
        priority: 50,
      },
      { id: "gym", name: "gym", category: "monthly_recurring", amountMinor: 5_000, priority: 50 },
      {
        id: "retired",
        name: "retired",
        category: "monthly_recurring",
        amountMinor: 99_000,
        priority: 2,
        active: false,
      },
    ] satisfies PaymentInput[],
  };
}

function soloScope(account: ReturnType<typeof soloAccount>): ScopeInput {
  return {
    scopeId: "owner",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      {
        ...account,
        role: "personal",
        memberUserId: "owner",
        ownerUserId: "owner",
        payments: account.payments.map((p) => ({ ...p, scope: "personal" as const })),
      },
    ],
  };
}

/**
 * Every figure `computeAccountPlan` produced for `soloAccount()` at `40f65d8` —
 * the commit before the account engine was deleted (ONE-ENGINE.md, WP-S).
 *
 * Captured rather than recomputed. The pin's whole point is that the pass must
 * not move a solo user's month by a penny, and once the engine it is pinned
 * against is gone there is nothing left to call: an expectation re-derived from
 * the code under test would only ever agree with itself.
 */
const ACCOUNT_ENGINE_AT_40F65D8 = {
  monthlyIncomeMinor: 150_000,
  bufferMinor: 20_000,
  totalRequiredMinor: 173_000,
  totalFundedMinor: 130_000,
  leftoverMinor: 0,
  shortfallMinor: 43_000,
  lines: [
    {
      paymentId: "rent",
      dueDate: "2026-08-15",
      targetDate: "2026-08-15",
      dueDateIsDerived: false,
      monthsUntilDue: 1,
      occurrencesThisMonth: 1,
      requiredMonthlyMinor: 120_000,
      fundedMonthlyMinor: 120_000,
      fundedFromOwnMinor: 120_000,
      fundedFromInflowMinor: 0,
      onTrack: true,
    },
    {
      paymentId: "holiday",
      dueDate: "2027-02-01",
      targetDate: "2027-02-01",
      dueDateIsDerived: false,
      monthsUntilDue: 5,
      occurrencesThisMonth: 1,
      requiredMonthlyMinor: 48_000,
      fundedMonthlyMinor: 10_000,
      fundedFromOwnMinor: 10_000,
      fundedFromInflowMinor: 0,
      onTrack: false,
    },
    {
      paymentId: "gym",
      dueDate: "2026-08-04",
      targetDate: "2026-08-04",
      dueDateIsDerived: false,
      monthsUntilDue: 1,
      occurrencesThisMonth: 1,
      requiredMonthlyMinor: 5_000,
      fundedMonthlyMinor: 0,
      fundedFromOwnMinor: 0,
      fundedFromInflowMinor: 0,
      onTrack: false,
    },
  ],
};

function pinnedFromScope(p: ScopeCurrencyPlan, accountId: string): unknown {
  const a = accountOf(p, accountId);
  return {
    monthlyIncomeMinor: a.monthlyIncomeMinor,
    bufferMinor: a.bufferMinor,
    totalRequiredMinor: a.requiredOutflowMinor,
    totalFundedMinor: a.fundedOutflowMinor,
    leftoverMinor: a.ownLeftoverMinor,
    shortfallMinor: a.shortfallMinor,
    lines: p.lines
      .filter((l) => l.accountId === accountId)
      .map((l) => ({
        paymentId: l.paymentId,
        dueDate: l.dueDate,
        targetDate: l.targetDate,
        dueDateIsDerived: l.dueDateIsDerived,
        monthsUntilDue: l.monthsUntilDue,
        occurrencesThisMonth: l.occurrencesThisMonth,
        requiredMonthlyMinor: l.requiredMonthlyMinor,
        fundedMonthlyMinor: l.fundedMonthlyMinor,
        fundedFromOwnMinor: l.fundedFromOwnMinor,
        fundedFromInflowMinor: l.fundedFromInflowMinor,
        onTrack: l.onTrack,
      })),
  };
}

describe("computeScopePlan — a solo user with one account does not move", () => {
  const account = soloAccount();
  const pass = only(computeScopePlan(soloScope(account), ASOF) as never);

  it("plans byte-identically to the account engine, tie-breaks included", () => {
    expect(JSON.stringify(pinnedFromScope(pass, "current"))).toBe(
      JSON.stringify(ACCOUNT_ENGINE_AT_40F65D8),
    );
  });

  it("spends the month in the order the account engine spends it", () => {
    expect(pass.lines.map((l) => l.paymentId)).toEqual(
      ACCOUNT_ENGINE_AT_40F65D8.lines.map((l) => l.paymentId),
    );
    // Named, so the pin above cannot pass by accident: the budget really does
    // run out, and it runs out on the holiday rather than on the gym.
    expect(pass.lines.map((l) => l.paymentId)).toEqual(["rent", "holiday", "gym"]);
    expect(lineOf(pass, "rent").fundedMonthlyMinor).toBe(120_000);
    expect(lineOf(pass, "gym").fundedMonthlyMinor).toBe(0);
    expect(lineOf(pass, "holiday").fundedMonthlyMinor).toBe(10_000);
  });

  it("derives no transfer and commits nothing", () => {
    expect(pass.transfers).toEqual([]);
    expect(pass.movements).toEqual([]);
    expect(accountOf(pass, "current").committedMinor).toBe(0);
    expect(memberOf(pass, "owner").committedMinor).toBe(0);
  });

  it("leaves the residual and the own-surplus agreeing, with nothing crossing", () => {
    const a = accountOf(pass, "current");
    expect(a.ownLeftoverMinor).toBe(0);
    expect(a.leftoverMinor).toBe(150_000 - 130_000);
    expect(a.shortfallMinor).toBe(ACCOUNT_ENGINE_AT_40F65D8.shortfallMinor);
  });
});

// =============================================================================
// Decision 8 — one priority space, both directions
// =============================================================================

describe("computeScopePlan — personal and shared expenses intertwine", () => {
  /** One member, one budget, one bill on each side of the household line. */
  const intertwined = (rentPriority: number, gymPriority: number) =>
    plan({
      members: [{ userId: "alice", shareBp: 10_000 }],
      accounts: [
        acc({
          accountId: "alice-cur",
          role: "personal",
          memberUserId: "alice",
          incomes: income(100_000),
          payments: [
            pay({ id: "gym", amountMinor: 80_000, scope: "personal", priority: gymPriority }),
          ],
        }),
        acc({
          accountId: "bills",
          payments: [pay({ id: "rent", amountMinor: 80_000, priority: rentPriority })],
        }),
      ],
    });

  it("lets a household bill at 5 beat a personal bill at 10", () => {
    const p = only(intertwined(5, 10));
    expect(lineOf(p, "rent").fundedMonthlyMinor).toBe(80_000);
    expect(lineOf(p, "gym").fundedMonthlyMinor).toBe(20_000);
    expect(transfer(p, "alice-cur", "bills")).toBe(80_000);
  });

  it("lets a personal bill at 5 beat a household bill at 10", () => {
    const p = only(intertwined(10, 5));
    expect(lineOf(p, "gym").fundedMonthlyMinor).toBe(80_000);
    expect(lineOf(p, "rent").fundedMonthlyMinor).toBe(20_000);
    expect(transfer(p, "alice-cur", "bills")).toBe(20_000);
    expect(accountOf(p, "bills").shortfallMinor).toBe(60_000);
  });

  it("charges each shared cost by share and each personal cost to its bearer", () => {
    const p = only(
      plan({
        members: [
          { userId: "alice", shareBp: 6_600 },
          { userId: "bob", shareBp: 3_400 },
        ],
        accounts: [
          acc({
            accountId: "alice-cur",
            role: "personal",
            memberUserId: "alice",
            incomes: income(300_000),
          }),
          acc({
            accountId: "bob-cur",
            role: "personal",
            memberUserId: "bob",
            incomes: income(200_000),
          }),
          acc({
            accountId: "bills",
            payments: [
              pay({ id: "rent", amountMinor: 100_000 }),
              pay({ id: "bobs-phone", amountMinor: 4_000, scope: "personal", bearerUserId: "bob" }),
            ],
          }),
        ],
      }),
    );
    expect(lineOf(p, "rent").allocations).toEqual([
      { userId: "alice", requiredMinor: 66_000, fundedMinor: 66_000 },
      { userId: "bob", requiredMinor: 34_000, fundedMinor: 34_000 },
    ]);
    expect(lineOf(p, "bobs-phone").allocations).toEqual([
      { userId: "alice", requiredMinor: 0, fundedMinor: 0 },
      { userId: "bob", requiredMinor: 4_000, fundedMinor: 4_000 },
    ]);
    expect(transfer(p, "alice-cur", "bills")).toBe(66_000);
    expect(transfer(p, "bob-cur", "bills")).toBe(38_000);
    expect(memberOf(p, "alice").shareBp).toBe(6_600);
  });

  it("falls back to a shared split when a personal bill has no resolvable bearer", () => {
    const p = only(
      plan({
        members: [
          { userId: "alice", shareBp: 5_000 },
          { userId: "bob", shareBp: 5_000 },
        ],
        accounts: [
          acc({
            accountId: "bills",
            payments: [pay({ id: "mystery", amountMinor: 10_000, scope: "personal" })],
          }),
        ],
      }),
    );
    expect(lineOf(p, "mystery").allocations.map((a) => a.requiredMinor)).toEqual([5_000, 5_000]);
  });

  it("splits equally when nobody has set a share", () => {
    const p = only(
      plan({
        members: [
          { userId: "alice", shareBp: 0 },
          { userId: "bob", shareBp: 0 },
        ],
        accounts: [
          acc({ accountId: "bills", payments: [pay({ id: "rent", amountMinor: 10_000 })] }),
        ],
      }),
    );
    expect(lineOf(p, "rent").allocations.map((a) => a.requiredMinor)).toEqual([5_000, 5_000]);
    expect(p.members.map((m) => m.shareBp)).toEqual([5_000, 5_000]);
  });

  it("excludes inactive payments entirely", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "bills",
            payments: [pay({ id: "gone", amountMinor: 10_000, active: false })],
          }),
        ],
      }),
    );
    expect(p.lines).toEqual([]);
    expect(p.totalRequiredMinor).toBe(0);
  });

  it("plans an empty scope without complaint", () => {
    const p = computeScopePlan({ scopeId: "nobody", members: [], accounts: [] }, ASOF);
    expect(p.partitions).toEqual([]);
    expect(p.lines).toEqual([]);
    expect(p.accounts).toEqual([]);
  });

  it("attributes nothing when the scope has no members, and says so", () => {
    const p = only(
      computeScopePlan(
        {
          scopeId: "nobody",
          members: [],
          accounts: [
            acc({ accountId: "bills", payments: [pay({ id: "rent", amountMinor: 10_000 })] }),
          ],
        },
        ASOF,
      ) as never,
    );
    expect(p.members).toEqual([]);
    expect(lineOf(p, "rent").fundedMonthlyMinor).toBe(0);
    expect(p.shortfallMinor).toBe(10_000);
  });
});

// =============================================================================
// Decision 9 — transport for expenses is derived, not authored
// =============================================================================

describe("computeScopePlan — a pot with no income feeds itself", () => {
  const p = only(
    plan({
      accounts: [
        acc({
          accountId: "current",
          role: "personal",
          memberUserId: "owner",
          incomes: income(200_000),
        }),
        acc({
          accountId: "pot",
          role: "personal",
          memberUserId: "owner",
          payments: [
            pay({ id: "rent", amountMinor: 90_000, scope: "personal" }),
            pay({ id: "council", amountMinor: 10_000, scope: "personal" }),
          ],
        }),
      ],
    }),
  );

  it("derives a transfer equal to the pot's obligations, with no authored row", () => {
    expect(p.movements).toEqual([]);
    expect(p.transfers).toHaveLength(1);
    expect(p.transfers[0]).toMatchObject({
      fromAccountId: "current",
      toAccountId: "pot",
      memberUserId: "owner",
      currency: "GBP",
      amountMinor: 100_000,
      confirmedMinor: 0,
    });
  });

  it("funds the pot's bills and leaves it neither short nor holding a surplus", () => {
    expect(accountOf(p, "pot").fundedOutflowMinor).toBe(100_000);
    expect(accountOf(p, "pot").shortfallMinor).toBe(0);
    expect(accountOf(p, "pot").leftoverMinor).toBe(0);
    expect(lineOf(p, "rent").fundedFromOwnMinor).toBe(0);
    expect(lineOf(p, "rent").fundedFromInflowMinor).toBe(90_000);
  });

  it("takes the transfer off the sending account's own surplus", () => {
    // The defect this package exists to kill, in its expense-shaped form: money
    // committed out of an account has to leave the account it is committed from.
    expect(accountOf(p, "current").transferOutMinor).toBe(100_000);
    expect(accountOf(p, "current").ownLeftoverMinor).toBe(100_000);
    expect(accountOf(p, "current").leftoverMinor).toBe(100_000);
  });

  it("originates every derived claim from the member's best-paid account", () => {
    // Decision 11. Three personal accounts, one source.
    const q = only(
      plan({
        accounts: [
          acc({
            accountId: "a-savings",
            role: "personal",
            memberUserId: "owner",
            incomes: income(1_000),
          }),
          acc({
            accountId: "b-salary",
            role: "personal",
            memberUserId: "owner",
            incomes: income(200_000),
          }),
          acc({
            accountId: "c-pot",
            role: "personal",
            memberUserId: "owner",
            payments: [pay({ id: "rent", amountMinor: 90_000, scope: "personal" })],
          }),
        ],
      }),
    );
    expect(memberOf(q, "owner").sourceAccountId).toBe("b-salary");
    expect(q.transfers.map((t) => t.fromAccountId)).toEqual(["b-salary"]);
  });

  it("makes no transfer for a member with no account to make it from", () => {
    const q = only(
      plan({
        members: [
          { userId: "alice", shareBp: 5_000 },
          { userId: "ghost", shareBp: 5_000 },
        ],
        accounts: [
          acc({
            accountId: "alice-cur",
            role: "personal",
            memberUserId: "alice",
            incomes: income(100_000),
          }),
          acc({ accountId: "bills", payments: [pay({ id: "rent", amountMinor: 20_000 })] }),
        ],
      }),
    );
    expect(memberOf(q, "ghost").sourceAccountId).toBeNull();
    expect(memberOf(q, "ghost").shortfallMinor).toBe(10_000);
    expect(q.transfers.map((t) => t.memberUserId)).toEqual(["alice"]);
  });
});

// =============================================================================
// Decision 9 — transport is for what the destination cannot pay for itself
// =============================================================================

/**
 * The netting decision 9 always described and the pass never did.
 *
 * "An in-scope account with obligations **and no income** gets its feed derived"
 * — and phase 3 derived one for every funded obligation off the member's source
 * account, income or no income. So an account holding the money for its own bill
 * was sent it again: a row on the transfer checklist that funds nothing, and a
 * rollup identity short by exactly it (`inflows.invariant.test.ts`).
 */
describe("computeScopePlan — an account pays for what it can out of its own income", () => {
  it("asks for nothing when the destination's income already covers the bill", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(300_000),
          }),
          acc({
            accountId: "savings",
            role: "personal",
            memberUserId: "owner",
            incomes: income(5_000),
            payments: [pay({ id: "subscription", amountMinor: 4_000, scope: "personal" })],
          }),
        ],
      }),
    );
    expect(p.transfers).toEqual([]);
    expect(accountOf(p, "savings").transferInMinor).toBe(0);
    expect(accountOf(p, "current").transferOutMinor).toBe(0);
    // The bill is funded either way; only the transport changed.
    expect(lineOf(p, "subscription").fundedFromOwnMinor).toBe(4_000);
    expect(memberOf(p, "owner").leftoverMinor).toBe(301_000);
  });

  it("transports only the part the destination's income cannot reach", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(300_000),
          }),
          acc({
            accountId: "pot",
            role: "personal",
            memberUserId: "owner",
            incomes: income(30_000),
            payments: [pay({ id: "rent", amountMinor: 90_000, scope: "personal" })],
          }),
        ],
      }),
    );
    expect(transfer(p, "current", "pot")).toBe(60_000);
    expect(accountOf(p, "pot").leftoverMinor).toBe(0);
  });

  it("relieves each member by their share, not by their place in the queue", () => {
    // A pot's own income belongs to no member's budget, so every obligation on
    // it may lean on the rebate — and the pass hands it out by what each share
    // is for, rather than to whichever member the list happens to name first.
    const p = only(
      plan({
        members: [
          { userId: "alice", shareBp: 6_000 },
          { userId: "bob", shareBp: 4_000 },
        ],
        accounts: [
          acc({
            accountId: "alice-cur",
            role: "personal",
            memberUserId: "alice",
            incomes: income(300_000),
          }),
          acc({
            accountId: "bob-cur",
            role: "personal",
            memberUserId: "bob",
            incomes: income(200_000),
          }),
          acc({
            accountId: "bills",
            incomes: income(20_000, "rebate"),
            payments: [pay({ id: "rent", amountMinor: 100_000 })],
          }),
        ],
      }),
    );
    // £1,000 of rent, £200 of rebate: £120 off Alice's £600 and £80 off Bob's £400.
    expect(transfer(p, "alice-cur", "bills")).toBe(48_000);
    expect(transfer(p, "bob-cur", "bills")).toBe(32_000);
    // A pot nobody owns now ends the month at exactly its buffer.
    expect(accountOf(p, "bills").leftoverMinor).toBe(0);
  });

  it("hands a rebate that will not divide out a penny at a time, in queue order", () => {
    // Floors and then the remainder, because rounding each share up the way
    // `splitByShares` does would net a penny the account has not got — and the
    // pot would end the month a penny short of paying its own rent.
    const p = only(
      plan({
        members: [
          { userId: "alice", shareBp: 6_000 },
          { userId: "bob", shareBp: 4_000 },
        ],
        accounts: [
          acc({
            accountId: "alice-cur",
            role: "personal",
            memberUserId: "alice",
            incomes: income(300_000),
          }),
          acc({
            accountId: "bob-cur",
            role: "personal",
            memberUserId: "bob",
            incomes: income(200_000),
          }),
          acc({
            accountId: "bills",
            incomes: income(1, "rebate"),
            payments: [pay({ id: "rent", amountMinor: 100_000 })],
          }),
        ],
      }),
    );
    expect(transfer(p, "alice-cur", "bills")).toBe(59_999);
    expect(transfer(p, "bob-cur", "bills")).toBe(40_000);
    expect(accountOf(p, "bills").leftoverMinor).toBe(0);
  });

  it("keeps a co-member owing their share of a bill on somebody else's account", () => {
    // The netting's one limit, and it is not an oversight. Alice's salary is
    // already inside Alice's budget (phase 1), so leaning Bob's half of the rent
    // on it would spend the same money twice and tell him he owes her nothing.
    const p = only(
      plan({
        members: [
          { userId: "alice", shareBp: 5_000 },
          { userId: "bob", shareBp: 5_000 },
        ],
        accounts: [
          acc({
            accountId: "alice-cur",
            role: "personal",
            memberUserId: "alice",
            incomes: income(300_000),
            payments: [pay({ id: "rent", amountMinor: 100_000 })],
          }),
          acc({
            accountId: "bob-cur",
            role: "personal",
            memberUserId: "bob",
            incomes: income(200_000),
          }),
        ],
      }),
    );
    expect(p.transfers).toHaveLength(1);
    expect(transfer(p, "bob-cur", "alice-cur")).toBe(50_000);
  });

  it("lets a pot's own income hold its own reserve, once", () => {
    // The buffer is the account's income held back, and the reserve obligation
    // is the members funding that buffer. A pot earning enough to hold its own
    // reserve was having it sent in as well, and reserving it twice.
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
          }),
          acc({ accountId: "pot", monthlyBufferMinor: 20_000, incomes: income(30_000) }),
        ],
      }),
    );
    expect(p.transfers).toEqual([]);
    expect(accountOf(p, "pot").leftoverMinor).toBe(30_000);
    // £100 of it is spare: the buffer holds £200 and no more.
    expect(accountOf(p, "pot").ownLeftoverMinor).toBe(10_000);
  });

  it("derives nothing for a bill on the source account itself, however short it is", () => {
    // A member's transfers leave their source account (decision 11), so there is
    // no transfer to derive for a bill that is already paid from it. Their other
    // account's income funded £300 of this one, and the money has to be
    // consolidated by hand — which the residual says by going negative rather
    // than by inventing a transfer out of the account into itself.
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
            payments: [pay({ id: "rent", amountMinor: 130_000, scope: "personal" })],
          }),
          acc({
            accountId: "savings",
            role: "personal",
            memberUserId: "owner",
            incomes: income(60_000),
          }),
        ],
      }),
    );
    expect(memberOf(p, "owner").sourceAccountId).toBe("current");
    expect(p.transfers).toEqual([]);
    expect(lineOf(p, "rent").fundedMonthlyMinor).toBe(130_000);
    expect(accountOf(p, "current").leftoverMinor).toBe(-30_000);
    expect(accountOf(p, "savings").leftoverMinor).toBe(60_000);
  });

  it("still sends a reserve the pot's own income cannot cover", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
          }),
          acc({ accountId: "pot", monthlyBufferMinor: 20_000, incomes: income(5_000) }),
        ],
      }),
    );
    expect(transfer(p, "current", "pot")).toBe(15_000);
    expect(accountOf(p, "pot").leftoverMinor).toBe(20_000);
  });
});

// =============================================================================
// Decision 8 — expenses beat savings, in both directions
// =============================================================================

describe("computeScopePlan — expenses beat savings, whatever the numbers say", () => {
  it("funds a bill at priority 99 before a movement at priority 1", () => {
    // The pinned test of INFLOWS decision 6, re-asserted against the one pass.
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
            payments: [pay({ id: "rent", amountMinor: 80_000, scope: "personal", priority: 99 })],
            outboundInflows: [leaving("to-pot", 100_000, "pot", 1)],
          }),
          acc({ accountId: "pot", role: "personal", memberUserId: "owner" }),
        ],
      }),
    );
    expect(lineOf(p, "rent").fundedMonthlyMinor).toBe(80_000);
    expect(p.movements[0]).toMatchObject({ fundedMinor: 20_000, status: "short" });
    expect(accountOf(p, "pot").movementInMinor).toBe(20_000);
  });

  it("funds a pot's rent at priority 1 before the sender's gym at 99", () => {
    // The other direction, which the account-local engine got wrong: transport
    // for an expense is not a saving, so it must not queue behind one — nor may
    // the sending account's own low-ranked bills eat it first.
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(90_000),
            payments: [pay({ id: "gym", amountMinor: 5_000, scope: "personal", priority: 99 })],
          }),
          acc({
            accountId: "pot",
            role: "personal",
            memberUserId: "owner",
            payments: [pay({ id: "rent", amountMinor: 90_000, scope: "personal", priority: 1 })],
          }),
        ],
      }),
    );
    expect(lineOf(p, "rent").fundedMonthlyMinor).toBe(90_000);
    expect(lineOf(p, "gym").fundedMonthlyMinor).toBe(0);
    expect(transfer(p, "current", "pot")).toBe(90_000);
  });

  it("funds savings out of what the derived transfers left, not out of them", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(200_000),
            outboundInflows: [leaving("to-isa", 150_000, "isa", 1)],
          }),
          acc({
            accountId: "pot",
            role: "personal",
            memberUserId: "owner",
            payments: [pay({ id: "rent", amountMinor: 120_000, scope: "personal" })],
          }),
          acc({ accountId: "isa", role: "personal", memberUserId: "owner" }),
        ],
      }),
    );
    // £2,000 in, £1,200 committed to the pot as an expense, £800 left for the ISA.
    expect(transfer(p, "current", "pot")).toBe(120_000);
    expect(p.movements[0]).toMatchObject({
      inflowId: "to-isa",
      fundedMinor: 80_000,
      fundedFromOwnMinor: 80_000,
      fundedFromInflowMinor: 0,
      status: "short",
    });
  });

  it("ranks movements against each other, best number first", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
            payments: [pay({ id: "rent", amountMinor: 10_000, scope: "personal" })],
            outboundInflows: [
              leaving("to-isa", 60_000, "isa", 20),
              leaving("to-pot", 60_000, "pot", 10),
            ],
          }),
          acc({ accountId: "pot", role: "personal", memberUserId: "owner" }),
          acc({ accountId: "isa", role: "personal", memberUserId: "owner" }),
        ],
      }),
    );
    expect(accountOf(p, "pot").movementInMinor).toBe(60_000);
    expect(accountOf(p, "isa").movementInMinor).toBe(30_000);
  });

  it("moves money down a chain one hop at a time, passing on what arrived", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(200_000),
            outboundInflows: [leaving("a", 150_000, "pot")],
          }),
          acc({
            accountId: "pot",
            role: "personal",
            memberUserId: "owner",
            outboundInflows: [leaving("b", 150_000, "isa")],
          }),
          acc({ accountId: "isa", role: "personal", memberUserId: "owner" }),
        ],
      }),
    );
    expect(p.movements.map((m) => [m.inflowId, m.fundedMinor])).toEqual([
      ["a", 150_000],
      ["b", 150_000],
    ]);
    expect(p.movements[1]).toMatchObject({ fundedFromOwnMinor: 0, fundedFromInflowMinor: 150_000 });
    expect(accountOf(p, "pot").availableLeftoverMinor).toBe(0);
    expect(accountOf(p, "isa").availableLeftoverMinor).toBe(0);
    expect(accountOf(p, "isa").inflowArrivals).toEqual([
      { inflowId: "b", fromAccountId: "pot", amountMinor: 150_000, confirmedMinor: 0 },
    ]);
  });
});

// =============================================================================
// Decision 13 — committedMinor alongside leftoverMinor
// =============================================================================

describe("computeScopePlan — what savings have spoken for", () => {
  const p = only(
    plan({
      accounts: [
        acc({
          accountId: "current",
          role: "personal",
          memberUserId: "owner",
          incomes: income(200_000),
          payments: [pay({ id: "rent", amountMinor: 50_000, scope: "personal" })],
          outboundInflows: [leaving("to-isa", 60_000, "isa")],
        }),
        acc({
          accountId: "pot",
          incomes: income(30_000),
          outboundInflows: [leaving("pot-to-isa", 10_000, "isa")],
        }),
        acc({ accountId: "isa", role: "personal", memberUserId: "owner" }),
      ],
    }),
  );

  it("reports the funded movements out on the account they leave", () => {
    expect(accountOf(p, "current").committedMinor).toBe(60_000);
    expect(accountOf(p, "pot").committedMinor).toBe(10_000);
    expect(accountOf(p, "isa").committedMinor).toBe(0);
    expect(p.committedMinor).toBe(70_000);
  });

  it("reports a member's committed savings without changing their leftover", () => {
    expect(memberOf(p, "owner").committedMinor).toBe(60_000);
    // Unreduced, exactly as decision 13 requires: £2,300 in — the £2,000 salary
    // and the pot's own £300, which is theirs because the pot is (decision 15) —
    // less £500 of rent.
    expect(memberOf(p, "owner").leftoverMinor).toBe(180_000);
    // The *account's* own residual is a different question and answers £1,500:
    // the pot's £300 is in the member's budget, not in the current account. The
    // two agreed while a shared pot's income belonged to nobody, which is the
    // coincidence decision 15 ended.
    expect(accountOf(p, "current").ownLeftoverMinor).toBe(150_000);
    // The residual is the one figure that *is* net of everything.
    expect(accountOf(p, "current").leftoverMinor).toBe(90_000);
  });

  it("leaves a shared pot's movement out of every member's committed total", () => {
    // The pot's £100 is spending the pot's money. Its *income* is its owner's
    // (decision 15), but what a shared pot sweeps out is the household's doing —
    // counted on the account alone rather than charged to a member.
    expect(memberOf(p, "owner").committedMinor).not.toBe(70_000);
  });
});

// =============================================================================
// The estate-wide money-in invariant, with derived transfers present
// =============================================================================

describe("computeScopePlan — money in is external money, however much moves", () => {
  const withPots = (pots: number) =>
    only(
      plan({
        members: [
          { userId: "alice", shareBp: 6_000 },
          { userId: "bob", shareBp: 4_000 },
        ],
        accounts: [
          acc({
            accountId: "alice-cur",
            role: "personal",
            memberUserId: "alice",
            monthlyBufferMinor: 10_000,
            incomes: income(300_000),
          }),
          acc({
            accountId: "bob-cur",
            role: "personal",
            memberUserId: "bob",
            incomes: income(200_000),
          }),
          ...Array.from({ length: pots }, (_, i) =>
            acc({
              accountId: `pot-${i}`,
              payments: [pay({ id: `bill-${i}`, amountMinor: 20_000 })],
            }),
          ),
        ],
      }),
    );

  it("counts only external income, at any number of derived transfers", () => {
    for (const pots of [0, 1, 4]) {
      const p = withPots(pots);
      expect(p.monthlyIncomeMinor).toBe(500_000);
      expect(p.accounts.reduce((s, a) => s + a.monthlyIncomeMinor, 0)).toBe(500_000);
      // £200 per pot moves, and none of it is income anywhere.
      expect(p.transfers.reduce((s, t) => s + t.amountMinor, 0)).toBe(pots * 20_000);
    }
  });

  it("makes the scope add up: funded plus left over plus reserved is what came in", () => {
    for (const pots of [0, 1, 4]) {
      const p = withPots(pots);
      expect(p.totalFundedMinor + p.leftoverMinor + 10_000).toBe(p.monthlyIncomeMinor);
    }
  });

  it("nets each pot to zero, and leaves the rounding penny in it", () => {
    const p = withPots(1);
    // 60/40 of £200, each share rounded up: £120 + £80, exact.
    expect(accountOf(p, "pot-0").transferInMinor).toBe(20_000);
    expect(accountOf(p, "pot-0").fundedOutflowMinor).toBe(20_000);
    expect(accountOf(p, "pot-0").leftoverMinor).toBe(0);
  });
});

// =============================================================================
// Decision 10 — per currency, and honest about what cannot cross
// =============================================================================

describe("computeScopePlan — planning is per currency", () => {
  const p = plan({
    accounts: [
      acc({
        accountId: "gbp-cur",
        role: "personal",
        memberUserId: "owner",
        incomes: income(300_000),
      }),
      acc({
        accountId: "gbp-pot",
        role: "personal",
        memberUserId: "owner",
        payments: [pay({ id: "rent", amountMinor: 100_000, scope: "personal" })],
      }),
      acc({
        accountId: "eur-pot",
        currency: "EUR",
        payments: [pay({ id: "ski-lodge", amountMinor: 50_000 })],
      }),
    ],
  });

  it("partitions the scope by currency, alphabetically", () => {
    expect(p.partitions.map((x) => x.currency)).toEqual(["EUR", "GBP"]);
  });

  it("derives transfers only inside a currency", () => {
    expect(p.transfers).toHaveLength(1);
    expect(p.transfers[0]).toMatchObject({
      fromAccountId: "gbp-cur",
      toAccountId: "gbp-pot",
      currency: "GBP",
      amountMinor: 100_000,
    });
  });

  it("reports the stranded obligation as an honest shortfall", () => {
    const eur = p.partitions[0]!;
    expect(eur.transfers).toEqual([]);
    expect(memberOf(eur, "owner").monthlyIncomeMinor).toBe(0);
    expect(memberOf(eur, "owner").sourceAccountId).toBeNull();
    expect(memberOf(eur, "owner").shortfallMinor).toBe(50_000);
    expect(eur.shortfallMinor).toBe(50_000);
    expect(lineOf(eur, "ski-lodge").fundedMonthlyMinor).toBe(0);
    // And the pound that could not reach it is still the sterling side's.
    expect(p.partitions[1]!.shortfallMinor).toBe(0);
  });

  it("keeps each member's income and source account per currency", () => {
    const q = computeScopePlan(
      scope({
        accounts: [
          acc({
            accountId: "gbp-cur",
            role: "personal",
            memberUserId: "owner",
            incomes: income(300_000),
          }),
          acc({
            accountId: "eur-cur",
            currency: "EUR",
            role: "personal",
            memberUserId: "owner",
            incomes: income(80_000, "eur-inc"),
          }),
          acc({
            accountId: "eur-pot",
            currency: "EUR",
            role: "personal",
            memberUserId: "owner",
            payments: [pay({ id: "ski-lodge", amountMinor: 50_000, scope: "personal" })],
          }),
        ],
      }),
      ASOF,
    );
    const eur = q.partitions[0]!;
    expect(memberOf(eur, "owner").sourceAccountId).toBe("eur-cur");
    expect(memberOf(eur, "owner").monthlyIncomeMinor).toBe(80_000);
    expect(memberOf(q.partitions[1]!, "owner").monthlyIncomeMinor).toBe(300_000);
    expect(q.transfers.map((t) => [t.currency, t.fromAccountId, t.toAccountId])).toEqual([
      ["EUR", "eur-cur", "eur-pot"],
    ]);
  });

  it("reports a movement whose sender is in another currency as unsourced", () => {
    const q = computeScopePlan(
      scope({
        accounts: [
          acc({
            accountId: "gbp-cur",
            role: "personal",
            memberUserId: "owner",
            incomes: income(300_000),
            outboundInflows: [leaving("cross", 10_000, "eur-pot")],
          }),
          acc({
            accountId: "eur-pot",
            currency: "EUR",
            role: "personal",
            memberUserId: "owner",
            inflows: [
              {
                id: "cross",
                amountMinor: 10_000,
                frequency: "monthly",
                anchorDate: ASOF,
                source: "account",
                sourceAccountId: "gbp-cur",
              },
            ],
          }),
        ],
      }),
      ASOF,
    );
    // The money really does leave the sterling account, and really does not
    // arrive: reported at both ends rather than silently vanishing.
    expect(q.movements.map((m) => [m.currency, m.status, m.fundedMinor])).toEqual([
      ["EUR", "unknown_source", 0],
      ["GBP", "funded", 10_000],
    ]);
    expect(q.partitions[0]!.accounts[0]!.movementInMinor).toBe(0);
  });
});

// =============================================================================
// Phase 4 keeps the estate machinery: loops, statuses, confirmations
// =============================================================================

describe("computeScopePlan — a savings loop is named and broken, not deadlocked", () => {
  const loop = (order: string[]) =>
    only(
      plan({
        accounts: order.map((id) =>
          acc({
            accountId: id,
            role: "personal",
            memberUserId: "owner",
            incomes: id === "a" ? income(100_000) : [],
            outboundInflows: [
              leaving(
                `${id}->${id === "a" ? "b" : id === "b" ? "c" : "a"}`,
                50_000,
                id === "a" ? "b" : id === "b" ? "c" : "a",
              ),
            ],
          }),
        ),
      }),
    );

  it("names the accounts in the loop, in the order money travels", () => {
    const p = loop(["a", "b", "c"]);
    expect(p.cycles).toHaveLength(1);
    expect(p.cycles[0]!.accountIds).toEqual(["a", "b", "c"]);
    expect(p.cycles[0]!.inflowIds).toEqual(["a->b", "b->c", "c->a"]);
    expect(p.cycles[0]!.brokenInflowId).toBe("c->a");
  });

  it("funds nothing along the edge it broke, and says so", () => {
    const p = loop(["a", "b", "c"]);
    const broken = p.movements.find((m) => m.inflowId === "c->a")!;
    expect(broken).toMatchObject({ fundedMinor: 0, status: "broken_cycle" });
    expect(p.movements.find((m) => m.inflowId === "a->b")!.fundedMinor).toBe(50_000);
  });

  it("breaks exactly one edge whatever order the accounts arrive in", () => {
    for (const order of [
      ["a", "b", "c"],
      ["c", "b", "a"],
      ["b", "a", "c"],
    ]) {
      const p = loop(order);
      expect(p.cycles).toHaveLength(1);
      // The loop is the same loop however it is entered; the accounts named are
      // the same set, and one edge — exactly one — is dropped.
      expect([...p.cycles[0]!.accountIds].sort()).toEqual(["a", "b", "c"]);
      expect(p.movements.filter((m) => m.status === "broken_cycle")).toHaveLength(1);
      // And the same input always drops the same one.
      expect(loop(order).cycles[0]!.brokenInflowId).toBe(p.cycles[0]!.brokenInflowId);
    }
  });

  it("tells every account on the loop that it is on one", () => {
    const p = loop(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) {
      expect(accountOf(p, id).fundingCycleAccountIds).toEqual(["a", "b", "c"]);
      expect(accountOf(p, id).fundingCycleBrokenInflowId).toBe("c->a");
    }
  });

  it("survives a loop far deeper than the call stack", () => {
    const ids = Array.from({ length: 6_000 }, (_, i) => `a${String(i).padStart(5, "0")}`);
    const p = only(
      plan({
        accounts: ids.map((id, i) =>
          acc({
            accountId: id,
            role: "personal",
            memberUserId: "owner",
            outboundInflows: [leaving(`${id}->next`, 1_000, ids[(i + 1) % ids.length]!)],
          }),
        ),
      }),
    );
    expect(p.cycles).toHaveLength(1);
    expect(p.cycles[0]!.accountIds).toHaveLength(6_000);
  });

  it("ignores an inactive movement at both ends", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
            outboundInflows: [{ ...leaving("off", 50_000, "pot"), active: false }],
          }),
          acc({ accountId: "pot", role: "personal", memberUserId: "owner" }),
        ],
      }),
    );
    expect(p.movements).toEqual([]);
    expect(accountOf(p, "pot").movementInMinor).toBe(0);
  });

  it("normalises a movement's cadence the way it normalises income", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
            outboundInflows: [{ ...leaving("yearly", 120_000, "pot"), frequency: "yearly" }],
          }),
          acc({ accountId: "pot", role: "personal", memberUserId: "owner" }),
        ],
      }),
    );
    expect(p.movements[0]).toMatchObject({ requestedMinor: 10_000, fundedMinor: 10_000 });
  });

  it("keeps a one-off movement active through its calendar month", () => {
    const p = only(
      computeScopePlan(
        scope({
          accounts: [
            acc({
              accountId: "current",
              role: "personal",
              memberUserId: "owner",
              incomes: income(300_000),
              outboundInflows: [
                {
                  ...leaving("flex-payment", 201_500, "flex"),
                  frequency: "one_off",
                  anchorDate: "2026-08-05",
                },
              ],
            }),
            acc({ accountId: "flex", role: "personal", memberUserId: "owner" }),
          ],
        }),
        "2026-08-06",
      ),
    );

    expect(p.movements[0]).toMatchObject({
      requestedMinor: 201_500,
      fundedMinor: 201_500,
    });
    expect(accountOf(p, "current").leftoverMinor).toBe(98_500);
    expect(accountOf(p, "current").availableLeftoverMinor).toBe(98_500);
    expect(accountOf(p, "flex").movementInMinor).toBe(201_500);
    expect(accountOf(p, "flex").leftoverMinor).toBe(201_500);
    expect(accountOf(p, "flex").availableLeftoverMinor).toBe(0);
  });
});

describe("computeScopePlan — money somebody has said they moved", () => {
  it("clamps a stale derived-transfer confirmation to what the transfer came to", () => {
    const p = only(
      computeScopePlan(
        scope({
          accounts: [
            acc({
              accountId: "current",
              role: "personal",
              memberUserId: "owner",
              incomes: income(60_000),
            }),
            acc({
              accountId: "pot",
              role: "personal",
              memberUserId: "owner",
              payments: [pay({ id: "rent", amountMinor: 90_000, scope: "personal" })],
            }),
          ],
          confirmedTransfers: [
            {
              fromAccountId: "current",
              toAccountId: "pot",
              memberUserId: "owner",
              confirmedMinor: 90_000,
            },
          ],
        }),
        ASOF,
      ) as never,
    );
    // The member could only afford £600 this month; a confirmation taken when
    // they owed £900 must not credit £900.
    expect(p.transfers[0]!.amountMinor).toBe(60_000);
    expect(p.transfers[0]!.confirmedMinor).toBe(60_000);
    expect(accountOf(p, "pot").confirmedInflowMinor).toBe(60_000);
  });

  it("leaves an unconfirmed derived transfer showing as unconfirmed", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
          }),
          acc({
            accountId: "pot",
            role: "personal",
            memberUserId: "owner",
            payments: [pay({ id: "rent", amountMinor: 40_000, scope: "personal" })],
          }),
        ],
      }),
    );
    expect(accountOf(p, "pot").allocatedInflowMinor).toBe(40_000);
    expect(accountOf(p, "pot").confirmedInflowMinor).toBe(0);
  });

  it("counts a confirmed movement, clamped to what it delivered", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(30_000),
            outboundInflows: [leaving("to-pot", 50_000, "pot")],
          }),
          acc({
            accountId: "pot",
            role: "personal",
            memberUserId: "owner",
            confirmedArrivals: [{ inflowId: "to-pot", confirmedMinor: 50_000 }],
          }),
        ],
      }),
    );
    expect(accountOf(p, "pot").movementInMinor).toBe(30_000);
    expect(accountOf(p, "pot").confirmedInflowMinor).toBe(30_000);
    expect(accountOf(p, "pot").inflowArrivals[0]!.confirmedMinor).toBe(30_000);
  });

  it("reports a movement whose sender the scope never loaded", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "pot",
            role: "personal",
            memberUserId: "owner",
            inflows: [
              {
                id: "from-elsewhere",
                amountMinor: 40_000,
                frequency: "monthly",
                anchorDate: ASOF,
                source: "account",
                sourceAccountId: "somewhere-else",
              },
            ],
          }),
        ],
      }),
    );
    expect(p.movements).toEqual([
      {
        inflowId: "from-elsewhere",
        fromAccountId: "somewhere-else",
        toAccountId: "pot",
        currency: "GBP",
        priority: 100,
        requestedMinor: 40_000,
        fundedMinor: 0,
        fundedFromOwnMinor: 0,
        fundedFromInflowMinor: 0,
        status: "unknown_source",
      },
    ]);
  });
});

// =============================================================================
// Buffers
// =============================================================================

describe("computeScopePlan — buffers", () => {
  it("reserves a personal buffer off the top of that member's budget", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            monthlyBufferMinor: 30_000,
            incomes: income(100_000),
            payments: [pay({ id: "rent", amountMinor: 90_000, scope: "personal" })],
          }),
        ],
      }),
    );
    expect(lineOf(p, "rent").fundedMonthlyMinor).toBe(70_000);
    expect(memberOf(p, "owner").leftoverMinor).toBe(0);
    expect(accountOf(p, "current").leftoverMinor).toBe(30_000);
  });

  it("funds a shared pot's buffer proportionally, and keeps savings out of it", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
          }),
          acc({
            accountId: "pot",
            monthlyBufferMinor: 20_000,
            payments: [pay({ id: "rent", amountMinor: 40_000 })],
            outboundInflows: [leaving("sweep", 100_000, "isa")],
          }),
          acc({ accountId: "isa", role: "personal", memberUserId: "owner" }),
        ],
      }),
    );
    // £400 of bills and £200 of reserve travel into the pot...
    expect(accountOf(p, "pot").transferInMinor).toBe(60_000);
    expect(accountOf(p, "pot").fundedOutflowMinor).toBe(40_000);
    // ...and the sweep may only take what is neither: nothing.
    expect(p.movements[0]).toMatchObject({ inflowId: "sweep", fundedMinor: 0, status: "unfunded" });
    expect(accountOf(p, "pot").leftoverMinor).toBe(20_000);
  });
});

// =============================================================================
// Shape
// =============================================================================

describe("computeScopePlan — the shape of the answer", () => {
  it("flattens every partition in a stable order", () => {
    const p = plan({
      accounts: [
        acc({ accountId: "gbp", role: "personal", memberUserId: "owner", incomes: income(1_000) }),
        acc({ accountId: "eur", currency: "EUR", role: "personal", memberUserId: "owner" }),
      ],
    });
    expect(p.accounts.map((a) => a.accountId)).toEqual(["eur", "gbp"]);
    expect(p.scopeId).toBe("scope");
    expect(p.householdId).toBeNull();
    expect(p.asOfDate).toBe(ASOF);
  });

  it("carries the household's id when the scope is one", () => {
    const p = computeScopePlan(
      { scopeId: "hh", householdId: "hh", members: [], accounts: [] },
      ASOF,
    );
    expect(p.householdId).toBe("hh");
  });

  it("defaults an unranked payment and an unranked movement to 100", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
            payments: [
              {
                id: "unranked",
                name: "unranked",
                category: "monthly_recurring",
                amountMinor: 10_000,
                scope: "personal",
              },
              pay({ id: "urgent", amountMinor: 10_000, scope: "personal", priority: 1 }),
            ],
            outboundInflows: [{ ...leaving("sweep", 1_000, "pot"), priority: undefined }],
          }),
          acc({ accountId: "pot", role: "personal", memberUserId: "owner" }),
        ],
      }),
    );
    expect(p.lines.map((l) => l.paymentId)).toEqual(["urgent", "unranked"]);
    expect(lineOf(p, "unranked").priority).toBe(100);
    expect(p.movements[0]!.priority).toBe(100);
  });

  it("paces a contribution-first goal and says when the pace chose the date", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
            payments: [
              pay({
                id: "dateless",
                amountMinor: 60_000,
                category: "fixed_point",
                fixedMonthlyMinor: 20_000,
                scope: "personal",
              }),
              pay({
                id: "dated",
                amountMinor: 60_000,
                category: "fixed_point",
                fixedMonthlyMinor: 20_000,
                dueDate: "2027-06-01",
                scope: "personal",
              }),
            ],
          }),
        ],
      }),
    );
    expect(lineOf(p, "dateless").requiredMonthlyMinor).toBe(20_000);
    expect(lineOf(p, "dateless").dueDateIsDerived).toBe(true);
    expect(lineOf(p, "dateless").monthsUntilDue).toBe(3);
    expect(lineOf(p, "dated").dueDateIsDerived).toBe(false);
    expect(lineOf(p, "dated").dueDate).toBe("2027-06-01");
  });

  it("orders two movements between the same pair of accounts by row", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
            outboundInflows: [
              leaving("zulu", 10_000, "pot", 10),
              leaving("alpha", 10_000, "pot", 10),
            ],
          }),
          acc({ accountId: "pot", role: "personal", memberUserId: "owner" }),
        ],
      }),
    );
    expect(p.movements.map((m) => m.inflowId)).toEqual(["alpha", "zulu"]);
    expect(accountOf(p, "pot").inflowArrivals.map((a) => a.inflowId)).toEqual(["alpha", "zulu"]);
  });

  it("does not report a movement twice when it can see both of its faces", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
            inflows: [
              {
                id: "salary",
                amountMinor: 100_000,
                frequency: "monthly",
                anchorDate: ASOF,
                source: "external",
                sourceAccountId: null,
              },
            ],
            outboundInflows: [leaving("to-pot", 10_000, "pot")],
          }),
          acc({
            accountId: "pot",
            role: "personal",
            memberUserId: "owner",
            inflows: [
              {
                id: "to-pot",
                amountMinor: 10_000,
                frequency: "monthly",
                anchorDate: ASOF,
                source: "account",
                sourceAccountId: "current",
              },
              {
                id: "retired",
                amountMinor: 10_000,
                frequency: "monthly",
                anchorDate: ASOF,
                active: false,
                source: "account",
                sourceAccountId: "nowhere",
              },
            ],
          }),
        ],
      }),
    );
    // The external row is not a movement, the inactive one is not happening, and
    // the live one is already known from the face that has to afford it.
    expect(p.movements.map((m) => [m.inflowId, m.status])).toEqual([["to-pot", "funded"]]);
  });

  it("carries a payment's tag and category onto the line", () => {
    const p = only(
      plan({
        accounts: [
          acc({
            accountId: "bills",
            payments: [pay({ id: "rent", amountMinor: 10_000, tag: "housing" })],
          }),
        ],
      }),
    );
    expect(lineOf(p, "rent")).toMatchObject({
      tag: "housing",
      category: "monthly_recurring",
      scope: "shared",
      currency: "GBP",
      accountId: "bills",
    });
  });

  it("explains funding rank, derived transfers and authored movements", () => {
    const debug = explainScopePlan(
      scope({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: income(100_000),
            outboundInflows: [
              { ...leaving("sweep", 30_000, "savings", 20), name: "Savings sweep" },
            ],
          }),
          acc({
            accountId: "bills",
            role: "personal",
            memberUserId: "owner",
            payments: [pay({ id: "rent", amountMinor: 40_000, scope: "personal" })],
          }),
          acc({ accountId: "savings", role: "personal", memberUserId: "owner" }),
        ],
      }),
      ASOF,
    );

    const trace = debug.currencies[0]!;
    expect(trace.fundingSteps[0]).toMatchObject({
      rank: 1,
      paymentId: "rent",
      accountId: "bills",
      memberUserId: "owner",
      fundedMinor: 40_000,
    });
    expect(trace.transferDerivations).toContainEqual(
      expect.objectContaining({
        paymentId: "rent",
        fromAccountId: "current",
        toAccountId: "bills",
        movingMinor: 40_000,
        reason: "transfer",
      }),
    );
    expect(trace.savings.accountSteps.flatMap((s) => s.movements)).toContainEqual(
      expect.objectContaining({
        inflowId: "sweep",
        fromAccountId: "current",
        toAccountId: "savings",
        fundedMinor: 30_000,
        status: "funded",
      }),
    );
    expect(debug.plan.partitions[0]!.members[0]).toMatchObject({
      leftoverMinor: 60_000,
      availableLeftoverMinor: 30_000,
      committedMinor: 30_000,
    });
    // The text these figures are laid out in is the API's
    // (`apps/api/src/plan-debug-report.ts`), and is asserted there.
  });

  /**
   * The explanations are built mid-pass, out of the same call whose result they
   * describe, so they cannot be generated anywhere else — and that is exactly
   * why they are pinned. An explanation that drifts from its own arithmetic is
   * worse than no explanation, because it is believed.
   */
  const explainIncome = (over: Partial<IncomeInput> & { id: string; amountMinor: number }) =>
    explainScopePlan(
      scope({
        accounts: [
          acc({
            accountId: "current",
            role: "personal",
            memberUserId: "owner",
            incomes: [{ frequency: "monthly", anchorDate: ASOF, ...over }],
          }),
        ],
      }),
      ASOF,
    ).currencies[0]!.accounts[0]!.incomes[0]!;

  it.each([
    ["monthly", { id: "i", amountMinor: 120_000 }, "monthly income contributes its amount"],
    [
      "yearly",
      { id: "i", amountMinor: 120_000, frequency: "yearly" as const },
      "yearly income is rounded over 12 months: 120000 / 12 = 10000",
    ],
    [
      "custom with a recurrence",
      {
        id: "i",
        amountMinor: 20_000,
        frequency: "custom" as const,
        recurrence: { interval: 2, unit: "month" as const, anchor: ASOF },
      },
      "custom income is normalised over its recurrence: 20000 -> 10000",
    ],
    [
      "custom with no recurrence",
      { id: "i", amountMinor: 20_000, frequency: "custom" as const },
      "custom income without a recurrence contributes its amount: 20000",
    ],
    [
      "a one-off still ahead",
      { id: "i", amountMinor: 60_000, frequency: "one_off" as const, anchorDate: "2026-11-04" },
      "one-off income is spread until its anchor when it is still in the future: 60000 -> 20000",
    ],
    [
      "an inactive row",
      { id: "i", amountMinor: 120_000, active: false },
      "inactive income contributes 0",
    ],
  ])("explains %s income", (_name, over, expected) => {
    expect(explainIncome(over).explanation).toContain(expected);
  });

  const explainPayment = (payment: ScopePaymentInput) =>
    explainScopePlan(
      scope({
        accounts: [
          acc({
            accountId: "bills",
            role: "personal",
            memberUserId: "owner",
            incomes: income(500_000),
            payments: [payment],
          }),
        ],
      }),
      ASOF,
    ).currencies[0]!.payments[0]!;

  it.each([
    [
      "a monthly recurring bill",
      pay({ id: "rent", amountMinor: 40_000 }),
      "monthly recurring: the full amount is due this month, required = 40000",
    ],
    [
      "a contribution-first fixed point",
      pay({
        id: "holiday",
        amountMinor: 100_000,
        category: "fixed_point",
        fixedMonthlyMinor: 15_000,
        alreadySavedMinor: 20_000,
      }),
      "contribution-first fixed point: remaining 80000, cap 15000, required = min(cap, remaining) = 15000",
    ],
    [
      "a custom recurring landing more than once",
      pay({
        id: "weekly",
        amountMinor: 10_000,
        category: "custom_recurring",
        recurrence: { interval: 1, unit: "week", anchor: ASOF },
      }),
      "times this month, required = 10000 *",
    ],
    [
      "a dated save-up",
      pay({
        id: "tax",
        amountMinor: 120_000,
        category: "fixed_point",
        targetDate: "2026-11-04",
      }),
      "save-up path: remaining 120000, months until effective date 3, required = ceil(remaining / months) = 40000",
    ],
  ])("explains %s", (_name, payment, expected) => {
    expect(explainPayment(payment).explanation).toContain(expected);
  });
});
