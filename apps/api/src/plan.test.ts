import { MemoryStore, type Account, type Store } from "@finance-planner/data";
import { computeAccountPlan } from "@finance-planner/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { buildAccountInput, computePlanForAccount, createPlanContext } from "./plan.js";

/**
 * The orchestration, through a real store: an account's plan is one slice of an
 * ordered pass over every account that funds it.
 *
 * The bug being fixed lives here rather than in the engine. Participation used
 * to come from household membership — `resolveAccountInflow` returns null for an
 * account no household plans — so a standalone pot was planned as if nothing
 * were coming into it, and reported every line at risk. Participation now comes
 * from the inflows the user authored.
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

describe("computePlanForAccount — a standalone pot is part of the plan", () => {
  it("funds a pot with no income of its own and no household anywhere", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Holiday pot");
    await salary(current, 300_000);
    await bill(pot, "Holiday", 50_000);
    await movement(current, pot, 50_000);

    const plan = await computePlanForAccount(store, pot, ASOF);
    expect(plan.monthlyIncomeMinor).toBe(0);
    expect(plan.allocatedInflowMinor).toBe(50_000);
    expect(plan.shortfallMinor).toBe(0);
    expect(plan.lines[0]!.onTrack).toBe(true);
    expect(plan.lines[0]!.fundedFromInflowMinor).toBe(50_000);
    // Planned but not moved: the pot is covered, and the transfer is the thing
    // left to do.
    expect(plan.lines[0]!.status).toBe("awaiting_transfer");
    expect(plan.inflowArrivals).toEqual([
      { inflowId: expect.any(String), fromAccountId: current.id, amountMinor: 50_000 },
    ]);
  });

  it("sends only what the sending account can spare", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Pot");
    await salary(current, 100_000);
    await bill(current, "Rent", 80_000, 99);
    await movement(current, pot, 100_000, 1);
    await bill(pot, "Saving", 100_000);

    // Decision 6: the rent is funded first, even though the movement carries the
    // better priority number.
    const sender = await computePlanForAccount(store, current, ASOF);
    expect(sender.lines[0]!.fundedMonthlyMinor).toBe(80_000);
    expect(sender.outboundInflowMinor).toBe(20_000);

    const receiver = await computePlanForAccount(store, pot, ASOF);
    expect(receiver.allocatedInflowMinor).toBe(20_000);
    expect(receiver.shortfallMinor).toBe(80_000);
  });

  it("leaves an account nothing pays into exactly as it was", async () => {
    const userId = await seedUser();
    const solo = await account(userId, "Solo");
    await salary(solo, 200_000);
    await bill(solo, "Rent", 90_000);

    const plan = await computePlanForAccount(store, solo, ASOF);
    const input = await buildAccountInput(store, solo, ASOF);
    expect(plan.allocatedInflowMinor).toBe(0);
    expect(plan.outboundInflows).toEqual([]);
    expect(plan.leftoverMinor).toBe(110_000);
    expect(JSON.stringify(plan)).toBe(JSON.stringify(computeAccountPlan(input, ASOF)));
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

    expect(currentPlan.outboundInflowMinor).toBe(300_000);
    expect(potPlan.allocatedInflowMinor).toBe(300_000);
    expect(potPlan.outboundInflowMinor).toBe(200_000);
    expect(isaPlan.allocatedInflowMinor).toBe(200_000);
    expect(isaPlan.shortfallMinor).toBe(100_000);
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

describe("buildAccountInput", () => {
  it("hands back the input the pass planned from, movements and all", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Pot");
    await salary(current, 100_000);
    await movement(current, pot, 40_000);

    const senderInput = await buildAccountInput(store, current, ASOF);
    expect(senderInput.outboundInflows).toHaveLength(1);
    expect(senderInput.outboundInflows![0]!.toAccountId).toBe(pot.id);
    expect(senderInput.inflow).toBeNull();

    const receiverInput = await buildAccountInput(store, pot, ASOF);
    expect(receiverInput.inflow).toMatchObject({ allocatedMinor: 40_000, confirmedMinor: 0 });
    expect(receiverInput.inflows).toHaveLength(1);
    expect(receiverInput.outboundInflows).toEqual([]);
  });

  it("keeps external inflows out of the movements", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    await salary(current, 100_000);
    const input = await buildAccountInput(store, current, ASOF);
    expect(input.incomes).toHaveLength(1);
    expect(input.outboundInflows).toEqual([]);
  });
});
