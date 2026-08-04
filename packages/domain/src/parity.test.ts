import { describe, expect, it } from "vitest";
import { computeEstatePlan } from "./estate.js";
import { flowFromEstate, type FlowScopeAccount } from "./flow.js";
import { computeHouseholdPlan, type HouseholdInput } from "./household.js";
import type { AccountInput, IncomeInput, OutboundInflowInput, PaymentInput } from "./types.js";

/**
 * The specification, written before the engine that satisfies it.
 *
 * > One account, three surfaces, one number.
 *
 * A user opens the household page and reads what one of their accounts has left
 * this month. They open the flow diagram over the same account and read a
 * different figure. Both screens describe the same month of the same account,
 * and they disagree — measured in a browser at **£2,793 against £2,093**, one
 * £700/month authored movement apart (ONE-ENGINE.md, "The defect that forced
 * this").
 *
 * Neither engine has a bug. There are two of them.
 *
 *   - `computeHouseholdPlan` derives an account's residual as
 *     `income + transferIn − transferOut − fundedOutflow` (`household.ts:420`),
 *     and `HouseholdAccountInput` carries `incomes` and `payments` and nothing
 *     else (`household.ts:38-48`). A household plan therefore has **no term at
 *     all** for money the user authored *out* of one of its accounts.
 *   - `computeEstatePlan` funds exactly those authored movements, per sending
 *     account, after the bills; `flowFromEstate` draws them as ribbons leaving
 *     and subtracts them from the node's residual (`flow.ts:243`).
 *
 * `flow.ts:119-127` calls the two derivations "disjoint by construction". For
 * an account inside a household with a standing order out of it they are not
 * disjoint at all — they are two answers to one question. This file is the
 * executable statement that they must be one answer.
 *
 * ## Red on purpose
 *
 * Landed as `it.fails`. Vitest passes a `fails` test while its body throws and
 * fails it the moment the body stops throwing, so this file is green in CI
 * today — with the disagreement recorded in the tree rather than remembered —
 * and goes red, unprompted, the moment one funding pass makes the three figures
 * agree. Nobody has to notice; the marker forces the flip to a plain `it`,
 * which is WP-S's acceptance.
 *
 * Written after the fix this would be a regression test. Written first and seen
 * red, it is the specification.
 *
 * ## Observed at `d25680e`
 *
 *     householdPage: 230_000   (£2,300)   ← the odd one out
 *     flowDiagram:   160_000   (£1,600)
 *     accountPage:   160_000   (£1,600)
 *
 * The fixture's own £700 apart, for the same reason production's £2,793 and
 * £2,093 were: the household plan cannot see the standing order.
 */

const ASOF = "2026-08-04";

/** The account all three surfaces are asked about. */
const ACCOUNT = "alex-current";

/**
 * What every surface owes the user for that account.
 *
 * £3,500 of salary arrives, £1,200 of rent leaves, £700 a month is committed to
 * the ISA: £1,600 is free. There is nothing to reconcile here — it is one
 * account's arithmetic, and any surface reporting something else is reporting a
 * month that did not happen.
 */
const FREE_AFTER_COMMITTED_MINOR = 160_000;

const salary = (id: string, amountMinor: number): IncomeInput => ({
  id,
  amountMinor,
  frequency: "monthly",
  recurrence: null,
  anchorDate: "2026-08-25",
  active: true,
});

const bill = (id: string, amountMinor: number, priority: number): PaymentInput => ({
  id,
  name: id,
  category: "monthly_recurring",
  amountMinor,
  dueDate: null,
  recurrence: null,
  targetDate: null,
  priority,
  alreadySavedMinor: 0,
  autoRenew: true,
  active: true,
});

/** The leaving face of the standing order — the face the engine funds. */
const leaving = (
  id: string,
  amountMinor: number,
  toAccountId: string,
  priority: number,
): OutboundInflowInput => ({
  id,
  toAccountId,
  amountMinor,
  frequency: "monthly",
  recurrence: null,
  anchorDate: "2026-08-25",
  active: true,
  priority,
});

// One salary, one bill, one standing order — built once and handed to both
// engines, so the two can never be found to be planning different months of
// different accounts. The only thing added on the household side is the
// household's own classification of the bill.
const SALARY = salary("alex-salary", 350_000);
const RENT = bill("rent", 120_000, 1);
const TO_ISA = leaving("alex-isa", 70_000, "isa", 10);

/**
 * The estate as the ordered pass is handed it — the shape `apps/api/src/plan.ts`
 * builds for `/api/flow` and for the account page alike.
 *
 * The ISA is deliberately **outside** the household: "a household plan cannot
 * see money leaving one of its accounts to an account outside the household" is
 * the defect verbatim, and an ISA is where a standing order out of a current
 * account actually goes.
 */
function estateAccounts(): AccountInput[] {
  return [
    {
      accountId: ACCOUNT,
      currency: "GBP",
      incomes: [SALARY],
      payments: [RENT],
      outboundInflows: [TO_ISA],
    },
    { accountId: "isa", currency: "GBP", incomes: [], payments: [] },
  ];
}

/** The scope the diagram is drawn over: the account and where its money goes. */
const SCOPE: FlowScopeAccount[] = [
  { accountId: ACCOUNT, name: "current" },
  { accountId: "isa", name: "isa" },
];

/**
 * The same account, inside the household it belongs to.
 *
 * Two members, because a household of one is a degenerate case and the defect
 * must not be able to hide behind that. Bob is otherwise inert: **no shared
 * account and no shared payment anywhere**, so the household derives no
 * transfers at all and no money crosses an account boundary except the one
 * authored movement. That is the point of the fixture — whatever gap the three
 * figures show is that movement, and nothing else is available to explain it.
 */
function household(): HouseholdInput {
  return {
    householdId: "h-parity",
    currency: "GBP",
    members: [
      { userId: "alex", displayName: "Alex", shareBp: 6000 },
      { userId: "bob", displayName: "Bob", shareBp: 4000 },
    ],
    accounts: [
      {
        accountId: ACCOUNT,
        name: "current",
        role: "personal",
        memberUserId: "alex",
        currency: "GBP",
        incomes: [SALARY],
        payments: [{ ...RENT, scope: "personal", bearerUserId: "alex" }],
      },
      {
        accountId: "bob-current",
        name: "bob's current",
        role: "personal",
        memberUserId: "bob",
        currency: "GBP",
        incomes: [salary("bob-salary", 240_000)],
        payments: [{ ...bill("bob rent", 90_000, 1), scope: "personal", bearerUserId: "bob" }],
      },
    ],
  };
}

describe("one account, planned twice", () => {
  /**
   * Every figure below is the engine's own. Nothing here re-derives funding:
   * `computeHouseholdPlan`, `computeEstatePlan` (which is what actually runs
   * `computeAccountPlan` in production) and `flowFromEstate` are all called,
   * and all three live in this package.
   */
  it.fails("agrees, to the penny, on what it has left", () => {
    const estate = computeEstatePlan(estateAccounts(), ASOF);
    const flow = flowFromEstate(estate, SCOPE, "GBP");
    const plan = computeHouseholdPlan(household(), ASOF);

    // 1. The household page. `HouseholdAccountPlan.leftoverMinor` is the figure
    //    printed in the account's "left over" column (`HouseholdPlanView.tsx:129`)
    //    and — per `apps/web/src/lib/flow.ts:24` — is claimed to *already be*
    //    the residual `income + in − out − spending`, which is why a household
    //    preset is allowed to draw the diagram straight from it. So this is not
    //    an approximation of the flow's number; it is asserted to be the same
    //    number by the code that maps one onto the other.
    const householdAccount = plan.accounts.find((a) => a.accountId === ACCOUNT)!;
    // The household plan publishes no term for money leaving on an authored
    // movement — there is no field on `HouseholdAccountPlan` to subtract, and
    // that absence *is* the defect. Written as an explicit zero rather than
    // left out, so that when decision 13's `committedMinor` lands the line to
    // change is visible instead of implied.
    const householdCommittedMinor = 0;
    const householdPage = householdAccount.leftoverMinor - householdCommittedMinor;

    // 2. The flow diagram. `FlowAccount.leftoverMinor` is the residual the
    //    Sankey draws as the "stays put" ribbon (`FlowSankey.tsx:193`), net of
    //    everything leaving by construction. It is what `/api/flow` returns for
    //    a set of accounts, which is the screen production's £2,093 was read on.
    const flowDiagram = flow.accounts.find((a) => a.accountId === ACCOUNT)!.leftoverMinor;

    // 3. The account page. `AccountPlan.leftoverMinor` is deliberately the
    //    account's surplus *before* its movements leave — a correct choice, and
    //    the one the estate rollup depends on, so this must not be asserted
    //    against raw. The account's free money is leftover minus what is
    //    committed to leave, which is the very arithmetic the account page
    //    spells out to the user in `AccountMovements.tsx`'s `outboundNote`.
    //    Decision 13 names this term `committedMinor`; today it is published as
    //    `outboundInflowMinor`.
    const accountPlan = estate.plans.find((p) => p.accountId === ACCOUNT)!;
    const accountPage = accountPlan.leftoverMinor - accountPlan.outboundInflowMinor;

    // Compared in one assertion so a failure names all three at once, and
    // against the arithmetic truth rather than against each other: three
    // surfaces agreeing on a wrong number would satisfy mutual equality.
    expect({ householdPage, flowDiagram, accountPage }).toEqual({
      householdPage: FREE_AFTER_COMMITTED_MINOR,
      flowDiagram: FREE_AFTER_COMMITTED_MINOR,
      accountPage: FREE_AFTER_COMMITTED_MINOR,
    });
  });
});
