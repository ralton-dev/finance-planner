import { MemoryStore, type Store } from "@finance-planner/data";
import { signAccessToken } from "@finance-planner/security";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "./env.js";
import { buildServer } from "./server.js";

const env: ApiEnv = {
  port: 0,
  host: "127.0.0.1",
  jwtSecret: "test-secret",
  authUrl: "http://localhost:4001",
  mailFrom: "Finance Planner <no-reply@test.local>",
  notifyEnabled: false,
  notifyHour: 8,
  enableDemoSeed: false,
};

async function seedUser(store: Store, email = "owner@example.com") {
  const user = await store.createUser({ email, passwordHash: "x", displayName: "Owner" });
  const token = await signAccessToken(env.jwtSecret, { sub: user.id, email });
  return { user, auth: { authorization: `Bearer ${token}` } };
}

/** The current month, the way the reality-loop routes default it. */
const thisMonth = (): string => new Date().toISOString().slice(0, 7);

/**
 * A two-member household for the reality-loop tests: alice + bob on a 66/34
 * share, each with a personal current account, plus a shared bills pot holding
 * a monthly bill and a savings goal. Both members' plans therefore derive a
 * transfer into the pot each month.
 */
async function seedHousehold(store: Store, app: ReturnType<typeof buildServer>) {
  const { user: alice, auth } = await seedUser(store, "alice@example.com");
  const { user: bob, auth: bobAuth } = await seedUser(store, "bob@example.com");
  const household = await store.createHousehold("Home", alice.id);
  await store.addMembership(household.id, bob.id, "member");
  await store.updateMembershipShare(household.id, alice.id, 6600);
  await store.updateMembershipShare(household.id, bob.id, 3400);

  const make = async (name: string, incomeMinor?: number) => {
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name, currency: "GBP" },
      })
    ).json();
    if (incomeMinor) {
      await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/incomes`,
        headers: auth,
        payload: {
          name: "Pay",
          amountMinor: incomeMinor,
          frequency: "monthly",
          anchorDate: "2026-01-01",
        },
      });
    }
    return account;
  };
  const aliceCur = await make("alice-cur", 300000);
  const bobCur = await make("bob-cur", 200000);
  const bills = await make("bills");

  for (const payload of [
    { name: "Rent", category: "monthly_recurring", amountMinor: 100000, scope: "shared" },
    {
      name: "Holiday",
      category: "fixed_point",
      amountMinor: 120000,
      dueDate: "2027-08-01",
      scope: "shared",
    },
  ]) {
    await app.inject({
      method: "POST",
      url: `/api/accounts/${bills.id}/payments`,
      headers: auth,
      payload,
    });
  }

  const assign = (accountId: string, payload: object) =>
    app.inject({
      method: "PUT",
      url: `/api/households/${household.id}/accounts/${accountId}`,
      headers: auth,
      payload,
    });
  await assign(aliceCur.id, { role: "personal", memberUserId: alice.id });
  await assign(bobCur.id, { role: "personal", memberUserId: bob.id });
  await assign(bills.id, { role: "shared" });

  return { alice, bob, auth, bobAuth, household, aliceCur, bobCur, bills };
}

describe("api service", () => {
  let store: MemoryStore;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    store = new MemoryStore();
    app = buildServer({ store, env, registerAuthProxy: false });
  });

  it("health endpoint works without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.json().service).toBe("api");
  });

  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/accounts" });
    expect(res.statusCode).toBe(401);
  });

  it("creates an account and lists it for the owner", async () => {
    const { auth } = await seedUser(store);
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: auth,
      payload: { name: "Everyday", currency: "GBP", monthlyBufferMinor: 10000 },
    });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: "/api/accounts", headers: auth });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].owner).toBe(true);
  });

  it("GET /api/accounts/:id returns owner + permission for the caller", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "Everyday", currency: "GBP" },
      })
    ).json();
    const single = await app.inject({
      method: "GET",
      url: `/api/accounts/${account.id}`,
      headers: auth,
    });
    expect(single.statusCode).toBe(200);
    expect(single.json().owner).toBe(true);
    expect(single.json().permission).toBe("edit");
  });

  it("computes a plan from incomes and payments", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "A", currency: "GBP" },
      })
    ).json();

    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/incomes`,
      headers: auth,
      payload: {
        name: "Salary",
        amountMinor: 300000,
        frequency: "monthly",
        anchorDate: "2026-01-25",
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/payments`,
      headers: auth,
      payload: {
        name: "Holiday",
        category: "fixed_point",
        amountMinor: 120000,
        dueDate: "2026-09-01",
      },
    });

    const plan = (
      await app.inject({
        method: "GET",
        url: `/api/accounts/${account.id}/plan?asOf=2026-01-01`,
        headers: auth,
      })
    ).json();
    expect(plan.monthlyIncomeMinor).toBe(300000);
    expect(plan.lines[0].requiredMonthlyMinor).toBe(15000);
    expect(plan.leftoverMinor).toBe(285000);
  });

  it("rejects fixed_point payments without a due date (422)", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "A", currency: "GBP" },
      })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/payments`,
      headers: auth,
      payload: { name: "Oops", category: "fixed_point", amountMinor: 1000 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("hides accounts from users without access (404)", async () => {
    const { auth } = await seedUser(store, "owner@example.com");
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "Private", currency: "GBP" },
      })
    ).json();

    const { auth: otherAuth } = await seedUser(store, "stranger@example.com");
    const res = await app.inject({
      method: "GET",
      url: `/api/accounts/${account.id}`,
      headers: otherAuth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("shares an account with a household so members can view it", async () => {
    const { user, auth } = await seedUser(store, "owner@example.com");
    const { user: partner, auth: partnerAuth } = await seedUser(store, "partner@example.com");

    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "Joint", currency: "GBP" },
      })
    ).json();

    const household = await store.createHousehold("Home", user.id);
    await store.addMembership(household.id, partner.id, "member");

    const share = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/shares`,
      headers: auth,
      payload: { householdId: household.id, permission: "view" },
    });
    expect(share.statusCode).toBe(201);

    // Partner can now see it, but cannot edit (view permission).
    const seen = await app.inject({
      method: "GET",
      url: `/api/accounts/${account.id}`,
      headers: partnerAuth,
    });
    expect(seen.statusCode).toBe(200);
    expect(seen.json().owner).toBe(false);
    expect(seen.json().permission).toBe("view");

    const edit = await app.inject({
      method: "PATCH",
      url: `/api/accounts/${account.id}`,
      headers: partnerAuth,
      payload: { name: "Renamed" },
    });
    expect(edit.statusCode).toBe(403);
  });

  it("aggregates an overview across accounts per currency", async () => {
    const { auth } = await seedUser(store);
    for (const currency of ["GBP", "GBP"]) {
      const acc = (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers: auth,
          payload: { name: currency, currency },
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/api/accounts/${acc.id}/incomes`,
        headers: auth,
        payload: {
          name: "Pay",
          amountMinor: 100000,
          frequency: "monthly",
          anchorDate: "2026-01-01",
        },
      });
    }
    const overview = (
      await app.inject({ method: "GET", url: "/api/overview?asOf=2026-01-01", headers: auth })
    ).json();
    expect(overview.perCurrency).toHaveLength(1);
    expect(overview.perCurrency[0].monthlyIncomeMinor).toBe(200000);
  });

  it("carries each account's state on the overview summary", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "Everyday", currency: "GBP" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/incomes`,
      headers: auth,
      payload: { name: "Pay", amountMinor: 300000, frequency: "monthly", anchorDate: "2026-01-25" },
    });
    // A save-up goal (120000 over 8 months → 15000/mo) and a monthly bill. Only
    // the goal is ever "recorded"; the bill leaves the account by itself.
    const goal = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/payments`,
        headers: auth,
        payload: {
          name: "Holiday",
          category: "fixed_point",
          amountMinor: 120000,
          dueDate: "2026-09-01",
        },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/payments`,
      headers: auth,
      payload: { name: "Rent", category: "monthly_recurring", amountMinor: 100000 },
    });
    await app.inject({
      method: "PUT",
      url: `/api/accounts/${account.id}/balance`,
      headers: auth,
      payload: { asOfDate: "2026-01-15", balanceMinor: 318450 },
    });

    const summary = (
      await app.inject({ method: "GET", url: "/api/overview?asOf=2026-01-20", headers: auth })
    ).json().perCurrency[0].accounts[0];

    expect(summary).toMatchObject({
      accountId: account.id,
      name: "Everyday",
      householdId: null,
      householdRole: null,
      monthlyIncomeMinor: 300000,
      latestBalanceMinor: 318450,
      latestBalanceDate: "2026-01-15",
      reservedMinor: 0,
      unrecordedCount: 1,
      unrecordedTotalMinor: 17143, // 120000 over the 7 months to the due date
    });

    // The same lines again, described well enough for the Overview's checklist
    // to draw a row and prefill its box — which is the plan request per account
    // this replaces. Only the unrecorded ones travel; the monthly bill is
    // nobody's to record, so it shows up only in the count.
    expect(summary.planSummary).toEqual({
      unrecorded: [
        {
          paymentId: goal.id,
          name: "Holiday",
          fundedMonthlyMinor: 17143,
          remainderMinor: 17143,
        },
      ],
      lineCount: 2,
      // Last in funding order, so the first thing a tighter month would cut.
      lastFundedName: "Rent",
    });

    // Part of the month's target recorded: the count stands, the total is only
    // what is still missing — the same figure the checklist would prefill.
    await app.inject({
      method: "POST",
      url: `/api/payments/${goal.id}/contributions`,
      headers: auth,
      payload: { amountMinor: 5000, month: "2026-01" },
    });
    const partly = (
      await app.inject({ method: "GET", url: "/api/overview?asOf=2026-01-20", headers: auth })
    ).json().perCurrency[0].accounts[0];
    expect(partly.reservedMinor).toBe(5000);
    expect(partly.unrecordedCount).toBe(1);
    expect(partly.unrecordedTotalMinor).toBe(11429); // (120000 - 5000) / 7 - 5000
    // The chip's figure is the descriptor's remainder, by construction: the row
    // asks for the month's target and the box prefills only the gap.
    expect(partly.planSummary.unrecorded).toEqual([
      { paymentId: goal.id, name: "Holiday", fundedMonthlyMinor: 16429, remainderMinor: 11429 },
    ]);

    // Covered: nothing left to record, and the monthly bill never counted.
    await app.inject({
      method: "POST",
      url: `/api/payments/${goal.id}/contributions`,
      headers: auth,
      payload: { amountMinor: 100000, month: "2026-01" },
    });
    const covered = (
      await app.inject({ method: "GET", url: "/api/overview?asOf=2026-01-20", headers: auth })
    ).json().perCurrency[0].accounts[0];
    expect(covered.unrecordedCount).toBe(0);
    expect(covered.unrecordedTotalMinor).toBe(0);
    expect(covered.planSummary.unrecorded).toEqual([]);
    // Nothing left to record does not mean nothing left to cut: the count and
    // the last funded line are what the fold's sentences read.
    expect(covered.planSummary.lineCount).toBe(2);
  });

  it("reports one balance for an account, whichever screen asks", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "Everyday", currency: "GBP", openingBalanceMinor: 250000 },
      })
    ).json();
    await app.inject({
      method: "PUT",
      url: `/api/accounts/${account.id}/balance`,
      headers: auth,
      payload: { asOfDate: "2026-01-15", balanceMinor: 318450 },
    });

    const url = "?asOf=2026-01-20";
    const plan = (
      await app.inject({
        method: "GET",
        url: `/api/accounts/${account.id}/plan${url}`,
        headers: auth,
      })
    ).json();
    const summary = (
      await app.inject({ method: "GET", url: `/api/overview${url}`, headers: auth })
    ).json().perCurrency[0].accounts[0];

    // The index and the account page's reality strip read the same check-in —
    // not the opening balance the account was configured with.
    expect(summary.latestBalanceMinor).toBe(plan.latestBalance.balanceMinor);
    expect(summary.latestBalanceDate).toBe(plan.latestBalance.asOfDate);
    expect(summary.reservedMinor).toBe(plan.reservedMinor);
    expect(summary.latestBalanceMinor).not.toBe(account.openingBalanceMinor);
  });

  it("places a household's accounts on the overview summary", async () => {
    const h = await seedHousehold(store, app);
    const accounts = (
      await app.inject({ method: "GET", url: "/api/overview?asOf=2026-01-20", headers: h.auth })
    )
      .json()
      .perCurrency[0].accounts.reduce(
        (byId: Record<string, unknown>, a: { accountId: string }) => ({
          ...byId,
          [a.accountId]: a,
        }),
        {},
      );

    expect(accounts[h.bills.id]).toMatchObject({
      name: "bills",
      householdId: h.household.id,
      householdRole: "shared",
    });
    expect(accounts[h.aliceCur.id]).toMatchObject({
      householdId: h.household.id,
      householdRole: "personal",
    });
  });

  it("creates a project and assigns a payment to it", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "Personal", currency: "GBP" },
      })
    ).json();

    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: auth,
        payload: { name: "House move 2026", targetDate: "2026-09-01" },
      })
    ).json();
    expect(project.id).toBeTruthy();
    expect(project.name).toBe("House move 2026");

    const payment = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/payments`,
        headers: auth,
        payload: {
          name: "Deposit",
          category: "fixed_point",
          amountMinor: 500000,
          dueDate: "2026-09-01",
          projectId: project.id,
        },
      })
    ).json();
    expect(payment.projectId).toBe(project.id);

    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}`,
        headers: auth,
      })
    ).json();
    expect(detail.payments).toHaveLength(1);
    expect(detail.payments[0].name).toBe("Deposit");
    expect(detail.payments[0].accountName).toBe("Personal");
  });

  it("hides another user's project (404) and refuses cross-user access", async () => {
    const { auth: aAuth } = await seedUser(store, "a@example.com");
    const { auth: bAuth } = await seedUser(store, "b@example.com");

    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: aAuth,
        payload: { name: "A's project" },
      })
    ).json();

    const peek = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
      headers: bAuth,
    });
    expect(peek.statusCode).toBe(404);

    const tryDelete = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      headers: bAuth,
    });
    expect(tryDelete.statusCode).toBe(404);
  });

  it("deleting a project leaves member payments intact (just unlinked)", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "Personal", currency: "GBP" },
      })
    ).json();
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: auth,
        payload: { name: "Holiday" },
      })
    ).json();
    const payment = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/payments`,
        headers: auth,
        payload: {
          name: "Flights",
          category: "fixed_point",
          amountMinor: 60000,
          dueDate: "2026-08-01",
          projectId: project.id,
        },
      })
    ).json();

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      headers: auth,
    });
    expect(deleted.statusCode).toBe(204);

    // payment still exists, but its projectId is now null
    const after = await store.getPayment(payment.id);
    expect(after).not.toBeNull();
    expect(after?.projectId ?? null).toBeNull();
  });

  it("moves a payment to another account the caller can edit", async () => {
    const { auth } = await seedUser(store);
    const mk = async (name: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers: auth,
          payload: { name, currency: "GBP" },
        })
      ).json();
    const a = await mk("A");
    const b = await mk("B");
    const payment = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${a.id}/payments`,
        headers: auth,
        payload: { name: "Rent", category: "monthly_recurring", amountMinor: 100000 },
      })
    ).json();

    const moved = await app.inject({
      method: "PATCH",
      url: `/api/payments/${payment.id}`,
      headers: auth,
      payload: { accountId: b.id },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().accountId).toBe(b.id);

    const onA = await app.inject({
      method: "GET",
      url: `/api/accounts/${a.id}/payments`,
      headers: auth,
    });
    const onB = await app.inject({
      method: "GET",
      url: `/api/accounts/${b.id}/payments`,
      headers: auth,
    });
    expect(onA.json()).toHaveLength(0);
    expect(onB.json().map((p: { id: string }) => p.id)).toContain(payment.id);
  });

  it("refuses to move a payment into an account the caller can't edit (404)", async () => {
    const { auth } = await seedUser(store, "mover@example.com");
    const a = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "A", currency: "GBP" },
      })
    ).json();
    const payment = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${a.id}/payments`,
        headers: auth,
        payload: { name: "Rent", category: "monthly_recurring", amountMinor: 100000 },
      })
    ).json();

    const { auth: otherAuth } = await seedUser(store, "other@example.com");
    const foreign = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: otherAuth,
        payload: { name: "Foreign", currency: "GBP" },
      })
    ).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/payments/${payment.id}`,
      headers: auth,
      payload: { accountId: foreign.id },
    });
    expect(res.statusCode).toBe(404);
    // The payment didn't move.
    expect((await store.getPayment(payment.id))?.accountId).toBe(a.id);
  });

  it("moves an income to another account the caller can edit", async () => {
    const { auth } = await seedUser(store);
    const mk = async (name: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers: auth,
          payload: { name, currency: "GBP" },
        })
      ).json();
    const a = await mk("A");
    const b = await mk("B");
    const income = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${a.id}/incomes`,
        headers: auth,
        payload: {
          name: "Salary",
          amountMinor: 300000,
          frequency: "monthly",
          anchorDate: "2026-01-25",
        },
      })
    ).json();

    const moved = await app.inject({
      method: "PATCH",
      url: `/api/incomes/${income.id}`,
      headers: auth,
      payload: { accountId: b.id },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().accountId).toBe(b.id);

    const onA = await app.inject({
      method: "GET",
      url: `/api/accounts/${a.id}/incomes`,
      headers: auth,
    });
    const onB = await app.inject({
      method: "GET",
      url: `/api/accounts/${b.id}/incomes`,
      headers: auth,
    });
    expect(onA.json()).toHaveLength(0);
    expect(onB.json().map((i: { id: string }) => i.id)).toContain(income.id);
  });

  it("passes payment scope + bearer through create", async () => {
    const { user, auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "A", currency: "GBP" },
      })
    ).json();
    const payment = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/payments`,
        headers: auth,
        payload: {
          name: "Gym",
          category: "monthly_recurring",
          amountMinor: 5000,
          scope: "personal",
          bearerUserId: user.id,
        },
      })
    ).json();
    expect(payment.scope).toBe("personal");
    expect(payment.bearerUserId).toBe(user.id);
  });

  it("computes a household plan with proportional shared costs + transfers", async () => {
    const { user, auth } = await seedUser(store, "alice@example.com");
    const { user: bob } = await seedUser(store, "bob@example.com");
    const household = await store.createHousehold("Home", user.id);
    await store.addMembership(household.id, bob.id, "member");
    await store.updateMembershipShare(household.id, user.id, 6600);
    await store.updateMembershipShare(household.id, bob.id, 3400);

    const make = async (name: string, incomeMinor?: number) => {
      const a = (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers: auth,
          payload: { name, currency: "GBP" },
        })
      ).json();
      if (incomeMinor) {
        await app.inject({
          method: "POST",
          url: `/api/accounts/${a.id}/incomes`,
          headers: auth,
          payload: {
            name: "Pay",
            amountMinor: incomeMinor,
            frequency: "monthly",
            anchorDate: "2026-01-01",
          },
        });
      }
      return a;
    };
    const aliceCur = await make("alice-cur", 300000);
    const bobCur = await make("bob-cur", 200000);
    const bills = await make("bills");
    await app.inject({
      method: "POST",
      url: `/api/accounts/${bills.id}/payments`,
      headers: auth,
      payload: {
        name: "Rent",
        category: "monthly_recurring",
        amountMinor: 100000,
        scope: "shared",
      },
    });

    // Build the household roster.
    const assign = (accountId: string, payload: object) =>
      app.inject({
        method: "PUT",
        url: `/api/households/${household.id}/accounts/${accountId}`,
        headers: auth,
        payload,
      });
    expect(
      (await assign(aliceCur.id, { role: "personal", memberUserId: user.id })).statusCode,
    ).toBe(200);
    await assign(bobCur.id, { role: "personal", memberUserId: bob.id });
    await assign(bills.id, { role: "shared" });

    const plan = (
      await app.inject({
        method: "GET",
        url: `/api/households/${household.id}/plan?asOf=2026-06-01`,
        headers: auth,
      })
    ).json();

    expect(plan.members).toHaveLength(2);
    expect(plan.shortfallMinor).toBe(0);
    const alice = plan.members.find((m: { userId: string }) => m.userId === user.id);
    const bobPlan = plan.members.find((m: { userId: string }) => m.userId === bob.id);
    expect(alice.obligationMinor).toBe(66000);
    expect(bobPlan.obligationMinor).toBe(34000);
    const t = (from: string, to: string) =>
      plan.transfers.find(
        (x: { fromAccountId: string; toAccountId: string }) =>
          x.fromAccountId === from && x.toAccountId === to,
      )?.amountMinor;
    expect(t(aliceCur.id, bills.id)).toBe(66000);
    expect(t(bobCur.id, bills.id)).toBe(34000);
  });

  it("hides the household plan from non-members (404)", async () => {
    const { user } = await seedUser(store, "member@example.com");
    const { auth: strangerAuth } = await seedUser(store, "stranger@example.com");
    const household = await store.createHousehold("Home", user.id);
    const res = await app.inject({
      method: "GET",
      url: `/api/households/${household.id}/plan`,
      headers: strangerAuth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("only admins can change the household account roster (403 for members)", async () => {
    const { user } = await seedUser(store, "owner2@example.com");
    const { user: member, auth: memberAuth } = await seedUser(store, "member2@example.com");
    const household = await store.createHousehold("Home", user.id);
    await store.addMembership(household.id, member.id, "member");
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: memberAuth,
        payload: { name: "Mine", currency: "GBP" },
      })
    ).json();
    const res = await app.inject({
      method: "PUT",
      url: `/api/households/${household.id}/accounts/${account.id}`,
      headers: memberAuth,
      payload: { role: "shared" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("derives a payment's already-saved from its contributions", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "A", currency: "GBP" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/incomes`,
      headers: auth,
      payload: {
        name: "Salary",
        amountMinor: 300000,
        frequency: "monthly",
        anchorDate: "2026-01-25",
      },
    });
    const payment = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/payments`,
        headers: auth,
        payload: {
          name: "Holiday",
          category: "fixed_point",
          amountMinor: 120000,
          dueDate: "2026-09-01",
        },
      })
    ).json();

    const before = (
      await app.inject({
        method: "GET",
        url: `/api/accounts/${account.id}/plan?asOf=2026-01-01`,
        headers: auth,
      })
    ).json();
    expect(before.lines[0].requiredMonthlyMinor).toBe(15000); // 120000 over 8 months
    expect(before.reservedMinor).toBe(0);
    expect(before.latestBalance).toBeNull();

    const recorded = await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/contributions`,
      headers: auth,
      payload: { amountMinor: 40000, month: "2026-01", note: "January transfer" },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json().month).toBe("2026-01-01"); // stored as the month's first day

    const after = (
      await app.inject({
        method: "GET",
        url: `/api/accounts/${account.id}/plan?asOf=2026-01-01`,
        headers: auth,
      })
    ).json();
    expect(after.lines[0].alreadySavedMinor).toBe(40000);
    expect(after.lines[0].requiredMonthlyMinor).toBe(10000); // (120000 - 40000) over 8
    expect(after.reservedMinor).toBe(40000);
    expect(after.contributionsMTD).toEqual([{ paymentId: payment.id, amountMinor: 40000 }]);
  });

  it("lists contributions by month and deletes them", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "A", currency: "GBP" },
      })
    ).json();
    const payment = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/payments`,
        headers: auth,
        payload: { name: "Rent", category: "monthly_recurring", amountMinor: 100000 },
      })
    ).json();
    const record = (month: string, amountMinor: number) =>
      app.inject({
        method: "POST",
        url: `/api/payments/${payment.id}/contributions`,
        headers: auth,
        payload: { amountMinor, month },
      });
    const january = (await record("2026-01", 100000)).json();
    await record("2026-02", 50000);

    const all = await app.inject({
      method: "GET",
      url: `/api/accounts/${account.id}/contributions`,
      headers: auth,
    });
    expect(all.json()).toHaveLength(2);
    const february = await app.inject({
      method: "GET",
      url: `/api/accounts/${account.id}/contributions?month=2026-02`,
      headers: auth,
    });
    expect(february.json()).toHaveLength(1);
    expect(february.json()[0].amountMinor).toBe(50000);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/contributions/${january.id}`,
      headers: auth,
    });
    expect(deleted.statusCode).toBe(204);
    const remaining = await app.inject({
      method: "GET",
      url: `/api/accounts/${account.id}/contributions`,
      headers: auth,
    });
    expect(remaining.json()).toHaveLength(1);

    const missing = await app.inject({
      method: "DELETE",
      url: "/api/contributions/00000000-0000-0000-0000-000000000000",
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses contributions from a view-only member (403) but lets them read the ledger", async () => {
    const { user, auth } = await seedUser(store, "owner@example.com");
    const { user: partner, auth: partnerAuth } = await seedUser(store, "partner@example.com");
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "Joint", currency: "GBP" },
      })
    ).json();
    const payment = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/payments`,
        headers: auth,
        payload: { name: "Rent", category: "monthly_recurring", amountMinor: 100000 },
      })
    ).json();
    const household = await store.createHousehold("Home", user.id);
    await store.addMembership(household.id, partner.id, "member");
    await store.createAccountShare(account.id, household.id, "view");

    const blocked = await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/contributions`,
      headers: partnerAuth,
      payload: { amountMinor: 10000 },
    });
    expect(blocked.statusCode).toBe(403);

    const readable = await app.inject({
      method: "GET",
      url: `/api/accounts/${account.id}/contributions`,
      headers: partnerAuth,
    });
    expect(readable.statusCode).toBe(200);
    expect(readable.json()).toHaveLength(0);
  });

  it("upserts one balance check-in per day and surfaces the latest on the plan", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "A", currency: "GBP" },
      })
    ).json();
    const put = (asOfDate: string, balanceMinor: number) =>
      app.inject({
        method: "PUT",
        url: `/api/accounts/${account.id}/balance`,
        headers: auth,
        payload: { asOfDate, balanceMinor },
      });

    const first = await put("2026-01-15", 125000);
    expect(first.statusCode).toBe(200);
    const restated = await put("2026-01-15", 130000);
    expect(restated.json().id).toBe(first.json().id); // same day overwrites
    await put("2026-01-01", -2500); // overdrafts are legal

    const list = await app.inject({
      method: "GET",
      url: `/api/accounts/${account.id}/balances`,
      headers: auth,
    });
    expect(list.json().map((b: { asOfDate: string }) => b.asOfDate)).toEqual([
      "2026-01-01",
      "2026-01-15",
    ]);
    expect(list.json()[1].balanceMinor).toBe(130000);

    const plan = await app.inject({
      method: "GET",
      url: `/api/accounts/${account.id}/plan?asOf=2026-01-20`,
      headers: auth,
    });
    expect(plan.json().latestBalance).toEqual({ asOfDate: "2026-01-15", balanceMinor: 130000 });
  });

  it("confirms a planned transfer, books its contributions, and un-confirms them", async () => {
    const h = await seedHousehold(store, app);
    const planUrl = `/api/households/${h.household.id}/plan`;
    const before = (await app.inject({ method: "GET", url: planUrl, headers: h.auth })).json();
    const planned = before.transfers.find(
      (t: { fromAccountId: string; toAccountId: string; memberUserId: string }) =>
        t.fromAccountId === h.aliceCur.id &&
        t.toAccountId === h.bills.id &&
        t.memberUserId === h.alice.id,
    );
    expect(planned).toBeTruthy();
    const holidayBefore = before.lines.find(
      (l: { name: string }) => l.name === "Holiday",
    ).requiredMonthlyMinor;

    const confirm = () =>
      app.inject({
        method: "POST",
        url: `/api/households/${h.household.id}/transfers/confirm`,
        headers: h.auth,
        payload: {
          fromAccountId: h.aliceCur.id,
          toAccountId: h.bills.id,
          memberUserId: h.alice.id,
        },
      });

    const res = await confirm();
    expect(res.statusCode).toBe(201);
    const { confirmation, contributions } = res.json();
    expect(confirmation.amountMinor).toBe(planned.amountMinor);
    expect(confirmation.month).toBe(`${thisMonth()}-01`);
    // One contribution per bill the transfer funds (rent + the holiday goal).
    expect(contributions).toHaveLength(2);
    expect(
      contributions.every(
        (c: { transferConfirmationId: string; accountId: string }) =>
          c.transferConfirmationId === confirmation.id && c.accountId === h.bills.id,
      ),
    ).toBe(true);

    // Confirming again is refused rather than double-counted.
    expect((await confirm()).statusCode).toBe(409);
    expect((await confirm()).json().error.code).toBe("already_confirmed");

    // The money that moved is now reflected in the household plan.
    const after = (await app.inject({ method: "GET", url: planUrl, headers: h.auth })).json();
    const holidayAfter = after.lines.find(
      (l: { name: string }) => l.name === "Holiday",
    ).requiredMonthlyMinor;
    expect(holidayAfter).toBeLessThan(holidayBefore);

    const listed = await app.inject({
      method: "GET",
      url: `/api/households/${h.household.id}/transfers/confirmations`,
      headers: h.auth,
    });
    expect(listed.json()).toHaveLength(1);

    // Un-confirming takes the contributions it created with it.
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/households/${h.household.id}/transfers/confirmations/${confirmation.id}`,
      headers: h.auth,
    });
    expect(removed.statusCode).toBe(204);
    const ledger = await app.inject({
      method: "GET",
      url: `/api/accounts/${h.bills.id}/contributions`,
      headers: h.auth,
    });
    expect(ledger.json()).toHaveLength(0);
  });

  it("rejects a confirmation with no matching planned transfer (422)", async () => {
    const h = await seedHousehold(store, app);
    const res = await app.inject({
      method: "POST",
      url: `/api/households/${h.household.id}/transfers/confirm`,
      headers: h.auth,
      payload: {
        fromAccountId: h.bills.id, // the plan never moves money this way
        toAccountId: h.aliceCur.id,
        memberUserId: h.alice.id,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("no_planned_transfer");
  });

  it("stops a plain member confirming someone else's transfer (403)", async () => {
    const h = await seedHousehold(store, app);
    const res = await app.inject({
      method: "POST",
      url: `/api/households/${h.household.id}/transfers/confirm`,
      headers: h.bobAuth,
      payload: {
        fromAccountId: h.aliceCur.id,
        toAccountId: h.bills.id,
        memberUserId: h.alice.id,
      },
    });
    expect(res.statusCode).toBe(403);

    // Their own transfer is fine, though.
    const own = await app.inject({
      method: "POST",
      url: `/api/households/${h.household.id}/transfers/confirm`,
      headers: h.bobAuth,
      payload: {
        fromAccountId: h.bobCur.id,
        toAccountId: h.bills.id,
        memberUserId: h.bob.id,
      },
    });
    expect(own.statusCode).toBe(201);
  });

  // --- an account inside a household is planned with what the household sends it

  /** Every transfer the household plan derives into the bills pot, confirmed. */
  async function confirmAllInflow(h: Awaited<ReturnType<typeof seedHousehold>>) {
    const plan = (
      await app.inject({
        method: "GET",
        url: `/api/households/${h.household.id}/plan`,
        headers: h.auth,
      })
    ).json();
    for (const t of plan.transfers) {
      const res = await app.inject({
        method: "POST",
        url: `/api/households/${h.household.id}/transfers/confirm`,
        headers: h.auth,
        payload: {
          fromAccountId: t.fromAccountId,
          toAccountId: t.toAccountId,
          memberUserId: t.memberUserId,
        },
      });
      expect(res.statusCode).toBe(201);
    }
  }

  it("plans a standalone account from its own income alone", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "solo", currency: "GBP" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/payments`,
      headers: auth,
      payload: { name: "Rent", category: "monthly_recurring", amountMinor: 100000 },
    });

    const plan = (
      await app.inject({ method: "GET", url: `/api/accounts/${account.id}/plan`, headers: auth })
    ).json();
    // No household, so nothing arrives and the shortfall is the whole bill —
    // exactly as before allocated inflow existed.
    expect(plan.monthlyIncomeMinor).toBe(0);
    expect(plan.allocatedInflowMinor).toBe(0);
    expect(plan.confirmedInflowMinor).toBe(0);
    expect(plan.inflowSources).toBeNull();
    expect(plan.shortfallMinor).toBe(100000);
    expect(plan.lines.map((l: { status: string }) => l.status)).toEqual(["at_risk"]);
  });

  // --- "I moved the money", with no household anywhere in it

  /** A holiday pot fed by a movement out of a current account. One user, two
   *  accounts, no household — the case the old NOT NULL made unrecordable.
   *
   *  The current account earns: a sending account that can actually afford the
   *  movement is the ordinary case, and the one the confirm path has to get
   *  right. Left penniless, the ordered pass delivers £0 into the pot and every
   *  assertion below passes on a plan where nothing happened. */
  async function seedMovement(auth: { authorization: string }) {
    const make = async (name: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers: auth,
          payload: { name, currency: "GBP" },
        })
      ).json();
    const current = await make("current");
    const pot = await make("holiday pot");
    await app.inject({
      method: "POST",
      url: `/api/accounts/${current.id}/incomes`,
      headers: auth,
      payload: {
        name: "Salary",
        amountMinor: 300000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/accounts/${pot.id}/payments`,
      headers: auth,
      payload: {
        name: "Holiday",
        category: "fixed_point",
        amountMinor: 120000,
        dueDate: "2027-08-01",
      },
    });
    // Authored on the store directly: inflows have no HTTP surface yet.
    const movement = await store.createInflow({
      accountId: pot.id,
      name: "Monthly top-up",
      source: "account",
      sourceAccountId: current.id,
      amountMinor: 20000,
      frequency: "monthly",
      recurrence: null,
      anchorDate: "2026-01-01",
      priority: 50,
      active: true,
    });
    return { current, pot, movement };
  }

  it("confirms a movement between two accounts you own, and un-confirms it", async () => {
    const { auth } = await seedUser(store);
    const { current, pot, movement } = await seedMovement(auth);

    const confirm = () =>
      app.inject({ method: "POST", url: `/api/inflows/${movement.id}/confirm`, headers: auth });

    const res = await confirm();
    expect(res.statusCode).toBe(201);
    const { confirmation, contributions } = res.json();
    expect(confirmation.householdId).toBeNull();
    expect(confirmation.inflowId).toBe(movement.id);
    expect(confirmation.fromAccountId).toBe(current.id);
    expect(confirmation.toAccountId).toBe(pot.id);
    expect(confirmation.amountMinor).toBe(20000);
    expect(confirmation.month).toBe(`${thisMonth()}-01`);

    // **Nothing is booked against a payment.** An authored movement is savings
    // (decision 9), and the pot's goal is funded by the transfer the pass
    // derives for it — the movement arrives on top rather than instead
    // (decision 12). There is nothing the plan says this money paid for, and a
    // contribution invented against a payment would be a second answer to a
    // question the pass has already answered.
    expect(contributions).toEqual([]);

    // Confirming the same movement again is refused rather than double-booked.
    expect((await confirm()).statusCode).toBe(409);
    expect((await confirm()).json().error.code).toBe("already_confirmed");

    // Readable from both ends of the movement, without naming a household.
    for (const accountId of [pot.id, current.id]) {
      const listed = await app.inject({
        method: "GET",
        url: `/api/accounts/${accountId}/transfers/confirmations`,
        headers: auth,
      });
      expect(listed.json().map((c: { id: string }) => c.id)).toEqual([confirmation.id]);
    }

    // Un-confirming takes the contributions it created with it.
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/inflows/${movement.id}/confirmations/${confirmation.id}`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(204);
    const ledger = await app.inject({
      method: "GET",
      url: `/api/accounts/${pot.id}/contributions`,
      headers: auth,
    });
    expect(ledger.json()).toHaveLength(0);
    const after = await app.inject({
      method: "GET",
      url: `/api/accounts/${pot.id}/transfers/confirmations`,
      headers: auth,
    });
    expect(after.json()).toEqual([]);

    // ...and it can be confirmed again afterwards.
    expect((await confirm()).statusCode).toBe(201);
  });

  /**
   * A current account that can afford the movement, and a pot whose bills the
   * caller chooses. The regression this pins is the one WP-H's fixture could
   * not see: with the sender penniless nothing arrives, and a handler that
   * diffed the plan against a *second* copy of the movement gave the same answer
   * as one that diffed against the movement's absence.
   */
  async function seedFundedMovement(
    auth: { authorization: string },
    bills: { name: string; amountMinor: number; priority: number }[],
  ) {
    const make = async (name: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers: auth,
          payload: { name, currency: "GBP" },
        })
      ).json();
    const current = await make("current");
    const pot = await make("pot");
    await app.inject({
      method: "POST",
      url: `/api/accounts/${current.id}/incomes`,
      headers: auth,
      payload: {
        name: "Salary",
        amountMinor: 300000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
      },
    });
    for (const b of bills) {
      await app.inject({
        method: "POST",
        url: `/api/accounts/${pot.id}/payments`,
        headers: auth,
        payload: { ...b, category: "monthly_recurring" },
      });
    }
    const movement = await store.createInflow({
      accountId: pot.id,
      name: "Monthly top-up",
      source: "account",
      sourceAccountId: current.id,
      amountMinor: 20000,
      frequency: "monthly",
      recurrence: null,
      anchorDate: "2026-01-01",
      priority: 50,
      active: true,
    });
    return { current, pot, movement };
  }

  it("says what a movement actually delivered, and books nothing against a bill", async () => {
    const { auth } = await seedUser(store);
    // £200 authored out of an account with £3,000 to spare, against a £150 bill
    // the pass already feeds. Both happen; neither is netted against the other.
    const { current, pot, movement } = await seedFundedMovement(auth, [
      { name: "Council tax", amountMinor: 15000, priority: 1 },
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/api/inflows/${movement.id}/confirm`,
      headers: auth,
    });
    expect(res.statusCode).toBe(201);
    const { confirmation, contributions } = res.json();
    // What arrived, not what was authored — here they agree, because the sender
    // could send the lot.
    expect(confirmation.amountMinor).toBe(20000);
    expect(contributions).toEqual([]);

    // And the duplication decision 12 accepts, on the wire for the UI to flag:
    // £150 of derived feed for the bill, £200 of savings on top, £200 of which
    // stays put in the pot.
    const plan = (
      await app.inject({ method: "GET", url: `/api/accounts/${pot.id}/plan`, headers: auth })
    ).json();
    expect(plan.allocatedInflowMinor).toBe(35000);
    expect(plan.lines[0].fundedFromInflowMinor).toBe(15000);
    expect(plan.residualMinor).toBe(20000);
    expect(plan.inflowArrivals).toEqual([
      {
        inflowId: movement.id,
        fromAccountId: current.id,
        amountMinor: 20000,
        confirmedMinor: 20000,
      },
    ]);
  });

  it("funds a pot's bills in the sender's own priority order, not after them", async () => {
    const { auth } = await seedUser(store);
    // Decision 8, the direction the old pin did not cover: the pot's bills are
    // expenses of the account's owner, so they are funded from the owner's
    // budget in one global priority order — not out of whatever an authored
    // movement happened to carry.
    const { pot } = await seedFundedMovement(auth, [
      { name: "Council tax", amountMinor: 15000, priority: 1 },
      { name: "Water", amountMinor: 15000, priority: 2 },
    ]);

    const plan = (
      await app.inject({ method: "GET", url: `/api/accounts/${pot.id}/plan`, headers: auth })
    ).json();
    expect(
      plan.lines.map((l: { name: string; fundedMonthlyMinor: number }) => l.fundedMonthlyMinor),
    ) //
      .toEqual([15000, 15000]);
    expect(plan.shortfallMinor).toBe(0);
    // No authored row says so — the pass derived the whole £300 of it.
    expect(
      plan.inflowArrivals.reduce((n: number, a: { amountMinor: number }) => n + a.amountMinor, 0),
    ) //
      .toBe(20000);
    expect(plan.allocatedInflowMinor).toBe(50000);
  });

  it("reports a confirmed movement as funded rather than awaiting for ever", async () => {
    const { auth } = await seedUser(store);
    const { current, pot, movement } = await seedFundedMovement(auth, [
      { name: "Council tax", amountMinor: 15000, priority: 1 },
    ]);
    const planOf = async () =>
      (
        await app.inject({ method: "GET", url: `/api/accounts/${pot.id}/plan`, headers: auth })
      ).json();

    const before = await planOf();
    // £150 of derived feed for the bill, plus the £200 the movement authors.
    expect(before.allocatedInflowMinor).toBe(35000);
    expect(before.confirmedInflowMinor).toBe(0);
    expect(before.lines[0].status).toBe("awaiting_transfer");

    await app.inject({
      method: "POST",
      url: `/api/inflows/${movement.id}/confirm`,
      headers: auth,
    });
    const after = await planOf();
    expect(after.confirmedInflowMinor).toBe(20000);
    expect(after.lines[0].status).toBe("funded");
    // Nobody else is involved, so there is no household — but there is very much
    // a sender, and it is one of the caller's own accounts. Membership of a
    // household was never what made that safe to say. Both producers show:
    // the transfer the pass derived (the caller's own, so nameable) and the
    // movement they authored.
    expect(after.inflowSources).toEqual([
      {
        kind: "member",
        memberUserId: expect.any(String),
        displayName: "Owner",
        amountMinor: 15000,
        confirmedMinor: 0,
      },
      {
        kind: "account",
        inflowId: movement.id,
        fromAccountId: current.id,
        accountName: "current",
        amountMinor: 20000,
        confirmedMinor: 20000,
      },
    ]);
  });

  it("closes a standalone pot's month on its own income plus what moved into it", async () => {
    const { auth } = await seedUser(store);
    const { pot, movement } = await seedFundedMovement(auth, [
      { name: "Council tax", amountMinor: 15000, priority: 1 },
    ]);
    await app.inject({
      method: "POST",
      url: `/api/inflows/${movement.id}/confirm`,
      headers: auth,
    });

    const closed = await app.inject({
      method: "POST",
      url: `/api/accounts/${pot.id}/close`,
      headers: auth,
      payload: { month: thisMonth() },
    });
    expect(closed.statusCode).toBe(201);
    // The pot earns nothing; £200 moved in and was confirmed. A close is history
    // that cannot be recomputed, so £0 here would be permanently wrong.
    expect(closed.json().incomeMinor).toBe(20000);
    expect(closed.json().plannedMinor).toBe(15000);
  });

  it("refuses to confirm anything that is not a movement", async () => {
    const { auth } = await seedUser(store);
    const { pot, movement } = await seedMovement(auth);
    const salary = await store.createIncome({
      accountId: pot.id,
      name: "Pay",
      amountMinor: 100000,
      frequency: "monthly",
      recurrence: null,
      anchorDate: "2026-01-01",
      active: true,
    });
    // Money arriving from outside the estate is not something you transferred.
    const res = await app.inject({
      method: "POST",
      url: `/api/inflows/${salary.id}/confirm`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    // A malformed month reaches a write, so it is checked rather than passed on.
    const bad = await app.inject({
      method: "POST",
      url: `/api/inflows/${movement.id}/confirm?month=2026-13`,
      headers: auth,
    });
    expect(bad.statusCode).toBe(422);
  });

  it("hides someone else's movement rather than admitting it exists", async () => {
    const { auth } = await seedUser(store);
    const { movement } = await seedMovement(auth);
    const { auth: strangerAuth } = await seedUser(store, "stranger@example.com");
    const res = await app.inject({
      method: "POST",
      url: `/api/inflows/${movement.id}/confirm`,
      headers: strangerAuth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("keeps household confirmations out of the account-scoped list", async () => {
    const h = await seedHousehold(store, app);
    await confirmAllInflow(h);
    // The household's own view is unchanged...
    const household = await app.inject({
      method: "GET",
      url: `/api/households/${h.household.id}/transfers/confirmations`,
      headers: h.auth,
    });
    expect(household.json().length).toBeGreaterThan(0);
    // ...and none of it shows up as a movement, because none of it is one: a
    // household transfer is derived from the plan, not authored as an inflow.
    const perAccount = await app.inject({
      method: "GET",
      url: `/api/accounts/${h.bills.id}/transfers/confirmations`,
      headers: h.auth,
    });
    expect(perAccount.json()).toEqual([]);
  });

  it("funds a household pot from the household's allocation, awaiting the transfer", async () => {
    const h = await seedHousehold(store, app);
    const householdPlan = (
      await app.inject({
        method: "GET",
        url: `/api/households/${h.household.id}/plan`,
        headers: h.auth,
      })
    ).json();
    const pot = householdPlan.accounts.find(
      (a: { accountId: string }) => a.accountId === h.bills.id,
    );

    const plan = (
      await app.inject({ method: "GET", url: `/api/accounts/${h.bills.id}/plan`, headers: h.auth })
    ).json();

    // The two engines now agree: what the household allocates is what the
    // account plans with, and the pot's own income is still nothing.
    expect(plan.monthlyIncomeMinor).toBe(0);
    expect(plan.allocatedInflowMinor).toBe(pot.transferInMinor);
    expect(plan.confirmedInflowMinor).toBe(0);
    expect(plan.shortfallMinor).toBe(0);
    expect(plan.totalFundedMinor).toBe(plan.totalRequiredMinor);
    // Nobody has moved anything yet, so every line is waiting on a transfer
    // rather than at risk — funded on paper, not in the account.
    expect(
      plan.lines.every(
        (l: { status: string; onTrack: boolean }) => l.status === "awaiting_transfer" && l.onTrack,
      ),
    ).toBe(true);
    for (const line of plan.lines) {
      expect(line.fundedFromOwnMinor + line.fundedFromInflowMinor).toBe(line.fundedMonthlyMinor);
      expect(line.fundedFromOwnMinor).toBe(0);
    }

    // ...and it is not yet money to record. The transfer is the outstanding
    // thing, and it has its own prompt.
    const overview = (
      await app.inject({ method: "GET", url: "/api/overview", headers: h.auth })
    ).json();
    const chip = overview.perCurrency[0].accounts.find(
      (a: { accountId: string }) => a.accountId === h.bills.id,
    );
    expect(chip.allocatedInflowMinor).toBe(pot.transferInMinor);
    expect(chip.unrecordedCount).toBe(0);
    expect(chip.planSummary.unrecorded).toEqual([]);
  });

  it("marks the pot's lines funded once the transfers are confirmed", async () => {
    const h = await seedHousehold(store, app);
    await confirmAllInflow(h);

    const plan = (
      await app.inject({ method: "GET", url: `/api/accounts/${h.bills.id}/plan`, headers: h.auth })
    ).json();
    expect(plan.confirmedInflowMinor).toBe(plan.allocatedInflowMinor);
    expect(plan.shortfallMinor).toBe(0);
    expect(plan.lines.every((l: { status: string }) => l.status === "funded")).toBe(true);
  });

  it("names who is sending the money only to someone who can see the household", async () => {
    const h = await seedHousehold(store, app);
    // Carol can see the pot — it is shared into a household of her own — but
    // she is not in the household that funds it.
    const { user: carol, auth: carolAuth } = await seedUser(store, "carol@example.com");
    const other = await store.createHousehold("Carol's place", carol.id);
    await store.createAccountShare(h.bills.id, other.id, "view");

    const mine = (
      await app.inject({ method: "GET", url: `/api/accounts/${h.bills.id}/plan`, headers: h.auth })
    ).json();
    expect(mine.inflowSources.map((s: { memberUserId: string }) => s.memberUserId).sort()).toEqual(
      [h.alice.id, h.bob.id].sort(),
    );
    expect(
      mine.inflowSources.reduce((n: number, s: { amountMinor: number }) => n + s.amountMinor, 0),
    ).toBe(mine.allocatedInflowMinor);

    const hers = await app.inject({
      method: "GET",
      url: `/api/accounts/${h.bills.id}/plan`,
      headers: carolAuth,
    });
    expect(hers.statusCode).toBe(200);
    // The amount is a fact about an account she can already see, so it is
    // there and her copy of the plan adds up. The senders' names are not.
    expect(hers.json().allocatedInflowMinor).toBe(mine.allocatedInflowMinor);
    expect(hers.json().shortfallMinor).toBe(0);
    expect(hers.json().inflowSources).toBeNull();
  });

  it("does not change the estate's income when an account starts receiving inflow", async () => {
    const h = await seedHousehold(store, app);
    const overview = async () =>
      (await app.inject({ method: "GET", url: "/api/overview", headers: h.auth })).json()
        .perCurrency[0];

    // Take the pot back out of the household plan: nothing is allocated to it.
    await app.inject({
      method: "DELETE",
      url: `/api/households/${h.household.id}/accounts/${h.bills.id}`,
      headers: h.auth,
    });
    const before = await overview();
    const potBefore = before.accounts.find(
      (a: { accountId: string }) => a.accountId === h.bills.id,
    );
    expect(potBefore.allocatedInflowMinor).toBe(0);
    expect(potBefore.shortfallMinor).toBeGreaterThan(0);

    // Put it back, and the household starts funding it.
    await app.inject({
      method: "PUT",
      url: `/api/households/${h.household.id}/accounts/${h.bills.id}`,
      headers: h.auth,
      payload: { role: "shared" },
    });
    const after = await overview();
    const potAfter = after.accounts.find((a: { accountId: string }) => a.accountId === h.bills.id);
    expect(potAfter.allocatedInflowMinor).toBeGreaterThan(0);
    expect(potAfter.shortfallMinor).toBe(0);

    // The guard: inflow is never folded into anyone's income, so the money the
    // members earn is counted once across the estate however it is moved
    // around inside it.
    expect(after.monthlyIncomeMinor).toBe(before.monthlyIncomeMinor);
    expect(
      after.accounts.reduce(
        (n: number, a: { monthlyIncomeMinor: number }) => n + a.monthlyIncomeMinor,
        0,
      ),
    ).toBe(
      before.accounts.reduce(
        (n: number, a: { monthlyIncomeMinor: number }) => n + a.monthlyIncomeMinor,
        0,
      ),
    );
  });

  it("closes a pot's month against the money that actually arrived", async () => {
    const h = await seedHousehold(store, app);
    await confirmAllInflow(h);
    const plan = (
      await app.inject({ method: "GET", url: `/api/accounts/${h.bills.id}/plan`, headers: h.auth })
    ).json();
    const close = await app.inject({
      method: "POST",
      url: `/api/accounts/${h.bills.id}/close`,
      headers: h.auth,
      payload: { month: thisMonth() },
    });
    expect(close.statusCode).toBe(201);
    // A pot has no income of its own; freezing £0 here would leave a scorecard
    // row that can never say anything, and closing is what makes it history.
    expect(plan.monthlyIncomeMinor).toBe(0);
    expect(close.json().incomeMinor).toBe(plan.confirmedInflowMinor);
    expect(close.json().incomeMinor).toBeGreaterThan(0);
  });

  it("closes a household month once, scoring plan against contributions", async () => {
    const h = await seedHousehold(store, app);
    const month = thisMonth();
    const confirmed = (
      await app.inject({
        method: "POST",
        url: `/api/households/${h.household.id}/transfers/confirm`,
        headers: h.auth,
        payload: {
          fromAccountId: h.aliceCur.id,
          toAccountId: h.bills.id,
          memberUserId: h.alice.id,
        },
      })
    ).json();
    const contributed = confirmed.contributions.reduce(
      (sum: number, c: { amountMinor: number }) => sum + c.amountMinor,
      0,
    );
    const plan = (
      await app.inject({
        method: "GET",
        url: `/api/households/${h.household.id}/plan`,
        headers: h.auth,
      })
    ).json();

    const closed = await app.inject({
      method: "POST",
      url: `/api/households/${h.household.id}/close`,
      headers: h.auth,
      payload: { month },
    });
    expect(closed.statusCode).toBe(201);
    expect(closed.json().month).toBe(`${month}-01`);
    expect(closed.json().incomeMinor).toBe(500000);
    expect(closed.json().plannedMinor).toBe(plan.totalRequiredMinor);
    expect(closed.json().contributedMinor).toBe(contributed);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/households/${h.household.id}/close`,
      headers: h.auth,
      payload: { month },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("already_closed");

    const listed = await app.inject({
      method: "GET",
      url: `/api/households/${h.household.id}/closes`,
      headers: h.auth,
    });
    expect(listed.json()).toHaveLength(1);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/households/${h.household.id}/closes/${closed.json().id}`,
      headers: h.auth,
    });
    expect(removed.statusCode).toBe(204);
  });

  it("restricts household closes to owners/admins and to months that have started", async () => {
    const h = await seedHousehold(store, app);
    const asMember = await app.inject({
      method: "POST",
      url: `/api/households/${h.household.id}/close`,
      headers: h.bobAuth,
      payload: { month: thisMonth() },
    });
    expect(asMember.statusCode).toBe(403);

    const future = await app.inject({
      method: "POST",
      url: `/api/households/${h.household.id}/close`,
      headers: h.auth,
      payload: { month: `${new Date().getUTCFullYear() + 1}-01` },
    });
    expect(future.statusCode).toBe(422);
    expect(future.json().error.code).toBe("future_month");
  });

  it("closes a standalone account's month", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "A", currency: "GBP" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/incomes`,
      headers: auth,
      payload: {
        name: "Salary",
        amountMinor: 300000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
      },
    });
    const payment = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/payments`,
        headers: auth,
        payload: { name: "Rent", category: "monthly_recurring", amountMinor: 100000 },
      })
    ).json();
    // No month given — defaults to the month being closed.
    await app.inject({
      method: "POST",
      url: `/api/payments/${payment.id}/contributions`,
      headers: auth,
      payload: { amountMinor: 25000 },
    });

    const closed = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/close`,
      headers: auth,
      payload: { month: thisMonth() },
    });
    expect(closed.statusCode).toBe(201);
    expect(closed.json().accountId).toBe(account.id);
    expect(closed.json().incomeMinor).toBe(300000);
    expect(closed.json().plannedMinor).toBe(100000);
    expect(closed.json().contributedMinor).toBe(25000);

    const listed = await app.inject({
      method: "GET",
      url: `/api/accounts/${account.id}/closes`,
      headers: auth,
    });
    expect(listed.json()).toHaveLength(1);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/accounts/${account.id}/closes/${closed.json().id}`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(204);
  });

  // ---- projections ----

  /** An account with a salary and a savings goal, ready to project. */
  async function seedProjectableAccount(auth: Record<string, string>) {
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "Everyday", currency: "GBP" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/incomes`,
      headers: auth,
      payload: {
        name: "Salary",
        amountMinor: 300000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/payments`,
      headers: auth,
      payload: {
        name: "Holiday",
        category: "fixed_point",
        amountMinor: 120000,
        dueDate: "2027-08-01",
      },
    });
    return account;
  }

  it("projects an account forward from its latest balance check-in", async () => {
    const { auth } = await seedUser(store);
    const account = await seedProjectableAccount(auth);
    await app.inject({
      method: "PUT",
      url: `/api/accounts/${account.id}/balance`,
      headers: auth,
      payload: { asOfDate: "2026-01-05", balanceMinor: 50000 },
    });

    const projection = (
      await app.inject({
        method: "GET",
        url: `/api/accounts/${account.id}/projection?months=3&asOf=2026-01-10`,
        headers: auth,
      })
    ).json();

    expect(projection.accountId).toBe(account.id);
    expect(projection.currency).toBe("GBP");
    expect(projection.asOfDate).toBe("2026-01-10");
    expect(projection.months).toHaveLength(3);
    expect(projection.months.map((m: { month: string }) => m.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    // The check-in anchors the trajectory: the opening balance plus what the
    // first month sets aside toward the goal.
    expect(projection.months[0].projectedBalanceMinor).toBe(
      50000 + projection.months[0].totalFundedMinor,
    );
    expect(projection.months[2].projectedBalanceMinor).toBeGreaterThan(
      projection.months[0].projectedBalanceMinor,
    );
    expect(projection.months[0].lines[0].name).toBe("Holiday");
  });

  it("defaults to 12 months and reports no balance without a check-in", async () => {
    const { auth } = await seedUser(store);
    const account = await seedProjectableAccount(auth);
    const projection = (
      await app.inject({
        method: "GET",
        url: `/api/accounts/${account.id}/projection?asOf=2026-01-10&months=nonsense`,
        headers: auth,
      })
    ).json();
    expect(projection.months).toHaveLength(12);
    expect(
      projection.months.every(
        (m: { projectedBalanceMinor: null }) => m.projectedBalanceMinor === null,
      ),
    ).toBe(true);
  });

  it("lets a view-only member project a shared account but hides it from strangers", async () => {
    const { user, auth } = await seedUser(store, "owner-proj@example.com");
    const { user: partner, auth: partnerAuth } = await seedUser(store, "partner-proj@example.com");
    const { auth: strangerAuth } = await seedUser(store, "stranger-proj@example.com");
    const account = await seedProjectableAccount(auth);

    const household = await store.createHousehold("Home", user.id);
    await store.addMembership(household.id, partner.id, "member");
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/shares`,
      headers: auth,
      payload: { householdId: household.id, permission: "view" },
    });

    const url = `/api/accounts/${account.id}/projection?months=2&asOf=2026-01-10`;
    const seen = await app.inject({ method: "GET", url, headers: partnerAuth });
    expect(seen.statusCode).toBe(200);
    expect(seen.json().months).toHaveLength(2);

    const hidden = await app.inject({ method: "GET", url, headers: strangerAuth });
    expect(hidden.statusCode).toBe(404);
  });

  it("projects a household plan month by month for its members only", async () => {
    const h = await seedHousehold(store, app);
    const { auth: strangerAuth } = await seedUser(store, "stranger-hh@example.com");
    const url = `/api/households/${h.household.id}/projection?months=2&asOf=2026-06-15`;

    const projection = (await app.inject({ method: "GET", url, headers: h.auth })).json();
    expect(projection.householdId).toBe(h.household.id);
    expect(projection.currency).toBe("GBP");
    expect(projection.months).toHaveLength(2);
    expect(projection.months[0].month).toBe("2026-06");
    expect(projection.months[0].transfersTotalMinor).toBeGreaterThan(0);
    // Household lines carry their account (payments are unique per account).
    expect(projection.months[0].lines[0].accountId).toBe(h.bills.id);

    const hidden = await app.inject({ method: "GET", url, headers: strangerAuth });
    expect(hidden.statusCode).toBe(404);
  });

  // ---- payday schedule ----

  it("carries a payday schedule for each member's transfers on the household plan", async () => {
    const h = await seedHousehold(store, app);
    const plan = (
      await app.inject({
        method: "GET",
        url: `/api/households/${h.household.id}/plan?asOf=2026-06-15`,
        headers: h.auth,
      })
    ).json();

    interface Schedule {
      memberUserId: string;
      events: { date: string; totalMinor: number; transfers: { toAccountId: string }[] }[];
    }
    const schedules: Schedule[] = plan.paydaySchedule;
    expect(schedules.map((s) => s.memberUserId)).toEqual([h.alice.id, h.bob.id]);

    for (const schedule of schedules) {
      // Salaries are anchored to the 1st, so one payday: the 1st of the month.
      expect(schedule.events.map((e) => e.date)).toEqual(["2026-06-01"]);
      const planned = plan.transfers
        .filter((t: { memberUserId: string }) => t.memberUserId === schedule.memberUserId)
        .reduce((sum: number, t: { amountMinor: number }) => sum + t.amountMinor, 0);
      const scheduled = schedule.events.reduce((sum, e) => sum + e.totalMinor, 0);
      expect(scheduled).toBe(planned);
      expect(schedule.events[0]!.transfers[0]!.toAccountId).toBe(h.bills.id);
    }
  });

  // ---- upcoming feed ----

  /** Create an account holding one payment, for the upcoming-feed tests. */
  async function seedDuePayment(auth: Record<string, string>, name: string, payment: object) {
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name, currency: "GBP" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/payments`,
      headers: auth,
      payload: payment,
    });
    return account;
  }

  it("merges upcoming payments across accounts and filters by the window", async () => {
    const { auth } = await seedUser(store);
    const everyday = await seedDuePayment(auth, "Everyday", {
      name: "Rent",
      category: "monthly_recurring",
      amountMinor: 100000,
      dueDate: "2026-08-10",
    });
    const savings = await seedDuePayment(auth, "Savings", {
      name: "Car tax",
      category: "fixed_point",
      amountMinor: 22000,
      dueDate: "2026-08-05",
    });
    // Well outside a fortnight — must not appear.
    await seedDuePayment(auth, "Later", {
      name: "Christmas",
      category: "fixed_point",
      amountMinor: 40000,
      dueDate: "2026-12-01",
    });

    const feed = (
      await app.inject({
        method: "GET",
        url: "/api/upcoming?days=14&asOf=2026-08-03",
        headers: auth,
      })
    ).json();

    expect(feed.asOfDate).toBe("2026-08-03");
    expect(feed.days).toBe(14);
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toMatchObject({
      accountId: savings.id,
      accountName: "Savings",
      currency: "GBP",
      name: "Car tax",
      category: "fixed_point",
      amountMinor: 22000,
      dueDate: "2026-08-05",
      daysUntil: 2,
    });
    expect(feed.items[1]).toMatchObject({
      accountId: everyday.id,
      accountName: "Everyday",
      name: "Rent",
      dueDate: "2026-08-10",
      daysUntil: 7,
    });
  });

  it("clamps the window and caps the feed at 50 rows", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "Busy", currency: "GBP" },
      })
    ).json();
    // Eight fortnightly bills × 7 hits each in a 90-day window = 56 rows.
    for (let i = 0; i < 8; i++) {
      await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/payments`,
        headers: auth,
        payload: {
          name: `Bill ${i}`,
          category: "custom_recurring",
          amountMinor: 1000,
          dueDate: "2026-08-03",
          recurrence: { interval: 2, unit: "week", anchor: "2026-08-03" },
        },
      });
    }

    const feed = (
      await app.inject({
        method: "GET",
        url: "/api/upcoming?days=400&asOf=2026-08-03",
        headers: auth,
      })
    ).json();
    expect(feed.days).toBe(90); // clamped
    expect(feed.items).toHaveLength(50);
    // The cap keeps the soonest rows: the feed is sorted before it is sliced.
    expect(feed.items[0].dueDate).toBe("2026-08-03");
    expect(feed.items[49].dueDate <= "2026-10-26").toBe(true);
  });

  it("shows each caller only their own accounts' upcoming payments", async () => {
    const { auth } = await seedUser(store, "mine@example.com");
    await seedDuePayment(auth, "Mine", {
      name: "Rent",
      category: "monthly_recurring",
      amountMinor: 100000,
      dueDate: "2026-08-10",
    });
    const { auth: strangerAuth } = await seedUser(store, "theirs@example.com");

    const mine = (
      await app.inject({ method: "GET", url: "/api/upcoming?asOf=2026-08-03", headers: auth })
    ).json();
    expect(mine.items).toHaveLength(1);
    expect(mine.days).toBe(14); // default window

    const theirs = (
      await app.inject({
        method: "GET",
        url: "/api/upcoming?asOf=2026-08-03",
        headers: strangerAuth,
      })
    ).json();
    expect(theirs.items).toEqual([]);

    const unauthenticated = await app.inject({ method: "GET", url: "/api/upcoming" });
    expect(unauthenticated.statusCode).toBe(401);
  });

  // ---- contribution-first goals + tags ----

  /** An account with a £3,000/month salary, ready for goal + preview tests. */
  async function seedFundedAccount(auth: Record<string, string>, name = "Everyday") {
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name, currency: "GBP" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/incomes`,
      headers: auth,
      payload: {
        name: "Salary",
        amountMinor: 300000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
      },
    });
    return account;
  }

  it("accepts a fixed_point goal with a monthly amount and no due date", async () => {
    const { auth } = await seedUser(store);
    const account = await seedFundedAccount(auth);
    const created = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/payments`,
      headers: auth,
      payload: {
        name: "New bike",
        category: "fixed_point",
        amountMinor: 120000,
        fixedMonthlyMinor: 20000,
        tag: "toys",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().fixedMonthlyMinor).toBe(20000);
    expect(created.json().dueDate).toBeNull();

    const plan = (
      await app.inject({
        method: "GET",
        url: `/api/accounts/${account.id}/plan?asOf=2026-01-01`,
        headers: auth,
      })
    ).json();
    // The cap sets the contribution, and the pace sets the finish date.
    expect(plan.lines[0].requiredMonthlyMinor).toBe(20000);
    expect(plan.lines[0].fixedMonthlyMinor).toBe(20000);
    expect(plan.lines[0].targetDate).toBe("2026-07-01");
    expect(plan.leftoverMinor).toBe(280000);
  });

  it("rejects a fixed_point payment with neither a date nor a monthly amount (422)", async () => {
    const { auth } = await seedUser(store);
    const account = await seedFundedAccount(auth);
    const res = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/payments`,
      headers: auth,
      payload: { name: "Vague", category: "fixed_point", amountMinor: 120000 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("round-trips a payment tag and carries it onto the plan line", async () => {
    const { auth } = await seedUser(store);
    const account = await seedFundedAccount(auth);
    const payment = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/payments`,
        headers: auth,
        payload: {
          name: "Rent",
          category: "monthly_recurring",
          amountMinor: 100000,
          tag: "housing",
        },
      })
    ).json();
    expect(payment.tag).toBe("housing");

    const listed = (
      await app.inject({
        method: "GET",
        url: `/api/accounts/${account.id}/payments`,
        headers: auth,
      })
    ).json();
    expect(listed[0].tag).toBe("housing");

    const plan = (
      await app.inject({
        method: "GET",
        url: `/api/accounts/${account.id}/plan?asOf=2026-01-01`,
        headers: auth,
      })
    ).json();
    expect(plan.lines[0].tag).toBe("housing");

    // Both fields are patchable, including back off again.
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/payments/${payment.id}`,
      headers: auth,
      payload: { tag: "home", fixedMonthlyMinor: 5000 },
    });
    expect(patched.json().tag).toBe("home");
    expect(patched.json().fixedMonthlyMinor).toBe(5000);
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/payments/${payment.id}`,
      headers: auth,
      payload: { tag: null, fixedMonthlyMinor: null },
    });
    expect(cleared.json().tag).toBeNull();
    expect(cleared.json().fixedMonthlyMinor).toBeNull();
  });

  it("says on the plan line whether the due date was derived or set", async () => {
    const { auth } = await seedUser(store);
    const account = await seedFundedAccount(auth);

    const add = async (payload: Record<string, unknown>): Promise<string> =>
      (
        await app.inject({
          method: "POST",
          url: `/api/accounts/${account.id}/payments`,
          headers: auth,
          payload: { category: "fixed_point", amountMinor: 120000, ...payload },
        })
      ).json().id as string;

    const paced = await add({ name: "Paced", fixedMonthlyMinor: 20000 });
    const dated = await add({ name: "Dated", dueDate: "2026-09-01" });
    // Both: a pace *and* a promise. The two are indistinguishable in `dueDate`
    // — it is filled in either way — which is the whole reason for the flag.
    const both = await add({
      name: "Paced and dated",
      fixedMonthlyMinor: 20000,
      dueDate: "2026-09-01",
    });

    const plan = (
      await app.inject({
        method: "GET",
        url: `/api/accounts/${account.id}/plan?asOf=2026-01-01`,
        headers: auth,
      })
    ).json();
    const byId = new Map<string, { dueDateIsDerived: boolean; dueDate: string }>(
      plan.lines.map((l: { paymentId: string }) => [l.paymentId, l as never]),
    );

    expect(byId.get(paced)!.dueDateIsDerived).toBe(true);
    expect(byId.get(dated)!.dueDateIsDerived).toBe(false);
    expect(byId.get(both)!.dueDateIsDerived).toBe(false);
    // …and the dates alone would have told the UI nothing: the paced goal's is
    // as concrete on the wire as the one somebody typed.
    expect(byId.get(paced)!.dueDate).toBe("2026-07-01");
    expect(byId.get(both)!.dueDate).toBe("2026-09-01");
  });

  it("carries payment tags onto household plan lines too", async () => {
    const h = await seedHousehold(store, app);
    await app.inject({
      method: "POST",
      url: `/api/accounts/${h.bills.id}/payments`,
      headers: h.auth,
      payload: {
        name: "Broadband",
        category: "monthly_recurring",
        amountMinor: 4000,
        scope: "shared",
        tag: "utilities",
      },
    });
    const plan = (
      await app.inject({
        method: "GET",
        url: `/api/households/${h.household.id}/plan?asOf=2026-06-15`,
        headers: h.auth,
      })
    ).json();
    const broadband = plan.lines.find((l: { name: string }) => l.name === "Broadband");
    expect(broadband.tag).toBe("utilities");
    expect(plan.lines.find((l: { name: string }) => l.name === "Rent").tag).toBeNull();
  });

  // ---- what-if plan preview ----

  it("previews a plan with extra payments without persisting anything", async () => {
    const { auth } = await seedUser(store);
    const account = await seedFundedAccount(auth);
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/payments`,
      headers: auth,
      payload: { name: "Rent", category: "monthly_recurring", amountMinor: 100000 },
    });
    const before = await store.listPayments(account.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/plan/preview?asOf=2026-01-01`,
      headers: auth,
      payload: {
        addPayments: [{ name: "Gym", category: "monthly_recurring", amountMinor: 5000 }],
      },
    });
    expect(res.statusCode).toBe(200);
    const { base, preview } = res.json();
    expect(base.leftoverMinor).toBe(200000);
    expect(preview.leftoverMinor).toBe(195000);
    expect(base.lines).toHaveLength(1);
    expect(preview.lines).toHaveLength(2);
    expect(preview.lines.map((l: { paymentId: string }) => l.paymentId)).toContain(
      "preview-payment-1",
    );

    // Nothing was written: the account still holds exactly what it did.
    expect(await store.listPayments(account.id)).toEqual(before);
  });

  it("previews extra income too, and both overlays at once", async () => {
    const { auth } = await seedUser(store);
    const account = await seedFundedAccount(auth);

    const res = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/plan/preview?asOf=2026-01-01`,
      headers: auth,
      payload: {
        addIncomes: [
          { name: "Side gig", amountMinor: 50000, frequency: "monthly", anchorDate: "2026-01-01" },
        ],
        addPayments: [
          {
            name: "New bike",
            category: "fixed_point",
            amountMinor: 120000,
            fixedMonthlyMinor: 20000,
            tag: "toys",
          },
        ],
      },
    });
    const { base, preview } = res.json();
    expect(base.monthlyIncomeMinor).toBe(300000);
    expect(preview.monthlyIncomeMinor).toBe(350000);
    expect(preview.leftoverMinor).toBe(330000); // 350000 income − the 20000 cap
    expect(preview.lines[0]).toMatchObject({
      paymentId: "preview-payment-1",
      requiredMonthlyMinor: 20000,
      fixedMonthlyMinor: 20000,
      tag: "toys",
    });
    expect(await store.listIncomes(account.id)).toHaveLength(1);
  });

  it("rejects an empty or oversized preview overlay (422)", async () => {
    const { auth } = await seedUser(store);
    const account = await seedFundedAccount(auth);
    const url = `/api/accounts/${account.id}/plan/preview`;

    const empty = await app.inject({ method: "POST", url, headers: auth, payload: {} });
    expect(empty.statusCode).toBe(422);
    const emptyArrays = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { addPayments: [], addIncomes: [] },
    });
    expect(emptyArrays.statusCode).toBe(422);

    const tooMany = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: {
        addPayments: Array.from({ length: 6 }, (_, i) => ({
          name: `Bill ${i}`,
          category: "monthly_recurring",
          amountMinor: 1000,
        })),
      },
    });
    expect(tooMany.statusCode).toBe(422);

    // Overlay entries are validated like real payments.
    const invalid = await app.inject({
      method: "POST",
      url,
      headers: auth,
      payload: { addPayments: [{ name: "Vague", category: "fixed_point", amountMinor: 1000 }] },
    });
    expect(invalid.statusCode).toBe(422);
  });

  it("lets a view-only member preview a shared account but hides it from strangers", async () => {
    const { user, auth } = await seedUser(store, "owner-prev@example.com");
    const { user: partner, auth: partnerAuth } = await seedUser(store, "partner-prev@example.com");
    const { auth: strangerAuth } = await seedUser(store, "stranger-prev@example.com");
    const account = await seedFundedAccount(auth);

    const household = await store.createHousehold("Home", user.id);
    await store.addMembership(household.id, partner.id, "member");
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/shares`,
      headers: auth,
      payload: { householdId: household.id, permission: "view" },
    });

    const url = `/api/accounts/${account.id}/plan/preview?asOf=2026-01-01`;
    const payload = {
      addPayments: [{ name: "Gym", category: "monthly_recurring", amountMinor: 5000 }],
    };
    const seen = await app.inject({ method: "POST", url, headers: partnerAuth, payload });
    expect(seen.statusCode).toBe(200);
    expect(seen.json().preview.leftoverMinor).toBe(295000);

    const hidden = await app.inject({ method: "POST", url, headers: strangerAuth, payload });
    expect(hidden.statusCode).toBe(404);

    const unauthenticated = await app.inject({ method: "POST", url, payload });
    expect(unauthenticated.statusCode).toBe(401);
  });
});

/**
 * The inflow routes: authoring money arriving, from outside the estate or from
 * another account you own. Everything WP-F, WP-G and WP-H built was reachable
 * only through the Store until these existed.
 */
describe("inflows over HTTP", () => {
  let store: MemoryStore;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    store = new MemoryStore();
    app = buildServer({ store, env, registerAuthProxy: false });
  });

  const makeAccount = async (auth: { authorization: string }, name: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name, currency: "GBP" },
      })
    ).json();

  const movementBody = (sourceAccountId: string, over: object = {}) => ({
    name: "Monthly top-up",
    source: "account",
    sourceAccountId,
    amountMinor: 20000,
    frequency: "monthly",
    anchorDate: "2026-01-01",
    priority: 50,
    ...over,
  });

  it("authors a movement, and both ends read the same row", async () => {
    const { auth } = await seedUser(store);
    const current = await makeAccount(auth, "current");
    const pot = await makeAccount(auth, "pot");

    const created = await app.inject({
      method: "POST",
      url: `/api/accounts/${pot.id}/inflows`,
      headers: auth,
      payload: movementBody(current.id),
    });
    expect(created.statusCode).toBe(201);
    const movement = created.json();
    expect(movement.source).toBe("account");
    expect(movement.sourceAccountId).toBe(current.id);
    expect(movement.priority).toBe(50);

    // One row, two faces: arriving on the pot, leaving the current account.
    const arriving = await app.inject({
      method: "GET",
      url: `/api/accounts/${pot.id}/inflows`,
      headers: auth,
    });
    expect(arriving.json().map((i: { id: string }) => i.id)).toEqual([movement.id]);
    const leaving = await app.inject({
      method: "GET",
      url: `/api/accounts/${current.id}/inflows/outbound`,
      headers: auth,
    });
    expect(leaving.json().map((i: { id: string }) => i.id)).toEqual([movement.id]);
    // ...and nothing arrives into the sender.
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/accounts/${current.id}/inflows`,
          headers: auth,
        })
      ).json(),
    ).toEqual([]);
  });

  it("authors an external inflow the income routes can see", async () => {
    const { auth } = await seedUser(store);
    const account = await makeAccount(auth, "current");
    const created = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/inflows`,
      headers: auth,
      payload: {
        name: "Salary",
        amountMinor: 300000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().source).toBe("external");
    expect(created.json().sourceAccountId).toBeNull();

    const incomes = await app.inject({
      method: "GET",
      url: `/api/accounts/${account.id}/incomes`,
      headers: auth,
    });
    expect(incomes.json().map((i: { name: string }) => i.name)).toEqual(["Salary"]);
  });

  /**
   * The access rule authoring turns on. A movement commits the *sending*
   * account's surplus every month from the moment it exists, so being allowed
   * to look at that account cannot be enough.
   */
  it("will not spend an account it may only look at", async () => {
    const { auth } = await seedUser(store);
    const { user: bob, auth: bobAuth } = await seedUser(store, "bob@example.com");
    const household = await store.createHousehold("Home", bob.id);
    await store.addMembership(
      household.id,
      (await store.getUserByEmail("owner@example.com"))!.id,
      "member",
    );

    const bobCurrent = await makeAccount(bobAuth, "bob-current");
    const myPot = await makeAccount(auth, "my-pot");
    await store.createAccountShare(bobCurrent.id, household.id, "view");

    // Visible, and still not spendable.
    expect(
      (await app.inject({ method: "GET", url: `/api/accounts/${bobCurrent.id}`, headers: auth }))
        .statusCode,
    ).toBe(200);
    const refused = await app.inject({
      method: "POST",
      url: `/api/accounts/${myPot.id}/inflows`,
      headers: auth,
      payload: movementBody(bobCurrent.id),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("forbidden");
    expect(await store.listInflows(myPot.id)).toEqual([]);

    // Edit on the sender, and it goes through.
    await store.createAccountShare(bobCurrent.id, household.id, "edit");
    const allowed = await app.inject({
      method: "POST",
      url: `/api/accounts/${myPot.id}/inflows`,
      headers: auth,
      payload: movementBody(bobCurrent.id),
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("says nothing about a source account it cannot see", async () => {
    const { auth } = await seedUser(store);
    const { auth: bobAuth } = await seedUser(store, "bob@example.com");
    const mine = await makeAccount(auth, "mine");
    const theirs = await makeAccount(bobAuth, "theirs");

    const hidden = await app.inject({
      method: "POST",
      url: `/api/accounts/${mine.id}/inflows`,
      headers: auth,
      payload: movementBody(theirs.id),
    });
    const absent = await app.inject({
      method: "POST",
      url: `/api/accounts/${mine.id}/inflows`,
      headers: auth,
      payload: movementBody("11111111-1111-4111-8111-111111111111"),
    });
    // An account somebody else owns and an account that does not exist answer
    // identically, so this cannot be used to find out which is which.
    expect(hidden.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(hidden.json()).toEqual(absent.json());
  });

  it("refuses an account that funds itself, at the API and not only at the CHECK", async () => {
    const { auth } = await seedUser(store);
    const account = await makeAccount(auth, "solo");
    const res = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/inflows`,
      headers: auth,
      payload: movementBody(account.id),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_error");
  });

  /**
   * There is no exchange rate anywhere in this system, and the rollup nets
   * intra-estate movement inside one currency bucket — so a movement across two
   * of them would leave `totalFunded + leftover === income - buffer` broken in
   * both. Refused rather than converted at an invented rate.
   */
  it("refuses a movement that crosses currencies", async () => {
    const { auth } = await seedUser(store);
    const pounds = await makeAccount(auth, "current");
    const dollars = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "us-pot", currency: "USD" },
      })
    ).json();

    const refused = await app.inject({
      method: "POST",
      url: `/api/accounts/${dollars.id}/inflows`,
      headers: auth,
      payload: movementBody(pounds.id),
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe("validation_error");
    expect(refused.json().error.message).toMatch(/GBP to USD/);
    expect(await store.listInflows(dollars.id)).toEqual([]);

    // The same movement between two accounts in one currency is fine.
    const sameCurrency = await makeAccount(auth, "gbp-pot");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/accounts/${sameCurrency.id}/inflows`,
          headers: auth,
          payload: movementBody(pounds.id),
        })
      ).statusCode,
    ).toBe(201);
  });

  it("rejects a source account on an external inflow, and one missing from a movement", async () => {
    const { auth } = await seedUser(store);
    const a = await makeAccount(auth, "a");
    const b = await makeAccount(auth, "b");
    const post = (payload: object) =>
      app.inject({ method: "POST", url: `/api/accounts/${a.id}/inflows`, headers: auth, payload });

    expect(
      (
        await post({
          name: "Salary",
          amountMinor: 1000,
          frequency: "monthly",
          anchorDate: "2026-01-01",
          sourceAccountId: b.id,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await post({
          name: "Top-up",
          source: "account",
          amountMinor: 1000,
          frequency: "monthly",
          anchorDate: "2026-01-01",
        })
      ).statusCode,
    ).toBe(422);
  });

  /** Priority ranks a movement among what leaves the sending account. Nothing
   *  sends a salary, so asking for one on an external inflow is refused rather
   *  than ignored. */
  it("refuses a priority on an external inflow, on create and on update", async () => {
    const { auth } = await seedUser(store);
    const account = await makeAccount(auth, "current");
    const created = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/inflows`,
      headers: auth,
      payload: {
        name: "Salary",
        amountMinor: 1000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
        priority: 5,
      },
    });
    expect(created.statusCode).toBe(422);

    const ok = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/inflows`,
      headers: auth,
      payload: {
        name: "Salary",
        amountMinor: 1000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
      },
    });
    // Carried on every row, meaningful on none of these: the default rank.
    expect(ok.json().priority).toBe(100);
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/inflows/${ok.json().id}`,
      headers: auth,
      payload: { priority: 5 },
    });
    expect(patched.statusCode).toBe(422);
  });

  it("updates what a movement asks for, but not which accounts it runs between", async () => {
    const { auth } = await seedUser(store);
    const current = await makeAccount(auth, "current");
    const other = await makeAccount(auth, "other");
    const pot = await makeAccount(auth, "pot");
    const movement = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${pot.id}/inflows`,
        headers: auth,
        payload: movementBody(current.id),
      })
    ).json();

    const changed = await app.inject({
      method: "PATCH",
      url: `/api/inflows/${movement.id}`,
      headers: auth,
      payload: { amountMinor: 30000, priority: 10, active: false },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ amountMinor: 30000, priority: 10, active: false });

    for (const payload of [
      { sourceAccountId: other.id },
      { accountId: other.id },
      { source: "external" },
    ]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/inflows/${movement.id}`,
        headers: auth,
        payload,
      });
      expect(res.statusCode).toBe(422);
    }
    // Untouched by every refusal above.
    expect((await store.getInflow(movement.id))!.sourceAccountId).toBe(current.id);
  });

  /** Authoring takes edit on both ends; calling it off takes edit on either.
   *  Laying a claim on somebody's surplus is not the same act as releasing one. */
  it("lets the sending end call a movement off", async () => {
    const { auth } = await seedUser(store);
    const { user: bob, auth: bobAuth } = await seedUser(store, "bob@example.com");
    const me = (await store.getUserByEmail("owner@example.com"))!;
    const household = await store.createHousehold("Home", bob.id);
    await store.addMembership(household.id, me.id, "member");

    const bobCurrent = await makeAccount(bobAuth, "bob-current");
    const myPot = await makeAccount(auth, "my-pot");
    await store.createAccountShare(bobCurrent.id, household.id, "edit");
    const movement = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${myPot.id}/inflows`,
        headers: auth,
        payload: movementBody(bobCurrent.id),
      })
    ).json();

    // Bob cannot see the pot at all, and can still stop money leaving his own
    // account.
    expect(
      (await app.inject({ method: "GET", url: `/api/accounts/${myPot.id}`, headers: bobAuth }))
        .statusCode,
    ).toBe(404);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/inflows/${movement.id}`,
      headers: bobAuth,
    });
    expect(removed.statusCode).toBe(204);
    expect(await store.getInflow(movement.id)).toBeNull();
  });

  it("hides an inflow from a stranger and refuses a viewer", async () => {
    const { auth } = await seedUser(store);
    const { user: carol, auth: carolAuth } = await seedUser(store, "carol@example.com");
    const { auth: strangerAuth } = await seedUser(store, "nobody@example.com");
    const current = await makeAccount(auth, "current");
    const pot = await makeAccount(auth, "pot");
    const movement = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${pot.id}/inflows`,
        headers: auth,
        payload: movementBody(current.id),
      })
    ).json();

    const household = await store.createHousehold("Carol's place", carol.id);
    await store.createAccountShare(pot.id, household.id, "view");

    const stranger = await app.inject({
      method: "DELETE",
      url: `/api/inflows/${movement.id}`,
      headers: strangerAuth,
    });
    expect(stranger.statusCode).toBe(404);
    const viewer = await app.inject({
      method: "DELETE",
      url: `/api/inflows/${movement.id}`,
      headers: carolAuth,
    });
    expect(viewer.statusCode).toBe(403);
  });

  /**
   * The income routes are the external half of these very rows, and WP-F held
   * that line at the Store. It is held here too: a movement is invisible to
   * every one of them.
   */
  it("keeps an account-sourced inflow out of the income routes", async () => {
    const { auth } = await seedUser(store);
    const current = await makeAccount(auth, "current");
    const pot = await makeAccount(auth, "pot");
    const movement = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${pot.id}/inflows`,
        headers: auth,
        payload: movementBody(current.id),
      })
    ).json();

    const listed = await app.inject({
      method: "GET",
      url: `/api/accounts/${pot.id}/incomes`,
      headers: auth,
    });
    expect(listed.json()).toEqual([]);
    for (const method of ["PATCH", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: `/api/incomes/${movement.id}`,
        headers: auth,
        payload: { amountMinor: 1 },
      });
      expect(res.statusCode).toBe(404);
    }
    // Still there, untouched by either attempt.
    expect((await store.getInflow(movement.id))!.amountMinor).toBe(20000);
  });

  /**
   * WP-G decided a funding loop is detected at compute time and broken, never
   * refused at authoring: a cycle is a property of the estate, not of whichever
   * edge happened to be saved last. So both edges are accepted, and the plan is
   * where the loop is named — end to end, over HTTP.
   */
  it("accepts an edge that closes a loop, and names the loop on the plan", async () => {
    const { auth } = await seedUser(store);
    const a = await makeAccount(auth, "a");
    const b = await makeAccount(auth, "b");

    const first = await app.inject({
      method: "POST",
      url: `/api/accounts/${b.id}/inflows`,
      headers: auth,
      payload: movementBody(a.id, { name: "a to b" }),
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/accounts/${a.id}/inflows`,
      headers: auth,
      payload: movementBody(b.id, { name: "b to a" }),
    });
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);

    for (const account of [a, b]) {
      const plan = (
        await app.inject({
          method: "GET",
          url: `/api/accounts/${account.id}/plan`,
          headers: auth,
        })
      ).json();
      expect([...plan.fundingCycleAccountIds].sort()).toEqual([a.id, b.id].sort());
    }
    // ...and the overview still answers rather than hanging on it.
    const overview = await app.inject({ method: "GET", url: "/api/overview", headers: auth });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().perCurrency[0].accounts).toHaveLength(2);
  });

  /**
   * The overview is one estate pass now. The pass reaches accounts the caller
   * cannot see — it must, since that is where the money comes from — so this
   * pins that only the accounts they *can* see come back, and that the row they
   * get agrees with the account's own plan endpoint to the penny.
   */
  it("plans the whole estate at once and still shows only what the caller may see", async () => {
    const { auth } = await seedUser(store);
    const { user: bob, auth: bobAuth } = await seedUser(store, "bob@example.com");
    const me = (await store.getUserByEmail("owner@example.com"))!;
    const household = await store.createHousehold("Home", bob.id);
    await store.addMembership(household.id, me.id, "member");

    const bobCurrent = await makeAccount(bobAuth, "bob-current");
    await app.inject({
      method: "POST",
      url: `/api/accounts/${bobCurrent.id}/incomes`,
      headers: bobAuth,
      payload: {
        name: "Salary",
        amountMinor: 300000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
      },
    });
    const myPot = await makeAccount(auth, "my-pot");
    await app.inject({
      method: "POST",
      url: `/api/accounts/${myPot.id}/payments`,
      headers: auth,
      payload: { name: "Council tax", category: "monthly_recurring", amountMinor: 15000 },
    });
    await store.createAccountShare(bobCurrent.id, household.id, "edit");
    await app.inject({
      method: "POST",
      url: `/api/accounts/${myPot.id}/inflows`,
      headers: auth,
      payload: movementBody(bobCurrent.id),
    });
    // Bob's account leaves my view again: the money still arrives, and I still
    // must not be shown his account.
    await store.deleteAccountShare((await store.listSharesForAccount(bobCurrent.id))[0]!.id);

    const overview = (
      await app.inject({ method: "GET", url: "/api/overview", headers: auth })
    ).json();
    const rows = overview.perCurrency[0].accounts;
    expect(rows.map((r: { accountId: string }) => r.accountId)).toEqual([myPot.id]);

    const plan = (
      await app.inject({ method: "GET", url: `/api/accounts/${myPot.id}/plan`, headers: auth })
    ).json();
    expect(plan.allocatedInflowMinor).toBe(20000);
    expect(rows[0].allocatedInflowMinor).toBe(plan.allocatedInflowMinor);
    expect(rows[0].confirmedInflowMinor).toBe(plan.confirmedInflowMinor);
    // The sender is outside the rollup, and nothing of his is netted out of it —
    // there is no netting term left to do it with. My pot's £150 bill is my own
    // (an account no household plans bears its own payments), so Bob's account
    // is planned beside mine without taking a share of it.
    expect(overview.perCurrency[0].leftoverMinor).toBe(0);
    expect(overview.perCurrency[0].shortfallMinor).toBe(15000);
  });

  /**
   * The itemisation the Overview used to buy an account plan per row to get.
   *
   * A checklist row has to name the *authored inflow* to confirm against it,
   * and the index sent per-account inflow totals without ever itemising them —
   * so the page read a whole plan for every account with money in transit, for
   * the ids alone. These are the same arrivals the account plan already carries
   * unfiltered: ids and amounts, never a name. `planInflowSources` gates names
   * and only names, which is why this needs no gate of its own, and the sender
   * here is an account the caller cannot see at all.
   */
  it("itemises the arriving money by inflow, and names nobody", async () => {
    const { auth } = await seedUser(store);
    const { user: bob, auth: bobAuth } = await seedUser(store, "bob@example.com");
    const me = (await store.getUserByEmail("owner@example.com"))!;
    const household = await store.createHousehold("Home", bob.id);
    await store.addMembership(household.id, me.id, "member");

    const bobCurrent = await makeAccount(bobAuth, "bob-current");
    await app.inject({
      method: "POST",
      url: `/api/accounts/${bobCurrent.id}/incomes`,
      headers: bobAuth,
      payload: {
        name: "Salary",
        amountMinor: 300000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
      },
    });
    const pot = await makeAccount(auth, "pot");
    const quiet = await makeAccount(auth, "quiet");
    await store.createAccountShare(bobCurrent.id, household.id, "edit");
    const movement = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${pot.id}/inflows`,
        headers: auth,
        payload: movementBody(bobCurrent.id),
      })
    ).json();
    // The sender leaves my view again. The money still arrives.
    await store.deleteAccountShare((await store.listSharesForAccount(bobCurrent.id))[0]!.id);

    const rows = (await app.inject({ method: "GET", url: "/api/overview", headers: auth })).json()
      .perCurrency[0].accounts;
    const plan = (
      await app.inject({ method: "GET", url: `/api/accounts/${pot.id}/plan`, headers: auth })
    ).json();
    const row = rows.find((r: { accountId: string }) => r.accountId === pot.id);

    // Byte for byte what the plan endpoint already sends, so no screen can
    // disagree with another about what arrived.
    expect(row.inflowArrivals).toEqual(plan.inflowArrivals);
    expect(row.inflowArrivals).toEqual([
      {
        inflowId: movement.id,
        fromAccountId: bobCurrent.id,
        amountMinor: 20000,
        confirmedMinor: 0,
      },
    ]);
    // The id of an account I cannot see travels; its *name* does not, here or
    // on the plan.
    expect(JSON.stringify(row)).not.toContain("bob-current");
    expect(plan.inflowSources).toEqual([
      {
        kind: "account",
        inflowId: movement.id,
        fromAccountId: bobCurrent.id,
        amountMinor: 20000,
        confirmedMinor: 0,
      },
    ]);

    // Omitted, not sent empty, on the ordinary account nothing moves into.
    const other = rows.find((r: { accountId: string }) => r.accountId === quiet.id);
    expect(other).not.toHaveProperty("inflowArrivals");
  });

  /**
   * The double-count guard, over the shape that used to hide it: a chain.
   *
   * Each hop's pound used to be reported as the sender's leftover *and* as the
   * receiver's funded money, so the rollup netted it once per hop. The pass
   * takes it out of the sender's surplus instead, so the rollup is a plain sum
   * and the identity holds with nothing subtracted — and, as the assertions
   * below insist, the income figure does not move by a penny however many
   * transfers the pass derives.
   */
  it("counts every pound once across a chain, with no netting term", async () => {
    const { auth } = await seedUser(store);
    const current = await makeAccount(auth, "current");
    const pot = await makeAccount(auth, "pot");
    const isa = await makeAccount(auth, "isa");
    await app.inject({
      method: "POST",
      url: `/api/accounts/${current.id}/incomes`,
      headers: auth,
      payload: {
        name: "Salary",
        amountMinor: 300000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
      },
    });
    for (const [to, from] of [
      [pot, current],
      [isa, pot],
    ]) {
      await app.inject({
        method: "POST",
        url: `/api/accounts/${to!.id}/inflows`,
        headers: auth,
        payload: movementBody(from!.id, { amountMinor: 50000 }),
      });
      await app.inject({
        method: "POST",
        url: `/api/accounts/${to!.id}/payments`,
        headers: auth,
        payload: { name: `bill-${to!.name}`, category: "monthly_recurring", amountMinor: 40000 },
      });
    }

    const bucket = (await app.inject({ method: "GET", url: "/api/overview", headers: auth })).json()
      .perCurrency[0];
    // £3,000 in from outside, and nothing else: the movements and the transfers
    // the pass derives both redistribute money already counted. Two derived
    // transfers and two authored movements later, the figure has not moved.
    expect(bucket.monthlyIncomeMinor).toBe(300000);
    // Both £400 bills are the owner's own obligations, funded from their one
    // budget and transported by transfers the pass derives; the authored
    // movements carry surplus on afterwards, as savings.
    expect(bucket.totalFundedMinor).toBe(80000);
    expect(bucket.leftoverMinor).toBe(220000);
    expect(bucket).not.toHaveProperty("intraEstateMovementMinor");
    // The identity that has to hold for an estate that funds itself.
    expect(bucket.totalFundedMinor + bucket.leftoverMinor).toBe(
      bucket.monthlyIncomeMinor - bucket.bufferMinor,
    );
  });
});

describe("export / import", () => {
  let store: MemoryStore;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    store = new MemoryStore();
    app = buildServer({ store, env, registerAuthProxy: false });
  });

  /** An owned account with one of everything hanging off it. */
  async function seedRichAccount(ownerId: string) {
    const account = await store.createAccount({
      ownerUserId: ownerId,
      name: "Everyday",
      description: "Primary",
      currency: "GBP",
      openingBalanceMinor: 250_000,
      monthlyBufferMinor: 10_000,
    });
    await store.createIncome({
      accountId: account.id,
      name: "Salary",
      amountMinor: 300_000,
      frequency: "monthly",
      recurrence: null,
      anchorDate: "2026-01-25",
      active: true,
    });
    const payment = await store.createPayment({
      accountId: account.id,
      name: "Holiday",
      category: "fixed_point",
      amountMinor: 120_000,
      dueDate: "2027-08-01",
      recurrence: null,
      targetDate: null,
      priority: 5,
      alreadySavedMinor: 1_000,
      autoRenew: true,
      active: true,
      notes: "Majorca",
      projectId: null,
      scope: "personal",
      bearerUserId: ownerId,
      fixedMonthlyMinor: 20_000,
      tag: "travel",
    });
    await store.createContribution({
      paymentId: payment.id,
      accountId: account.id,
      userId: ownerId,
      month: "2026-08-01",
      amountMinor: 20_000,
      note: "August",
      transferConfirmationId: null,
    });
    await store.upsertBalanceSnapshot({
      accountId: account.id,
      asOfDate: "2026-08-01",
      balanceMinor: 240_000,
    });
    await store.createMonthClose({
      householdId: null,
      accountId: account.id,
      month: "2026-07-01",
      incomeMinor: 300_000,
      plannedMinor: 20_000,
      contributedMinor: 20_000,
      closedBy: ownerId,
    });
    await store.createProject({
      ownerUserId: ownerId,
      name: "House move",
      description: null,
      color: "#abc",
      targetDate: "2027-01-01",
    });
    return account;
  }

  it("exports everything owned, as a download", async () => {
    const { user, auth } = await seedUser(store, "exporter@example.com");
    await seedRichAccount(user.id);

    const res = await app.inject({ method: "GET", url: "/api/export", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="finance-planner-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );

    const file = res.json();
    expect(file.version).toBe(1);
    expect(file.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(file.accounts).toHaveLength(1);
    expect(file.projects.map((p: { name: string }) => p.name)).toEqual(["House move"]);

    const account = file.accounts[0];
    expect(account.name).toBe("Everyday");
    expect(account.monthlyBufferMinor).toBe(10_000);
    expect(account.incomes).toHaveLength(1);
    expect(account.balanceSnapshots).toEqual([{ asOfDate: "2026-08-01", balanceMinor: 240_000 }]);
    expect(account.closes).toEqual([
      { month: "2026-07-01", incomeMinor: 300_000, plannedMinor: 20_000, contributedMinor: 20_000 },
    ]);

    const payment = account.payments[0];
    expect(payment.fixedMonthlyMinor).toBe(20_000);
    expect(payment.tag).toBe("travel");
    expect(payment.scope).toBe("personal");
    expect(payment.notes).toBe("Majorca");
    expect(payment.contributions).toEqual([
      { month: "2026-08-01", amountMinor: 20_000, note: "August" },
    ]);
    // Cross-entity ids don't travel: no row id survives the document.
    expect(payment.bearerUserId).toBeUndefined();
    expect(payment.projectId).toBeUndefined();
    expect(payment.id).toBeUndefined();
    expect(account.id).toBeUndefined();
  });

  it("leaves accounts shared in by someone else to their owner", async () => {
    const { user: owner, auth: ownerAuth } = await seedUser(store, "sharer@example.com");
    const { user: guest, auth: guestAuth } = await seedUser(store, "guest@example.com");
    const shared = await seedRichAccount(owner.id);
    const household = await store.createHousehold("Home", owner.id);
    await store.addMembership(household.id, guest.id, "member");
    await store.createAccountShare(shared.id, household.id, "edit");

    // The guest can see it in their own account list…
    const visible = await app.inject({ method: "GET", url: "/api/accounts", headers: guestAuth });
    expect(visible.json()).toHaveLength(1);
    // …but exports nothing, because they own nothing.
    const guestExport = await app.inject({ method: "GET", url: "/api/export", headers: guestAuth });
    expect(guestExport.json().accounts).toEqual([]);
    // The owner still exports it.
    const ownerExport = await app.inject({ method: "GET", url: "/api/export", headers: ownerAuth });
    expect(ownerExport.json().accounts).toHaveLength(1);
  });

  it("imports an export under a different user with fresh ids", async () => {
    const { user: from, auth: fromAuth } = await seedUser(store, "from@example.com");
    const { user: to, auth: toAuth } = await seedUser(store, "to@example.com");
    await seedRichAccount(from.id);
    const file = (
      await app.inject({ method: "GET", url: "/api/export", headers: fromAuth })
    ).json();

    const res = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: toAuth,
      payload: file,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      accounts: 1,
      incomes: 1,
      accountInflows: 0,
      accountInflowConfirmations: 0,
      payments: 1,
      contributions: 1,
      balanceSnapshots: 1,
      closes: 1,
      projects: 1,
    });

    const imported = await store.listAccountsForOwner(to.id);
    expect(imported).toHaveLength(1);
    expect(imported[0]!.id).not.toBe((await store.listAccountsForOwner(from.id))[0]!.id);
    const payments = await store.listPayments(imported[0]!.id);
    expect(payments[0]!.tag).toBe("travel");
    // The links that couldn't survive are cleanly null, not dangling.
    expect(payments[0]!.bearerUserId).toBeNull();
    expect(payments[0]!.projectId).toBeNull();
    // Contributions land under the importing user, unhooked from any transfer.
    const contributions = await store.listContributionsForAccount(imported[0]!.id);
    expect(contributions[0]!.userId).toBe(to.id);
    expect(contributions[0]!.transferConfirmationId).toBeNull();
    // …and the exporter still has theirs: import adds, it never moves.
    expect(await store.listAccountsForOwner(from.id)).toHaveLength(1);
  });

  it("is additive: importing the same file twice gives two copies", async () => {
    const { user, auth } = await seedUser(store, "twice@example.com");
    await seedRichAccount(user.id);
    const file = (await app.inject({ method: "GET", url: "/api/export", headers: auth })).json();

    await app.inject({ method: "POST", url: "/api/import", headers: auth, payload: file });
    await app.inject({ method: "POST", url: "/api/import", headers: auth, payload: file });
    expect(await store.listAccountsForOwner(user.id)).toHaveLength(3); // original + 2
  });

  it("rejects a file that isn't an export (422) and an anonymous caller (401)", async () => {
    const { auth } = await seedUser(store, "bad@example.com");
    for (const payload of [
      { version: 2, exportedAt: new Date().toISOString(), accounts: [], projects: [] },
      { version: 1, exportedAt: "yesterday", accounts: [], projects: [] },
      { version: 1, exportedAt: new Date().toISOString(), accounts: [{ currency: "GBP" }] },
      { nope: true },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/import", headers: auth, payload });
      expect(res.statusCode).toBe(422);
    }
    expect((await app.inject({ method: "GET", url: "/api/export" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/import", payload: {} })).statusCode).toBe(
      401,
    );
  });
});

describe("meta + demo seed", () => {
  const demoEnv: ApiEnv = { ...env, enableDemoSeed: true };
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it("reports the demo seed as off, and hides the route entirely", async () => {
    const app = buildServer({ store, env, registerAuthProxy: false });
    const meta = await app.inject({ method: "GET", url: "/api/meta" });
    expect(meta.statusCode).toBe(200); // public: no token needed
    expect(meta.json()).toEqual({ demoSeedEnabled: false });

    const { auth } = await seedUser(store, "nodemo@example.com");
    const seed = await app.inject({ method: "POST", url: "/api/demo/seed", headers: auth });
    expect(seed.statusCode).toBe(404); // 404, not 403: a disabled feature doesn't advertise itself
  });

  it("seeds a worked example into an empty account, once", async () => {
    const app = buildServer({ store, env: demoEnv, registerAuthProxy: false });
    expect((await app.inject({ method: "GET", url: "/api/meta" })).json()).toEqual({
      demoSeedEnabled: true,
    });

    const { user, auth } = await seedUser(store, "demo@example.com");
    const seed = await app.inject({ method: "POST", url: "/api/demo/seed", headers: auth });
    expect(seed.statusCode).toBe(201);
    expect(seed.json()).toEqual({
      accounts: 1,
      incomes: 1,
      payments: 4,
      contributions: 1,
      balanceSnapshots: 1,
    });

    const accounts = await store.listAccountsForOwner(user.id);
    expect(accounts[0]!.name).toBe("Everyday Account");
    expect(accounts[0]!.openingBalanceMinor).toBe(250_000);
    const payments = await store.listPayments(accounts[0]!.id);
    expect(payments.map((p) => p.name).sort()).toEqual([
      "Car insurance",
      "Phone bill",
      "Summer holiday",
      "Water bill",
    ]);
    expect(payments.filter((p) => p.tag).map((p) => p.tag)).toEqual(["utilities"]);
    // Dates are relative to today, so the plan is alive rather than historical.
    const today = new Date().toISOString().slice(0, 10);
    expect(payments.every((p) => !p.dueDate || p.dueDate > today)).toBe(true);
    expect((await store.listBalanceSnapshots(accounts[0]!.id))[0]!.asOfDate).toBe(today);

    // The plan actually computes over the seeded data.
    const plan = await app.inject({
      method: "GET",
      url: `/api/accounts/${accounts[0]!.id}/plan`,
      headers: auth,
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().monthlyIncomeMinor).toBe(250_000);

    // Second run refuses: the account is no longer empty.
    const again = await app.inject({ method: "POST", url: "/api/demo/seed", headers: auth });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("demo_not_empty");
  });

  it("still needs a token", async () => {
    const app = buildServer({ store, env: demoEnv, registerAuthProxy: false });
    expect((await app.inject({ method: "POST", url: "/api/demo/seed" })).statusCode).toBe(401);
  });
});

/**
 * The flow endpoint: where money goes across any set of accounts.
 *
 * The interesting case is the one the household-only diagram could never draw —
 * a scope spanning two households and a pot that belongs to neither.
 */
describe("flow over any scope", () => {
  let store: MemoryStore;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    store = new MemoryStore();
    app = buildServer({ store, env, registerAuthProxy: false });
  });

  const flow = (auth: { authorization: string }, ids: string[], asOf = "2026-08-04") =>
    app.inject({
      method: "GET",
      url: `/api/flow?accounts=${ids.join(",")}&asOf=${asOf}`,
      headers: auth,
    });

  /**
   * Alice is in two households — one with Bob, one with Carol — and also keeps
   * a standalone ISA that no household has ever heard of, fed by a movement out
   * of her current account. One diagram, all of it.
   */
  async function seedTwoHouseholdsAndAPot() {
    const { user: alice, auth } = await seedUser(store, "alice@example.com");
    const { user: bob } = await seedUser(store, "bob@example.com");
    const { user: carol } = await seedUser(store, "carol@example.com");

    const make = async (name: string, incomeMinor?: number) => {
      const account = (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers: auth,
          payload: { name, currency: "GBP" },
        })
      ).json();
      if (incomeMinor) {
        await app.inject({
          method: "POST",
          url: `/api/accounts/${account.id}/incomes`,
          headers: auth,
          payload: {
            name: "Pay",
            amountMinor: incomeMinor,
            frequency: "monthly",
            anchorDate: "2026-01-01",
          },
        });
      }
      return account;
    };

    const current = await make("current", 400_000);
    const homeBills = await make("home-bills");
    // Alice's second current account, the one the flat is paid out of. It is
    // deliberately left out of the diagram below, so the flat's rent arrives
    // across the scope's edge while the home's arrives account to account.
    const flatCurrent = await make("flat-current", 150_000);
    const flatBills = await make("flat-bills");
    const isa = await make("isa");

    const bill = (accountId: string, name: string, amountMinor: number) =>
      app.inject({
        method: "POST",
        url: `/api/accounts/${accountId}/payments`,
        headers: auth,
        payload: { name, category: "monthly_recurring", amountMinor, scope: "shared" },
      });
    await bill(homeBills.id, "Rent", 100_000);
    await bill(flatBills.id, "Council tax", 40_000);

    const home = await store.createHousehold("Home", alice.id);
    await store.addMembership(home.id, bob.id, "member");
    const flat = await store.createHousehold("Flat", alice.id);
    await store.addMembership(flat.id, carol.id, "member");
    const assign = (householdId: string, accountId: string, payload: object) =>
      app.inject({
        method: "PUT",
        url: `/api/households/${householdId}/accounts/${accountId}`,
        headers: auth,
        payload,
      });
    await assign(home.id, current.id, { role: "personal", memberUserId: alice.id });
    await assign(home.id, homeBills.id, { role: "shared" });
    await assign(flat.id, flatCurrent.id, { role: "personal", memberUserId: alice.id });
    await assign(flat.id, flatBills.id, { role: "shared" });

    // The standalone leg: £600 a month from the current account into the ISA,
    // with no household anywhere in it.
    const movement = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${isa.id}/inflows`,
        headers: auth,
        payload: {
          name: "Monthly saving",
          source: "account",
          sourceAccountId: current.id,
          amountMinor: 60_000,
          frequency: "monthly",
          anchorDate: "2026-01-01",
        },
      })
    ).json();

    return { auth, alice, current, homeBills, flatCurrent, flatBills, isa, movement };
  }

  it("draws a scope spanning two households and a standalone pot", async () => {
    const { auth, alice, current, homeBills, flatBills, isa, movement } =
      await seedTwoHouseholdsAndAPot();

    const res = await flow(auth, [current.id, homeBills.id, flatBills.id, isa.id]);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.accounts.map((a: { name: string }) => a.name)).toEqual([
      "current",
      "home-bills",
      "flat-bills",
      "isa",
    ]);
    expect(body.currency).toBe("GBP");

    // The authored movement is drawn account to account, by its own id.
    const internal = body.edges.find((e: { inflowId?: string }) => e.inflowId === movement.id);
    expect(internal).toMatchObject({
      fromAccountId: current.id,
      toAccountId: isa.id,
      amountMinor: 60_000,
      status: "funded",
    });

    // The home's rent is a household transfer whose sender *is* in the diagram,
    // so it is drawn account to account, named by the member who moves it —
    // a fact only the household plan holds, and one the estate pass has no
    // authored row for.
    expect(
      body.edges.find(
        (e: { toAccountId: string; memberUserId?: string }) =>
          e.toAccountId === homeBills.id && e.memberUserId,
      ),
    ).toMatchObject({
      fromAccountId: current.id,
      memberUserId: alice.id,
      memberName: "Owner",
    });

    // The flat's rent leaves an account the user left out, so it arrives across
    // the scope's edge instead of out of thin air.
    const arriving = body.edges.filter((e: { fromAccountId: null }) => e.fromAccountId === null);
    expect(arriving.map((e: { toAccountId: string }) => e.toAccountId)).toEqual([flatBills.id]);

    // Every node balances: what comes in is what goes out.
    for (const node of body.accounts) {
      const into = body.edges
        .filter((e: { toAccountId: string }) => e.toAccountId === node.accountId)
        .reduce((sum: number, e: { amountMinor: number }) => sum + e.amountMinor, 0);
      const outOf = body.edges
        .filter((e: { fromAccountId: string }) => e.fromAccountId === node.accountId)
        .reduce((sum: number, e: { amountMinor: number }) => sum + e.amountMinor, 0);
      expect(node.incomeMinor + into).toBe(node.spendingMinor + outOf + node.leftoverMinor);
    }

    // The denominator: money entering the scope from outside it, counted once.
    const fromOutside = arriving.reduce(
      (sum: number, e: { amountMinor: number }) => sum + e.amountMinor,
      0,
    );
    expect(body.totalInflowMinor).toBe(400_000 + fromOutside);
  });

  /**
   * The whole point of the endpoint taking the *set* rather than the household:
   * a subset of the same accounts is a different picture of the same money, and
   * the money crossing the edge of the smaller scope is still drawn.
   */
  it("draws a subset of the same accounts without inventing or losing money", async () => {
    const { auth, current, isa } = await seedTwoHouseholdsAndAPot();
    const body = (await flow(auth, [isa.id])).json();
    expect(body.accounts).toHaveLength(1);
    expect(body.edges).toEqual([
      expect.objectContaining({ fromAccountId: null, toAccountId: isa.id, amountMinor: 60_000 }),
    ]);
    expect(body.totalInflowMinor).toBe(60_000);
    // ...and the sender is untouched by not being drawn.
    const sender = (await flow(auth, [current.id])).json();
    expect(sender.accounts[0].incomeMinor).toBe(400_000);
  });

  it("is exactly as visible as the least visible account in the set", async () => {
    const { auth, current } = await seedTwoHouseholdsAndAPot();
    const { auth: strangerAuth } = await seedUser(store, "stranger@example.com");
    const theirs = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: strangerAuth,
        payload: { name: "not-yours", currency: "GBP" },
      })
    ).json();

    const res = await flow(auth, [current.id, theirs.id]);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("refuses an empty scope, an oversized one, and one spanning currencies", async () => {
    const { auth, current } = await seedTwoHouseholdsAndAPot();

    const empty = await app.inject({ method: "GET", url: "/api/flow", headers: auth });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.message).toMatch(/at least one account/);

    const tooMany = await flow(
      auth,
      Array.from({ length: 41 }, (_, i) => `id-${i}`),
    );
    expect(tooMany.statusCode).toBe(422);
    expect(tooMany.json().error.message).toMatch(/at most 40 accounts/);

    const dollars = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "us-pot", currency: "USD" },
      })
    ).json();
    const mixed = await flow(auth, [current.id, dollars.id]);
    expect(mixed.statusCode).toBe(422);
    expect(mixed.json().error.message).toMatch(/cannot span currencies: GBP, USD/);
  });

  it("takes a repeated account once, in the order the set names it", async () => {
    const { auth, current, isa } = await seedTwoHouseholdsAndAPot();
    const body = (await flow(auth, [isa.id, current.id, isa.id])).json();
    expect(body.accounts.map((a: { name: string }) => a.name)).toEqual(["isa", "current"]);
  });

  /**
   * Visibility is presentation, and the endpoint is where that promise is kept
   * by having nowhere to break it: there is no parameter for hiding an account,
   * so a hidden account cannot be dropped from the pass that funds the others.
   */
  it("has no notion of a hidden account, so hiding one cannot move a figure", async () => {
    const { auth, current, isa } = await seedTwoHouseholdsAndAPot();
    const scope = [current.id, isa.id];
    const before = (await flow(auth, scope)).json();
    // The client hiding the ISA still asks for the whole set.
    const after = (await flow(auth, scope)).json();
    expect(after).toEqual(before);
    // ...and asking for a smaller set is a different question, which is why
    // hiding must never be expressed that way: the movement's money leaves the
    // current account either way, but the ISA's own node goes with it.
    const narrowed = (await flow(auth, [current.id])).json();
    expect(narrowed.accounts).toHaveLength(1);
    expect(narrowed.edges[0]).toMatchObject({ fromAccountId: current.id, toAccountId: null });
  });
});
