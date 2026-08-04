import { MemoryStore, type Account, type Store } from "@finance-planner/data";
import { beforeEach, describe, expect, it } from "vitest";
import {
  computePlanForAccount,
  createPlanContext,
  inflowSourcesFor,
  scopeForAccount,
  scopesFor,
} from "./plan.js";

/**
 * The orchestration, through a real store: **one scope loader, one pass**.
 *
 * The API used to build two inputs from two loaders — `buildHouseholdInput` for
 * the household engine and `loadAccountInput` for the account engine — and the
 * two could only agree by coincidence. There is one loader now. It seeds from
 * the accounts asked about and closes over household assignment *and* funding
 * edges in both directions, so the set of accounts planned together is a
 * property of the accounts rather than of the question asked about them.
 */

const ASOF = "2026-08-04";

let store: Store;

beforeEach(() => {
  store = new MemoryStore();
});

async function seedUser(email = "owner@example.com") {
  const user = await store.createUser({ email, passwordHash: null, displayName: "Owner" });
  return user.id;
}

const account = (userId: string, name: string): Promise<Account> =>
  store.createAccount({ ownerUserId: userId, name, currency: "GBP" });

const salary = (target: Account, amountMinor: number) =>
  store.createIncome({
    accountId: target.id,
    name: "Salary",
    amountMinor,
    frequency: "monthly",
    recurrence: null,
    anchorDate: "2026-08-25",
    active: true,
  });

const movement = (from: Account, to: Account, amountMinor: number, priority = 50) =>
  store.createInflow({
    accountId: to.id,
    name: `into ${to.name}`,
    source: "account",
    sourceAccountId: from.id,
    amountMinor,
    frequency: "monthly",
    recurrence: null,
    anchorDate: "2026-08-25",
    priority,
    active: true,
  });

const bill = (target: Account, name: string, amountMinor: number, priority = 1) =>
  store.createPayment({
    accountId: target.id,
    name,
    category: "monthly_recurring",
    amountMinor,
    dueDate: null,
    recurrence: null,
    targetDate: null,
    priority,
    alreadySavedMinor: 0,
    autoRenew: true,
    active: true,
    notes: null,
    projectId: null,
    scope: "shared",
    bearerUserId: null,
    fixedMonthlyMinor: null,
    tag: null,
  });

describe("computePlanForAccount — a pot with no income feeds itself", () => {
  /**
   * WP-S's acceptance, and decision 9: an expense-bearing account with no income
   * of its own gets its feed **derived**. Nobody authors "£500 into the holiday
   * pot"; the plan says what the bills cost and who has to move it.
   */
  it("derives a transfer for a standalone pot, with no authored row anywhere", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Holiday pot");
    await salary(current, 300_000);
    await bill(pot, "Holiday", 50_000);

    expect(await store.listInflows(pot.id)).toEqual([]);

    const plan = await computePlanForAccount(store, pot, ASOF);
    expect(plan.monthlyIncomeMinor).toBe(0);
    expect(plan.allocatedInflowMinor).toBe(50_000);
    expect(plan.shortfallMinor).toBe(0);
    expect(plan.lines[0]!.onTrack).toBe(true);
    expect(plan.lines[0]!.fundedFromInflowMinor).toBe(50_000);
    // Planned but not moved: the pot is covered, and the transfer is the thing
    // left to do. `at_risk` would be the old answer, and the wrong one — the
    // money is there, it is just still in the current account.
    expect(plan.lines[0]!.status).toBe("awaiting_transfer");
    // Nothing authored it, so there is no arrival to itemise; the prompt is the
    // derived transfer, which the plan endpoint publishes as an inflow source.
    expect(plan.inflowArrivals).toEqual([]);

    const scope = await scopeForAccount(store, pot, ASOF);
    expect(inflowSourcesFor(scope, pot.id, "GBP")).toEqual([
      { memberUserId: userId, displayName: "Owner", amountMinor: 50_000, confirmedMinor: 0 },
    ]);
    // And it comes out of the sending account's own surplus, once.
    const sender = await computePlanForAccount(store, current, ASOF);
    expect(sender.leftoverMinor).toBe(250_000);
  });

  /**
   * The direction the old pin did not cover, and the bug decision 9 exists to
   * fix: a pot's rent at priority 1 must not lose to the sending account's
   * priority-99 gym membership. Both are expenses of one member, funded from one
   * budget in one order.
   */
  it("lets a pot's priority-1 bill beat the sender's priority-99 one", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Pot");
    await salary(current, 100_000);
    await bill(current, "Gym", 80_000, 99);
    await bill(pot, "Rent", 100_000, 1);

    const potPlan = await computePlanForAccount(store, pot, ASOF);
    expect(potPlan.lines[0]!.fundedMonthlyMinor).toBe(100_000);
    const senderPlan = await computePlanForAccount(store, current, ASOF);
    expect(senderPlan.lines[0]!.fundedMonthlyMinor).toBe(0);
    expect(senderPlan.shortfallMinor).toBe(80_000);
  });

  /** Decision 6, kept: savings lose to every expense, whatever they are ranked. */
  it("funds a bill before a movement that carries a better priority number", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Pot");
    await salary(current, 100_000);
    await bill(current, "Rent", 80_000, 99);
    await movement(current, pot, 100_000, 1);

    const sender = await computePlanForAccount(store, current, ASOF);
    expect(sender.lines[0]!.fundedMonthlyMinor).toBe(80_000);
    expect(sender.outboundInflowMinor).toBe(20_000);
    expect((await computePlanForAccount(store, pot, ASOF)).allocatedInflowMinor).toBe(20_000);
  });

  it("leaves an account nothing pays into exactly as it was", async () => {
    const userId = await seedUser();
    const solo = await account(userId, "Solo");
    await salary(solo, 200_000);
    await bill(solo, "Rent", 90_000);

    const plan = await computePlanForAccount(store, solo, ASOF);
    expect(plan.allocatedInflowMinor).toBe(0);
    expect(plan.outboundInflows).toEqual([]);
    expect(plan.leftoverMinor).toBe(110_000);
    expect(plan.residualMinor).toBe(110_000);
  });
});

describe("the scope loader closes over the graph in both directions", () => {
  it("plans an account with the accounts it sends to, not only those it receives from", async () => {
    // The old closure walked senders only. A downstream account is money this
    // one is committed to sending, and — since a scope fixes how a member's
    // income is attributed — two endpoints closing over different sets would
    // print two figures for one account. That is the defect, one level up.
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const isa = await account(userId, "ISA");
    await salary(current, 200_000);
    await movement(current, isa, 50_000);

    const fromSender = await scopeForAccount(store, current, ASOF);
    const fromReceiver = await scopeForAccount(store, isa, ASOF);
    expect([...fromSender.accountIds].sort()).toEqual([current.id, isa.id].sort());
    expect(fromSender.accountIds).toEqual(fromReceiver.accountIds);
  });

  it("plans an account with its household, and its household with it", async () => {
    const alice = await seedUser("alice@example.com");
    const bobId = await seedUser("bob@example.com");
    const household = await store.createHousehold("Home", alice);
    await store.addMembership(household.id, bobId, "member");
    const aliceCur = await account(alice, "Alice current");
    const bobCur = await account(bobId, "Bob current");
    const bills = await account(alice, "Bills");
    for (const [acc, role, member] of [
      [aliceCur, "personal", alice],
      [bobCur, "personal", bobId],
      [bills, "shared", null],
    ] as const) {
      await store.upsertAccountAssignment({
        householdId: household.id,
        accountId: acc.id,
        role,
        memberUserId: member,
      });
    }
    await salary(aliceCur, 300_000);
    await salary(bobCur, 200_000);
    await bill(bills, "Rent", 100_000);

    const scope = await scopeForAccount(store, bills, ASOF);
    expect([...scope.accountIds].sort()).toEqual([aliceCur.id, bobCur.id, bills.id].sort());
    expect(scope.input.householdId).toBe(household.id);
    // 50/50 by default, and each member's slice arrives from their own account.
    expect(inflowSourcesFor(scope, bills.id, "GBP").map((s) => s.amountMinor)).toEqual([
      50_000, 50_000,
    ]);
  });

  it("keeps two unconnected scopes apart rather than pooling their members", async () => {
    const alice = await seedUser("alice@example.com");
    const bobId = await seedUser("bob@example.com");
    const mine = await account(alice, "Mine");
    const theirs = await account(bobId, "Theirs");
    await salary(mine, 100_000);
    await salary(theirs, 100_000);

    const scopes = await scopesFor(store, [mine, theirs], ASOF);
    expect(scopes).toHaveLength(2);
    expect(scopes.map((s) => s.input.members.map((m) => m.userId))).toEqual([[alice], [bobId]]);
  });

  it("bears an unassigned account's payments itself rather than sharing them out", async () => {
    // `Payment.scope` defaults to "shared", which meant nothing while an
    // unassigned account was planned alone. Sharing a bill with somebody who
    // merely sends money into the account would be a cost they never agreed to.
    const alice = await seedUser("alice@example.com");
    const bobId = await seedUser("bob@example.com");
    const theirs = await account(bobId, "Theirs");
    const myPot = await account(alice, "My pot");
    await salary(theirs, 300_000);
    await bill(myPot, "Council tax", 15_000);
    await movement(theirs, myPot, 20_000);

    const plan = await computePlanForAccount(store, myPot, ASOF);
    // Bob sends £200 of savings and pays for nothing: the bill is mine, and I
    // have no income, so it is short.
    expect(plan.allocatedInflowMinor).toBe(20_000);
    expect(plan.shortfallMinor).toBe(15_000);
  });
});

describe("computePlanForAccount — chains and loops", () => {
  async function chain() {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Pot");
    const isa = await account(userId, "ISA");
    await salary(current, 500_000);
    await bill(current, "Rent", 100_000);
    await bill(pot, "Bills", 100_000);
    await bill(isa, "Stocks", 300_000);
    await movement(current, pot, 300_000);
    await movement(pot, isa, 200_000);
    return { userId, current, pot, isa };
  }

  it("carries money three accounts deep in one pass", async () => {
    const { current, pot, isa } = await chain();
    const ctx = createPlanContext();
    const [currentPlan, potPlan, isaPlan] = await Promise.all([
      computePlanForAccount(store, current, ASOF, ctx),
      computePlanForAccount(store, pot, ASOF, ctx),
      computePlanForAccount(store, isa, ASOF, ctx),
    ]);

    // £5,000 of income against £5,000 of bills, all of them the one owner's:
    // the transfers the pass derives cover the pot and £300 of the ISA's goal,
    // and there is nothing left for the authored movements to carry.
    expect(currentPlan.leftoverMinor).toBe(0);
    expect(currentPlan.outboundInflowMinor).toBe(0);
    expect(potPlan.allocatedInflowMinor).toBe(100_000);
    expect(potPlan.shortfallMinor).toBe(0);
    expect(isaPlan.allocatedInflowMinor).toBe(300_000);
    expect(isaPlan.shortfallMinor).toBe(0);
  });

  it("gives the same answer whether or not the callers share a memo", async () => {
    const { pot } = await chain();
    const shared = await computePlanForAccount(store, pot, ASOF, createPlanContext());
    const alone = await computePlanForAccount(store, pot, ASOF);
    expect(JSON.stringify(shared)).toBe(JSON.stringify(alone));
  });

  it("reports a loop on the plan itself, rather than hanging", async () => {
    const userId = await seedUser();
    const a = await account(userId, "A");
    const b = await account(userId, "B");
    const c = await account(userId, "C");
    await salary(a, 100_000);
    await movement(a, b, 50_000);
    await movement(b, c, 50_000);
    await movement(c, a, 50_000);

    const plan = await computePlanForAccount(store, c, ASOF);
    // Named, so a UI can say which accounts fund each other in a circle.
    expect(plan.fundingCycleAccountIds).toHaveLength(3);
    expect([...plan.fundingCycleAccountIds!].sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it("walks a loop from every account in it without looping", async () => {
    const userId = await seedUser();
    const x = await account(userId, "X");
    const y = await account(userId, "Y");
    await salary(x, 100_000);
    await movement(x, y, 40_000);
    await movement(y, x, 40_000);

    for (const target of [x, y]) {
      const plan = await computePlanForAccount(store, target, ASOF);
      expect(plan.fundingCycleAccountIds).toHaveLength(2);
    }
  });

  it("ignores a movement out of an account that no longer exists", async () => {
    const userId = await seedUser();
    const pot = await account(userId, "Pot");
    const gone = await account(userId, "Gone");
    await bill(pot, "Saving", 10_000);
    await movement(gone, pot, 10_000);
    await store.deleteAccount(gone.id);

    const plan = await computePlanForAccount(store, pot, ASOF);
    expect(plan.allocatedInflowMinor).toBe(0);
    expect(plan.shortfallMinor).toBe(10_000);
  });
});

describe("the scope loader — what has actually moved", () => {
  const MONTH = "2026-08-01";

  async function movedPair() {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Pot");
    await salary(current, 100_000);
    await bill(pot, "Saving", 40_000);
    const inflow = await movement(current, pot, 40_000);
    return { userId, current, pot, inflow };
  }

  it("reads a derived feed's confirmation, so it is not awaiting for ever", async () => {
    const { userId, current, pot } = await movedPair();
    // Before anyone says it moved: the bill is covered by the derived feed and
    // the transfer is the outstanding thing.
    expect((await computePlanForAccount(store, pot, ASOF)).lines[0]!.status).toBe(
      "awaiting_transfer",
    );

    // The shape 0010 made storable: no household, no inflow, scoped by the two
    // accounts, the month and the member.
    await store.createTransferConfirmation({
      householdId: null,
      inflowId: null,
      month: MONTH,
      fromAccountId: current.id,
      toAccountId: pot.id,
      memberUserId: userId,
      amountMinor: 40_000,
    });
    const plan = await computePlanForAccount(store, pot, ASOF);
    expect(plan.confirmedInflowMinor).toBe(40_000);
    expect(plan.lines[0]!.status).toBe("funded");
  });

  it("clamps a derived confirmation the member can no longer afford", async () => {
    const { userId, current, pot } = await movedPair();
    await store.createTransferConfirmation({
      householdId: null,
      inflowId: null,
      month: MONTH,
      fromAccountId: current.id,
      toAccountId: pot.id,
      memberUserId: userId,
      amountMinor: 40_000,
    });
    // A rent bill lands, and it outranks the pot's saving: only £100 of the
    // month's budget reaches the pot, so only £100 can be credited as arrived.
    await bill(current, "Rent", 90_000, 0);

    const scope = await scopeForAccount(store, pot, ASOF);
    expect(inflowSourcesFor(scope, pot.id, "GBP")).toEqual([
      { memberUserId: userId, displayName: "Owner", amountMinor: 10_000, confirmedMinor: 10_000 },
    ]);
  });

  it("reports an authored movement's confirmation on the arrival it delivered", async () => {
    const { userId, current, pot, inflow } = await movedPair();
    await store.createTransferConfirmation({
      householdId: null,
      inflowId: inflow.id,
      month: MONTH,
      fromAccountId: current.id,
      toAccountId: pot.id,
      memberUserId: userId,
      amountMinor: 40_000,
    });
    const plan = await computePlanForAccount(store, pot, ASOF);
    // £400 of derived feed for the bill, plus the £400 the movement authored —
    // both arriving, neither netted against the other (decision 12).
    expect(plan.allocatedInflowMinor).toBe(80_000);
    expect(plan.inflowArrivals).toEqual([
      {
        inflowId: inflow.id,
        fromAccountId: current.id,
        amountMinor: 40_000,
        confirmedMinor: 40_000,
      },
    ]);
  });

  it("does not credit money confirmed as leaving an account to that account", async () => {
    const { userId, current, pot, inflow } = await movedPair();
    await store.createTransferConfirmation({
      householdId: null,
      inflowId: inflow.id,
      month: MONTH,
      fromAccountId: current.id,
      toAccountId: pot.id,
      memberUserId: userId,
      amountMinor: 40_000,
    });
    // The same row read from the sending end. It says money left, which is no
    // reason to think any arrived.
    const sender = await computePlanForAccount(store, current, ASOF);
    expect(sender.allocatedInflowMinor).toBe(0);
    expect(sender.confirmedInflowMinor).toBe(0);
  });

  it("asks nothing of the store about authored arrivals for an account nothing moves into", async () => {
    const userId = await seedUser();
    const solo = await account(userId, "Solo");
    await salary(solo, 100_000);
    let asked = 0;
    const counted = new Proxy(store, {
      get: (target, prop, receiver) => {
        if (prop === "listTransferConfirmationsForAccount") asked += 1;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const scope = await scopeForAccount(counted, solo, ASOF);
    expect(scope.input.accounts[0]!.confirmedArrivals).toEqual([]);
    expect(asked).toBe(0);
  });
});
