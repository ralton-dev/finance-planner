import { describe, expect, it } from "vitest";
import { estate, ESTATE_ASOF } from "./estate.fixture.js";
import { householdPlanFromScope } from "./household.js";
import { computeScopePlan } from "./scope.js";

/**
 * **Mine, and ours** — the identity `MINE-AND-OURS.md` exists to establish,
 * written down and observed failing before anything implements it.
 *
 * Decision 19: left over is **one derivation read at three altitudes**, and the
 * boundary is ownership.
 *
 *  - an **account's** left over is its residual — `income + arriving − spending
 *    − leaving`, which is `ScopeAccountPlan.leftoverMinor` today;
 *  - a **person's** is that, summed over the accounts they **own**
 *    (`ownerUserId`, never access — decision 20);
 *  - a **household's** is its members' left overs, added up. That is all it is.
 *
 * Each altitude is a plain sum of the one below it, so the rows on a screen add
 * up to the total above them. Nothing is netted and nothing is reconstructed by
 * algebra.
 *
 * ## The figures, measured at `22c1ce6`
 *
 * First measured at `1409e5f` and re-verified identical at `22c1ce6`, through
 * the fixture correction `22c1ce6` itself made. Every one below was measured
 * off `estate.fixture.ts` rather than copied from the plan:
 *
 * | altitude                              | GBP                     |
 * | ------------------------------------- | ----------------------- |
 * | Alice — Σ over accounts she owns      | **£2,501.00** (250_100) |
 * | Bob — Σ over accounts he owns         | **£1,524.00** (152_400) |
 * | the household — their sum             | **£4,025.00** (402_500) |
 * | what the household page prints today  | **£3,575.00** (357_500) |
 *
 * ## The two diverging figures, and the £450 between them
 *
 * `HouseholdPlanView.householdFreeMinor` (`HouseholdPlanView.tsx:64`) derives the
 * household's headline as `householdLeftoverMinor − committedMinor`. On this
 * estate that is `402_500 − 45_000 = 357_500` — **£3,575.00 where the members'
 * sum is £4,025.00**, a difference of exactly the £450 of funded authored
 * savings movements (`mov-savings` £200, `mov-holiday` £150, `mov-car` £100).
 *
 * The subtraction is the whole of the gap here. `household.ts:340` adds each
 * account's committed back into `HouseholdAccountPlan.leftoverMinor` and the page
 * subtracts the same total, so the two cancel and what prints is Σ **residuals**
 * over the household roster — and the £450 sits in three pots Alice owns that the
 * roster does not hold. A residual has already netted a movement at both ends, so
 * subtracting `committedMinor` from a roll-up of residuals loses that money
 * outright.
 *
 * ## Why this lands as `it.fails`, and why it can never turn green
 *
 * `it.fails` passes while its assertion fails and fails the moment it passes, so
 * CI stays green while the divergence stands and the tree records that it is
 * known rather than unnoticed. This one can **never** come true on its own:
 * decision 19 redefines no existing field — `leftoverMinor`, `householdLeftoverMinor`
 * and `committedMinor` all keep their meanings on the wire to the penny, and
 * anything new is added alongside — so `householdLeftoverMinor − committedMinor`
 * reads £3,575.00 forever. Its job is to make the divergence undeniable and
 * dated, not to turn green.
 *
 * **WP-AE replaces this file.** The same three figures, asserted against the
 * fields WP-AE publishes (`personalLeftoverMinor`, `membersLeftoverMinor`), as a
 * plain `it`; this divergence assertion is deleted with the replacement.
 *
 * ## What this pin deliberately does not prove
 *
 * That the ownership basis is the one implemented. On this estate the ownership
 * sums and the old roster basis coincide to the penny — `householdLeftoverMinor`
 * alone is already 402_500 — because every authored movement is Alice's, fully
 * funded, into a pot of hers that spends nothing. An implementation wired to the
 * roster would pass every figure below. Only an **authored movement crossing
 * owners** tells the two apart, which is the fixture `MINE-AND-OURS.md`'s "the
 * regression to fear" orders built and WP-AE's acceptance pins.
 */
describe("mine, and ours — one derivation at three altitudes", () => {
  const plan = computeScopePlan(estate.scope, ESTATE_ASOF);
  const gbp = plan.partitions.find((p) => p.currency === "GBP");
  const eur = plan.partitions.find((p) => p.currency === "EUR");

  /** A person's left over: Σ the residual over the accounts they **own**. No
   *  production code does this yet — that is WP-AE's `leftoverForUser`. */
  const leftoverForOwner = (partition: typeof gbp, userId: string): number =>
    (partition?.accounts ?? [])
      .filter((a) => a.ownerUserId === userId)
      .reduce((s, a) => s + a.leftoverMinor, 0);

  it("a person's left over is the sum over the accounts they own", () => {
    // Alice owns six of the eight GBP accounts, including the shared house pot
    // (decision 15: a shared pot is still somebody's account) and the bills pot
    // the household never assigned.
    expect(leftoverForOwner(gbp, "u-alice")).toBe(250_100);
    expect(leftoverForOwner(gbp, "u-bob")).toBe(152_400);
  });

  it("counts by ownership, not by what the roster or the household holds", () => {
    // Bob's whole GBP figure is his own current account: he owns nothing else
    // here, and his £476 into the house pot is Alice's pot, not his.
    const bobs = (gbp?.accounts ?? []).filter((a) => a.ownerUserId === "u-bob");
    expect(bobs.map((a) => a.accountId)).toEqual(["acc-bob-current"]);
    // And the three pots holding the £450 the household page loses are Alice's,
    // owned by her and assigned to nothing.
    const pots = ["acc-alice-savings", "acc-alice-holiday", "acc-alice-car"];
    for (const id of pots) {
      const acc = (gbp?.accounts ?? []).find((a) => a.accountId === id);
      expect(acc?.ownerUserId).toBe("u-alice");
      expect(estate.assignedAccountIds).not.toContain(id);
    }
  });

  it("reports a second currency separately and never adds it in", () => {
    // Alice earns €800 and owes €120 on the account it lands in. £2,501.00 and
    // €680.00 are two answers, never one (decision 10, decision 14).
    expect(leftoverForOwner(eur, "u-alice")).toBe(68_000);
    expect(leftoverForOwner(eur, "u-bob")).toBe(0);
  });

  it("a household's left over is its members', added up", () => {
    expect(leftoverForOwner(gbp, "u-alice") + leftoverForOwner(gbp, "u-bob")).toBe(402_500);
  });

  /**
   * The red pin. `it.fails` — see the module note: it passes while this
   * assertion fails, and it can never come true on its own.
   */
  it.fails("today's household headline is not the members' sum — £3,575.00 vs £4,025.00", () => {
    const household = householdPlanFromScope(
      plan,
      estate.householdId,
      estate.assignedAccountIds,
      "GBP",
    );
    // `householdFreeMinor` verbatim (`apps/web/src/components/HouseholdPlanView.tsx:64`),
    // which the domain cannot import. This much holds today, at `22c1ce6`:
    const householdFreeMinor = household.householdLeftoverMinor - household.committedMinor;
    expect(household.householdLeftoverMinor).toBe(402_500);
    expect(household.committedMinor).toBe(45_000);
    expect(householdFreeMinor).toBe(357_500);

    // And this is the divergence, which fails, which is the point:
    expect(householdFreeMinor).toBe(402_500);
  });
});
