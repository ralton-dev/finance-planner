import { describe, expect, it } from "vitest";
import { estate, ESTATE_ASOF, estateWithoutSharedIncome } from "./estate.fixture.js";
import { householdPlanFromScope } from "./household.js";
import {
  closeForUser,
  computeScopePlan,
  leftoverForUser,
  type CloseContribution,
  type ScopeAccountInput,
  type ScopeCurrencyPlan,
  type ScopeInput,
  type ScopePlan,
} from "./scope.js";

/**
 * **Whose income is it?** — decision 15, and the guard that it changed nothing
 * else.
 *
 * `core.accounts.owner_user_id` is `NOT NULL`: every account has exactly one
 * owner, and a "joint" account is one person's account shared into a household.
 * The pass could not see that. It attributed external income by the household's
 * *role* instead, so a shared pot's own income — a lodger's rent, the interest
 * on a joint savings pot — belonged to nobody at all. It was in no member's
 * budget, so it paid for nothing; the members transported the gross of the pot's
 * bills as though it had never arrived; and a month closed against that pot
 * froze an income of £0.
 *
 * The comment that justified the behaviour lived on `computeHouseholdPlan` and
 * died when WP-S deleted it. The behaviour outlived its justification, which is
 * the shape of defect this repository keeps finding.
 *
 * ## The regression to fear
 *
 * Attributing income by ownership changes member **budgets** wherever a shared
 * account earns — so funding order, derived transfers, the `elsewhere*`
 * identities and every figure downstream of a budget move with it. That is the
 * feature. On an estate where **no shared account earns**, it must move
 * absolutely nothing, and "nothing" is asserted here as bytes rather than as the
 * fields somebody thought to check.
 */

// --- helpers -----------------------------------------------------------------

const partitionOf = (plan: ScopePlan, currency: string): ScopeCurrencyPlan =>
  plan.partitions.find((p) => p.currency === currency)!;

const memberOf = (p: ScopeCurrencyPlan, userId: string) =>
  p.members.find((m) => m.userId === userId)!;

const accountOf = (p: ScopeCurrencyPlan, accountId: string) =>
  p.accounts.find((a) => a.accountId === accountId)!;

const transferred = (p: ScopeCurrencyPlan, to: string) =>
  p.transfers.filter((t) => t.toAccountId === to).reduce((s, t) => s + t.amountMinor, 0);

/**
 * The pass's whole answer, as bytes, minus the one key this package adds to it.
 *
 * Removed mechanically, by name, so that what remains is every byte of the
 * output surface that existed before this work — not a field-by-field comparison
 * of the ones somebody thought to check. `ownerUserId` is asserted separately,
 * against the fixture, so nothing hides inside the hole it leaves.
 */
const bytesWithoutOwners = (input: ScopeInput): string =>
  JSON.stringify(computeScopePlan(input, ESTATE_ASOF))
    .replaceAll(/"ownerUserId":"[^"]*",/g, "")
    .replaceAll(/,"availableLeftoverMinor":-?\d+/g, "");

// =============================================================================
// The guard: no shared income, no change
// =============================================================================

describe("decision 15 — an estate where no shared account earns", () => {
  it("plans byte-for-byte as the tree before this package did", () => {
    expect(bytesWithoutOwners(estateWithoutSharedIncome)).toBe(PLAN_AT_F9604C8);
  });

  it("carries every account's owner, so the byte comparison hides nothing", () => {
    const plan = computeScopePlan(estateWithoutSharedIncome, ESTATE_ASOF);
    expect(Object.fromEntries(plan.accounts.map((a) => [a.accountId, a.ownerUserId]))).toEqual(
      estate.ownerOf,
    );
  });

  /**
   * The same statement without a recorded string: hand the pass the *old* rule
   * as an input — income to the member the roster names, and to nobody at all
   * for a shared account — and it answers identically. Attribution is the only
   * thing that moved, and here there is nothing for it to move.
   */
  it("cannot tell ownership from role when no shared account earns", () => {
    const NOBODY = "u-nobody";
    const byRole: ScopeInput = {
      ...estateWithoutSharedIncome,
      accounts: estateWithoutSharedIncome.accounts.map((a): ScopeAccountInput => ({
        ...a,
        ownerUserId: a.role === "personal" && a.memberUserId ? a.memberUserId : NOBODY,
      })),
    };
    expect(bytesWithoutOwners(byRole)).toBe(bytesWithoutOwners(estateWithoutSharedIncome));
  });
});

// =============================================================================
// The estate: a pot that earns, and the owner it earns for
// =============================================================================

describe("decision 15 — a shared pot with income of its own", () => {
  const plan = computeScopePlan(estate.scope, ESTATE_ASOF);
  const gbp = partitionOf(plan, "GBP");
  const eur = partitionOf(plan, "EUR");

  it("gives the pot's income to the member whose pot it is", () => {
    // £3,000 of salary and the pot's £500 of lodger rent. The pot is Alice's —
    // `estate.ownerOf` says so, and `core.accounts.owner_user_id` would.
    expect(accountOf(gbp, "acc-house-pot").ownerUserId).toBe("u-alice");
    expect(memberOf(gbp, "u-alice").monthlyIncomeMinor).toBe(350_000);
    expect(memberOf(gbp, "u-bob").monthlyIncomeMinor).toBe(200_000);
  });

  it("gives it to her budget too, and not only to her scorecard", () => {
    // £500 more to spend, against obligations that did not move: her surplus is
    // larger by exactly the pot's income, and Bob's is untouched.
    expect(memberOf(gbp, "u-alice").obligationMinor).toBe(99_900);
    expect(memberOf(gbp, "u-alice").leftoverMinor).toBe(250_100);
    expect(memberOf(gbp, "u-bob").leftoverMinor).toBe(152_400);
  });

  it("leaves nobody's income unattributed", () => {
    // Every account in the estate is owned by a member of it, so the partition's
    // income *is* its members' income. That identity is what makes a per-user
    // month close a view of the pass rather than a second sum.
    for (const p of [gbp, eur]) {
      expect(p.members.reduce((s, m) => s + m.monthlyIncomeMinor, 0)).toBe(p.monthlyIncomeMinor);
    }
  });
});

// =============================================================================
// The `0c35284` netting, pinned
// =============================================================================

describe("an account with income of its own is not sent money it already holds", () => {
  const plan = computeScopePlan(estate.scope, ESTATE_ASOF);
  const gbp = partitionOf(plan, "GBP");

  it("transports the pot's bills less the pot's own income, and no more", () => {
    const pot = accountOf(gbp, "acc-house-pot");
    expect(pot.monthlyIncomeMinor).toBe(50_000);
    expect(pot.fundedOutflowMinor).toBe(140_000);
    // £1,400 of bills, £500 already there: £900 travels, not £1,400.
    expect(transferred(gbp, "acc-house-pot")).toBe(90_000);
    // And the ribbons meet — what arrives plus what was already here is exactly
    // what leaves, so nothing was sent that funds nothing.
    expect(pot.monthlyIncomeMinor + pot.transferInMinor - pot.fundedOutflowMinor).toBe(0);
  });

  it("nets it off the owner's share, because the owner's budget already counted it", () => {
    // £924 and £476 gross, split 66/34. The £500 is in Alice's budget now
    // (decision 15), so it relieves *her* share; letting Bob lean on it too would
    // spend the same £500 twice and leave him holding money her surplus claims.
    const byMember = Object.fromEntries(
      gbp.transfers
        .filter((t) => t.toAccountId === "acc-house-pot")
        .map((t) => [t.memberUserId, t.amountMinor]),
    );
    expect(byMember).toEqual({ "u-alice": 42_400, "u-bob": 47_600 });
    // Which is the whole point: each member's own accounts hold exactly what
    // their own surplus says they do.
    expect(accountOf(gbp, "acc-alice-current").ownLeftoverMinor).toBe(
      memberOf(gbp, "u-alice").leftoverMinor,
    );
    expect(accountOf(gbp, "acc-bob-current").ownLeftoverMinor).toBe(
      memberOf(gbp, "u-bob").leftoverMinor,
    );
  });

  it("derives no transfer at all when the account's own income covers it", () => {
    // `0c35284`'s scenario in its smallest form, and unmoved by this package:
    // £50 of interest arrives in the pot, the £40 subscription it pays is
    // Alice's, and there is nothing to send. Two members, so a scope of one
    // cannot be what makes it work.
    const pot: ScopeAccountInput = {
      accountId: "pot",
      role: "shared",
      memberUserId: null,
      ownerUserId: "alice",
      currency: "GBP",
      incomes: [
        { id: "interest", amountMinor: 5_000, frequency: "monthly", anchorDate: ESTATE_ASOF },
      ],
      payments: [
        {
          id: "sub",
          name: "Subscription",
          category: "monthly_recurring",
          amountMinor: 4_000,
          scope: "personal",
          bearerUserId: "alice",
          priority: 10,
        },
      ],
    };
    const current = (accountId: string, ownerUserId: string): ScopeAccountInput => ({
      accountId,
      role: "personal",
      memberUserId: ownerUserId,
      ownerUserId,
      currency: "GBP",
      incomes: [
        {
          id: `${accountId}-pay`,
          amountMinor: 200_000,
          frequency: "monthly",
          anchorDate: ESTATE_ASOF,
        },
      ],
      payments: [],
    });
    const scope: ScopeInput = {
      scopeId: "h",
      householdId: "h",
      members: [
        { userId: "alice", shareBp: 5_000 },
        { userId: "bob", shareBp: 5_000 },
      ],
      accounts: [current("alice-cur", "alice"), current("bob-cur", "bob"), pot],
    };
    const p = partitionOf(computeScopePlan(scope, ESTATE_ASOF), "GBP");
    expect(accountOf(p, "pot").fundedOutflowMinor).toBe(4_000);
    expect(p.transfers).toEqual([]);
  });
});

// =============================================================================
// The household view, re-asserted under the new attribution
// =============================================================================

describe("householdPlanFromScope — the elsewhere identities under ownership", () => {
  const plan = computeScopePlan(estate.scope, ESTATE_ASOF);
  const gbp = partitionOf(plan, "GBP");
  const household = householdPlanFromScope(
    plan,
    estate.householdId,
    estate.assignedAccountIds,
    "GBP",
    estate.scope.members.map((m) => m.userId),
  );

  it("lands a pot's income in the household income of the member who owns it", () => {
    const alice = household.members.find((m) => m.userId === "u-alice")!;
    // Her current account **and** the pot are both on this roster, and both are
    // hers: £3,500 of the household's income is Alice's, and none of it is
    // "elsewhere". While income followed the role, the pot's £500 was in neither
    // half — it belonged to nobody at all, on the page listing the pot.
    expect(alice.householdIncomeMinor).toBe(350_000);
    expect(alice.elsewhereIncomeMinor).toBe(0);
  });

  it("keeps every household + elsewhere === total identity exactly", () => {
    for (const m of household.members) {
      const scopeMember = memberOf(gbp, m.userId);
      expect(m.householdIncomeMinor + m.elsewhereIncomeMinor).toBe(m.monthlyIncomeMinor);
      expect(m.householdObligationMinor + m.elsewhereObligationMinor).toBe(m.obligationMinor);
      expect(m.householdFundedMinor + m.elsewhereFundedMinor).toBe(m.fundedMinor);
      expect(m.committedMinor + m.elsewhereCommittedMinor).toBe(scopeMember.committedMinor);
    }
  });

  it("keeps the household's own money the sum of its own accounts", () => {
    expect(household.householdLeftoverMinor).toBe(
      household.accounts.reduce((s, a) => s + a.leftoverMinor, 0),
    );
    // And the headline is no longer double-counting the pot: its £500 is inside
    // Alice's surplus, so there is nothing unattributed to add beside it.
    expect(household.leftoverMinor).toBe(
      household.members.reduce((s, m) => s + m.leftoverMinor, 0),
    );
  });
});

// =============================================================================
// closeForUser — a scorecard about a person
// =============================================================================

describe("closeForUser", () => {
  const plan = computeScopePlan(estate.scope, ESTATE_ASOF);

  /** The ledger of money actually set aside, as `core.contributions` holds it. */
  const ledger: CloseContribution[] = [
    { accountId: "acc-house-pot", userId: "u-alice", amountMinor: 42_400 },
    { accountId: "acc-alice-bills", userId: "u-alice", amountMinor: 3_000 },
    { accountId: "acc-alice-eur", userId: "u-alice", amountMinor: 12_000 },
    { accountId: "acc-house-pot", userId: "u-bob", amountMinor: 10_000 },
    // Nobody's: the column predates the writers that set it, and a row without
    // one is counted for nobody (decision 17).
    { accountId: "acc-house-pot", userId: null, amountMinor: 99_999 },
    // An account this pass never planned has no currency to be bucketed by.
    { accountId: "acc-elsewhere", userId: "u-alice", amountMinor: 99_999 },
  ];

  it("returns one row per currency partition, in the pass's order", () => {
    expect(closeForUser(plan, ledger, "u-alice")).toEqual([
      { currency: "EUR", incomeMinor: 80_000, plannedMinor: 12_000, contributedMinor: 12_000 },
      { currency: "GBP", incomeMinor: 350_000, plannedMinor: 99_900, contributedMinor: 45_400 },
    ]);
    expect(closeForUser(plan, ledger, "u-bob")).toEqual([
      { currency: "EUR", incomeMinor: 0, plannedMinor: 0, contributedMinor: 0 },
      { currency: "GBP", incomeMinor: 200_000, plannedMinor: 47_600, contributedMinor: 10_000 },
    ]);
  });

  it("reads its figures off the pass and nowhere else", () => {
    // Not "the same number": the same field. A close freezes a view of the
    // month, and the one thing it must never become is a second computation.
    for (const close of closeForUser(plan, ledger, "u-alice")) {
      const member = memberOf(partitionOf(plan, close.currency), "u-alice");
      expect(close.incomeMinor).toBe(member.monthlyIncomeMinor);
      expect(close.plannedMinor).toBe(member.obligationMinor);
    }
  });

  it("holds the close identity, per currency", () => {
    // Σ over the partition's members of what each would close === the
    // partition's income. It holds because every account has an owner and every
    // owner is a member — which is decision 15, cashed.
    for (const p of plan.partitions) {
      const summed = p.members
        .map((m) => closeForUser(plan, ledger, m.userId).find((c) => c.currency === p.currency)!)
        .reduce((s, c) => s + c.incomeMinor, 0);
      expect(summed).toBe(p.monthlyIncomeMinor);
    }
  });

  it("closes nothing for somebody the scope does not plan", () => {
    expect(closeForUser(plan, ledger, "u-carol")).toEqual([]);
  });
});

// =============================================================================
// leftoverForUser — what is left over for a person
// =============================================================================

/**
 * `closeForUser`'s sibling one question over: not what they set aside this
 * month, but what they have left (decision 19). Same shape, same discipline —
 * no arithmetic the pass has not already done — and the same boundary decision
 * 15 drew for income, one altitude up: **ownership, never access, never the
 * roster's `memberUserId`** (decision 20).
 */
describe("leftoverForUser", () => {
  const plan = computeScopePlan(estate.scope, ESTATE_ASOF);

  it("returns one row per currency partition, in the pass's order", () => {
    // Alice's GBP figure excludes the three pots her movements fill: those
    // arrivals are saved money, not available left over. Her EUR is a second
    // answer, never a term in the first (decision 10).
    expect(leftoverForUser(plan, "u-alice")).toEqual([
      { currency: "EUR", leftoverMinor: 68_000, shortfallMinor: 0, paymentCount: 1 },
      { currency: "GBP", leftoverMinor: 205_100, shortfallMinor: 0, paymentCount: 4 },
    ]);
    expect(leftoverForUser(plan, "u-bob")).toEqual([
      // A member with nothing in a partition reads zero there rather than being
      // missing from it — `closeForUser`'s choice, kept.
      { currency: "EUR", leftoverMinor: 0, shortfallMinor: 0, paymentCount: 0 },
      { currency: "GBP", leftoverMinor: 152_400, shortfallMinor: 0, paymentCount: 0 },
    ]);
  });

  it("counts the accounts you own, not the ones the household holds", () => {
    // Four of Alice's six GBP accounts are off the household's roster. The roster
    // is not the boundary, but saved arrivals in those accounts are not free.
    const gbp = partitionOf(plan, "GBP");
    const hers = gbp.accounts.filter((a) => a.ownerUserId === "u-alice");
    expect(hers.map((a) => a.accountId)).toEqual([
      "acc-alice-current",
      "acc-house-pot",
      "acc-alice-bills",
      "acc-alice-savings",
      "acc-alice-holiday",
      "acc-alice-car",
    ]);
    // Including the shared pot, which is her account (decision 15) and which the
    // roster attributes to no member at all.
    expect(hers.find((a) => a.accountId === "acc-house-pot")?.memberUserId).toBeNull();
    expect(hers.reduce((s, a) => s + a.availableLeftoverMinor, 0)).toBe(205_100);
  });

  it("reads its figures off the pass and nowhere else", () => {
    // Not "the same number": the same field, summed. The whole point of the
    // three altitudes is that each is a plain sum of the one below it.
    for (const partition of plan.partitions) {
      for (const member of partition.members) {
        const mine = leftoverForUser(plan, member.userId).find(
          (l) => l.currency === partition.currency,
        )!;
        const owned = partition.accounts.filter((a) => a.ownerUserId === member.userId);
        expect(mine.leftoverMinor).toBe(owned.reduce((s, a) => s + a.availableLeftoverMinor, 0));
        expect(mine.shortfallMinor).toBe(owned.reduce((s, a) => s + a.shortfallMinor, 0));
        const ids = new Set(owned.map((a) => a.accountId));
        expect(mine.paymentCount).toBe(partition.lines.filter((l) => ids.has(l.accountId)).length);
      }
    }
  });

  it("holds the three-altitude identity, per currency", () => {
    // Σ over the partition's members === the partition's accounts, whole. It
    // holds because every account has an owner and every owner here is a member
    // — decision 15, cashed a second time.
    for (const partition of plan.partitions) {
      const summed = partition.members
        .map((m) => leftoverForUser(plan, m.userId).find((l) => l.currency === partition.currency)!)
        .reduce((s, l) => s + l.leftoverMinor, 0);
      expect(summed).toBe(partition.accounts.reduce((s, a) => s + a.availableLeftoverMinor, 0));
    }
  });

  it("reports nothing for somebody the scope does not plan", () => {
    expect(leftoverForUser(plan, "u-carol")).toEqual([]);
  });

  it("carries the shortfall and the payment count on the same basis", () => {
    // Decision 24: a left over that is yours beside a shortfall that is the
    // household's would state two bases in one sentence. Alice's £30 gym becomes
    // a £3,500 one here, and her £3,000 salary — the pot's own £500 relieves her
    // share of the pot's bills rather than joining what she can spend — cannot
    // reach it past the £469 it owes first. She is £969 short, on a pot of her
    // own that the household does not hold, and Bob's figure does not move a
    // penny.
    const starved: ScopeInput = {
      ...estate.scope,
      accounts: estate.scope.accounts.map((a) =>
        a.accountId === "acc-alice-bills"
          ? {
              ...a,
              payments: a.payments.map((p) =>
                p.id === "pay-gym" ? { ...p, amountMinor: 350_000 } : p,
              ),
            }
          : a,
      ),
    };
    const short = computeScopePlan(starved, ESTATE_ASOF);
    const alice = leftoverForUser(short, "u-alice").find((l) => l.currency === "GBP")!;
    const bob = leftoverForUser(short, "u-bob").find((l) => l.currency === "GBP")!;
    expect(alice.shortfallMinor).toBe(96_900);
    expect(alice.paymentCount).toBe(4);
    expect(bob.shortfallMinor).toBe(0);
    expect(bob.paymentCount).toBe(0);
    // And it is the pass's own per-account figure, summed — not a second
    // subtraction of required from funded.
    const hers = partitionOf(short, "GBP").accounts.filter((a) => a.ownerUserId === "u-alice");
    expect(hers.reduce((s, a) => s + a.shortfallMinor, 0)).toBe(96_900);
  });
});

/**
 * `JSON.stringify(computeScopePlan(estateWithoutSharedIncome, ESTATE_ASOF))` at
 * `f9604c8` — the commit before this package — recorded verbatim.
 *
 * One line, because it is bytes and not prose. Captured rather than recomputed,
 * for the reason `ACCOUNT_ENGINE_AT_40F65D8` is: an expectation re-derived from
 * the code under test would only ever agree with itself.
 */
const PLAN_AT_F9604C8 =
  '{"scopeId":"hh-estate","householdId":"hh-estate","asOfDate":"2026-08-04","partitions":[{"currency":"EUR","monthlyIncomeMinor":80000,"totalRequiredMinor":12000,"totalFundedMinor":12000,"leftoverMinor":68000,"committedMinor":0,"shortfallMinor":0,"members":[{"userId":"u-alice","displayName":"Alice","currency":"EUR","shareBp":6600,"monthlyIncomeMinor":80000,"obligationMinor":12000,"fundedMinor":12000,"leftoverMinor":68000,"committedMinor":0,"shortfallMinor":0,"sourceAccountId":"acc-alice-eur"},{"userId":"u-bob","displayName":"Bob","currency":"EUR","shareBp":3400,"monthlyIncomeMinor":0,"obligationMinor":0,"fundedMinor":0,"leftoverMinor":0,"committedMinor":0,"shortfallMinor":0,"sourceAccountId":null}],"accounts":[{"accountId":"acc-alice-eur","name":"Alice euro","role":"personal","memberUserId":"u-alice","currency":"EUR","monthlyIncomeMinor":80000,"bufferMinor":0,"requiredOutflowMinor":12000,"fundedOutflowMinor":12000,"transferInMinor":0,"transferOutMinor":0,"movementInMinor":0,"committedMinor":0,"allocatedInflowMinor":0,"confirmedInflowMinor":0,"ownLeftoverMinor":68000,"leftoverMinor":68000,"shortfallMinor":0,"inflowArrivals":[]}],"lines":[{"paymentId":"pay-hosting","accountId":"acc-alice-eur","currency":"EUR","name":"Hosting","category":"monthly_recurring","scope":"personal","amountMinor":12000,"dueDate":"2026-08-04","targetDate":"2026-08-04","dueDateIsDerived":false,"monthsUntilDue":1,"priority":10,"requiredMonthlyMinor":12000,"fundedMonthlyMinor":12000,"fundedFromOwnMinor":12000,"fundedFromInflowMinor":0,"alreadySavedMinor":0,"occurrencesThisMonth":1,"onTrack":true,"tag":null,"allocations":[{"userId":"u-alice","requiredMinor":12000,"fundedMinor":12000},{"userId":"u-bob","requiredMinor":0,"fundedMinor":0}]}],"transfers":[],"movements":[],"cycles":[]},{"currency":"GBP","monthlyIncomeMinor":500000,"totalRequiredMinor":147500,"totalFundedMinor":147500,"leftoverMinor":352500,"committedMinor":45000,"shortfallMinor":0,"members":[{"userId":"u-alice","displayName":"Alice","currency":"GBP","shareBp":6600,"monthlyIncomeMinor":300000,"obligationMinor":99900,"fundedMinor":99900,"leftoverMinor":200100,"committedMinor":45000,"shortfallMinor":0,"sourceAccountId":"acc-alice-current"},{"userId":"u-bob","displayName":"Bob","currency":"GBP","shareBp":3400,"monthlyIncomeMinor":200000,"obligationMinor":47600,"fundedMinor":47600,"leftoverMinor":152400,"committedMinor":0,"shortfallMinor":0,"sourceAccountId":"acc-bob-current"}],"accounts":[{"accountId":"acc-alice-current","name":"Alice current","role":"personal","memberUserId":"u-alice","currency":"GBP","monthlyIncomeMinor":300000,"bufferMinor":0,"requiredOutflowMinor":0,"fundedOutflowMinor":0,"transferInMinor":0,"transferOutMinor":99900,"movementInMinor":0,"committedMinor":45000,"allocatedInflowMinor":0,"confirmedInflowMinor":0,"ownLeftoverMinor":200100,"leftoverMinor":155100,"shortfallMinor":0,"inflowArrivals":[]},{"accountId":"acc-bob-current","name":"Bob current","role":"personal","memberUserId":"u-bob","currency":"GBP","monthlyIncomeMinor":200000,"bufferMinor":0,"requiredOutflowMinor":0,"fundedOutflowMinor":0,"transferInMinor":0,"transferOutMinor":47600,"movementInMinor":0,"committedMinor":0,"allocatedInflowMinor":0,"confirmedInflowMinor":0,"ownLeftoverMinor":152400,"leftoverMinor":152400,"shortfallMinor":0,"inflowArrivals":[]},{"accountId":"acc-house-pot","name":"House pot","role":"shared","memberUserId":null,"currency":"GBP","monthlyIncomeMinor":0,"bufferMinor":0,"requiredOutflowMinor":140000,"fundedOutflowMinor":140000,"transferInMinor":140000,"transferOutMinor":0,"movementInMinor":0,"committedMinor":0,"allocatedInflowMinor":140000,"confirmedInflowMinor":59400,"ownLeftoverMinor":0,"leftoverMinor":0,"shortfallMinor":0,"inflowArrivals":[]},{"accountId":"acc-alice-bills","name":"Alice bills","role":"personal","memberUserId":"u-alice","currency":"GBP","monthlyIncomeMinor":0,"bufferMinor":0,"requiredOutflowMinor":7500,"fundedOutflowMinor":7500,"transferInMinor":7500,"transferOutMinor":0,"movementInMinor":0,"committedMinor":0,"allocatedInflowMinor":7500,"confirmedInflowMinor":3000,"ownLeftoverMinor":0,"leftoverMinor":0,"shortfallMinor":0,"inflowArrivals":[]},{"accountId":"acc-alice-savings","name":"Alice savings","role":"personal","memberUserId":"u-alice","currency":"GBP","monthlyIncomeMinor":0,"bufferMinor":0,"requiredOutflowMinor":0,"fundedOutflowMinor":0,"transferInMinor":0,"transferOutMinor":0,"movementInMinor":20000,"committedMinor":0,"allocatedInflowMinor":20000,"confirmedInflowMinor":20000,"ownLeftoverMinor":0,"leftoverMinor":20000,"shortfallMinor":0,"inflowArrivals":[{"inflowId":"mov-savings","fromAccountId":"acc-alice-current","amountMinor":20000,"confirmedMinor":20000}]},{"accountId":"acc-alice-holiday","name":"Alice holiday","role":"personal","memberUserId":"u-alice","currency":"GBP","monthlyIncomeMinor":0,"bufferMinor":0,"requiredOutflowMinor":0,"fundedOutflowMinor":0,"transferInMinor":0,"transferOutMinor":0,"movementInMinor":15000,"committedMinor":0,"allocatedInflowMinor":15000,"confirmedInflowMinor":5000,"ownLeftoverMinor":0,"leftoverMinor":15000,"shortfallMinor":0,"inflowArrivals":[{"inflowId":"mov-holiday","fromAccountId":"acc-alice-current","amountMinor":15000,"confirmedMinor":5000}]},{"accountId":"acc-alice-car","name":"Alice car fund","role":"personal","memberUserId":"u-alice","currency":"GBP","monthlyIncomeMinor":0,"bufferMinor":0,"requiredOutflowMinor":0,"fundedOutflowMinor":0,"transferInMinor":0,"transferOutMinor":0,"movementInMinor":10000,"committedMinor":0,"allocatedInflowMinor":10000,"confirmedInflowMinor":0,"ownLeftoverMinor":0,"leftoverMinor":10000,"shortfallMinor":0,"inflowArrivals":[{"inflowId":"mov-car","fromAccountId":"acc-alice-current","amountMinor":10000,"confirmedMinor":0}]}],"lines":[{"paymentId":"pay-rent","accountId":"acc-house-pot","currency":"GBP","name":"Rent","category":"monthly_recurring","scope":"shared","amountMinor":120000,"dueDate":"2026-08-04","targetDate":"2026-08-04","dueDateIsDerived":false,"monthsUntilDue":1,"priority":10,"requiredMonthlyMinor":120000,"fundedMonthlyMinor":120000,"fundedFromOwnMinor":0,"fundedFromInflowMinor":120000,"alreadySavedMinor":0,"occurrencesThisMonth":1,"onTrack":true,"tag":null,"allocations":[{"userId":"u-alice","requiredMinor":79200,"fundedMinor":79200},{"userId":"u-bob","requiredMinor":40800,"fundedMinor":40800}]},{"paymentId":"pay-phone","accountId":"acc-alice-bills","currency":"GBP","name":"Phone","category":"monthly_recurring","scope":"personal","amountMinor":4500,"dueDate":"2026-08-04","targetDate":"2026-08-04","dueDateIsDerived":false,"monthsUntilDue":1,"priority":10,"requiredMonthlyMinor":4500,"fundedMonthlyMinor":4500,"fundedFromOwnMinor":0,"fundedFromInflowMinor":4500,"alreadySavedMinor":0,"occurrencesThisMonth":1,"onTrack":true,"tag":null,"allocations":[{"userId":"u-alice","requiredMinor":4500,"fundedMinor":4500},{"userId":"u-bob","requiredMinor":0,"fundedMinor":0}]},{"paymentId":"pay-council","accountId":"acc-house-pot","currency":"GBP","name":"Council tax","category":"monthly_recurring","scope":"shared","amountMinor":20000,"dueDate":"2026-08-04","targetDate":"2026-08-04","dueDateIsDerived":false,"monthsUntilDue":1,"priority":20,"requiredMonthlyMinor":20000,"fundedMonthlyMinor":20000,"fundedFromOwnMinor":0,"fundedFromInflowMinor":20000,"alreadySavedMinor":0,"occurrencesThisMonth":1,"onTrack":true,"tag":null,"allocations":[{"userId":"u-alice","requiredMinor":13200,"fundedMinor":13200},{"userId":"u-bob","requiredMinor":6800,"fundedMinor":6800}]},{"paymentId":"pay-gym","accountId":"acc-alice-bills","currency":"GBP","name":"Gym","category":"monthly_recurring","scope":"personal","amountMinor":3000,"dueDate":"2026-08-04","targetDate":"2026-08-04","dueDateIsDerived":false,"monthsUntilDue":1,"priority":20,"requiredMonthlyMinor":3000,"fundedMonthlyMinor":3000,"fundedFromOwnMinor":0,"fundedFromInflowMinor":3000,"alreadySavedMinor":0,"occurrencesThisMonth":1,"onTrack":true,"tag":null,"allocations":[{"userId":"u-alice","requiredMinor":3000,"fundedMinor":3000},{"userId":"u-bob","requiredMinor":0,"fundedMinor":0}]}],"transfers":[{"fromAccountId":"acc-alice-current","toAccountId":"acc-alice-bills","memberUserId":"u-alice","currency":"GBP","amountMinor":7500,"confirmedMinor":3000},{"fromAccountId":"acc-alice-current","toAccountId":"acc-house-pot","memberUserId":"u-alice","currency":"GBP","amountMinor":92400,"confirmedMinor":59400},{"fromAccountId":"acc-bob-current","toAccountId":"acc-house-pot","memberUserId":"u-bob","currency":"GBP","amountMinor":47600,"confirmedMinor":0}],"movements":[{"inflowId":"mov-car","fromAccountId":"acc-alice-current","toAccountId":"acc-alice-car","currency":"GBP","priority":30,"requestedMinor":10000,"fundedMinor":10000,"fundedFromOwnMinor":10000,"fundedFromInflowMinor":0,"status":"funded"},{"inflowId":"mov-holiday","fromAccountId":"acc-alice-current","toAccountId":"acc-alice-holiday","currency":"GBP","priority":20,"requestedMinor":15000,"fundedMinor":15000,"fundedFromOwnMinor":15000,"fundedFromInflowMinor":0,"status":"funded"},{"inflowId":"mov-savings","fromAccountId":"acc-alice-current","toAccountId":"acc-alice-savings","currency":"GBP","priority":10,"requestedMinor":20000,"fundedMinor":20000,"fundedFromOwnMinor":20000,"fundedFromInflowMinor":0,"status":"funded"}],"cycles":[]}],"accounts":[{"accountId":"acc-alice-eur","name":"Alice euro","role":"personal","memberUserId":"u-alice","currency":"EUR","monthlyIncomeMinor":80000,"bufferMinor":0,"requiredOutflowMinor":12000,"fundedOutflowMinor":12000,"transferInMinor":0,"transferOutMinor":0,"movementInMinor":0,"committedMinor":0,"allocatedInflowMinor":0,"confirmedInflowMinor":0,"ownLeftoverMinor":68000,"leftoverMinor":68000,"shortfallMinor":0,"inflowArrivals":[]},{"accountId":"acc-alice-current","name":"Alice current","role":"personal","memberUserId":"u-alice","currency":"GBP","monthlyIncomeMinor":300000,"bufferMinor":0,"requiredOutflowMinor":0,"fundedOutflowMinor":0,"transferInMinor":0,"transferOutMinor":99900,"movementInMinor":0,"committedMinor":45000,"allocatedInflowMinor":0,"confirmedInflowMinor":0,"ownLeftoverMinor":200100,"leftoverMinor":155100,"shortfallMinor":0,"inflowArrivals":[]},{"accountId":"acc-bob-current","name":"Bob current","role":"personal","memberUserId":"u-bob","currency":"GBP","monthlyIncomeMinor":200000,"bufferMinor":0,"requiredOutflowMinor":0,"fundedOutflowMinor":0,"transferInMinor":0,"transferOutMinor":47600,"movementInMinor":0,"committedMinor":0,"allocatedInflowMinor":0,"confirmedInflowMinor":0,"ownLeftoverMinor":152400,"leftoverMinor":152400,"shortfallMinor":0,"inflowArrivals":[]},{"accountId":"acc-house-pot","name":"House pot","role":"shared","memberUserId":null,"currency":"GBP","monthlyIncomeMinor":0,"bufferMinor":0,"requiredOutflowMinor":140000,"fundedOutflowMinor":140000,"transferInMinor":140000,"transferOutMinor":0,"movementInMinor":0,"committedMinor":0,"allocatedInflowMinor":140000,"confirmedInflowMinor":59400,"ownLeftoverMinor":0,"leftoverMinor":0,"shortfallMinor":0,"inflowArrivals":[]},{"accountId":"acc-alice-bills","name":"Alice bills","role":"personal","memberUserId":"u-alice","currency":"GBP","monthlyIncomeMinor":0,"bufferMinor":0,"requiredOutflowMinor":7500,"fundedOutflowMinor":7500,"transferInMinor":7500,"transferOutMinor":0,"movementInMinor":0,"committedMinor":0,"allocatedInflowMinor":7500,"confirmedInflowMinor":3000,"ownLeftoverMinor":0,"leftoverMinor":0,"shortfallMinor":0,"inflowArrivals":[]},{"accountId":"acc-alice-savings","name":"Alice savings","role":"personal","memberUserId":"u-alice","currency":"GBP","monthlyIncomeMinor":0,"bufferMinor":0,"requiredOutflowMinor":0,"fundedOutflowMinor":0,"transferInMinor":0,"transferOutMinor":0,"movementInMinor":20000,"committedMinor":0,"allocatedInflowMinor":20000,"confirmedInflowMinor":20000,"ownLeftoverMinor":0,"leftoverMinor":20000,"shortfallMinor":0,"inflowArrivals":[{"inflowId":"mov-savings","fromAccountId":"acc-alice-current","amountMinor":20000,"confirmedMinor":20000}]},{"accountId":"acc-alice-holiday","name":"Alice holiday","role":"personal","memberUserId":"u-alice","currency":"GBP","monthlyIncomeMinor":0,"bufferMinor":0,"requiredOutflowMinor":0,"fundedOutflowMinor":0,"transferInMinor":0,"transferOutMinor":0,"movementInMinor":15000,"committedMinor":0,"allocatedInflowMinor":15000,"confirmedInflowMinor":5000,"ownLeftoverMinor":0,"leftoverMinor":15000,"shortfallMinor":0,"inflowArrivals":[{"inflowId":"mov-holiday","fromAccountId":"acc-alice-current","amountMinor":15000,"confirmedMinor":5000}]},{"accountId":"acc-alice-car","name":"Alice car fund","role":"personal","memberUserId":"u-alice","currency":"GBP","monthlyIncomeMinor":0,"bufferMinor":0,"requiredOutflowMinor":0,"fundedOutflowMinor":0,"transferInMinor":0,"transferOutMinor":0,"movementInMinor":10000,"committedMinor":0,"allocatedInflowMinor":10000,"confirmedInflowMinor":0,"ownLeftoverMinor":0,"leftoverMinor":10000,"shortfallMinor":0,"inflowArrivals":[{"inflowId":"mov-car","fromAccountId":"acc-alice-current","amountMinor":10000,"confirmedMinor":0}]}],"lines":[{"paymentId":"pay-hosting","accountId":"acc-alice-eur","currency":"EUR","name":"Hosting","category":"monthly_recurring","scope":"personal","amountMinor":12000,"dueDate":"2026-08-04","targetDate":"2026-08-04","dueDateIsDerived":false,"monthsUntilDue":1,"priority":10,"requiredMonthlyMinor":12000,"fundedMonthlyMinor":12000,"fundedFromOwnMinor":12000,"fundedFromInflowMinor":0,"alreadySavedMinor":0,"occurrencesThisMonth":1,"onTrack":true,"tag":null,"allocations":[{"userId":"u-alice","requiredMinor":12000,"fundedMinor":12000},{"userId":"u-bob","requiredMinor":0,"fundedMinor":0}]},{"paymentId":"pay-rent","accountId":"acc-house-pot","currency":"GBP","name":"Rent","category":"monthly_recurring","scope":"shared","amountMinor":120000,"dueDate":"2026-08-04","targetDate":"2026-08-04","dueDateIsDerived":false,"monthsUntilDue":1,"priority":10,"requiredMonthlyMinor":120000,"fundedMonthlyMinor":120000,"fundedFromOwnMinor":0,"fundedFromInflowMinor":120000,"alreadySavedMinor":0,"occurrencesThisMonth":1,"onTrack":true,"tag":null,"allocations":[{"userId":"u-alice","requiredMinor":79200,"fundedMinor":79200},{"userId":"u-bob","requiredMinor":40800,"fundedMinor":40800}]},{"paymentId":"pay-phone","accountId":"acc-alice-bills","currency":"GBP","name":"Phone","category":"monthly_recurring","scope":"personal","amountMinor":4500,"dueDate":"2026-08-04","targetDate":"2026-08-04","dueDateIsDerived":false,"monthsUntilDue":1,"priority":10,"requiredMonthlyMinor":4500,"fundedMonthlyMinor":4500,"fundedFromOwnMinor":0,"fundedFromInflowMinor":4500,"alreadySavedMinor":0,"occurrencesThisMonth":1,"onTrack":true,"tag":null,"allocations":[{"userId":"u-alice","requiredMinor":4500,"fundedMinor":4500},{"userId":"u-bob","requiredMinor":0,"fundedMinor":0}]},{"paymentId":"pay-council","accountId":"acc-house-pot","currency":"GBP","name":"Council tax","category":"monthly_recurring","scope":"shared","amountMinor":20000,"dueDate":"2026-08-04","targetDate":"2026-08-04","dueDateIsDerived":false,"monthsUntilDue":1,"priority":20,"requiredMonthlyMinor":20000,"fundedMonthlyMinor":20000,"fundedFromOwnMinor":0,"fundedFromInflowMinor":20000,"alreadySavedMinor":0,"occurrencesThisMonth":1,"onTrack":true,"tag":null,"allocations":[{"userId":"u-alice","requiredMinor":13200,"fundedMinor":13200},{"userId":"u-bob","requiredMinor":6800,"fundedMinor":6800}]},{"paymentId":"pay-gym","accountId":"acc-alice-bills","currency":"GBP","name":"Gym","category":"monthly_recurring","scope":"personal","amountMinor":3000,"dueDate":"2026-08-04","targetDate":"2026-08-04","dueDateIsDerived":false,"monthsUntilDue":1,"priority":20,"requiredMonthlyMinor":3000,"fundedMonthlyMinor":3000,"fundedFromOwnMinor":0,"fundedFromInflowMinor":3000,"alreadySavedMinor":0,"occurrencesThisMonth":1,"onTrack":true,"tag":null,"allocations":[{"userId":"u-alice","requiredMinor":3000,"fundedMinor":3000},{"userId":"u-bob","requiredMinor":0,"fundedMinor":0}]}],"transfers":[{"fromAccountId":"acc-alice-current","toAccountId":"acc-alice-bills","memberUserId":"u-alice","currency":"GBP","amountMinor":7500,"confirmedMinor":3000},{"fromAccountId":"acc-alice-current","toAccountId":"acc-house-pot","memberUserId":"u-alice","currency":"GBP","amountMinor":92400,"confirmedMinor":59400},{"fromAccountId":"acc-bob-current","toAccountId":"acc-house-pot","memberUserId":"u-bob","currency":"GBP","amountMinor":47600,"confirmedMinor":0}],"movements":[{"inflowId":"mov-car","fromAccountId":"acc-alice-current","toAccountId":"acc-alice-car","currency":"GBP","priority":30,"requestedMinor":10000,"fundedMinor":10000,"fundedFromOwnMinor":10000,"fundedFromInflowMinor":0,"status":"funded"},{"inflowId":"mov-holiday","fromAccountId":"acc-alice-current","toAccountId":"acc-alice-holiday","currency":"GBP","priority":20,"requestedMinor":15000,"fundedMinor":15000,"fundedFromOwnMinor":15000,"fundedFromInflowMinor":0,"status":"funded"},{"inflowId":"mov-savings","fromAccountId":"acc-alice-current","toAccountId":"acc-alice-savings","currency":"GBP","priority":10,"requestedMinor":20000,"fundedMinor":20000,"fundedFromOwnMinor":20000,"fundedFromInflowMinor":0,"status":"funded"}],"cycles":[]}';
