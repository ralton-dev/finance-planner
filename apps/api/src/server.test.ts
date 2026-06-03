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
});
