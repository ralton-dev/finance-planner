import type { ScopeAccountInput, ScopeInput } from "./scope.js";

/**
 * **An estate shaped like somebody's actual money**, for every test that needs
 * one.
 *
 * Every fixture in this repository was a user with **no household assignments**.
 * That is why `ONE-ENGINE.md`'s purpose-built parity test and five field-by-field
 * audits all passed while a live defect sat in production, and why the repo
 * owner found it in thirty seconds on his own accounts page: a bills pot he kept
 * *out* of his household could never reach the salary that was supposed to feed
 * it, because that salary account **was** in the household, and the two closure
 * rules were alternatives (`f3acef8`). No fixture had that relationship, so no
 * test could have.
 *
 * So this one has it, and the rest of the shapes nothing had either:
 *
 * | Feature                                     | Where                                   |
 * | ------------------------------------------- | --------------------------------------- |
 * | a household of two, hand-set shares         | `hh-estate`, 66 / 34                    |
 * | personal assigned accounts with salaries    | `acc-alice-current`, `acc-bob-current`  |
 * | a shared pot with **its own** income        | `acc-house-pot` — £500 lodger rent      |
 * | an unassigned pot fed by a derived transfer | `acc-alice-bills` — the `f3acef8` shape |
 * | authored movements to several destinations  | three, out of `acc-alice-current`       |
 * | mixed confirmed states                      | full / partial / none, both kinds       |
 * | a second currency                           | `acc-alice-eur`                         |
 *
 * ## Two projections, one description
 *
 * What the pass is handed **is** a description of an estate, so this exports one
 * rather than inventing a second vocabulary: `estate.scope` is a `ScopeInput`,
 * ready for `computeScopePlan`. Beside it sits what a *store* seeder needs in the
 * shape a seeder wants it — `ownerOf`, the same fact each account now carries as
 * `ownerUserId`, as a map — and the one fact the pass is deliberately never told:
 * which accounts the household actually assigned. That one is not recoverable
 * from the input, because an unassigned account and a household-assigned personal
 * one are the same shape by the time they reach the pass
 * (`apps/api/src/plan.ts` gives an unassigned account `role: "personal"` and its
 * owner as `memberUserId`), which is exactly the ambiguity `assignedAccountIds`
 * resolves.
 *
 * There is no store seeder in here, and there cannot be: `@finance-planner/domain`
 * does not depend on `@finance-planner/data` and this is not the package to make
 * it. An API-level seeder is a short walk over `estate` — `seedEstate` in
 * `apps/api/src/server.test.ts`, lifted there from the red pin when `1409e5f`
 * deleted it.
 *
 * ## Nothing here depends on what day it is
 *
 * Every income is monthly and every payment is a monthly recurring bill, so the
 * pass answers the same on any as-of date and a test may close "this month"
 * against the figures written down below. `ESTATE_ASOF` is supplied for callers
 * that need to name a date; it is not a date any figure was tuned to.
 *
 * ## What it plans to
 *
 * GBP partition — alice earns £3,000 of salary and, since decision 15, the pot's
 * £500 as well (it is her account); bob earns £2,000:
 *
 *  - the pot's £1,400 of shared bills, less the £500 the pot's own income
 *    already covers (`0c35284`'s netting), split 66 / 34 gross: alice moves
 *    **£424.00**, bob **£476.00** — £900 between them, and the £500 relieves
 *    alice's share alone because it is alice's budget that counted it. At
 *    `21ec4e1`, when the £500 belonged to nobody, both members leant on it and
 *    the same £900 was split £594 / £306;
 *  - alice's out-of-household bills pot needs **£75.00**, derived, out of her
 *    current account — the relationship no fixture had;
 *  - her three authored movements (£200 / £150 / £100) all fund, out of what is
 *    left after those two derived transfers.
 *
 * EUR partition — alice earns €800 and owes €120 on the account it lands in, so
 * it self-funds and derives no transfer at all. Two partitions is the point: a
 * user is multi-currency by construction, and `MONTH-CLOSE.md` decision 14 makes
 * a close per user **per currency** for exactly that reason.
 *
 * **Decision 15 moved some of these figures and had to move no others.** The
 * pot's £500 belonged to nobody at `21ec4e1`; WP-C gave it to the account's
 * owner (alice), which changed her income, her budget and how her share of the
 * pot's bills is netted — and no other account here is shared, so every other
 * figure above was a regression guard rather than an expectation to update.
 * `estateWithoutSharedIncome` below is that guard, and
 * `packages/domain/src/ownership.test.ts` holds it to the byte.
 *
 * ## And what has been said to have moved
 *
 * The confirmations are the half of the estate no figure can state on its own: a
 * confirmed £424 is "the whole of it" only against a plan that derives £424, and
 * plans move. `ESTATE_CONFIRMATION_SHAPES` writes down which of them is meant to
 * be whole, which part-moved and which unsaid, and `estate.fixture.test.ts`
 * holds the numbers to it — because the pass clamps a confirmation into range
 * and a figure left behind by a domain change goes quiet rather than red.
 */

/** A date to plan as of. Nothing below was tuned to it — see the module note. */
export const ESTATE_ASOF = "2026-08-04";

/**
 * The estate, and what a store seeder needs beside it: the assignment a
 * `ScopeInput` cannot carry, and the ownership it now can but wants as a map.
 *
 * Ids are readable rather than uuid-shaped: a store generates its own, so a
 * seeder keeps a fixture-id → real-id map and these are what that map is keyed
 * by. Nothing in the pass reads an id for anything but identity and tie-breaks.
 */
export interface EstateFixture {
  /** See `ESTATE_ASOF`. */
  asOfDate: string;
  householdId: string;
  /**
   * `core.accounts.owner_user_id` per account — `NOT NULL` in the schema, so
   * every account has exactly one owner and a "joint" account is one person's
   * account shared into a household.
   *
   * The same fact each account now carries as `ScopeAccountInput.ownerUserId`
   * (`MONTH-CLOSE.md` decision 15, WP-C), kept here as a map because that is the
   * shape a *store* seeder wants: it writes accounts before it has a scope.
   */
  ownerOf: Readonly<Record<string, string>>;
  /**
   * The accounts the household has actually assigned, in assignment order.
   *
   * Not derivable from `scope.accounts`: an unassigned account reaches the pass
   * as `role: "personal"` with its owner as `memberUserId`, identically to an
   * assigned personal one. The order matters to one caller today —
   * `scopeForHousehold` denominates a household in its first assigned account's
   * currency — so the GBP accounts come first, as they did on the real estate.
   */
  assignedAccountIds: readonly string[];
  /** The pass's input, as `apps/api/src/plan.ts`'s loader would build it. */
  scope: ScopeInput;
}

export const estate: EstateFixture = {
  asOfDate: ESTATE_ASOF,
  householdId: "hh-estate",
  ownerOf: {
    "acc-alice-current": "u-alice",
    "acc-bob-current": "u-bob",
    // A shared pot is still somebody's account. This is the entry that makes
    // decision 15 mean anything.
    "acc-house-pot": "u-alice",
    "acc-alice-bills": "u-alice",
    "acc-alice-savings": "u-alice",
    "acc-alice-holiday": "u-alice",
    "acc-alice-car": "u-alice",
    "acc-alice-eur": "u-alice",
  },
  assignedAccountIds: [
    "acc-alice-current",
    "acc-bob-current",
    "acc-house-pot",
    // Assigned, and in a currency the household's own plan cannot see: a
    // household is denominated in its first assigned account's currency, so this
    // one is silently absent from every household figure. Decision 14 is the fix.
    "acc-alice-eur",
  ],
  scope: {
    // One household applies, so the loader names the scope after it.
    scopeId: "hh-estate",
    householdId: "hh-estate",
    // Hand-set shares, not the even default: a split that has to round is the
    // only one that can catch a rounding bug.
    members: [
      { userId: "u-alice", displayName: "Alice", shareBp: 6600 },
      { userId: "u-bob", displayName: "Bob", shareBp: 3400 },
    ],
    accounts: [
      {
        accountId: "acc-alice-current",
        ownerUserId: "u-alice",
        name: "Alice current",
        role: "personal",
        memberUserId: "u-alice",
        currency: "GBP",
        monthlyBufferMinor: 0,
        incomes: [
          {
            id: "inc-alice-salary",
            amountMinor: 300_000,
            frequency: "monthly",
            anchorDate: "2026-01-25",
          },
        ],
        payments: [],
        inflows: [],
        // Three destinations, so a surface standing here has three rows to tell
        // apart. One authored movement to one pot could never have caught the
        // row that lumped three of them into a far end that was a *set*.
        outboundInflows: [
          {
            id: "mov-savings",
            toAccountId: "acc-alice-savings",
            amountMinor: 20_000,
            frequency: "monthly",
            anchorDate: "2026-01-28",
            priority: 10,
          },
          {
            id: "mov-holiday",
            toAccountId: "acc-alice-holiday",
            amountMinor: 15_000,
            frequency: "monthly",
            anchorDate: "2026-01-28",
            priority: 20,
          },
          {
            id: "mov-car",
            toAccountId: "acc-alice-car",
            amountMinor: 10_000,
            frequency: "monthly",
            anchorDate: "2026-01-28",
            priority: 30,
          },
        ],
        confirmedArrivals: [],
      },
      {
        accountId: "acc-bob-current",
        ownerUserId: "u-bob",
        name: "Bob current",
        role: "personal",
        memberUserId: "u-bob",
        currency: "GBP",
        monthlyBufferMinor: 0,
        incomes: [
          {
            id: "inc-bob-salary",
            amountMinor: 200_000,
            frequency: "monthly",
            anchorDate: "2026-01-25",
          },
        ],
        payments: [],
        inflows: [],
        outboundInflows: [],
        confirmedArrivals: [],
      },
      {
        accountId: "acc-house-pot",
        ownerUserId: "u-alice",
        name: "House pot",
        role: "shared",
        // Shared, so no *member's* by role — which is what made its income
        // unattributable until decision 15. `ownerUserId` above says whose it
        // really is, and the pass reads that now.
        memberUserId: null,
        currency: "GBP",
        monthlyBufferMinor: 0,
        // A shared pot that earns. The lodger pays the house, not a member, and
        // `0c35284`'s netting means the members transport the £1,400 of bills
        // **less** this £500 — never the gross.
        incomes: [
          {
            id: "inc-pot-lodger",
            amountMinor: 50_000,
            frequency: "monthly",
            anchorDate: "2026-01-01",
          },
        ],
        payments: [
          {
            id: "pay-rent",
            name: "Rent",
            category: "monthly_recurring",
            amountMinor: 120_000,
            scope: "shared",
            priority: 10,
          },
          {
            id: "pay-council",
            name: "Council tax",
            category: "monthly_recurring",
            amountMinor: 20_000,
            scope: "shared",
            priority: 20,
          },
        ],
        inflows: [],
        outboundInflows: [],
        confirmedArrivals: [],
      },
      {
        // **The pot kept out of the household.** Obligations, no income, no
        // assignment — and its owner's salary sits in an account the household
        // *has* assigned. Before `f3acef8` the two closure rules were
        // alternatives and this pot could reach that salary from neither end; it
        // read `unfunded · £303.20` on a live screen while the household's own
        // pots were fed beside it.
        accountId: "acc-alice-bills",
        ownerUserId: "u-alice",
        name: "Alice bills",
        role: "personal",
        memberUserId: "u-alice",
        currency: "GBP",
        monthlyBufferMinor: 0,
        incomes: [],
        // Personal, borne by alice: an account no household plans bears its own
        // payments whatever the column says, and the loader rewrites them so.
        payments: [
          {
            id: "pay-phone",
            name: "Phone",
            category: "monthly_recurring",
            amountMinor: 4_500,
            scope: "personal",
            bearerUserId: "u-alice",
            priority: 10,
          },
          {
            id: "pay-gym",
            name: "Gym",
            category: "monthly_recurring",
            amountMinor: 3_000,
            scope: "personal",
            bearerUserId: "u-alice",
            priority: 20,
          },
        ],
        inflows: [],
        outboundInflows: [],
        confirmedArrivals: [],
      },
      {
        accountId: "acc-alice-savings",
        ownerUserId: "u-alice",
        name: "Alice savings",
        role: "personal",
        memberUserId: "u-alice",
        currency: "GBP",
        monthlyBufferMinor: 0,
        incomes: [],
        payments: [],
        inflows: [
          {
            id: "mov-savings",
            amountMinor: 20_000,
            frequency: "monthly",
            anchorDate: "2026-01-28",
            source: "account",
            sourceAccountId: "acc-alice-current",
            priority: 10,
          },
        ],
        outboundInflows: [],
        // Confirmed in full.
        confirmedArrivals: [{ inflowId: "mov-savings", confirmedMinor: 20_000 }],
      },
      {
        accountId: "acc-alice-holiday",
        ownerUserId: "u-alice",
        name: "Alice holiday",
        role: "personal",
        memberUserId: "u-alice",
        currency: "GBP",
        monthlyBufferMinor: 0,
        incomes: [],
        payments: [],
        inflows: [
          {
            id: "mov-holiday",
            amountMinor: 15_000,
            frequency: "monthly",
            anchorDate: "2026-01-28",
            source: "account",
            sourceAccountId: "acc-alice-current",
            priority: 20,
          },
        ],
        outboundInflows: [],
        // Confirmed in part — £50 of the £150 moved. No API surface writes this
        // one: both confirm handlers book the whole planned amount. A store
        // does, and a plan that has been half-lived is a state the product
        // reaches whether or not a handler can create it.
        confirmedArrivals: [{ inflowId: "mov-holiday", confirmedMinor: 5_000 }],
      },
      {
        accountId: "acc-alice-car",
        ownerUserId: "u-alice",
        name: "Alice car fund",
        role: "personal",
        memberUserId: "u-alice",
        currency: "GBP",
        monthlyBufferMinor: 0,
        incomes: [],
        payments: [],
        inflows: [
          {
            id: "mov-car",
            amountMinor: 10_000,
            frequency: "monthly",
            anchorDate: "2026-01-28",
            source: "account",
            sourceAccountId: "acc-alice-current",
            priority: 30,
          },
        ],
        outboundInflows: [],
        // Nobody has said this one moved.
        confirmedArrivals: [],
      },
      {
        // The second currency. A user is multi-currency by construction — the
        // pass partitions per currency and nothing derived crosses one
        // (decision 10) — so a fixture with one currency cannot exercise the
        // partition boundary at all.
        accountId: "acc-alice-eur",
        ownerUserId: "u-alice",
        name: "Alice euro",
        role: "personal",
        memberUserId: "u-alice",
        currency: "EUR",
        monthlyBufferMinor: 0,
        incomes: [
          {
            id: "inc-alice-eur",
            amountMinor: 80_000,
            frequency: "monthly",
            anchorDate: "2026-01-15",
          },
        ],
        // On the account the euros land in, so it self-funds and derives no
        // transfer: the partition is deliberately simple, because what it is
        // here to test is that it exists at all.
        payments: [
          {
            id: "pay-hosting",
            name: "Hosting",
            category: "monthly_recurring",
            amountMinor: 12_000,
            scope: "personal",
            bearerUserId: "u-alice",
            priority: 10,
          },
        ],
        inflows: [],
        outboundInflows: [],
        confirmedArrivals: [],
      },
    ],
    // Somebody has said these derived transfers happened — one in full, one in
    // part, and bob's £476 into the pot deliberately not at all: an estate where
    // everything has been confirmed is one where the difference between
    // "planned" and "moved" cannot be seen.
    //
    // Hand-set against the figures in the module note, and **not** made safe by
    // the pass clamping them. A whole confirmation left behind by a domain
    // change is clamped back into range and reads as a part-moved one instead —
    // which is how `1ea409f` left £594 standing here against a £424 transfer
    // with every test still green. `ESTATE_CONFIRMATION_SHAPES` says which of
    // these is meant to be whole; nothing here is a free number.
    confirmedTransfers: [
      {
        fromAccountId: "acc-alice-current",
        toAccountId: "acc-house-pot",
        memberUserId: "u-alice",
        // Alice's share of the pot's bills, netted (`0c35284`) against the £500
        // of lodger rent her budget now counts — the whole of it, moved.
        confirmedMinor: 42_400,
      },
      {
        fromAccountId: "acc-alice-current",
        toAccountId: "acc-alice-bills",
        memberUserId: "u-alice",
        confirmedMinor: 3_000,
      },
    ],
  },
};

/** Whether a confirmation covers the whole of what the pass derives, part of it,
 *  or none of it at all. */
export type ConfirmationShape = "whole" | "partial" | "none";

/**
 * What each confirmation in the estate is **meant** to be, against what the pass
 * derives for it — the one fact the figures cannot state for themselves.
 *
 * `1ea409f` gave the pot's £500 to its owner, which re-netted alice's share of
 * the pot's bills from £594 to £424 and left `59_400` written here as a
 * confirmation that meant to be **whole**. Nothing failed. The pass clamps a
 * confirmation to what the transfer came to, so the figure simply became a
 * part-moved one — and `seedEstate` in `apps/api/src/server.test.ts`, which
 * branches on exactly that equality to choose between the real
 * `POST /api/households/:id/transfers/confirm` and a direct store write, stopped
 * calling the endpoint and stopped booking any contribution at all. The estate
 * every later package plans, closes and renders had an empty ledger, and five
 * green suites said so in no way whatsoever.
 *
 * So the intent lives somewhere a test can hold the numbers to it.
 * `estate.fixture.test.ts` checks every shape below against the current pass,
 * and `seedEstate` checks that the arm it takes per confirmation is the arm
 * declared here. A domain change that moves a figure fails a test now instead of
 * quietly downgrading the fixture that was built to catch it.
 */
export const ESTATE_CONFIRMATION_SHAPES: {
  /** Derived transfers, named the three ways the pass keys one. */
  readonly transfers: readonly {
    fromAccountId: string;
    toAccountId: string;
    memberUserId: string;
    shape: ConfirmationShape;
  }[];
  /** Authored movements, named by the inflow row that authors them. */
  readonly movements: readonly { inflowId: string; shape: ConfirmationShape }[];
} = {
  transfers: [
    {
      fromAccountId: "acc-alice-current",
      toAccountId: "acc-house-pot",
      memberUserId: "u-alice",
      shape: "whole",
    },
    {
      fromAccountId: "acc-alice-current",
      toAccountId: "acc-alice-bills",
      memberUserId: "u-alice",
      shape: "partial",
    },
    {
      fromAccountId: "acc-bob-current",
      toAccountId: "acc-house-pot",
      memberUserId: "u-bob",
      shape: "none",
    },
  ],
  movements: [
    { inflowId: "mov-savings", shape: "whole" },
    { inflowId: "mov-holiday", shape: "partial" },
    { inflowId: "mov-car", shape: "none" },
  ],
};

/**
 * The same estate with the shared pot earning nothing.
 *
 * Decision 15's regression guard, in the form WP-C's acceptance names it: with
 * no shared-account income anywhere, attributing income by **ownership** rather
 * than by household **role** can change nothing, so the whole `ScopePlan` must be
 * byte-identical either side of that change. Any figure that moves here is a
 * defect rather than a consequence.
 *
 * Its confirmations are written out rather than inherited, and that is the
 * point: `ownership.test.ts`'s `PLAN_AT_F9604C8` is a photograph of the plan
 * **this exact input** produced on the old tree, so the input may not drift
 * either. £594 is alice's gross 66% share of the pot's £900 as it stood before
 * decision 15 re-netted it; with the pot earning nothing here she owes the full
 * £924, so it stays the part-moved figure it was. Inheriting `estate.scope`'s
 * would mean holding the old tree's answer against a question nobody asked it.
 */
/**
 * **The same estate, with each member's own account holding a shared bill.**
 *
 * The shape every fixture here still avoided, and it is not an exotic one. Every
 * payment in `estate` sits on a *pot* — the house pot, alice's bills pot, the
 * euro account — and every member's source is a *current* account with no
 * payments of its own. So the derived transfers can only ever run current → pot:
 * two stars that never meet, a graph that cannot contain a loop **by the
 * fixture's construction rather than by anything the domain promises**. Nothing
 * was testing what happens when they do meet, because nothing could.
 *
 * A household reaches it by being ordinary. The broadband comes out of alice's
 * current account and the council tax out of bob's; each owes the other a share
 * of the bill the other pays. The pass then derives
 * `acc-alice-current → acc-bob-current` **and**
 * `acc-bob-current → acc-alice-current`, both funded, both non-zero, and
 * correctly reports **no cycle at all** — see the module comment on `scope.ts`,
 * which predicts exactly this and is right that it costs the funding pass
 * nothing, because neither transfer waits on the other. Phase 4's `broken_cycle`
 * machinery is about authored movements, which chain; a derived transfer never
 * funds another one, so none of this is a funding loop.
 *
 * It is, however, a loop **in the drawn graph**, and that is what issue #62 was:
 * `apps/web/src/components/FlowSankey.tsx` handed it to a Sankey whose depth walk
 * follows targets with no record of where it has been, and
 * `/households/:id/plan` rendered nothing whatsoever. The fix is in the drawing,
 * where the defect is — nothing below is a figure the domain should change, and
 * zeroing either transfer would be a lie about money that genuinely moves.
 *
 * Its confirmations are emptied rather than inherited: a confirmation is a
 * relationship to a *derived figure* (see `ESTATE_CONFIRMATION_SHAPES`), and this
 * input derives a different set of transfers from the one those figures were
 * hand-set against.
 */
export const estateThatFundsBothWays: ScopeInput = {
  ...estate.scope,
  accounts: estate.scope.accounts.map((a): ScopeAccountInput => {
    if (a.accountId === "acc-alice-current") {
      return {
        ...a,
        payments: [
          {
            id: "pay-broadband",
            name: "Broadband",
            category: "monthly_recurring",
            amountMinor: 6_000,
            scope: "shared",
            priority: 30,
          },
        ],
      };
    }
    if (a.accountId === "acc-bob-current") {
      return {
        ...a,
        payments: [
          {
            id: "pay-bob-council",
            name: "Council tax (bob's)",
            category: "monthly_recurring",
            amountMinor: 20_000,
            scope: "shared",
            priority: 30,
          },
        ],
      };
    }
    return a;
  }),
  confirmedTransfers: [],
};

/**
 * The two directions that must both come out of `estateThatFundsBothWays`, and
 * the fact about them that matters.
 *
 * In the tradition of `ESTATE_CONFIRMATION_SHAPES`: the intent a figure cannot
 * state for itself. A fixture built to carry a loop is worth nothing the day the
 * pass stops deriving one — self-funding netting could absorb a share, a
 * priority could reorder, a member's source could move — and the failure mode is
 * silent, because a graph with no loop in it passes every test that a graph with
 * one is supposed to. So the loop is asserted, not assumed.
 */
export const ESTATE_MUTUAL_FUNDING: readonly {
  fromAccountId: string;
  toAccountId: string;
  memberUserId: string;
  /** What must move, once each member's own income has covered its own share. */
  amountMinor: number;
}[] = [
  // Alice's 66% of the £200 council tax that leaves bob's account.
  {
    fromAccountId: "acc-alice-current",
    toAccountId: "acc-bob-current",
    memberUserId: "u-alice",
    amountMinor: 13_200,
  },
  // Bob's 34% of the £60 broadband that leaves alice's.
  {
    fromAccountId: "acc-bob-current",
    toAccountId: "acc-alice-current",
    memberUserId: "u-bob",
    amountMinor: 2_040,
  },
];

export const estateWithoutSharedIncome: ScopeInput = {
  ...estate.scope,
  accounts: estate.scope.accounts.map((a): ScopeAccountInput =>
    a.role === "shared" ? { ...a, incomes: [] } : a,
  ),
  confirmedTransfers: [
    {
      fromAccountId: "acc-alice-current",
      toAccountId: "acc-house-pot",
      memberUserId: "u-alice",
      confirmedMinor: 59_400,
    },
    {
      fromAccountId: "acc-alice-current",
      toAccountId: "acc-alice-bills",
      memberUserId: "u-alice",
      confirmedMinor: 3_000,
    },
  ],
};
