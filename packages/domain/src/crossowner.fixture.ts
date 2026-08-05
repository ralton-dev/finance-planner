import type { ScopeInput } from "./scope.js";

/**
 * **A co-member's money parked in an account you own.**
 *
 * `MINE-AND-OURS.md`'s "the regression to fear", built. Decision 19 makes a
 * person's left over the sum of the residuals of the accounts they **own**, and
 * that sum is exact only because a movement is subtracted where it leaves and
 * added where it lands. When a co-member's movement lands in an account **you**
 * own and is not spent there, the remainder sits in your residual and therefore
 * in your personal figure — genuinely in your account, genuinely not your money.
 *
 * ## Why the estate fixture cannot stand in for this one
 *
 * Two reasons, and they are the whole reason this file exists.
 *
 * **It cannot tell the ownership basis from the roster basis.** On
 * `estate.fixture.ts` the two coincide to the penny — £2,501 / £1,524 / £4,025
 * either way (verified at `22c1ce6`) — because every authored movement there is
 * Alice's, fully funded, into a pot of hers that spends nothing. An
 * implementation wired to `residual + committed` over the household roster
 * passes every estate figure. Here it does not: Bob's £400 is added back into
 * his current account's roster figure **and** counted again in the pot's
 * residual, so the roster basis reads £3,300 where the members' sum is £2,900.
 *
 * **And a derived transfer provably cannot produce the case.** The pass derives
 * transport equal to what the destination cannot pay out of its own income, so
 * the destination's bills consume it by construction (verified at `22c1ce6` by
 * shrinking the pot's bills — the transport shrank with them). Only an
 * **authored** movement crossing owners reaches it, because authored movements
 * are funded last, out of what the bills left, and nothing downstream spends
 * them (decision 8).
 *
 * ## The shape
 *
 * A household of two, one currency, evenly split, and one authored movement
 * that crosses an ownership boundary:
 *
 * | account            | owner | role     | income   | pays | authored out            |
 * | ------------------ | ----- | -------- | -------- | ---- | ----------------------- |
 * | `acc-x-alice-cur`  | alice | personal | £2,000   | —    | —                       |
 * | `acc-x-bob-cur`    | bob   | personal | £1,500   | —    | £400 → the pot          |
 * | `acc-x-house-pot`  | alice | shared   | —        | £600 | —                       |
 *
 * All three are on the household's roster. The pot is Alice's account shared
 * into the household (decision 15), which is what makes Bob's movement cross an
 * owner rather than merely cross an account.
 *
 * ## What it plans to
 *
 * The pot has £600 of shared bills and no income of its own, so the pass derives
 * transport for the whole £600, split 50/50: £300 out of each current account.
 * Bob's authored £400 is funded afterwards out of what his £1,500 has left
 * (£1,200), so it moves in full — and it arrives **after** the pot's bills have
 * already been paid for, which is precisely why it is still there at the end of
 * the month.
 *
 * | account            | residual                                | owner |
 * | ------------------ | --------------------------------------- | ----- |
 * | `acc-x-alice-cur`  | 2000 − 300 = **£1,700**                 | alice |
 * | `acc-x-bob-cur`    | 1500 − 300 − 400 = **£800**             | bob   |
 * | `acc-x-house-pot`  | 300 + 300 + 400 − 600 = **£400**        | alice |
 *
 * - **Alice £2,100** — her current account plus the pot, £400 of which is Bob's
 *   money sitting in an account of hers;
 * - **Bob £800**;
 * - **the household £2,900**, which is every pound of external income (£3,500)
 *   less every pound spent (£600). The £400 is counted once: added to Alice's
 *   figure and subtracted from Bob's.
 *
 * Nothing here is tuned to a date: every income is monthly and the one bill is a
 * monthly recurring one, so the pass answers the same on any as-of date.
 */

/** A date to plan as of. Nothing below was tuned to it. */
export const CROSS_OWNER_ASOF = "2026-08-04";

/** The household these three accounts are all assigned to. */
export const CROSS_OWNER_HOUSEHOLD_ID = "hh-cross";

/**
 * The roster, in assignment order — the one fact a `ScopeInput` cannot carry
 * (see `EstateFixture.assignedAccountIds`). Every account is on it, deliberately:
 * the divergence between the ownership basis and the roster basis here is not
 * about which accounts the household holds, but about the roster basis adding
 * `committedMinor` back into the sender while the receiver still reports the
 * money that arrived.
 */
export const CROSS_OWNER_ASSIGNED_ACCOUNT_IDS: readonly string[] = [
  "acc-x-alice-cur",
  "acc-x-bob-cur",
  "acc-x-house-pot",
];

export const crossOwnerScope: ScopeInput = {
  scopeId: CROSS_OWNER_HOUSEHOLD_ID,
  householdId: CROSS_OWNER_HOUSEHOLD_ID,
  // Evenly split: the rounding cases are the estate's job, and a 50/50 split
  // keeps every figure here checkable by hand.
  members: [
    { userId: "u-alice", displayName: "Alice", shareBp: 5000 },
    { userId: "u-bob", displayName: "Bob", shareBp: 5000 },
  ],
  accounts: [
    {
      accountId: "acc-x-alice-cur",
      ownerUserId: "u-alice",
      name: "Alice current",
      role: "personal",
      memberUserId: "u-alice",
      currency: "GBP",
      monthlyBufferMinor: 0,
      incomes: [
        { id: "inc-x-alice", amountMinor: 200_000, frequency: "monthly", anchorDate: "2026-01-25" },
      ],
      payments: [],
      inflows: [],
      outboundInflows: [],
      confirmedArrivals: [],
    },
    {
      accountId: "acc-x-bob-cur",
      ownerUserId: "u-bob",
      name: "Bob current",
      role: "personal",
      memberUserId: "u-bob",
      currency: "GBP",
      monthlyBufferMinor: 0,
      incomes: [
        { id: "inc-x-bob", amountMinor: 150_000, frequency: "monthly", anchorDate: "2026-01-25" },
      ],
      payments: [],
      inflows: [],
      // **The movement this fixture exists for.** Bob authors it, it leaves his
      // account, and it lands in an account Alice owns. Nothing on the receiving
      // side can spend it: authored movements are funded after every expense
      // (decision 8), so the pot's bills were already paid for when it arrived.
      outboundInflows: [
        {
          id: "mov-bob-to-pot",
          toAccountId: "acc-x-house-pot",
          amountMinor: 40_000,
          frequency: "monthly",
          anchorDate: "2026-01-28",
          priority: 10,
        },
      ],
      confirmedArrivals: [],
    },
    {
      accountId: "acc-x-house-pot",
      ownerUserId: "u-alice",
      name: "House pot",
      role: "shared",
      memberUserId: null,
      currency: "GBP",
      monthlyBufferMinor: 0,
      // No income of its own: the £600 of bills is transported in full, which is
      // what makes the derived money exactly consumed and the authored money
      // exactly left over.
      incomes: [],
      payments: [
        {
          id: "pay-x-rent",
          name: "Rent",
          category: "monthly_recurring",
          amountMinor: 60_000,
          scope: "shared",
          priority: 10,
        },
      ],
      // The arriving face of Bob's authored row — one record read from both
      // ends, as a store holds it. The pass funds from the leaving face; this
      // side is here so the fixture is the shape `apps/api/src/plan.ts` builds.
      inflows: [
        {
          id: "mov-bob-to-pot",
          amountMinor: 40_000,
          frequency: "monthly",
          anchorDate: "2026-01-28",
          source: "account",
          sourceAccountId: "acc-x-bob-cur",
          priority: 10,
        },
      ],
      outboundInflows: [],
      // Nobody has said it moved. A confirmation would change what the
      // checklist says and none of the figures below, and this fixture is about
      // the figures.
      confirmedArrivals: [],
    },
  ],
  confirmedTransfers: [],
};
