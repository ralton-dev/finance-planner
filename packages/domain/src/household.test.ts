import { describe, expect, it } from "vitest";
import {
  CROSS_OWNER_ASOF,
  CROSS_OWNER_ASSIGNED_ACCOUNT_IDS,
  CROSS_OWNER_HOUSEHOLD_ID,
  crossOwnerScope,
} from "./crossowner.fixture.js";
import { estate, ESTATE_ASOF } from "./estate.fixture.js";
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
  // A shared pot is still somebody's account (decision 15); here it is Alice's,
  // and a personal account is owned by the member the roster names.
  ownerUserId: over.memberUserId ?? "alice",
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
    expect(plan.householdLeftoverMinor).toBe(395_000);
    // Three figures with "leftover" in the name, all £3,950 here because this
    // household holds every account its members own and nobody moves anything
    // between them. The fixtures below are where they come apart.
    expect(plan.membersLeftoverMinor).toBe(395_000);
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
      // Everything arriving here is derived transport; nobody authored a
      // movement into the bills pot.
      movementInMinor: 0,
      leftoverMinor: 0,
      committedMinor: 0,
      shortfallMinor: 0,
    });
  });

  /**
   * The mirror of `committedMinor`, and the reason it is published rather than
   * left to be inferred: the flow page recovered it by rearranging
   * `leftoverMinor`'s identity, which is arithmetic over terms this work has
   * already redefined twice (WP-Y).
   */
  it("reports what an authored movement delivered into one of its accounts", () => {
    const fed = view(
      household({
        accounts: household().accounts.map((a) =>
          a.accountId === "alice-cur"
            ? {
                ...a,
                outboundInflows: [
                  {
                    id: "to-bills",
                    toAccountId: "bills",
                    amountMinor: 20_000,
                    frequency: "monthly" as const,
                    anchorDate: "2026-08-25",
                    priority: 10,
                  },
                ],
              }
            : a,
        ),
      }),
    );
    const bills = fed.accounts.find((a) => a.accountId === "bills")!;
    expect(bills.movementInMinor).toBe(20_000);
    // Decision 12: it lands on top of the derived feed as savings, not instead
    // of it, so the transport is unchanged and the pot simply keeps the £200.
    expect(bills.transferInMinor).toBe(100_000);
    expect(bills.leftoverMinor).toBe(20_000);
    // And the identity the flow page used to invert still holds — it is just
    // no longer what the picture depends on.
    expect(
      bills.leftoverMinor +
        bills.fundedOutflowMinor +
        bills.transferOutMinor -
        bills.monthlyIncomeMinor -
        bills.transferInMinor,
    ).toBe(bills.movementInMinor);
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
    // The account it leaves is the household's, so there is no elsewhere half.
    expect(plan.members.every((m) => m.elsewhereCommittedMinor === 0)).toBe(true);
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
    expect(bills.movementInMinor).toBe(10_000);
    // The sender is outside the household, so nothing on this roster is
    // committed — and the £100 is in the pot all the same. A row that recorded
    // the arrival and reported £0 left over described a month in which the
    // money left one account and reached none.
    expect(bills.leftoverMinor).toBe(10_000);
    expect(plan.committedMinor).toBe(0);
  });

  /**
   * WP-AA. The fifth instance of one assumption, and the one where the two
   * halves were already published side by side without a name for the second.
   *
   * `committedMinor` here is the household's own accounts — correctly, a
   * member's private ISA draining a private current account is not its business
   * — and `leftoverMinor` on the same object is scope-wide. Netting the one
   * against the other spans two different sets of accounts, so the page printed
   * Alice £2,850 free when £2,750 was true: the £100 `alice-private` sweeps into
   * the pot was in neither term.
   */
  it("names what a member commits out of an account the household does not hold", () => {
    const alice = plan.members.find((m) => m.userId === "alice")!;
    expect(alice.committedMinor).toBe(0);
    expect(alice.elsewhereCommittedMinor).toBe(10_000);
    // Scope-wide surplus less scope-wide commitment: a figure about a person,
    // measured over the accounts that person actually has.
    expect(alice.leftoverMinor - alice.committedMinor - alice.elsewhereCommittedMinor).toBe(
      275_000,
    );
  });

  it("reconciles: the two halves are the pass's whole, for every member", () => {
    const scope = computeScopePlan(wider, ASOF).partitions.find((p) => p.currency === "GBP")!;
    for (const m of plan.members) {
      const inScope = scope.members.find((s) => s.userId === m.userId)!;
      expect(m.committedMinor + m.elsewhereCommittedMinor).toBe(inScope.committedMinor);
    }
    expect(plan.members.find((m) => m.userId === "bob")!.elsewhereCommittedMinor).toBe(0);
  });

  it("keeps the household's own committed total to the household's own accounts", () => {
    // The narrowing is the point, and it survives: what a member commits
    // elsewhere is named on their row and counted in neither the household's
    // total nor any account row on it.
    expect(plan.committedMinor).toBe(0);
    expect(plan.accounts.every((a) => a.committedMinor === 0)).toBe(true);
  });

  /**
   * WP-AG. The same assumption on the other side of the row, and the one
   * `f3acef8` created: closing ownership and household assignment into one
   * relation put a member's private salary into the budget that pays their
   * household share, so `monthlyIncomeMinor` — scope-wide, like every other
   * member figure here — began counting £500 the account table beneath it does
   * not hold and cannot explain.
   *
   * The amount is published; the source is not (Ben, 2026-08-05). A co-member
   * needs it to judge the hand-set share split, and needs nothing more.
   */
  it("names what a member earns into an account the household does not hold", () => {
    const alice = plan.members.find((m) => m.userId === "alice")!;
    // Decision 4/13: the scope-wide figure is untouched — £3,000 salary plus the
    // £500 landing in the account nobody assigned here.
    expect(alice.monthlyIncomeMinor).toBe(350_000);
    expect(alice.householdIncomeMinor).toBe(300_000);
    expect(alice.elsewhereIncomeMinor).toBe(50_000);
  });

  it("reconciles income the same way: the two halves are the pass's whole", () => {
    const scope = computeScopePlan(wider, ASOF).partitions.find((p) => p.currency === "GBP")!;
    for (const m of plan.members) {
      expect(m.householdIncomeMinor + m.elsewhereIncomeMinor).toBe(m.monthlyIncomeMinor);
      expect(m.monthlyIncomeMinor).toBe(
        scope.members.find((s) => s.userId === m.userId)!.monthlyIncomeMinor,
      );
    }
    // And the household half is the INCOME column of the table above, for this
    // member's rows — figure and breakdown off one set of accounts (WP-V).
    const fromAccounts = plan.accounts
      .filter((a) => a.role === "personal" && a.memberUserId === "alice")
      .reduce((s, a) => s + a.monthlyIncomeMinor, 0);
    expect(fromAccounts).toBe(plan.members.find((m) => m.userId === "alice")!.householdIncomeMinor);
  });

  it("leaves a member who banks only here with no elsewhere half", () => {
    const bob = plan.members.find((m) => m.userId === "bob")!;
    expect(bob.elsewhereIncomeMinor).toBe(0);
    expect(bob.householdIncomeMinor).toBe(bob.monthlyIncomeMinor);
  });

  it("names it whether or not any of that money crosses into the household", () => {
    // The same £500, in an account that sends the household nothing. The figure
    // has two halves permanently — like every other `elsewhere*` field on this
    // interface — rather than a note that appears when money moves.
    const sealed = view(
      household({
        accounts: [
          ...household().accounts,
          acc({
            accountId: "alice-private",
            role: "personal",
            memberUserId: "alice",
            incomes: [income("side", 50_000)],
          }),
        ],
      }),
    );
    expect(sealed.transfers.every((t) => t.fromAccountId !== "alice-private")).toBe(true);
    const alice = sealed.members.find((m) => m.userId === "alice")!;
    expect(alice.householdIncomeMinor).toBe(300_000);
    expect(alice.elsewhereIncomeMinor).toBe(50_000);
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

  /**
   * WP-X. The feed into `alice-pot` is a real £400 transfer Alice must make and
   * it is **not the household's** — the same rule `committedMinor` gets, in the
   * one direction a transfer has and a balance does not.
   *
   * It was listed here, because the filter asked whether *either* end was the
   * household's. On screen it was a row the household could not name — the far
   * end is not in `accounts`, so the checklist and the fold both printed
   * "Alice → account" — with a working "mark done" that booked no contributions,
   * because `POST /households/:id/transfers/confirm` credits `plan.lines`
   * filtered to the destination and there are no lines on an account this plan
   * does not hold. Ticking it did nothing, and said it had.
   *
   * Alice's pot is fed and confirmed from its own account page instead, off the
   * pass's own `transfers` (`POST /accounts/:id/transfers/confirm`).
   */
  it("lists what arrives at its own accounts, and not what leaves for a member's", () => {
    expect(plan.transfers).toEqual([
      {
        fromAccountId: "alice-cur",
        toAccountId: "bills",
        memberUserId: "alice",
        amountMinor: 60_000,
      },
      { fromAccountId: "bob-cur", toAccountId: "bills", memberUserId: "bob", amountMinor: 40_000 },
    ]);
    // The pass derived it; this view is the thing that does not report it.
    expect(computeScopePlan(withOwnPot, ASOF).transfers).toContainEqual(
      expect.objectContaining({ toAccountId: "alice-pot", amountMinor: 40_000 }),
    );
  });

  it("keeps the published transfers coherent with the totals they pay for", () => {
    // Every row is transport for an obligation these totals count, and nothing
    // else is: the sum is what the household's own accounts receive, to the
    // penny. `alice-cur`'s own `transferOutMinor` still counts the £400 leaving
    // for her pot, because the money really does leave — that is the account's
    // arithmetic, not the household's instruction list.
    const received = plan.accounts.reduce((s, a) => s + a.transferInMinor, 0);
    expect(plan.transfers.reduce((s, t) => s + t.amountMinor, 0)).toBe(received);
    expect(plan.accounts.find((a) => a.accountId === "alice-cur")!.transferOutMinor).toBe(
      60_000 + 40_000,
    );
    // …and every row has lines on this plan for a confirmation to book against.
    for (const t of plan.transfers) {
      expect(plan.lines.some((l) => l.accountId === t.toAccountId)).toBe(true);
    }
  });

  it("still lists a transfer arriving from an account the household does not hold", () => {
    // The other direction, which is the household's business: money a member
    // sends *in* pays for a line on this list, wherever they send it from. Here
    // only the pot is the household's, and both members feed it from outside.
    const potOnly = householdPlanFromScope(
      computeScopePlan(withOwnPot, ASOF),
      "hh",
      ["bills"],
      "GBP",
    );
    expect(potOnly.accounts.map((a) => a.accountId)).toEqual(["bills"]);
    expect(potOnly.transfers.map((t) => [t.fromAccountId, t.toAccountId])).toEqual([
      ["alice-cur", "bills"],
      ["bob-cur", "bills"],
    ]);
  });
});

/**
 * WP-Z. `leftoverMinor` was the one scope-wide figure in a KPI row of
 * household-only ones, and the row read as if it were not.
 *
 * The fourth instance of one assumption — *"a figure derived over the scope can
 * be published as the household's without re-deriving it"* — after
 * `obligationMinor` (WP-V), `committedMinor` and `transfers` (WP-X). Same
 * answer: keep the field, add the household's own alongside it (decision 4/13),
 * and sum the new one off the very rows the page prints beneath the figure.
 */
describe("householdPlanFromScope — what is left in the household's accounts", () => {
  /** Every term is a published field of the accounts this plan lists. */
  const ribbons = (plan: ReturnType<typeof view>): number =>
    plan.monthlyIncomeMinor +
    plan.accounts.reduce((s, a) => s + a.transferInMinor + a.movementInMinor, 0) -
    plan.accounts.reduce((s, a) => s + a.fundedOutflowMinor + a.transferOutMinor, 0);

  it("is the account table's LEFT OVER column, added up", () => {
    // The whole point of deriving it here rather than off `partition.members`:
    // the figure and the breakdown beneath it cannot be computed over different
    // sets of accounts, because they are the same sum.
    const plan = view(household());
    expect(plan.householdLeftoverMinor).toBe(
      plan.accounts.reduce((s, a) => s + a.leftoverMinor, 0),
    );
    expect(plan.householdLeftoverMinor - plan.committedMinor).toBe(
      plan.accounts.reduce((s, a) => s + (a.leftoverMinor - a.committedMinor), 0),
    );
  });

  /**
   * The reported defect, in the smallest fixture that shows it: a household
   * that holds nothing but the bills pot. Its own income is £0 and its own
   * accounts spend every penny that reaches them, and it reported the members'
   * whole scope-wide surplus as its left over — a headline derived from income
   * its own income figure does not contain.
   */
  it("does not report the members' surplus as the household's", () => {
    const potOnly = view(household(), ["bills"]);
    expect(potOnly.monthlyIncomeMinor).toBe(0);
    expect(potOnly.totalRequiredMinor).toBe(100_000);
    // Preserved to the penny (decision 13) — and this is what the page used to
    // print beside an income of £0.
    expect(potOnly.leftoverMinor).toBe(395_000);
    // What the household's own accounts actually hold when the month is over.
    expect(potOnly.householdLeftoverMinor).toBe(0);
    expect(potOnly.householdLeftoverMinor).toBe(ribbons(potOnly));
  });

  it("keeps the household's ribbons meeting, in every shape this file plans", () => {
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
    for (const plan of [
      view(household()),
      view(household(), ["bills"]),
      view(household({ members: [] })),
      view(withISA),
    ]) {
      expect(plan.householdLeftoverMinor).toBe(ribbons(plan));
      expect(plan.householdLeftoverMinor).toBe(
        plan.accounts.reduce((s, a) => s + a.leftoverMinor, 0),
      );
    }
    // …and the savings leaving are alongside it, never netted into it: what a
    // headline shows is the difference, and it is the one the flow diagram and
    // the account page print for the same accounts.
    const isa = view(withISA);
    expect(isa.householdLeftoverMinor).toBe(395_000);
    expect(isa.committedMinor).toBe(70_000);
    expect(isa.householdLeftoverMinor - isa.committedMinor).toBe(325_000);
  });

  it("counts a shared pot's reserve, which no member's surplus does", () => {
    // The buffer on a shared pot is funded as an obligation and then *stays in
    // the pot*. It is money the household has; it is not any member's
    // discretionary surplus, so `leftoverMinor` counts it nowhere — one more
    // way the two figures are answers to different questions.
    const reserved = household({
      accounts: household().accounts.map((a) =>
        a.accountId === "bills" ? { ...a, monthlyBufferMinor: 25_000 } : a,
      ),
    });
    const plan = view(reserved);
    const bills = plan.accounts.find((a) => a.accountId === "bills")!;
    expect(bills.leftoverMinor).toBe(25_000);
    expect(plan.householdLeftoverMinor).toBe(395_000);
    expect(plan.leftoverMinor).toBe(370_000);
    expect(plan.householdLeftoverMinor).toBe(ribbons(plan));
  });

  it("stays signed, so a household sending on more than reaches it can say so", () => {
    // Alice's transfers all leave `alice-cur` (decision 11 — her personal
    // account with the most income), and her budget counts the £50 sitting in
    // `alice-savings` too. So she is committed to moving £150 out of an account
    // holding £100, and has to consolidate first. Flooring would hide the thing
    // to do, exactly as it would on the account page.
    const split = household({
      members: [{ userId: "alice", displayName: "Alice", shareBp: 10_000 }],
      accounts: [
        acc({
          accountId: "alice-cur",
          role: "personal",
          memberUserId: "alice",
          incomes: [income("alice-pay", 10_000)],
        }),
        acc({
          accountId: "alice-savings",
          role: "personal",
          memberUserId: "alice",
          incomes: [income("alice-interest", 5_000)],
        }),
        acc({ accountId: "bills", payments: [owed("rent", 100_000)] }),
      ],
    });
    const plan = householdPlanFromScope(
      computeScopePlan(split, ASOF),
      "hh",
      ["alice-cur", "bills"],
      "GBP",
    );
    expect(plan.householdLeftoverMinor).toBe(-5_000);
    expect(plan.householdLeftoverMinor).toBe(ribbons(plan));
    expect(plan.shortfallMinor).toBe(85_000);
    // Her budget is spent to the penny, so the scope-wide figure says zero and
    // has nothing to say about the £50 that is in the wrong account.
    expect(plan.leftoverMinor).toBe(0);
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
    // A household that holds every account its members own is the case where
    // the two agree — which is exactly why the difference went unnoticed.
    expect(plan.householdLeftoverMinor).toBe(396_000);
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

/**
 * **A household's left over is its members', added up** (decision 19).
 *
 * The third figure, and the only one a household headline should print. Its two
 * neighbours are wrong in opposite directions and the estate fixture shows only
 * one of them, which is why the cross-owner fixture exists: `householdLeftoverMinor`
 * misses a member's money in a pot the roster does not hold, and counts a
 * co-member's money twice when they move it into one the roster does.
 */
describe("householdPlanFromScope — a household's left over is its members'", () => {
  it("is the member rows, added up, on the screen", () => {
    const plan = view(household());
    expect(plan.membersLeftoverMinor).toBe(
      plan.members.reduce((s, m) => s + m.personalLeftoverMinor, 0),
    );
  });

  it("counts a member's money in a pot the roster does not hold", () => {
    const plan = householdPlanFromScope(
      computeScopePlan(estate.scope, ESTATE_ASOF),
      estate.householdId,
      estate.assignedAccountIds,
      "GBP",
    );
    expect(plan.members.map((m) => [m.userId, m.personalLeftoverMinor])).toEqual([
      ["u-alice", 205_100],
      ["u-bob", 152_400],
    ]);
    expect(plan.membersLeftoverMinor).toBe(357_500);
    // £450 of Alice's raw residual is in three pots the household never assigned.
    // Those arrivals are savings, so the free/member figure excludes them.
    expect(plan.householdLeftoverMinor).toBe(402_500);
    expect(plan.householdLeftoverMinor - plan.committedMinor).toBe(357_500);
  });

  it("does not count a co-member's parked money twice", () => {
    const plan = householdPlanFromScope(
      computeScopePlan(crossOwnerScope, CROSS_OWNER_ASOF),
      CROSS_OWNER_HOUSEHOLD_ID,
      CROSS_OWNER_ASSIGNED_ACCOUNT_IDS,
      "GBP",
    );
    expect(plan.members.map((m) => [m.userId, m.personalLeftoverMinor])).toEqual([
      ["u-alice", 170_000],
      ["u-bob", 80_000],
    ]);
    // Every pound of external income (£3,500) less every pound spent (£600) and
    // less Bob's £400 saved into Alice's pot.
    expect(plan.membersLeftoverMinor).toBe(250_000);
    // The roster basis adds Bob's £400 back into his row and counts it again in
    // the pot's, and is £800 over for it.
    expect(plan.householdLeftoverMinor).toBe(330_000);
  });

  it("gives a household with nobody in it no members to add up", () => {
    expect(
      householdPlanFromScope(computeScopePlan(household(), ASOF), "hh", HOUSEHOLD_ACCOUNTS, "USD")
        .membersLeftoverMinor,
    ).toBe(0);
  });
});
