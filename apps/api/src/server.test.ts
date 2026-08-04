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
});
