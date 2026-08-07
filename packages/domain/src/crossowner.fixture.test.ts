import { describe, expect, it } from "vitest";
import {
  CROSS_OWNER_ASOF,
  CROSS_OWNER_ASSIGNED_ACCOUNT_IDS,
  CROSS_OWNER_HOUSEHOLD_ID,
  crossOwnerScope,
} from "./crossowner.fixture.js";
import { householdPlanFromScope } from "./household.js";
import { computeScopePlan } from "./scope.js";

/**
 * The fixture's **shape**, held to the pass — the half of it no figure can state
 * for itself.
 *
 * `estate.fixture.ts` went stale silently once: a figure drifted, a seeding
 * branch quietly took a different path, and every test still passed. So the
 * intent behind this fixture is written down where a test can hold the numbers
 * to it. Three things have to stay true or it stops being the shape
 * `MINE-AND-OURS.md`'s "the regression to fear" asks for:
 *
 *  1. the movement crosses an ownership boundary — Bob's, into an account Alice
 *     owns — and it is **authored**, not derived;
 *  2. it is funded in full and **nothing spends it where it lands**, so it is
 *     still there in the destination's residual at the end of the month;
 *  3. the ownership basis and the old roster basis therefore **disagree**, which
 *     is the property the estate fixture does not have and cannot be given.
 *
 * The three altitude figures themselves are pinned in `mine.test.ts`, against
 * the fields the pass publishes.
 */
describe("the cross-owner fixture: a co-member's money parked in your account", () => {
  const plan = computeScopePlan(crossOwnerScope, CROSS_OWNER_ASOF);
  const gbp = plan.partitions.find((p) => p.currency === "GBP")!;
  const accountOf = (id: string) => gbp.accounts.find((a) => a.accountId === id)!;

  it("is one currency, three accounts, and two members", () => {
    expect(plan.partitions.map((p) => p.currency)).toEqual(["GBP"]);
    expect(gbp.accounts.map((a) => a.accountId)).toEqual([
      "acc-x-alice-cur",
      "acc-x-bob-cur",
      "acc-x-house-pot",
    ]);
    // The pot is Alice's, shared into the household. That is what makes Bob's
    // movement cross an *owner* and not merely an account (decision 15).
    expect(gbp.accounts.map((a) => a.ownerUserId)).toEqual(["u-alice", "u-bob", "u-alice"]);
    expect(accountOf("acc-x-house-pot").role).toBe("shared");
  });

  it("moves Bob's £400 into Alice's pot, authored and funded in full", () => {
    expect(plan.movements).toHaveLength(1);
    const movement = plan.movements[0]!;
    expect(movement).toMatchObject({
      inflowId: "mov-bob-to-pot",
      fromAccountId: "acc-x-bob-cur",
      toAccountId: "acc-x-house-pot",
      requestedMinor: 40_000,
      fundedMinor: 40_000,
      status: "funded",
    });
    // Out of Bob's own income, not out of money passing through him: a movement
    // funded from an arrival would be a chain, and a chain is a different test.
    expect(movement.fundedFromOwnMinor).toBe(40_000);
    expect(movement.fundedFromInflowMinor).toBe(0);
  });

  it("derives the pot's transport in full and lets the bills consume all of it", () => {
    // £600 of bills, no income of the pot's own, split 50/50 — so the derived
    // side is exactly spent and only the authored side survives. This is the
    // fact that makes a derived transfer unable to produce this case at all.
    expect(
      gbp.transfers.map((t) => [t.fromAccountId, t.memberUserId, t.amountMinor] as const),
    ).toEqual([
      ["acc-x-alice-cur", "u-alice", 30_000],
      ["acc-x-bob-cur", "u-bob", 30_000],
    ]);
    const pot = accountOf("acc-x-house-pot");
    expect(pot.transferInMinor).toBe(60_000);
    expect(pot.fundedOutflowMinor).toBe(60_000);
    expect(pot.shortfallMinor).toBe(0);
  });

  it("leaves the whole £400 sitting in a residual that is not its owner's money", () => {
    const pot = accountOf("acc-x-house-pot");
    expect(pot.movementInMinor).toBe(40_000);
    // income 0 + arriving 100_000 − spending 60_000 − leaving 0.
    expect(pot.leftoverMinor).toBe(40_000);
    expect(accountOf("acc-x-alice-cur").leftoverMinor).toBe(170_000);
    expect(accountOf("acc-x-bob-cur").leftoverMinor).toBe(80_000);
  });

  it("makes the ownership basis and the roster basis disagree, which is its whole point", () => {
    const household = householdPlanFromScope(
      plan,
      CROSS_OWNER_HOUSEHOLD_ID,
      CROSS_OWNER_ASSIGNED_ACCOUNT_IDS,
      "GBP",
    );
    // The household rows are pre-commit *and* they apply what arrived, so Bob's
    // £400 is on his sending row — added back — and again in the pot it reached.
    // That double count is the roster basis, and it is the whole reason this
    // fixture exists; `membersLeftoverMinor` is the basis without it.
    expect(household.householdLeftoverMinor).toBe(330_000);
    expect(household.householdLeftoverMinor - household.committedMinor).toBe(290_000);
    // The ownership basis: Σ available money over the accounts each member owns.
    const owned = (userId: string) =>
      gbp.accounts
        .filter((a) => a.ownerUserId === userId)
        .reduce((s, a) => s + a.availableLeftoverMinor, 0);
    expect(owned("u-alice") + owned("u-bob")).toBe(250_000);
    // £800 apart: Bob's £400, counted at both ends. Subtracting `committedMinor`
    // removes one of the two and still leaves the other, which is exactly why a
    // household headline reads the ownership basis instead.
    expect(household.householdLeftoverMinor - (owned("u-alice") + owned("u-bob"))).toBe(80_000);
  });
});
