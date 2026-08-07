import { describe, expect, it } from "vitest";
import { accountPlanFromScope } from "./engine.js";
import { flowFromScope, type FlowScopeAccount } from "./flow.js";
import { householdPlanFromScope } from "./household.js";
import { computeScopePlan, type ScopeAccountInput, type ScopeInput } from "./scope.js";
import type { OutboundInflowInput, PaymentInput } from "./types.js";

/**
 * The specification, written before the engine that satisfies it.
 *
 * > One account, three surfaces, one number.
 *
 * A user opens the household page and reads what one of their accounts has left
 * this month. They open the flow diagram over the same account and read a
 * different figure. Both screens describe the same month of the same account,
 * and they disagreed — measured in a browser at **£2,793 against £2,093**, one
 * £700/month authored movement apart (ONE-ENGINE.md, "The defect that forced
 * this").
 *
 * Neither engine had a bug. There were two of them.
 *
 *   - `computeHouseholdPlan` derived an account's residual as
 *     `income + transferIn − transferOut − fundedOutflow` (`household.ts:420`),
 *     and `HouseholdAccountInput` carried `incomes` and `payments` and nothing
 *     else (`household.ts:38-48`). A household plan therefore had **no term at
 *     all** for money the user authored *out* of one of its accounts.
 *   - `computeEstatePlan` funded exactly those authored movements, per sending
 *     account, after the bills; `flowFromEstate` drew them as ribbons leaving
 *     and subtracted them from the node's residual (`flow.ts:243`).
 *
 * `flow.ts:119-127` called the two derivations "disjoint by construction". For
 * an account inside a household with a standing order out of it they were not
 * disjoint at all — they were two answers to one question. This file is the
 * executable statement that they must be one answer.
 *
 * ## Red first, then green
 *
 * Landed by WP-O as `it.fails` and observed to fail at `d25680e`:
 *
 *     householdPage: 230_000   (£2,300)   ← the odd one out
 *     flowDiagram:   160_000   (£1,600)
 *     accountPage:   160_000   (£1,600)
 *
 * The fixture's own £700 apart, for the same reason production's £2,793 and
 * £2,093 were: the household plan could not see the standing order.
 *
 * WP-S flipped it to a plain `it`, and the assertion below is unchanged from the
 * one that failed. What changed underneath it is that there is now one funding
 * pass and all three figures are views of it: `householdPlanFromScope`,
 * `flowFromScope` and `accountPlanFromScope`, each reading the same
 * `computeScopePlan`. It still bites — replace the household view's
 * `committedMinor` term with the zero the old engine published and this file goes
 * red at `householdPage: 230_000`, which is exactly the failure it was written to
 * catch.
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

const salary = (id: string, amountMinor: number) => ({
  id,
  amountMinor,
  frequency: "monthly" as const,
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

/** The leaving face of the standing order — the face the pass funds. */
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

const SALARY = salary("alex-salary", 350_000);
const RENT = bill("rent", 120_000, 1);
const TO_ISA = leaving("alex-isa", 70_000, "isa", 10);

/** The household's roster: the two accounts assigned to it, and no more. */
const HOUSEHOLD_ACCOUNTS = [ACCOUNT, "bob-current"];

/** The scope the diagram is drawn over: the account and where its money goes. */
const SCOPE: FlowScopeAccount[] = [
  { accountId: ACCOUNT, name: "current" },
  { accountId: "isa", name: "isa" },
];

/**
 * One scope, handed once to the one pass — which is the whole point.
 *
 * Two members, because a household of one is a degenerate case and the defect
 * must not be able to hide behind that. Bob is otherwise inert: **no shared
 * account and no shared payment anywhere**, so the pass derives no transfers at
 * all and no money crosses an account boundary except the one authored movement.
 * Whatever gap the three figures show is that movement, and nothing else is
 * available to explain it.
 *
 * The ISA is deliberately **outside** the household — "a household plan cannot
 * see money leaving one of its accounts to an account outside the household" is
 * the defect verbatim, and an ISA is where a standing order out of a current
 * account actually goes. It is inside the *scope*, because the API's loader
 * closes over funding edges in both directions: a scope is what money can reach,
 * and a household is a roster within it.
 */
function scope(): ScopeInput {
  const accounts: ScopeAccountInput[] = [
    {
      accountId: ACCOUNT,
      name: "current",
      role: "personal",
      memberUserId: "alex",
      ownerUserId: "alex",
      currency: "GBP",
      incomes: [SALARY],
      payments: [{ ...RENT, scope: "personal", bearerUserId: "alex" }],
      outboundInflows: [TO_ISA],
    },
    {
      accountId: "bob-current",
      name: "bob's current",
      role: "personal",
      memberUserId: "bob",
      ownerUserId: "bob",
      currency: "GBP",
      incomes: [salary("bob-salary", 240_000)],
      payments: [{ ...bill("bob rent", 90_000, 1), scope: "personal", bearerUserId: "bob" }],
    },
    {
      accountId: "isa",
      name: "isa",
      role: "personal",
      memberUserId: "alex",
      ownerUserId: "alex",
      currency: "GBP",
      incomes: [],
      payments: [],
    },
  ];
  return {
    scopeId: "h-parity",
    householdId: "h-parity",
    members: [
      { userId: "alex", displayName: "Alex", shareBp: 6000 },
      { userId: "bob", displayName: "Bob", shareBp: 4000 },
    ],
    accounts,
  };
}

describe("one account, planned once", () => {
  /**
   * Every figure below is the pass's own. Nothing here re-derives funding: one
   * `computeScopePlan`, three views of it, all four in this package.
   */
  it("agrees, to the penny, on what it has left", () => {
    const input = scope();
    const pass = computeScopePlan(input, ASOF);
    const household = householdPlanFromScope(pass, "h-parity", HOUSEHOLD_ACCOUNTS, "GBP");
    const flow = flowFromScope(pass, SCOPE, "GBP");
    const plan = accountPlanFromScope(input, pass, ACCOUNT);

    // 1. The household page. `HouseholdAccountPlan.leftoverMinor` is the figure
    //    printed in the account's "left over" column (`HouseholdPlanView.tsx:129`)
    //    and — per `apps/web/src/lib/flow.ts:24` — is claimed to *already be*
    //    the residual `income + in − out − spending`, which is why a household
    //    preset is allowed to draw the diagram straight from it. So this is not
    //    an approximation of the flow's number; it is asserted to be the same
    //    number by the code that maps one onto the other.
    const householdAccount = household.accounts.find((a) => a.accountId === ACCOUNT)!;
    // The term the old household plan had no field for. Decision 13 names it
    // `committedMinor` and publishes it alongside `leftoverMinor`, whose meaning
    // is unchanged — so the line WP-O wrote as an explicit zero is the one line
    // that had to change, and this is it.
    const householdCommittedMinor = householdAccount.committedMinor;
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
    //    Decision 13 names this term `committedMinor`; it is published here as
    //    `outboundInflowMinor`.
    const accountPage = plan.leftoverMinor - plan.outboundInflowMinor;

    // Compared in one assertion so a failure names all three at once, and
    // against the arithmetic truth rather than against each other: three
    // surfaces agreeing on a wrong number would satisfy mutual equality.
    expect({ householdPage, flowDiagram, accountPage }).toEqual({
      householdPage: FREE_AFTER_COMMITTED_MINOR,
      flowDiagram: FREE_AFTER_COMMITTED_MINOR,
      accountPage: FREE_AFTER_COMMITTED_MINOR,
    });
  });

  /**
   * The pass's own residual, straight off `ScopeAccountPlan`, so the three views
   * above cannot all be reading the same field twice by accident: each of them
   * arrives at £1,600 by a different route, and this is the fourth.
   */
  it("puts the same figure on the pass itself", () => {
    const pass = computeScopePlan(scope(), ASOF);
    const account = pass.accounts.find((a) => a.accountId === ACCOUNT)!;
    expect(account.leftoverMinor).toBe(FREE_AFTER_COMMITTED_MINOR);
    expect(account.committedMinor).toBe(70_000);
    // And the movement really is funded — a fixture where the standing order
    // moved nothing would agree on £2,300 and prove nothing at all.
    expect(pass.movements.map((m) => [m.inflowId, m.fundedMinor, m.status])).toEqual([
      ["alex-isa", 70_000, "funded"],
    ]);
  });
});

/**
 * The **receiving** end, which this file had never asked about.
 *
 * Everything above is the sending account, and the ISA it sends to is
 * deliberately outside the household — so no surface here has ever reported an
 * account that an authored movement *arrives* at. Every household fixture in the
 * package has the same hole from the other side: each feeds its pot with a
 * **derived transfer**, which is the one case the code got right.
 *
 * The gap that leaves is the defect Ben read off one screen: the household plan
 * page drew `holiday · £500.00` arriving into the pot and printed **LEFT OVER
 * £0.00** for the same account on the same date, because `HouseholdSankey` asks
 * `/api/flow` and the table beside it reads the plan. A node the chart shows
 * holding £500 and the table beside it shows holding nothing is the same class
 * of defect WP-O caught at the sender: one account, two surfaces, two numbers.
 *
 * `householdPlanFromScope` had a term for the arrival — it publishes
 * `movementInMinor: 50_000` — and no term for it in the residual it published
 * beside it. **The record existed and the event never landed.**
 */
describe("the account an authored movement arrives at", () => {
  /** The pot on the real screen, and its amount. */
  const POT = "holiday";
  const ARRIVED_MINOR = 50_000;

  /**
   * What every surface owes the user for the pot.
   *
   * Nothing else reaches it and nothing leaves it: £500 arrived, £500 is there.
   * A surface reporting anything else is reporting a month in which the money
   * left one account and reached none.
   */
  const IN_THE_POT_MINOR = ARRIVED_MINOR;

  /**
   * The pot is **on the roster**, which is the shape nothing in this repository
   * has. `parity.test.ts`'s ISA is off it by design and every household fixture
   * feeds its pot by a derived transfer, so no test in the tree has ever had a
   * household account whose money arrived by a movement somebody authored.
   */
  const ROSTER = [ACCOUNT, "bob-current", POT];
  const POT_SCOPE: FlowScopeAccount[] = [
    { accountId: ACCOUNT, name: "current" },
    { accountId: POT, name: "holiday" },
  ];

  function potScope(): ScopeInput {
    const base = scope();
    return {
      ...base,
      accounts: base.accounts.map((a): ScopeAccountInput => {
        if (a.accountId === ACCOUNT) {
          return { ...a, outboundInflows: [leaving("alex-holiday", ARRIVED_MINOR, POT, 10)] };
        }
        if (a.accountId === "isa") {
          return { ...a, accountId: POT, name: "holiday", role: "shared", memberUserId: null };
        }
        return a;
      }),
    };
  }

  it("agrees, to the penny, on what is in it", () => {
    const input = potScope();
    const pass = computeScopePlan(input, ASOF);
    const household = householdPlanFromScope(pass, "h-parity", ROSTER, "GBP");
    const flow = flowFromScope(pass, POT_SCOPE, "GBP");
    const plan = accountPlanFromScope(input, pass, POT);

    // 1. The household page's LEFT OVER cell — `freeMinor` in
    //    `HouseholdPlanView.tsx`, which is `leftoverMinor − committedMinor` and
    //    is documented there as "the number the account page and the flow
    //    diagram print for the same account".
    const potRow = household.accounts.find((a) => a.accountId === POT)!;
    const householdPage = potRow.leftoverMinor - potRow.committedMinor;

    // 2. The flow diagram — the figure `/api/flow` returns and the Sankey draws
    //    beside that very table on the household plan page.
    const flowDiagram = flow.accounts.find((a) => a.accountId === POT)!.leftoverMinor;

    // 3. The account page. `AccountPlan.leftoverMinor` is the account's *own*
    //    income after its own obligations and is £0 here, correctly — the pot
    //    earns nothing. `residualMinor` is the figure for "what is in it", and
    //    is the one to compare.
    const accountPage = plan.residualMinor;

    expect({ householdPage, flowDiagram, accountPage }).toEqual({
      householdPage: IN_THE_POT_MINOR,
      flowDiagram: IN_THE_POT_MINOR,
      accountPage: IN_THE_POT_MINOR,
    });
  });

  it("records the arrival on the very row that has to apply it", () => {
    const pass = computeScopePlan(potScope(), ASOF);
    const household = householdPlanFromScope(pass, "h-parity", ROSTER, "GBP");
    const potRow = household.accounts.find((a) => a.accountId === POT)!;

    // The movement really is funded — a fixture whose standing order moved
    // nothing would agree on £0 everywhere and prove nothing at all.
    expect(pass.movements.map((m) => [m.inflowId, m.fundedMinor, m.status])).toEqual([
      ["alex-holiday", ARRIVED_MINOR, "funded"],
    ]);
    // The record, and the residual that has to contain it. These two sat on one
    // object, disagreeing, and the household page printed both.
    expect(potRow.movementInMinor).toBe(ARRIVED_MINOR);
    expect(potRow.leftoverMinor).toBe(ARRIVED_MINOR);

    // And the household's own published identity, which names `movementInMinor`
    // as a term (`household.ts`'s `householdLeftoverMinor` comment). It held
    // over every fixture in the package only because none of them put a
    // movement's destination on the roster.
    const ribbons =
      household.monthlyIncomeMinor +
      household.accounts.reduce((s, a) => s + a.transferInMinor + a.movementInMinor, 0) -
      household.accounts.reduce((s, a) => s + a.fundedOutflowMinor + a.transferOutMinor, 0);
    expect(household.householdLeftoverMinor).toBe(ribbons);
  });
});
