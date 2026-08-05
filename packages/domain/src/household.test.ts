import { describe, expect, it } from "vitest";
import { householdPlanFromScope } from "./household.js";
import {
  computeScopePlan,
  type ScopeAccountInput,
  type ScopeInput,
  type ScopePaymentInput,
} from "./scope.js";

/**
 * The household plan is a **view** now, so this file tests a view.
 *
 * Everything that used to live here — proportional shared costs, shares rounding
 * up per line, personal bearers, contribution-first goals, one global priority
 * order, buffers — is the funding pass's behaviour and is tested against the pass
 * in `scope.test.ts`. It moved when the engine did. What is left is the thing
 * only this module can get wrong: which of the scope's accounts belong to the
 * household, and how the pass's figures are reported once they do.
 */

const ASOF = "2026-08-04";

const income = (id: string, amountMinor: number) => ({
  id,
  amountMinor,
  frequency: "monthly" as const,
  anchorDate: "2026-08-25",
});

const owed = (
  id: string,
  amountMinor: number,
  over: Partial<ScopePaymentInput> = {},
): ScopePaymentInput => ({
  id,
  name: id,
  category: "monthly_recurring",
  scope: "shared",
  amountMinor,
  priority: 1,
  ...over,
});

const acc = (over: Partial<ScopeAccountInput> & { accountId: string }): ScopeAccountInput => ({
  name: over.accountId,
  role: "shared",
  currency: "GBP",
  incomes: [],
  payments: [],
  ...over,
});

/** Alice and Bob, 60/40, a shared bills pot and one personal gym membership. */
function household(over: Partial<ScopeInput> = {}): ScopeInput {
  return {
    scopeId: "hh",
    householdId: "hh",
    members: [
      { userId: "alice", displayName: "Alice", shareBp: 6_000 },
      { userId: "bob", displayName: "Bob", shareBp: 4_000 },
    ],
    accounts: [
      acc({
        accountId: "alice-cur",
        role: "personal",
        memberUserId: "alice",
        incomes: [income("alice-pay", 300_000)],
        payments: [owed("gym", 5_000, { scope: "personal" })],
      }),
      acc({
        accountId: "bob-cur",
        role: "personal",
        memberUserId: "bob",
        incomes: [income("bob-pay", 200_000)],
      }),
      acc({ accountId: "bills", payments: [owed("rent", 100_000)] }),
    ],
    ...over,
  };
}

const HOUSEHOLD_ACCOUNTS = ["alice-cur", "bob-cur", "bills"];

function view(input: ScopeInput, accountIds: readonly string[] = HOUSEHOLD_ACCOUNTS) {
  return householdPlanFromScope(computeScopePlan(input, ASOF), "hh", accountIds, "GBP");
}

describe("householdPlanFromScope", () => {
  const plan = view(household());

  it("echoes the household's identity and the pass's as-of date", () => {
    expect(plan.householdId).toBe("hh");
    expect(plan.currency).toBe("GBP");
    expect(plan.asOfDate).toBe(ASOF);
  });

  it("totals what the household earns, owes and got", () => {
    expect(plan.monthlyIncomeMinor).toBe(500_000);
    expect(plan.totalRequiredMinor).toBe(105_000);
    expect(plan.totalFundedMinor).toBe(105_000);
    expect(plan.shortfallMinor).toBe(0);
    expect(plan.leftoverMinor).toBe(395_000);
    expect(plan.committedMinor).toBe(0);
  });

  it("reports each member's slice, and their committed savings alongside", () => {
    expect(plan.members.map((m) => [m.userId, m.shareBp, m.obligationMinor])).toEqual([
      ["alice", 6_000, 65_000],
      ["bob", 4_000, 40_000],
    ]);
    expect(plan.members.map((m) => m.leftoverMinor)).toEqual([235_000, 160_000]);
    expect(plan.members.every((m) => m.committedMinor === 0)).toBe(true);
    expect(plan.members.map((m) => m.displayName)).toEqual(["Alice", "Bob"]);
  });

  it("derives the transfers into the shared pot, per member", () => {
    expect(plan.transfers).toEqual([
      {
        fromAccountId: "alice-cur",
        toAccountId: "bills",
        memberUserId: "alice",
        amountMinor: 60_000,
      },
      { fromAccountId: "bob-cur", toAccountId: "bills", memberUserId: "bob", amountMinor: 40_000 },
    ]);
  });

  it("reports each account's residual before its savings leave", () => {
    const bills = plan.accounts.find((a) => a.accountId === "bills")!;
    expect(bills).toMatchObject({
      role: "shared",
      memberUserId: null,
      monthlyIncomeMinor: 0,
      requiredOutflowMinor: 100_000,
      fundedOutflowMinor: 100_000,
      transferInMinor: 100_000,
      transferOutMinor: 0,
      leftoverMinor: 0,
      committedMinor: 0,
      shortfallMinor: 0,
    });
  });
});

describe("householdPlanFromScope — the money leaving one of its accounts", () => {
  /**
   * The defect, in the smallest fixture that shows it: Alice moves £700 a month
   * into an ISA that is not the household's. The old engine had no term for it
   * at all, so the household page reported a leftover £700 higher than the flow
   * diagram's (ONE-ENGINE.md, "the defect that forced this").
   */
  const withISA = household({
    accounts: household().accounts.map((a) =>
      a.accountId === "alice-cur"
        ? {
            ...a,
            outboundInflows: [
              {
                id: "to-isa",
                toAccountId: "isa",
                amountMinor: 70_000,
                frequency: "monthly" as const,
                anchorDate: "2026-08-25",
                priority: 10,
              },
            ],
          }
        : a,
    ),
  });
  const plan = view(withISA);
  const alice = () => plan.accounts.find((a) => a.accountId === "alice-cur")!;

  it("keeps leftoverMinor's meaning and adds committedMinor alongside", () => {
    // Decision 13: the residual before savings is what it always was, and what
    // the movement takes is a second field rather than a change to the first.
    expect(alice().leftoverMinor).toBe(300_000 - 5_000 - 60_000);
    expect(alice().committedMinor).toBe(70_000);
    expect(alice().leftoverMinor - alice().committedMinor).toBe(165_000);
  });

  it("rolls the committed total up to the household and to the member", () => {
    expect(plan.committedMinor).toBe(70_000);
    expect(plan.members.find((m) => m.userId === "alice")?.committedMinor).toBe(70_000);
    expect(plan.members.find((m) => m.userId === "bob")?.committedMinor).toBe(0);
  });

  it("leaves the member's own leftover unreduced by it", () => {
    expect(plan.members.find((m) => m.userId === "alice")?.leftoverMinor).toBe(235_000);
  });
});

describe("householdPlanFromScope — the scope is wider than the household", () => {
  /** Alice's private current account, outside the household, feeding the pot. */
  const wider = household({
    accounts: [
      ...household().accounts,
      acc({
        accountId: "alice-private",
        role: "personal",
        memberUserId: "alice",
        incomes: [income("side", 50_000)],
        outboundInflows: [
          {
            id: "private->bills",
            toAccountId: "bills",
            amountMinor: 10_000,
            frequency: "monthly",
            anchorDate: "2026-08-25",
            priority: 10,
          },
        ],
      }),
    ],
  });
  const plan = view(wider);

  it("reports only the accounts the household was given", () => {
    expect(plan.accounts.map((a) => a.accountId)).toEqual(HOUSEHOLD_ACCOUNTS);
    // In the pass's funding order — the order the month's money was spent —
    // which is what makes an account's slice of this list its funding order too.
    expect(plan.lines.map((l) => [l.paymentId, l.accountId])).toEqual([
      ["gym", "alice-cur"],
      ["rent", "bills"],
    ]);
    expect(plan.monthlyIncomeMinor).toBe(500_000);
  });

  it("still counts what arrives from outside it, because the money is there", () => {
    const bills = plan.accounts.find((a) => a.accountId === "bills")!;
    expect(bills.leftoverMinor).toBe(10_000);
    expect(plan.committedMinor).toBe(0);
  });
});

describe("householdPlanFromScope — a member's costs the household's lines do not carry", () => {
  /**
   * Decision 9, as the household page reads it. Alice keeps a rent pot of her
   * own, outside the household, with a £400 bill on it — the pass funds it from
   * her budget and derives the feed, so nobody authored anything and nothing is
   * short. Her `obligationMinor` counts it, because it is hers; this view's
   * `lines` cannot, because the account is not the household's.
   *
   * Those two were published side by side with nothing naming the difference, so
   * the page printed "their costs" over a breakdown that explained less than the
   * figure, and the web invented the missing category by subtracting the red
   * from the remainder. The split is published now.
   */
  const withOwnPot = household({
    accounts: [
      ...household().accounts,
      acc({
        accountId: "alice-pot",
        role: "personal",
        memberUserId: "alice",
        payments: [owed("alice-rent", 40_000, { scope: "personal", bearerUserId: "alice" })],
      }),
    ],
  });
  const plan = view(withOwnPot);
  const alice = () => plan.members.find((m) => m.userId === "alice")!;
  const bob = () => plan.members.find((m) => m.userId === "bob")!;

  it("keeps the scope-wide figures exactly as they were", () => {
    // Decision 4/13: added alongside, never a change of meaning.
    expect(alice().obligationMinor).toBe(60_000 + 5_000 + 40_000);
    expect(alice().fundedMinor).toBe(105_000);
    expect(alice().shortfallMinor).toBe(0);
  });

  it("names what these lines carry, and names the rest", () => {
    expect(alice().householdObligationMinor).toBe(65_000);
    expect(alice().householdFundedMinor).toBe(65_000);
    expect(alice().elsewhereObligationMinor).toBe(40_000);
    expect(alice().elsewhereFundedMinor).toBe(40_000);
  });

  it("reconciles: the two halves are the whole, for every member", () => {
    for (const m of plan.members) {
      expect(m.householdObligationMinor + m.elsewhereObligationMinor).toBe(m.obligationMinor);
      expect(m.householdFundedMinor + m.elsewhereFundedMinor).toBe(m.fundedMinor);
    }
    // And what the lines carry is what the lines say, member by member.
    const fromLines = plan.lines.reduce(
      (sum, l) => sum + (l.allocations.find((a) => a.userId === "alice")?.requiredMinor ?? 0),
      0,
    );
    expect(fromLines).toBe(alice().householdObligationMinor);
  });

  it("leaves a member with nothing outside the household untouched", () => {
    expect(bob().elsewhereObligationMinor).toBe(0);
    expect(bob().elsewhereFundedMinor).toBe(0);
    expect(bob().householdObligationMinor).toBe(bob().obligationMinor);
    expect(bob().householdFundedMinor).toBe(bob().fundedMinor);
  });
});

describe("householdPlanFromScope — the edges", () => {
  it("reports the shortfall of a household nobody is a member of", () => {
    // The finding WP-P raised and declined to patch in a live surface: the old
    // engine attributed the rent to nobody, summed the obligations it *did*
    // attribute, and reported a shortfall of zero while the pot was £1,000
    // short. A bill nobody was asked for is still a bill.
    const plan = view(household({ members: [] }));
    expect(plan.members).toEqual([]);
    expect(plan.totalRequiredMinor).toBe(105_000);
    expect(plan.totalFundedMinor).toBe(0);
    expect(plan.shortfallMinor).toBe(105_000);
    expect(plan.accounts.find((a) => a.accountId === "bills")?.shortfallMinor).toBe(100_000);
  });

  it("counts income in an account no member owns as the household's own surplus", () => {
    const orphan = household({
      accounts: [
        ...household().accounts,
        acc({ accountId: "joint-savings", incomes: [income("interest", 1_000)] }),
      ],
    });
    const plan = view(orphan, [...HOUSEHOLD_ACCOUNTS, "joint-savings"]);
    expect(plan.monthlyIncomeMinor).toBe(501_000);
    expect(plan.leftoverMinor).toBe(396_000);
  });

  it("plans an empty household without complaint", () => {
    const plan = householdPlanFromScope(
      computeScopePlan({ scopeId: "hh", members: [], accounts: [] }, ASOF),
      "hh",
      [],
      "GBP",
    );
    expect(plan).toMatchObject({
      monthlyIncomeMinor: 0,
      totalRequiredMinor: 0,
      leftoverMinor: 0,
      shortfallMinor: 0,
      members: [],
      accounts: [],
      lines: [],
      transfers: [],
    });
  });

  it("answers with nothing for a currency the scope never planned", () => {
    // Defensive rather than expected: a household is one currency by
    // assumption, and asking for another must not throw at the view layer.
    expect(
      householdPlanFromScope(computeScopePlan(household(), ASOF), "hh", HOUSEHOLD_ACCOUNTS, "USD"),
    ).toMatchObject({ currency: "USD", accounts: [], members: [], monthlyIncomeMinor: 0 });
  });
});
