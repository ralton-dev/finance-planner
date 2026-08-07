import { describe, expect, it } from "vitest";
import {
  CROSS_OWNER_ASOF,
  CROSS_OWNER_ASSIGNED_ACCOUNT_IDS,
  CROSS_OWNER_HOUSEHOLD_ID,
  crossOwnerScope,
} from "./crossowner.fixture.js";
import { estate, ESTATE_ASOF } from "./estate.fixture.js";
import { householdPlanFromScope } from "./household.js";
import { computeScopePlan, leftoverForUser } from "./scope.js";

/**
 * **Mine, and ours** — the identity `MINE-AND-OURS.md` exists to establish,
 * now asserted against the fields the pass publishes.
 *
 * Decision 19: left over is **one derivation read at three altitudes**, and the
 * boundary is ownership.
 *
 *  - an **account's** left over is its residual — `income + arriving − spending
 *    − leaving`, which is `ScopeAccountPlan.leftoverMinor`;
 *  - a **person's** is that, summed over the accounts they **own**
 *    (`ownerUserId`, never access — decision 20), which is `leftoverForUser`;
 *  - a **household's** is its members' left overs, added up, which is
 *    `HouseholdPlan.membersLeftoverMinor`.
 *
 * Each altitude is a plain sum of the one below it, so the rows on a screen add
 * up to the total above them. Nothing is netted and nothing is reconstructed by
 * algebra.
 *
 * ## This file replaces WP-AB's red pin, and why that pin is gone
 *
 * It landed at `865a0ed` as an `it.fails`: the same three figures, computed by
 * hand off the pass because no production code answered them yet, plus an
 * assertion that today's household headline (`householdLeftoverMinor −
 * committedMinor`) equalled the members' sum — which failed, which was the
 * point. That assertion could never come true on its own, because decision 19
 * redefines no existing field: `leftoverMinor`, `householdLeftoverMinor` and
 * `committedMinor` all keep their meanings on the wire to the penny and
 * everything new is added alongside. Its job was to make the divergence
 * undeniable and dated, and that is done; carrying an `it.fails` that can never
 * pass is carrying a test that asserts nothing. The divergence is not lost — it
 * is stated below as a plain equality, because the old derivation still returns
 * £3,575.00 and will until WP-AG changes which field the page reads.
 *
 * ## The figures, measured at `22c1ce6` and unmoved since
 *
 * First measured at `1409e5f`, re-verified identical at `22c1ce6` through the
 * fixture correction `22c1ce6` itself made, and re-verified here against the
 * published fields:
 *
 * | altitude                              | GBP                     |
 * | ------------------------------------- | ----------------------- |
 * | Alice — Σ over available account money | **£2,051.00** (205_100) |
 * | Bob — Σ over accounts he owns         | **£1,524.00** (152_400) |
 * | the household — their sum             | **£3,575.00** (357_500) |
 * | household rows before commitments     | **£4,025.00** (402_500) |
 * | what the household page prints today  | **£3,575.00** (357_500) |
 *
 * The £450 between the last two is three funded authored savings movements
 * (`mov-savings` £200, `mov-holiday` £150, `mov-car` £100). `household.ts:340`
 * adds each account's committed back into `HouseholdAccountPlan.leftoverMinor`
 * and the page subtracts the same total, so the two cancel and what prints is Σ
 * **residuals over the roster** — and those three pots are Alice's, owned by her
 * and assigned to nothing. A residual has already netted a movement at both
 * ends, so subtracting `committedMinor` from a roll-up of residuals loses that
 * money outright.
 *
 * ## Why the estate fixture is only half of this file
 *
 * On the estate the ownership basis and the old roster basis **coincide to the
 * penny** — £2,501 / £1,524 / £4,025 either way — because every authored
 * movement there is Alice's, fully funded, into a pot of hers that spends
 * nothing. An implementation wired to the wrong basis passes every estate figure
 * above. Only an authored movement crossing owners tells the two apart, and
 * `crossowner.fixture.ts` is that shape; the second half of this file pins it.
 */
describe("mine, and ours — one derivation at three altitudes", () => {
  const plan = computeScopePlan(estate.scope, ESTATE_ASOF);
  const gbp = (userId: string) => leftoverForUser(plan, userId).find((l) => l.currency === "GBP")!;
  const household = householdPlanFromScope(
    plan,
    estate.householdId,
    estate.assignedAccountIds,
    "GBP",
  );

  it("a person's left over is the sum over the accounts they own", () => {
    // Alice owns six of the eight GBP accounts, including the shared house pot
    // (decision 15: a shared pot is still somebody's account) and the bills pot
    // the household never assigned.
    expect(gbp("u-alice").leftoverMinor).toBe(205_100);
    expect(gbp("u-bob").leftoverMinor).toBe(152_400);
  });

  it("counts by ownership, not by what the roster or the household holds", () => {
    // Bob's whole GBP figure is his own current account: he owns nothing else
    // here, and his £476 into the house pot is Alice's pot, not his.
    const partition = plan.partitions.find((p) => p.currency === "GBP")!;
    const bobs = partition.accounts.filter((a) => a.ownerUserId === "u-bob");
    expect(bobs.map((a) => a.accountId)).toEqual(["acc-bob-current"]);
    // And the three pots holding the £450 the household page loses are Alice's,
    // owned by her and assigned to nothing.
    for (const id of ["acc-alice-savings", "acc-alice-holiday", "acc-alice-car"]) {
      expect(partition.accounts.find((a) => a.accountId === id)?.ownerUserId).toBe("u-alice");
      expect(estate.assignedAccountIds).not.toContain(id);
    }
  });

  it("reports a second currency separately and never adds it in", () => {
    // Alice earns €800 and owes €120 on the account it lands in. £2,501.00 and
    // €680.00 are two answers, never one (decision 10, decision 14).
    expect(leftoverForUser(plan, "u-alice")).toEqual([
      { currency: "EUR", leftoverMinor: 68_000, shortfallMinor: 0, paymentCount: 1 },
      { currency: "GBP", leftoverMinor: 205_100, shortfallMinor: 0, paymentCount: 4 },
    ]);
    // And the household, denominated in one currency, never sees the other.
    expect(household.currency).toBe("GBP");
    expect(household.membersLeftoverMinor).toBe(357_500);
  });

  it("a household's left over is its members', added up", () => {
    expect(household.members.map((m) => [m.userId, m.personalLeftoverMinor])).toEqual([
      ["u-alice", 205_100],
      ["u-bob", 152_400],
    ]);
    expect(household.membersLeftoverMinor).toBe(357_500);
    expect(household.membersLeftoverMinor).toBe(
      gbp("u-alice").leftoverMinor + gbp("u-bob").leftoverMinor,
    );
  });

  it("reads the same free total after committed savings are removed", () => {
    expect(household.householdLeftoverMinor).toBe(402_500);
    expect(household.committedMinor).toBe(45_000);
    expect(household.householdLeftoverMinor - household.committedMinor).toBe(357_500);
    expect(household.membersLeftoverMinor).toBe(household.householdLeftoverMinor - 45_000);
  });

  it("does not move an existing field to get there", () => {
    // Decision 13's surviving half: every figure the wire carried before this
    // work carries the same figure after it, and the three altitudes are
    // additions beside them.
    expect(household.leftoverMinor).toBe(402_500);
    expect(household.members.map((m) => m.leftoverMinor)).toEqual([250_100, 152_400]);
    const partition = plan.partitions.find((p) => p.currency === "GBP")!;
    expect(partition.leftoverMinor).toBe(402_500);
    expect(partition.committedMinor).toBe(45_000);
  });
});

/**
 * **A co-member's money parked in an account you own** — "the regression to
 * fear", and the only shape that tells the ownership basis from the roster one.
 *
 * `crossowner.fixture.ts` describes it: Bob authors £400 a month into a pot
 * Alice owns; the pot's £600 of bills were already paid for by the transport the
 * pass derived, and authored movements are funded after every expense
 * (decision 8) — so nothing spends Bob's £400 where it lands and it is still
 * sitting there when the month is over.
 *
 * ## What the personal figure should say, and why
 *
 * **It says £2,100 for Alice: the money is in her accounts, so it is in her
 * figure.** Deliberately, not by omission.
 *
 *  - A residual is a fact about a **place** — what is in the account when the
 *    month has happened — and a person's left over is the sum over the places
 *    they own. Provenance is a different relation from ownership, and the pass
 *    is not told which one an authored movement means: Bob's £400 could be his
 *    half of a bill, a gift, a loan repayment or a standing arrangement, and
 *    those want four different answers to "whose is it?".
 *  - Attributing it back to the sender would be a **fourth derivation of left
 *    over**, which is the disease this plan exists to cure: the altitudes would
 *    stop being plain sums of one another, and the rows on a screen would stop
 *    adding up to the total above them.
 *  - The household total is **not at risk either way**: the pound is added to
 *    Alice's figure and subtracted from Bob's, so their sum counts it exactly
 *    once — £2,900 here, which is every pound of external income (£3,500) less
 *    every pound spent (£600). Both readings agree on the total; only the
 *    personal figures move.
 *
 * What is left over from that decision is a **labelling** question rather than
 * an arithmetic one: a screen may well want to say "incl. £400 that arrived from
 * Bob", and the arrival is already itemised on the account plan
 * (`inflowArrivals`) for a surface that decides to. That is a product call about
 * a sentence, and this is the figure the sentence would be about.
 */
describe("mine, and ours — a co-member's money parked in your account", () => {
  const plan = computeScopePlan(crossOwnerScope, CROSS_OWNER_ASOF);
  const gbp = (userId: string) => leftoverForUser(plan, userId).find((l) => l.currency === "GBP")!;
  const household = householdPlanFromScope(
    plan,
    CROSS_OWNER_HOUSEHOLD_ID,
    CROSS_OWNER_ASSIGNED_ACCOUNT_IDS,
    "GBP",
  );

  it("counts the money where it is, and says so", () => {
    // £1,700 in her current account and £400 in the pot — all £400 of it Bob's,
    // and all £400 of it in an account of hers. See the note above.
    expect(gbp("u-alice").leftoverMinor).toBe(170_000);
    // Bob's £400 has left him, and his figure is £400 lighter for it.
    expect(gbp("u-bob").leftoverMinor).toBe(80_000);
    const pot = plan.accounts.find((a) => a.accountId === "acc-x-house-pot")!;
    expect(pot.ownerUserId).toBe("u-alice");
    expect(pot.movementInMinor).toBe(40_000);
    expect(pot.leftoverMinor).toBe(40_000);
    expect(pot.availableLeftoverMinor).toBe(0);
  });

  it("counts it once at the household altitude, whichever way it is read", () => {
    expect(household.members.map((m) => [m.userId, m.personalLeftoverMinor])).toEqual([
      ["u-alice", 170_000],
      ["u-bob", 80_000],
    ]);
    expect(household.membersLeftoverMinor).toBe(250_000);
    // £3,500 of external income less £600 spent and less Bob's £400 saved into
    // Alice's pot.
    expect(
      household.monthlyIncomeMinor - household.totalFundedMinor - household.committedMinor,
    ).toBe(250_000);
  });

  it("is the fixture the estate cannot be: the two bases disagree here", () => {
    // The pre-commit household rows count Bob's £400 twice — added back on his
    // sending row, and again in the pot it arrived at — so the roster basis is
    // £800 clear of the ownership one. That gap is what this fixture is for.
    expect(household.householdLeftoverMinor).toBe(330_000);
    expect(household.householdLeftoverMinor - household.membersLeftoverMinor).toBe(80_000);
    // And the per-person figures diverge with it, which is what an
    // implementation wired to the roster gets wrong while passing every estate
    // figure: Bob's roster row reads £1,200 where his left over is £800.
    const bobsRow = household.accounts.find((a) => a.accountId === "acc-x-bob-cur")!;
    expect(bobsRow.leftoverMinor).toBe(120_000);
    expect(bobsRow.committedMinor).toBe(40_000);
    expect(gbp("u-bob").leftoverMinor).toBe(80_000);
  });

  it("carries the shortfall and the payment count on the same basis", () => {
    // Decision 24. The pot's one bill is on an account Alice owns, so it is on
    // her payment count; Bob pays for half of it and it is not on his.
    expect(leftoverForUser(plan, "u-alice")).toEqual([
      { currency: "GBP", leftoverMinor: 170_000, shortfallMinor: 0, paymentCount: 1 },
    ]);
    expect(leftoverForUser(plan, "u-bob")).toEqual([
      { currency: "GBP", leftoverMinor: 80_000, shortfallMinor: 0, paymentCount: 0 },
    ]);
  });
});
