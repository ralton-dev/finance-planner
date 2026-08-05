import { type Account, MemoryStore, type Store } from "@finance-planner/data";
import { closeForUser, computeScopePlan } from "@finance-planner/domain";
import { signAccessToken } from "@finance-planner/security";
import { beforeEach, describe, expect, it } from "vitest";
// Not `@finance-planner/domain`: the package exports its index and nothing else,
// and a fixture is not part of a package's public surface.
import {
  estate,
  ESTATE_ASOF,
  ESTATE_CONFIRMATION_SHAPES,
  type ConfirmationShape,
} from "../../../packages/domain/src/estate.fixture.js";
import {
  CROSS_OWNER_ASOF,
  CROSS_OWNER_ASSIGNED_ACCOUNT_IDS,
  crossOwnerScope,
} from "../../../packages/domain/src/crossowner.fixture.js";
import type { ApiEnv } from "./env.js";
import { buildDailyDigest } from "./notify.js";
import { scopeForAccount } from "./plan.js";
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

  // `who` creates the account, so `who` owns it — and since MONTH-CLOSE.md
  // decision 15 external income counts for an account's **owner**, not for the
  // member the roster names. Bob's salary has to arrive in an account that is
  // actually Bob's, which is how it works outside a test: people open their own
  // accounts and then share them into a household.
  const make = async (
    name: string,
    incomeMinor?: number,
    who: { authorization: string } = auth,
  ) => {
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: who,
        payload: { name, currency: "GBP" },
      })
    ).json();
    if (incomeMinor) {
      await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/incomes`,
        headers: who,
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
  const bobCur = await make("bob-cur", 200000, bobAuth);
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
  // Bob's account goes on the roster through the store, not through Alice: the
  // endpoint requires the caller to be able to see the account, and Bob is a
  // plain member here, so neither of them could do it over HTTP. What matters to
  // the plan is that the assignment exists and that the account is Bob's.
  await store.upsertAccountAssignment({
    householdId: household.id,
    accountId: bobCur.id,
    role: "personal",
    memberUserId: bob.id,
  });
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

    // The third ownership route, unasserted until now: a project you cannot
    // see is a project you cannot rename either, and it 404s for the same
    // existence-leak reason rather than 403ing and confirming it exists.
    const tryPatch = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      headers: bAuth,
      payload: { name: "B's project now" },
    });
    expect(tryPatch.statusCode).toBe(404);
  });

  /**
   * A project is a grouping of *your* payments, so the id you file one under
   * has to be a project of yours. Nothing checked: the body's `projectId` went
   * to the store, which enforced existence and nothing else — so a payment on
   * your own account could be filed into a stranger's project, where it then
   * printed your account's name on their screen (the test below).
   */
  it("refuses a payment filed into someone else's project", async () => {
    const { auth: aAuth } = await seedUser(store, "a@example.com");
    const { auth: bAuth } = await seedUser(store, "b@example.com");

    const victimProject = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: aAuth,
        payload: { name: "A's project" },
      })
    ).json();

    const bAccount = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: bAuth,
        payload: { name: "B's secret account", currency: "GBP" },
      })
    ).json();

    const created = await app.inject({
      method: "POST",
      url: `/api/accounts/${bAccount.id}/payments`,
      headers: bAuth,
      payload: {
        name: "Nosy",
        category: "fixed_point",
        amountMinor: 1000,
        dueDate: "2026-09-01",
        projectId: victimProject.id,
      },
    });
    expect(created.statusCode).toBe(422);
    // The id the caller supplied, never the project's name: echoing that back
    // would leak exactly what the gate exists to protect.
    expect(created.json().error.message).toContain(victimProject.id);

    // And the same body arriving one request later, as an update.
    const payment = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${bAccount.id}/payments`,
        headers: bAuth,
        payload: {
          name: "Nosy",
          category: "fixed_point",
          amountMinor: 1000,
          dueDate: "2026-09-01",
        },
      })
    ).json();
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/payments/${payment.id}`,
      headers: bAuth,
      payload: { projectId: victimProject.id },
    });
    expect(patched.statusCode).toBe(422);
    expect(patched.json().error.message).toContain(victimProject.id);

    // Nothing got in by either door.
    const detail = (
      await app.inject({ method: "GET", url: `/api/projects/${victimProject.id}`, headers: aAuth })
    ).json();
    expect(detail.payments).toHaveLength(0);
  });

  /**
   * A project's payments cross accounts by design, so its detail route is the
   * one place in the product that reads accounts the caller was never checked
   * against. It hydrated each payment with a bare `getAccount`, which answers
   * for any account in the database.
   *
   * The shape that reaches it without anybody doing anything wrong: a payment
   * filed on an account shared into your household, and then the share is
   * taken away. The payment stays in your project — it is your project — and
   * the account behind it stops being yours to name. Gated exactly as
   * `planInflowSources` gates a sender's name: the amount is a fact about your
   * own project and always travels; the name does not.
   */
  it("names only the accounts a project's owner may still see, and still reports every amount", async () => {
    const { user: alice, auth: aAuth } = await seedUser(store, "alice@example.com");
    const { user: bob, auth: bAuth } = await seedUser(store, "bob@example.com");
    const household = await store.createHousehold("Home", alice.id);
    await store.addMembership(household.id, bob.id, "member");

    const bobAccount = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: bAuth,
        payload: { name: "Bob current", currency: "GBP" },
      })
    ).json();
    const share = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${bobAccount.id}/shares`,
        headers: bAuth,
        payload: { householdId: household.id, permission: "edit" },
      })
    ).json();

    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: aAuth,
        payload: { name: "Kitchen" },
      })
    ).json();
    const payment = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${bobAccount.id}/payments`,
        headers: aAuth,
        payload: {
          name: "Worktop",
          category: "fixed_point",
          amountMinor: 120000,
          dueDate: "2026-09-01",
          projectId: project.id,
        },
      })
    ).json();
    expect(payment.projectId).toBe(project.id);

    // While the share stands, Alice may be told whose account it is.
    const shared = (
      await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: aAuth })
    ).json();
    expect(shared.payments[0]).toMatchObject({
      accountName: "Bob current",
      currency: "GBP",
      amountMinor: 120000,
    });

    await app.inject({
      method: "DELETE",
      url: `/api/accounts/${bobAccount.id}/shares/${share.id}`,
      headers: bAuth,
    });
    expect(await store.getAccess(alice.id, bobAccount.id)).toBeNull();
    expect(bob.id).not.toBe(alice.id);

    const after = (
      await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: aAuth })
    ).json();
    expect(after.payments).toHaveLength(1);
    // The absence is an absence — no name, and no invented one either.
    expect(after.payments[0].accountName).toBeUndefined();
    // Amounts are never gated. The money is still in her project — and the
    // currency travels with it, because a minor-unit integer with no code
    // cannot be rendered at all, so gating it would gate the amount.
    expect(after.payments[0]).toMatchObject({
      accountId: bobAccount.id,
      name: "Worktop",
      amountMinor: 120000,
      alreadySavedMinor: 0,
      currency: "GBP",
    });
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
    const { user: bob, auth: bobAuth } = await seedUser(store, "bob@example.com");
    const household = await store.createHousehold("Home", user.id);
    await store.addMembership(household.id, bob.id, "member");
    await store.updateMembershipShare(household.id, user.id, 6600);
    await store.updateMembershipShare(household.id, bob.id, 3400);

    // `who` creates the account, so `who` owns it — and income counts for an
    // account's owner (MONTH-CLOSE.md decision 15), so Bob's salary has to
    // arrive in an account that is his.
    const make = async (
      name: string,
      incomeMinor?: number,
      who: { authorization: string } = auth,
    ) => {
      const a = (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers: who,
          payload: { name, currency: "GBP" },
        })
      ).json();
      if (incomeMinor) {
        await app.inject({
          method: "POST",
          url: `/api/accounts/${a.id}/incomes`,
          headers: who,
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
    const bobCur = await make("bob-cur", 200000, bobAuth);
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
    // Through the store: the endpoint wants the caller to be able to see the
    // account, and Bob's is nobody else's to assign.
    await store.upsertAccountAssignment({
      householdId: household.id,
      accountId: bobCur.id,
      role: "personal",
      memberUserId: bob.id,
    });
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

  /**
   * The case 0009 could not reach and WP-R made storable: a transfer the pass
   * derived for a user with no household. It has no `household_id` to scope it
   * and no `inflow_id` to name it, because nobody authored it — it is what the
   * plan says the month costs, and the only thing that identifies it is the two
   * accounts, the month and the member.
   */
  it("confirms a transfer nobody authored, for a user with no household", async () => {
    const { user, auth } = await seedUser(store);
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
    await app.inject({
      method: "POST",
      url: `/api/accounts/${pot.id}/payments`,
      headers: auth,
      payload: { name: "Council tax", category: "monthly_recurring", amountMinor: 15000 },
    });

    // Nothing authored the feed. The prompt is the derived transfer, and the
    // line leaning on it is awaiting a transfer rather than at risk.
    expect(await store.listInflows(pot.id)).toEqual([]);
    const before = (
      await app.inject({ method: "GET", url: `/api/accounts/${pot.id}/plan`, headers: auth })
    ).json();
    expect(before.allocatedInflowMinor).toBe(15000);
    expect(before.lines[0].status).toBe("awaiting_transfer");
    expect(before.inflowSources).toEqual([
      {
        kind: "member",
        memberUserId: user.id,
        displayName: "Owner",
        // Which account to move it out of — ungated, like the sending account
        // id on an authored movement's row, because an id is not a name. The
        // confirmation below is posted with exactly this.
        fromAccountId: current.id,
        amountMinor: 15000,
        confirmedMinor: 0,
      },
    ]);

    const confirm = () =>
      app.inject({
        method: "POST",
        url: `/api/accounts/${pot.id}/transfers/confirm`,
        headers: auth,
        payload: { fromAccountId: current.id, toAccountId: pot.id, memberUserId: user.id },
      });
    const res = await confirm();
    expect(res.statusCode).toBe(201);
    const { confirmation, contributions } = res.json();
    expect(confirmation.householdId).toBeNull();
    expect(confirmation.inflowId).toBeNull();
    expect(confirmation.amountMinor).toBe(15000);
    // Unlike an authored movement, a derived transfer *is* what pays the bills,
    // so its slices are booked against them.
    expect(contributions.map((c: { amountMinor: number }) => c.amountMinor)).toEqual([15000]);

    const after = (
      await app.inject({ method: "GET", url: `/api/accounts/${pot.id}/plan`, headers: auth })
    ).json();
    expect(after.confirmedInflowMinor).toBe(15000);
    expect(after.lines[0].status).toBe("funded");

    // Idempotent, exactly as the other two handlers are.
    expect((await confirm()).statusCode).toBe(409);

    // ...and un-confirming takes the contributions it created with it.
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/accounts/${pot.id}/transfers/confirmations/${confirmation.id}`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(204);
    const ledger = await app.inject({
      method: "GET",
      url: `/api/accounts/${pot.id}/contributions`,
      headers: auth,
    });
    expect(ledger.json()).toEqual([]);
    const listed = await app.inject({
      method: "GET",
      url: `/api/accounts/${pot.id}/transfers/confirmations`,
      headers: auth,
    });
    expect(listed.json()).toEqual([]);
    expect((await confirm()).statusCode).toBe(201);
    // Readable from both ends, and distinguishable from an authored movement by
    // carrying neither a household nor an inflow.
    for (const accountId of [pot.id, current.id]) {
      const rows = (
        await app.inject({
          method: "GET",
          url: `/api/accounts/${accountId}/transfers/confirmations`,
          headers: auth,
        })
      ).json();
      expect(rows).toHaveLength(1);
      expect(rows[0].householdId).toBeNull();
      expect(rows[0].inflowId).toBeNull();
    }
  });

  it("refuses a derived confirmation nothing in the plan asks for", async () => {
    const { user, auth } = await seedUser(store);
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

    const post = (payload: object) =>
      app.inject({
        method: "POST",
        url: `/api/accounts/${pot.id}/transfers/confirm`,
        headers: auth,
        payload,
      });
    // Nothing is owed anywhere, so no transfer is derived.
    expect(
      (await post({ fromAccountId: current.id, toAccountId: pot.id, memberUserId: user.id }))
        .statusCode,
    ).toBe(422);
    // The destination has to be the account in the URL...
    expect(
      (await post({ fromAccountId: pot.id, toAccountId: current.id, memberUserId: user.id }))
        .statusCode,
    ).toBe(422);
    // ...and there is no roster here to make anybody an admin of somebody
    // else's money.
    const { user: bob } = await seedUser(store, "bob@example.com");
    expect(
      (await post({ fromAccountId: current.id, toAccountId: pot.id, memberUserId: bob.id }))
        .statusCode,
    ).toBe(403);
  });

  it("keeps the derived un-confirm route away from the other two shapes", async () => {
    const { user, auth } = await seedUser(store);
    const { current, pot, movement } = await seedMovement(auth);
    const authored = await store.createTransferConfirmation({
      householdId: null,
      inflowId: movement.id,
      month: `${thisMonth()}-01`,
      fromAccountId: current.id,
      toAccountId: pot.id,
      memberUserId: user.id,
      amountMinor: 20000,
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/accounts/${pot.id}/transfers/confirmations/${authored.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

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

  /**
   * Two arrivals, two confirmations, and a line that must only answer to one.
   *
   * Money reaches this pot both ways: £150 of transfer the pass derived for the
   * bill, and a £200 movement the user authored as savings on top (decision 12).
   * Each is separately confirmable, and the bill is funded out of the derived
   * one — every expense is paid from member budgets before a single savings
   * movement runs (decision 8), so the money a line leans on is never authored
   * money.
   *
   * This test used to assert the opposite, and pinned the defect: `status` was
   * decided against `confirmedInflowMinor`, which counts both, so confirming the
   * savings movement declared the bill funded while the transfer that actually
   * pays it had not been made. Wrong status about money, which is the category
   * this project exists to get right (ONE-ENGINE.md, WP-V).
   */
  it("does not let a confirmed savings movement declare a bill's transfer made", async () => {
    const { auth, user } = await seedUser(store);
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
    expect(before.confirmedTransferMinor).toBe(0);
    expect(before.lines[0].status).toBe("awaiting_transfer");

    await app.inject({
      method: "POST",
      url: `/api/inflows/${movement.id}/confirm`,
      headers: auth,
    });
    const afterMovement = await planOf();
    // The savings arrived; the bill's transfer did not. £200 of the £350 has
    // moved and none of it is the £150 this line is funded with.
    expect(afterMovement.confirmedInflowMinor).toBe(20000);
    expect(afterMovement.confirmedTransferMinor).toBe(0);
    expect(afterMovement.lines[0].status).toBe("awaiting_transfer");
    // Nobody else is involved, so there is no household — but there is very much
    // a sender, and it is one of the caller's own accounts. Membership of a
    // household was never what made that safe to say. Both producers show:
    // the transfer the pass derived (the caller's own, so nameable) and the
    // movement they authored.
    expect(afterMovement.inflowSources).toEqual([
      {
        kind: "member",
        memberUserId: user.id,
        displayName: "Owner",
        fromAccountId: current.id,
        amountMinor: 15000,
        confirmedMinor: 0,
      },
      {
        kind: "account",
        inflowId: movement.id,
        fromAccountId: current.id,
        // Ungated, and here it happens to be the caller: the row is what lets a
        // screen say "between your own accounts" and mean it (decision 25).
        ownerUserId: user.id,
        accountName: "current",
        amountMinor: 20000,
        confirmedMinor: 20000,
      },
    ]);

    // And the converse: confirming the derived transfer settles the line, with
    // the savings movement's own confirmation neither needed nor consulted.
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/accounts/${pot.id}/transfers/confirm`,
      headers: auth,
      payload: { fromAccountId: current.id, toAccountId: pot.id, memberUserId: user.id },
    });
    expect(confirmed.statusCode).toBe(201);
    const afterTransfer = await planOf();
    expect(afterTransfer.confirmedInflowMinor).toBe(35000);
    expect(afterTransfer.confirmedTransferMinor).toBe(15000);
    expect(afterTransfer.lines[0].status).toBe("funded");
  });

  /** The same converse from the other side: the transfer alone settles the line,
   *  with no authored movement confirmed at any point. */
  it("settles a line on its derived transfer alone, savings untouched", async () => {
    const { auth, user } = await seedUser(store);
    const { current, pot } = await seedFundedMovement(auth, [
      { name: "Council tax", amountMinor: 15000, priority: 1 },
    ]);
    await app.inject({
      method: "POST",
      url: `/api/accounts/${pot.id}/transfers/confirm`,
      headers: auth,
      payload: { fromAccountId: current.id, toAccountId: pot.id, memberUserId: user.id },
    });
    const plan = (
      await app.inject({ method: "GET", url: `/api/accounts/${pot.id}/plan`, headers: auth })
    ).json();
    expect(plan.confirmedTransferMinor).toBe(15000);
    // The £200 movement is still unconfirmed, and says nothing about the bill.
    expect(plan.confirmedInflowMinor).toBe(15000);
    expect(plan.lines[0].status).toBe("funded");
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

  /**
   * The state `36c90bf` had to cope with, closed at the source instead.
   *
   * `ScopePlan.movements` is every currency partition flattened, and a movement
   * whose ends sit in different partitions appears twice: really, where the
   * sender is, and as an `unknown_source` £0 twin where the destination is.
   * `find` on `inflowId` alone took EUR's zero for a GBP→EUR movement and
   * recorded "I moved the money" as £0 — a wrong figure about money, written on
   * the user's say-so and never shown to them again.
   *
   * The POST-time guard always refused *authoring* one; the state was reached
   * afterwards, by moving an end — `PATCH /api/accounts/:id` used to take a
   * currency. It does not any more, so the state has no way in. This test used
   * to redenominate the pot to EUR and assert the confirmation still booked the
   * sender's £200; the redenomination is the thing now refused, so that is what
   * it asserts. The handler's status filter stays for rows that pre-date this
   * refusal and for a sender the scope never loaded.
   */
  it("refuses to redenominate an account, so a movement cannot cross partitions", async () => {
    const { auth } = await seedUser(store);
    const { current, pot, movement } = await seedMovement(auth);
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/accounts/${pot.id}`,
      headers: auth,
      payload: { currency: "EUR" },
    });
    expect(moved.statusCode).toBe(422);
    expect(moved.json().error.code).toBe("validation_error");
    expect(
      (await app.inject({ method: "GET", url: `/api/accounts/${pot.id}`, headers: auth })).json()
        .currency,
    ).toBe("GBP");

    // Both ends still in one partition, so the confirmation books what really
    // leaves the sender — the figure the EUR twin used to steal.
    const res = await app.inject({
      method: "POST",
      url: `/api/inflows/${movement.id}/confirm`,
      headers: auth,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().confirmation.amountMinor).toBe(20000);
    const sender = (
      await app.inject({ method: "GET", url: `/api/accounts/${current.id}/plan`, headers: auth })
    ).json();
    expect(sender.outboundInflowMinor).toBe(20000);
  });

  /** Renaming an account is not redenominating it, and a client that PATCHes
   *  its whole form back — which `AccountSettingsDrawer` does on every save —
   *  is not asking for anything. Refusing on the field's mere presence would
   *  have made the settings drawer unable to save at all. */
  it("lets a patch carry back the currency the account already has", async () => {
    const { auth } = await seedUser(store);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { name: "Everyday", currency: "GBP" },
      })
    ).json();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/accounts/${account.id}`,
      headers: auth,
      // Lower case, as the drawer's own uppercasing would not have applied.
      payload: { name: "Everyday spending", currency: "gbp", monthlyBufferMinor: 5000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Everyday spending");
    expect(res.json().monthlyBufferMinor).toBe(5000);
    expect(res.json().currency).toBe("GBP");
  });

  /**
   * A loop's broken edge is not a movement anybody can have made.
   *
   * `engine.ts` keeps `broken_cycle` and `unknown_source` off the sending
   * account's outbound plan because neither is happening; the confirm handler
   * read straight past the status and booked the £0 instead of refusing. 422,
   * the code the derived-transfer handler already answers with when this month's
   * plan holds no such transfer.
   */
  it("refuses to confirm the edge a funding loop is broken at", async () => {
    const { auth } = await seedUser(store);
    const make = async (name: string) => {
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
    };
    const a = await make("a");
    const b = await make("b");
    const edge = (to: string, from: string) =>
      store.createInflow({
        accountId: to,
        name: "Top-up",
        source: "account",
        sourceAccountId: from,
        amountMinor: 20000,
        frequency: "monthly",
        recurrence: null,
        anchorDate: "2026-01-01",
        priority: 50,
        active: true,
      });
    const ab = await edge(b.id, a.id);
    const ba = await edge(a.id, b.id);

    const confirm = (inflowId: string) =>
      app.inject({ method: "POST", url: `/api/inflows/${inflowId}/confirm`, headers: auth });
    const codes = [(await confirm(ab.id)).statusCode, (await confirm(ba.id)).statusCode];
    // One edge is broken and one survives; which is the pass's deterministic
    // business, and neither is 201-and-zero.
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 422)).toHaveLength(1);
    const refused = (await confirm(codes[0] === 422 ? ab.id : ba.id)).json();
    expect(refused.error.code).toBe("no_planned_movement");
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

    // One pass, read twice: what the household attributes is what the account
    // plans with, and the pot's own income is still nothing.
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

  /**
   * Amounts travel; member *names* are gated on being able to see the
   * household that plans the account (`planInflowSources`). Both halves are
   * pinned here, from the two sides of one account.
   *
   * This case used to be Carol, who saw the household's own bills pot through
   * a share into a household of *her* own. WP-W makes that state unreachable
   * and not merely unusual: sharing an account requires membership of the
   * household shared into, and a user belongs to exactly one household, so an
   * account's owner is always a member of any household that has assigned it —
   * and anybody who can see the account through a share is in that same
   * household. An account planned by a household you are not in is therefore no
   * longer something you can be shown at all, and a fixture that fabricates one
   * at the Store would be testing a shape the product cannot produce.
   *
   * The property survives in the shape that *is* reachable, which is also the
   * one that matters: a pot **no household plans**, shared read-only with the
   * household. Alice may see what lands in it. She may not be told that it is
   * Bob moving the money — that is a fact about his private plan, and the gate
   * is the same line of code either way.
   */
  it("names who is sending the money only to someone who can see the household", async () => {
    const h = await seedHousehold(store, app);
    // Bob's own money, outside the household plan entirely: a second current
    // account and a pot it feeds.
    const make = async (name: string, incomeMinor?: number) => {
      const account = (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers: h.bobAuth,
          payload: { name, currency: "GBP" },
        })
      ).json();
      if (incomeMinor) {
        await app.inject({
          method: "POST",
          url: `/api/accounts/${account.id}/incomes`,
          headers: h.bobAuth,
          payload: {
            name: "Side work",
            amountMinor: incomeMinor,
            frequency: "monthly",
            anchorDate: "2026-01-01",
          },
        });
      }
      return account;
    };
    await make("bob-side", 120_000);
    const bobPot = await make("bob-pot");
    await app.inject({
      method: "POST",
      url: `/api/accounts/${bobPot.id}/payments`,
      headers: h.bobAuth,
      payload: { name: "Bike", category: "monthly_recurring", amountMinor: 30_000 },
    });
    // Shared with the household so Alice can watch it — a grant, never a role
    // in the plan. Bob may make it because he is a member; it is the only
    // household he could make it to.
    const shared = await app.inject({
      method: "POST",
      url: `/api/accounts/${bobPot.id}/shares`,
      headers: h.bobAuth,
      payload: { householdId: h.household.id, permission: "view" },
    });
    expect(shared.statusCode).toBe(201);

    const his = (
      await app.inject({
        method: "GET",
        url: `/api/accounts/${bobPot.id}/plan`,
        headers: h.bobAuth,
      })
    ).json();
    expect(his.inflowSources.map((s: { memberUserId: string }) => s.memberUserId)).toEqual([
      h.bob.id,
    ]);
    expect(
      his.inflowSources.reduce((n: number, s: { amountMinor: number }) => n + s.amountMinor, 0),
    ).toBe(his.allocatedInflowMinor);
    expect(his.allocatedInflowMinor).toBeGreaterThan(0);

    const hers = await app.inject({
      method: "GET",
      url: `/api/accounts/${bobPot.id}/plan`,
      headers: h.auth,
    });
    expect(hers.statusCode).toBe(200);
    // The amount is a fact about an account she can already see, so it is
    // there and her copy of the plan adds up. The sender's name is not.
    expect(hers.json().allocatedInflowMinor).toBe(his.allocatedInflowMinor);
    expect(hers.json().totalRequiredMinor).toBe(his.totalRequiredMinor);
    expect(hers.json().shortfallMinor).toBe(his.shortfallMinor);
    expect(hers.json().inflowSources).toBeNull();
  });

  /**
   * The same rule, from the other end of the same transfer.
   *
   * `transferOutMinor` says how much derived transport leaves an account and
   * never said where it goes, so the account page drew one row for the lot and
   * had to label a far end that was a *set* of accounts. `transferDepartures`
   * itemises it, and every destination is an account — so its name is gated
   * exactly as a sender's name is (`withTransferDestinations`), by `getAccess`
   * and by nothing else.
   *
   * Both answers land in one response. Bob's side account feeds two pots of his
   * own; he shares the side account and one pot with the household and keeps
   * the other to himself. Alice reads the same two rows with the same two
   * amounts summing to the same total, names the pot she can see, and does not
   * name the one she cannot.
   */
  it("names the account a derived transfer goes to, only where the caller may see it", async () => {
    const h = await seedHousehold(store, app);
    const make = async (name: string, incomeMinor?: number) => {
      const account = (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers: h.bobAuth,
          payload: { name, currency: "GBP" },
        })
      ).json();
      if (incomeMinor) {
        await app.inject({
          method: "POST",
          url: `/api/accounts/${account.id}/incomes`,
          headers: h.bobAuth,
          payload: {
            name: "Side work",
            amountMinor: incomeMinor,
            frequency: "monthly",
            anchorDate: "2026-01-01",
          },
        });
      }
      return account;
    };
    const side = await make("bob-side", 400_000);
    const bike = await make("bob-bike");
    const boat = await make("bob-boat");
    for (const [account, name, amountMinor] of [
      [bike, "Bike", 30_000],
      [boat, "Boat", 45_000],
    ] as const) {
      await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/payments`,
        headers: h.bobAuth,
        payload: { name, category: "monthly_recurring", amountMinor },
      });
    }
    // The sending account and one of the two pots, shared into the household so
    // Alice can watch them. The other pot is nobody's business but Bob's.
    for (const account of [side, bike]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/accounts/${account.id}/shares`,
            headers: h.bobAuth,
            payload: { householdId: h.household.id, permission: "view" },
          })
        ).statusCode,
      ).toBe(201);
    }

    interface Departure {
      toAccountId: string;
      memberUserId: string;
      amountMinor: number;
      confirmedMinor: number;
      toAccountName?: string;
    }
    const departuresOf = (body: {
      transferDepartures: Departure[];
      transferOutMinor: number;
    }): Departure[] => {
      // The identity the field is published under, asserted at the endpoint and
      // not only in the engine: the list is the scalar, itemised.
      expect(body.transferDepartures.reduce((n, d) => n + d.amountMinor, 0)).toBe(
        body.transferOutMinor,
      );
      return body.transferDepartures;
    };

    const his = departuresOf(
      (
        await app.inject({
          method: "GET",
          // Dated, because one of the three departures below is Bob's share of
          // the household's dated holiday goal and would otherwise move with
          // the calendar.
          url: `/api/accounts/${side.id}/plan?asOf=2026-06-01`,
          headers: h.bobAuth,
        })
      ).json(),
    );
    // Biggest first, each with its own far end — the row-per-destination the
    // one synthetic "£X → your bills" row could never be.
    expect(his).toEqual([
      {
        toAccountId: boat.id,
        memberUserId: h.bob.id,
        amountMinor: 45_000,
        confirmedMinor: 0,
        toAccountName: "bob-boat",
      },
      // His share of the household's bills, leaving this account rather than his
      // current one: decision 11 sends a member's transfers out of the personal
      // account of theirs with the most income, and this one has twice his
      // salary in it. Unnamed, because the household's bills pot is Alice's
      // account and nobody shared it with him — the far end is an id he can act
      // on and no more.
      {
        toAccountId: h.bills.id,
        memberUserId: h.bob.id,
        amountMinor: 36_915,
        confirmedMinor: 0,
      },
      {
        toAccountId: bike.id,
        memberUserId: h.bob.id,
        amountMinor: 30_000,
        confirmedMinor: 0,
        toAccountName: "bob-bike",
      },
    ]);

    const hersResponse = await app.inject({
      method: "GET",
      url: `/api/accounts/${side.id}/plan?asOf=2026-06-01`,
      headers: h.auth,
    });
    expect(hersResponse.statusCode).toBe(200);
    const hers = departuresOf(hersResponse.json());
    // Every amount is a fact about an account she can already see, so nothing
    // is withheld and her copy adds up to the same total.
    expect(hers.map((d) => [d.toAccountId, d.amountMinor])).toEqual(
      his.map((d) => [d.toAccountId, d.amountMinor]),
    );
    // The pot she cannot see is not named; the one she can still is — the gate
    // discriminates inside one response rather than switching it off.
    expect(hers.find((d) => d.toAccountId === boat.id)!.toAccountName).toBeUndefined();
    expect(hers.find((d) => d.toAccountId === bike.id)!.toAccountName).toBe("bob-bike");
  });

  /**
   * The rule the paragraph above leans on, asserted rather than assumed: you
   * may only share an account into a household you are in, and you are in one.
   * It is what stops two households ever joining into one scope — a scope
   * closes over sharing and funding edges, and both need somebody who can edit
   * two accounts at once.
   */
  it("refuses to share an account into a household the owner is not in", async () => {
    const h = await seedHousehold(store, app);
    const { user: carol } = await seedUser(store, "carol@example.com");
    const hers = await store.createHousehold("Carol's place", carol.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/accounts/${h.bills.id}/shares`,
      headers: h.auth,
      payload: { householdId: hers.id, permission: "view" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/Not a member of that household/);

    // And Alice cannot become a member of it either, because she has one.
    await expect(store.addMembership(hers.id, h.alice.id, "member")).rejects.toThrow(
      /already belongs to a household/,
    );
  });

  /**
   * WP-O's specification test, asserted once more where the user actually reads
   * the numbers: three HTTP responses, one account, one figure.
   *
   * The domain has its own copy (`packages/domain/src/parity.test.ts`) over one
   * `computeScopePlan`. This one goes through the loader, the store and three
   * separate requests, because "the same numbers because they are the same
   * numbers" is a claim about the API as much as about the engine — the defect
   * was two loaders, and a fixture that hands one input to three views cannot
   * see a second loader if one comes back.
   */
  it("agrees to the penny across the household plan, the flow and the account plan", async () => {
    const h = await seedHousehold(store, app);
    // Alice moves £700 a month into an ISA that is not the household's — the
    // defect verbatim: "a household plan cannot see money leaving one of its
    // accounts to an account outside the household".
    const isa = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: h.auth,
        payload: { name: "isa", currency: "GBP" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/accounts/${isa.id}/inflows`,
      headers: h.auth,
      payload: {
        name: "Standing order",
        source: "account",
        sourceAccountId: h.aliceCur.id,
        amountMinor: 70000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
        priority: 10,
      },
    });

    const get = async (url: string) =>
      (await app.inject({ method: "GET", url, headers: h.auth })).json();

    const household = await get(`/api/households/${h.household.id}/plan`);
    const flow = await get(`/api/flow?accounts=${h.aliceCur.id},${isa.id}`);
    const account = await get(`/api/accounts/${h.aliceCur.id}/plan`);

    const householdAccount = household.accounts.find(
      (a: { accountId: string }) => a.accountId === h.aliceCur.id,
    );
    const householdPage = householdAccount.leftoverMinor - householdAccount.committedMinor;
    const flowDiagram = flow.accounts.find(
      (a: { accountId: string }) => a.accountId === h.aliceCur.id,
    ).leftoverMinor;
    const accountPage = account.leftoverMinor - account.outboundInflowMinor;

    expect({ householdPage, flowDiagram, accountPage }).toEqual({
      householdPage: flowDiagram,
      flowDiagram,
      accountPage: flowDiagram,
    });
    // And the movement really is funded — three surfaces agreeing that nothing
    // left would prove nothing at all.
    expect(householdAccount.committedMinor).toBe(70000);
    expect(account.residualMinor).toBe(flowDiagram);
  });

  /**
   * The digest's third section is decision 13's committed bucket: the savings
   * movements the plan funds out of the caller's own accounts, which they have
   * not said they made.
   */
  it("renders the committed movements in the daily digest", async () => {
    const h = await seedHousehold(store, app);
    const isa = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: h.auth,
        payload: { name: "isa", currency: "GBP" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/accounts/${isa.id}/inflows`,
      headers: h.auth,
      payload: {
        name: "Standing order",
        source: "account",
        sourceAccountId: h.aliceCur.id,
        amountMinor: 70000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
        priority: 10,
      },
    });

    const digest = await buildDailyDigest(store, h.alice.id, "2026-08-04");
    expect(digest).toContain("Money to move between your own accounts");
    expect(digest).toContain("700.00 GBP from alice-cur to isa");
    // What the movement *delivers*, not what it asks for — the same figure the
    // account page and the flow diagram print, read off the same pass.
    const account = (
      await app.inject({
        method: "GET",
        url: `/api/accounts/${h.aliceCur.id}/plan`,
        headers: h.auth,
      })
    ).json();
    expect(account.outboundInflowMinor).toBe(70000);
  });

  it("does not change the estate's income when a pot's bills change hands", async () => {
    const h = await seedHousehold(store, app);
    const overview = async () =>
      (await app.inject({ method: "GET", url: "/api/overview", headers: h.auth })).json()
        .perCurrency[0];

    // Take the pot back out of the household plan. It is still Alice's, and her
    // salary is still Alice's, so the pass still derives its feed — assignment
    // changes *who bears* the bills, never whether they are transported. This
    // block asserted `allocatedInflowMinor === 0` until WP-AF, which was the
    // severed closure showing through: an unassigned account could not reach its
    // owner's household-assigned salary, and the pot read unfunded. Decision 9
    // says it is fed, household or not.
    await app.inject({
      method: "DELETE",
      url: `/api/households/${h.household.id}/accounts/${h.bills.id}`,
      headers: h.auth,
    });
    const before = await overview();
    const potBefore = before.accounts.find(
      (a: { accountId: string }) => a.accountId === h.bills.id,
    );
    // £1,000 rent + £109.10 of the £1,200 holiday, all borne by Alice alone:
    // an account no household plans bears its own payments (its owner's), so
    // Bob's 34% share does not apply and one transfer carries the lot.
    expect(potBefore.allocatedInflowMinor).toBe(110910);
    expect(potBefore.shortfallMinor).toBe(0);
    expect(potBefore.inflowSources.map((s: { memberUserId: string }) => s.memberUserId)).toEqual([
      h.alice.id,
    ]);

    // Put it back, and the same obligations split 66/34 across the household.
    await app.inject({
      method: "PUT",
      url: `/api/households/${h.household.id}/accounts/${h.bills.id}`,
      headers: h.auth,
      payload: { role: "shared" },
    });
    const after = await overview();
    const potAfter = after.accounts.find((a: { accountId: string }) => a.accountId === h.bills.id);
    expect(potAfter.shortfallMinor).toBe(0);
    // A penny more than borne alone: each member's share rounds up
    // independently, and 73201 + 37710 is what the two of them owe.
    expect(potAfter.allocatedInflowMinor).toBe(110911);
    expect(
      potAfter.inflowSources.map((s: { memberUserId: string; amountMinor: number }) => [
        s.memberUserId,
        s.amountMinor,
      ]),
    ).toEqual([
      [h.alice.id, 73201],
      [h.bob.id, 37710],
    ]);

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

  /**
   * The source account the household does not hold.
   *
   * `f3acef8` put every account a member owns into one scope with the
   * household's, so Alice's private side account can be the one her transfers
   * leave (decision 11 — her personal account with the most income). The
   * transfer belongs to the household its money arrives in (WP-X), so it is on
   * the household's list with a source `plan.accounts` does not carry, and the
   * checklist had no name to print.
   *
   * The name travels for a caller who can see the account and for nobody else —
   * WP-J's rule for a sender's name, reused rather than re-invented. The person
   * who has to make this transfer owns the account, so the person who needs the
   * name has it; a co-member gets the amount, which is all their business.
   */
  async function seedPrivateSource(h: Awaited<ReturnType<typeof seedHousehold>>) {
    const side = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: h.auth,
        payload: { name: "Side account", currency: "GBP" },
      })
    ).json();
    // More income than alice-cur, so it becomes the account her transfers leave.
    await app.inject({
      method: "POST",
      url: `/api/accounts/${side.id}/incomes`,
      headers: h.auth,
      payload: {
        name: "Consulting",
        amountMinor: 400000,
        frequency: "monthly",
        anchorDate: "2026-01-01",
      },
    });
    return side;
  }

  const transferFrom = (plan: { transfers: { fromAccountId: string }[] }, accountId: string) =>
    plan.transfers.find((t) => t.fromAccountId === accountId) as
      | { fromAccountId: string; amountMinor: number; fromAccountName?: string }
      | undefined;

  it("names a transfer's source for the owner who has to move the money", async () => {
    const h = await seedHousehold(store, app);
    const side = await seedPrivateSource(h);
    const plan = (
      await app.inject({
        method: "GET",
        url: `/api/households/${h.household.id}/plan`,
        headers: h.auth,
      })
    ).json();

    // It really is off the roster: the household reports only what it holds.
    expect(plan.accounts.map((a: { accountId: string }) => a.accountId)).not.toContain(side.id);
    const mine = transferFrom(plan, side.id)!;
    expect(mine.fromAccountName).toBe("Side account");
    expect(mine.amountMinor).toBeGreaterThan(0);
    // An account the household does hold is named by the roster and carries
    // nothing extra — one answer per question.
    expect(transferFrom(plan, h.bobCur.id)!.fromAccountName).toBeUndefined();
  });

  it("withholds it from a co-member who can see the household, not the account", async () => {
    const h = await seedHousehold(store, app);
    const side = await seedPrivateSource(h);
    // Bob is a member of the household and has no access to Alice's account.
    expect(await store.getAccess(h.bob.id, side.id)).toBeNull();

    const plan = (
      await app.inject({
        method: "GET",
        url: `/api/households/${h.household.id}/plan`,
        headers: h.bobAuth,
      })
    ).json();

    const hers = transferFrom(plan, side.id)!;
    expect(hers.fromAccountName).toBeUndefined();
    // The id and the amount are never gated — only the name is. Bob has to know
    // that £X is coming and from whom; where Alice banks is not his business.
    expect(hers.fromAccountId).toBe(side.id);
    expect(hers.amountMinor).toBe(
      transferFrom(
        (
          await app.inject({
            method: "GET",
            url: `/api/households/${h.household.id}/plan`,
            headers: h.auth,
          })
        ).json(),
        side.id,
      )!.amountMinor,
    );
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
    // on the plan. Its **owner** travels too, and this is the case that decides
    // the wording: the sender is Bob's, so a screen drawing this arrival must
    // not call it money moving between accounts of mine (decision 25). An owner
    // id is not a name — the gate has only ever been on names.
    expect(JSON.stringify(row)).not.toContain("bob-current");
    expect(plan.inflowSources).toEqual([
      {
        kind: "account",
        inflowId: movement.id,
        fromAccountId: bobCurrent.id,
        ownerUserId: bob.id,
        amountMinor: 20000,
        confirmedMinor: 0,
      },
    ]);
    expect(plan.inflowSources[0]).not.toHaveProperty("accountName");
    // And the plan says whose account the money arrived *in*, which is the
    // other half of the same question.
    expect(plan.ownerUserId).toBe(me.id);

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

// ---------------------------------------------------------------------------
// My month closes
// ---------------------------------------------------------------------------

/** Everything the seeded estate is, in the store's own ids. */
interface SeededEstate {
  householdId: string;
  /** Fixture user id → real user id. */
  userIds: ReadonlyMap<string, string>;
  /** Fixture account id → real account. */
  accounts: ReadonlyMap<string, Account>;
  /** Per fixture user id, an `authorization` header for them. */
  auth: ReadonlyMap<string, { authorization: string }>;
}

/**
 * The estate fixture, walked into a store.
 *
 * `@finance-planner/domain` cannot ship this — it does not depend on
 * `@finance-planner/data`, and a fixture is not a reason to make it — so the
 * walk lives on this side of the boundary. It is deliberately mechanical: every
 * figure it writes comes off `estate`, and the only thing it decides for itself
 * is the mapping from the fixture's readable ids to the ids the store generates.
 *
 * **Confirmations that are whole go through the real endpoints**, so the
 * fixture's hand-set figures are checked against what the running product
 * derives rather than merely asserted alongside it. The partial ones cannot: both
 * confirm handlers book the whole planned amount, so a half-moved transfer is
 * written straight to the store — which is the only way a state the product
 * genuinely reaches gets into a test at all.
 *
 * **Which arm each confirmation takes is declared, not discovered.** The
 * equalities below are relationships between a hand-set figure and a plan, and
 * a plan moves: `1ea409f` re-netted alice's transfer to the pot from £594 to
 * £424, the fixture kept saying £594, and this walk quietly stopped calling
 * `POST /api/households/:id/transfers/confirm` — so it booked no contributions
 * at all and every suite over the estate stayed green with an empty ledger.
 * `ESTATE_CONFIRMATION_SHAPES` names the intended arm and the assertions here
 * hold the walk to it, so the next figure that drifts fails loudly instead.
 *
 * Lifted from `close.divergence.test.ts`, which `MONTH-CLOSE.md` WP-D deleted
 * along with the two location-scoped closes its pin condemned.
 */
async function seedEstate(
  store: Store,
  app: ReturnType<typeof buildServer>,
  month: string,
): Promise<SeededEstate> {
  const userIds = new Map<string, string>();
  const auth = new Map<string, { authorization: string }>();
  /** Which arm each confirmation actually took, for the assertion at the end. */
  const paths: string[] = [];
  for (const m of estate.scope.members) {
    const email = `${m.userId}@example.com`;
    const user = await store.createUser({
      email,
      passwordHash: "x",
      displayName: m.displayName ?? m.userId,
    });
    userIds.set(m.userId, user.id);
    auth.set(m.userId, {
      authorization: `Bearer ${await signAccessToken(env.jwtSecret, { sub: user.id, email })}`,
    });
  }
  const [founder, ...rest] = estate.scope.members;
  const household = await store.createHousehold("Estate", userIds.get(founder!.userId)!);
  for (const m of rest) await store.addMembership(household.id, userIds.get(m.userId)!, "member");
  for (const m of estate.scope.members) {
    await store.updateMembershipShare(household.id, userIds.get(m.userId)!, m.shareBp);
  }

  const accounts = new Map<string, Account>();
  for (const a of estate.scope.accounts) {
    accounts.set(
      a.accountId,
      await store.createAccount({
        ownerUserId: userIds.get(estate.ownerOf[a.accountId]!)!,
        name: a.name ?? a.accountId,
        currency: a.currency,
        monthlyBufferMinor: a.monthlyBufferMinor,
      }),
    );
  }
  for (const accountId of estate.assignedAccountIds) {
    const a = estate.scope.accounts.find((x) => x.accountId === accountId)!;
    await store.upsertAccountAssignment({
      householdId: household.id,
      accountId: accounts.get(accountId)!.id,
      role: a.role,
      memberUserId: a.memberUserId ? userIds.get(a.memberUserId)! : null,
    });
  }

  /** Fixture inflow id → real inflow id, for the authored movements. */
  const inflowIds = new Map<string, string>();
  for (const a of estate.scope.accounts) {
    const accountId = accounts.get(a.accountId)!.id;
    for (const i of a.incomes) {
      await store.createIncome({
        accountId,
        name: i.id,
        amountMinor: i.amountMinor,
        frequency: i.frequency,
        recurrence: i.recurrence ?? null,
        anchorDate: i.anchorDate,
        active: i.active ?? true,
      });
    }
    for (const p of a.payments) {
      await store.createPayment({
        accountId,
        name: p.name,
        category: p.category,
        amountMinor: p.amountMinor,
        dueDate: p.dueDate ?? null,
        recurrence: p.recurrence ?? null,
        targetDate: p.targetDate ?? null,
        priority: p.priority ?? 100,
        alreadySavedMinor: p.alreadySavedMinor ?? 0,
        autoRenew: true,
        active: true,
        notes: null,
        projectId: null,
        scope: p.scope,
        bearerUserId: p.bearerUserId ? userIds.get(p.bearerUserId)! : null,
        fixedMonthlyMinor: null,
        tag: null,
      });
    }
    // One row with two faces: authored on the account the money **arrives** in,
    // naming the account it leaves. The sending account's `outboundInflows` are
    // the same rows read from the other end, so they are not seeded again.
    for (const f of a.inflows ?? []) {
      const inflow = await store.createInflow({
        accountId,
        name: f.id,
        source: f.source,
        sourceAccountId: f.sourceAccountId ? accounts.get(f.sourceAccountId)!.id : null,
        amountMinor: f.amountMinor,
        frequency: f.frequency,
        recurrence: f.recurrence ?? null,
        anchorDate: f.anchorDate,
        priority: f.priority ?? 100,
        active: f.active ?? true,
      });
      inflowIds.set(f.id, inflow.id);
    }
  }

  // Confirmations of **authored** movements. The whole ones go through
  // `POST /api/inflows/:id/confirm`, which books what the pass says the movement
  // delivered; a part-moved one has no endpoint and is written directly.
  for (const a of estate.scope.accounts) {
    for (const c of a.confirmedArrivals ?? []) {
      const authored = a.inflows!.find((i) => i.id === c.inflowId)!;
      const owner = auth.get(estate.ownerOf[a.accountId]!)!;
      if (c.confirmedMinor === authored.amountMinor) {
        paths.push(`${c.inflowId}: endpoint`);
        const res = await app.inject({
          method: "POST",
          url: `/api/inflows/${inflowIds.get(c.inflowId)!}/confirm?month=${month.slice(0, 7)}`,
          headers: owner,
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().confirmation.amountMinor).toBe(c.confirmedMinor);
      } else {
        paths.push(`${c.inflowId}: direct`);
        await store.createTransferConfirmation({
          householdId: null,
          inflowId: inflowIds.get(c.inflowId)!,
          month,
          fromAccountId: accounts.get(authored.sourceAccountId!)!.id,
          toAccountId: accounts.get(a.accountId)!.id,
          memberUserId: userIds.get(estate.ownerOf[a.accountId]!)!,
          amountMinor: c.confirmedMinor,
        });
      }
    }
  }

  // Confirmations of **derived** transfers, which no row authors. A whole one
  // into a household account goes through the household endpoint (which also
  // books the contributions the plan says it paid for); a part-moved one, and
  // one into an account the household never assigned, are written directly —
  // the household-free shape `0010` made storable.
  const planned = computeScopePlan(estate.scope, estate.asOfDate);
  for (const c of estate.scope.confirmedTransfers ?? []) {
    const derived = planned.transfers.find(
      (t) =>
        t.fromAccountId === c.fromAccountId &&
        t.toAccountId === c.toAccountId &&
        t.memberUserId === c.memberUserId,
    )!;
    const whole = c.confirmedMinor === derived.amountMinor;
    const assigned = estate.assignedAccountIds.includes(c.toAccountId);
    paths.push(
      `${c.toAccountId} ← ${c.memberUserId}: ${whole && assigned ? "endpoint" : "direct"}`,
    );
    if (whole && assigned) {
      const res = await app.inject({
        method: "POST",
        url: `/api/households/${household.id}/transfers/confirm`,
        headers: auth.get(c.memberUserId)!,
        payload: {
          month: month.slice(0, 7),
          fromAccountId: accounts.get(c.fromAccountId)!.id,
          toAccountId: accounts.get(c.toAccountId)!.id,
          memberUserId: userIds.get(c.memberUserId)!,
        },
      });
      expect(res.statusCode).toBe(201);
      // The fixture's hand-set figure, checked against what the product itself
      // derives — not merely asserted beside it.
      expect(res.json().confirmation.amountMinor).toBe(c.confirmedMinor);
    } else {
      await store.createTransferConfirmation({
        householdId: null,
        inflowId: null,
        month,
        fromAccountId: accounts.get(c.fromAccountId)!.id,
        toAccountId: accounts.get(c.toAccountId)!.id,
        memberUserId: userIds.get(c.memberUserId)!,
        amountMinor: c.confirmedMinor,
      });
    }
  }

  // **The paths, named.** A fixture figure that falls out of step with the pass
  // does not change a number, it changes which arm ran — and the direct arm
  // seeds an estate that looks identical and books nothing. An unsaid
  // confirmation walks neither arm: there is no row for it to walk from, which
  // is why the two lists below drop the `none`s rather than mapping them.
  const arm = (shape: ConfirmationShape, endpointCan: boolean) =>
    shape === "whole" && endpointCan ? "endpoint" : "direct";
  expect(paths).toEqual([
    ...ESTATE_CONFIRMATION_SHAPES.movements
      .filter((m) => m.shape !== "none")
      .map((m) => `${m.inflowId}: ${arm(m.shape, true)}`),
    // Only a transfer into an account the household assigned has an endpoint to
    // go through at all; alice's out-of-household bills pot is `0010`'s
    // household-free shape and is written directly whatever its figure says.
    ...ESTATE_CONFIRMATION_SHAPES.transfers
      .filter((t) => t.shape !== "none")
      .map(
        (t) =>
          `${t.toAccountId} ← ${t.memberUserId}: ${arm(t.shape, estate.assignedAccountIds.includes(t.toAccountId))}`,
      ),
  ]);

  // And what the endpoint arm is *for*, which is the half a direct write drops
  // in silence: confirming a derived transfer whole books the member's funded
  // share of every bill in the destination account. £792 of rent and £132 of
  // council tax — Alice's 66% of the pot's £1,400 — against a £424 transfer,
  // because her budget already held the £500 of lodger rent sitting there.
  const booked = await store.listContributionsForAccount(accounts.get("acc-house-pot")!.id, month);
  expect(booked.map((b) => [b.userId, b.amountMinor])).toEqual([
    [userIds.get("u-alice"), 79_200],
    [userIds.get("u-alice"), 13_200],
  ]);

  return { householdId: household.id, userIds, accounts, auth };
}

describe("a month close is something a person does", () => {
  let store: Store;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    store = new MemoryStore();
    app = buildServer({ store, env, registerAuthProxy: false });
  });

  /** The caller's frozen months, as the API hands them back. */
  const closesOf = async (headers: { authorization: string }) =>
    (await app.inject({ method: "GET", url: "/api/me/closes", headers })).json() as {
      id: string;
      userId: string;
      currency: string;
      month: string;
      incomeMinor: number;
      plannedMinor: number;
      contributedMinor: number;
    }[];

  /**
   * The fixture composes: seeded into a store and read back through the real
   * loader, it plans to exactly what `computeScopePlan` makes of it directly.
   *
   * This is the test that guards the estate every close below is scored over. It
   * also settles the date question: the fixture is planned at `ESTATE_ASOF` and
   * the store is planned as of today, and the two agree, because every income in
   * the estate is monthly and every payment a monthly recurring bill.
   */
  it("plans identically whether it comes from the fixture or from a store", async () => {
    const asOfDate = new Date().toISOString().slice(0, 10);
    const seeded = await seedEstate(store, app, `${thisMonth()}-01`);

    const loaded = await scopeForAccount(
      store,
      seeded.accounts.get("acc-alice-current")!,
      asOfDate,
    );
    const direct = computeScopePlan(estate.scope, ESTATE_ASOF);

    // One scope, whichever end it is seeded from: the household's accounts and
    // the pot alice kept out of it are planned together (`f3acef8`).
    expect(loaded.accountIds).toHaveLength(estate.scope.accounts.length);
    expect(loaded.plan.partitions.map((p) => p.currency)).toEqual(["EUR", "GBP"]);
    expect(direct.partitions.map((p) => p.currency)).toEqual(["EUR", "GBP"]);

    /** The fixture's readable id for a real account id. */
    const fixtureId = new Map(
      [...seeded.accounts].map(([fixture, account]) => [account.id, fixture]),
    );
    const fixtureUser = new Map([...seeded.userIds].map(([fixture, id]) => [id, fixture]));

    const transfersOf = (plan: typeof direct, translate: boolean) =>
      plan.transfers
        .map((t) => ({
          from: translate ? fixtureId.get(t.fromAccountId) : t.fromAccountId,
          to: translate ? fixtureId.get(t.toAccountId) : t.toAccountId,
          member: translate ? fixtureUser.get(t.memberUserId) : t.memberUserId,
          amountMinor: t.amountMinor,
          confirmedMinor: t.confirmedMinor,
        }))
        .sort((a, b) => `${a.to}${a.member}`.localeCompare(`${b.to}${b.member}`));

    // Every derived transfer, to the penny, with its confirmation state — the
    // three destinations and the three states the estate exists to carry.
    expect(transfersOf(loaded.plan, true)).toEqual(transfersOf(direct, false));
    expect(transfersOf(direct, false)).toEqual([
      // Part-moved: £30 of the £75 feeding the out-of-household pot.
      {
        from: "acc-alice-current",
        to: "acc-alice-bills",
        member: "u-alice",
        amountMinor: 7_500,
        confirmedMinor: 3_000,
      },
      // Whole. The pot's own £500 of lodger rent is Alice's, because the pot is
      // (MONTH-CLOSE.md decision 15), so it is her share of the pot's bills that
      // the £500 already sitting there nets off. The two members still transport
      // £900 between them — the pot's £1,400 less its own £500, which is
      // `0c35284`'s netting.
      {
        from: "acc-alice-current",
        to: "acc-house-pot",
        member: "u-alice",
        amountMinor: 42_400,
        confirmedMinor: 42_400,
      },
      // Nobody has said this one moved. Bob's gross share, un-netted: leaning on
      // money that is in Alice's budget would have him end the month holding
      // hers.
      {
        from: "acc-bob-current",
        to: "acc-house-pot",
        member: "u-bob",
        amountMinor: 47_600,
        confirmedMinor: 0,
      },
    ]);

    // And the authored movements, with their own three states. Keyed by
    // destination rather than taken in order: a store hands its accounts back
    // sorted by the ids it generated, and the fixture's are readable.
    const arrivals = (plan: typeof direct, translate: boolean) =>
      plan.accounts
        .flatMap((a) =>
          a.inflowArrivals.map((i) => ({
            to: translate ? fixtureId.get(a.accountId) : a.accountId,
            amountMinor: i.amountMinor,
            confirmedMinor: i.confirmedMinor ?? 0,
          })),
        )
        .sort((x, y) => x.to!.localeCompare(y.to!));
    expect(arrivals(loaded.plan, true)).toEqual(arrivals(direct, false));
    expect(arrivals(direct, false)).toEqual([
      { to: "acc-alice-car", amountMinor: 10_000, confirmedMinor: 0 },
      { to: "acc-alice-holiday", amountMinor: 15_000, confirmedMinor: 5_000 },
      { to: "acc-alice-savings", amountMinor: 20_000, confirmedMinor: 20_000 },
    ]);
  });

  /**
   * One action, every partition — and every figure the one `closeForUser`
   * derives, through the HTTP surface, to the penny.
   *
   * The estate is why this is per currency. Alice holds a euro account, so she
   * plans in two partitions; the household close this replaces was denominated
   * in its first assigned account's currency and could not see the second one at
   * all, so the €800 landing in it appeared in no close anywhere.
   */
  it("freezes one row per currency the caller plans in", async () => {
    const month = thisMonth();
    const seeded = await seedEstate(store, app, `${month}-01`);
    const alice = seeded.auth.get("u-alice")!;

    // Money set aside by hand, on top of the £924 confirming her transfer to the
    // pot already booked — in both of her currencies, so the ledger half of the
    // scorecard is a sum over rows that land in different partitions and has to
    // bucket them by the account's currency to be right. Nothing seeds a euro
    // contribution, so without this one the EUR row could not tell an empty
    // ledger from a bucket it had put in the wrong partition.
    const record = async (fixtureAccountId: string, name: string, amountMinor: number) => {
      const account = seeded.accounts.get(fixtureAccountId)!;
      const payment = (await store.listPayments(account.id)).find((p) => p.name === name)!;
      const res = await app.inject({
        method: "POST",
        url: `/api/payments/${payment.id}/contributions`,
        headers: alice,
        payload: { amountMinor, month },
      });
      expect(res.statusCode).toBe(201);
    };
    await record("acc-house-pot", "Rent", 10_000);
    await record("acc-alice-eur", "Hosting", 2_500);

    const res = await app.inject({
      method: "POST",
      url: "/api/me/closes",
      headers: alice,
      payload: { month },
    });
    expect(res.statusCode).toBe(201);

    const rows = res.json() as { currency: string; incomeMinor: number }[];
    expect(rows.map((r) => r.currency)).toEqual(["EUR", "GBP"]);
    expect(res.json()).toEqual(
      rows.map((r) => ({
        ...r,
        userId: seeded.userIds.get("u-alice"),
        householdId: null,
        accountId: null,
        month: `${month}-01`,
        closedBy: seeded.userIds.get("u-alice"),
        closedAt: expect.any(String),
        id: expect.any(String),
      })),
    );

    // The figures, hand-checked against `estate.fixture.ts`'s own note:
    //  - EUR: €800 of income, €120 of hosting, €25 set aside;
    //  - GBP: £3,000 of salary **plus the pot's own £500** (decision 15 — the
    //    pot is Alice's account), £924 of the pot's bills at her 66% share plus
    //    the £75 her out-of-household pot needs, and £1,024 set aside: the £924
    //    confirming her transfer booked against the pot's two bills, and the
    //    £100 recorded by hand above.
    //
    // Contributed exceeding planned is not a bug and is worth seeing here: a
    // member's *obligation* is netted against the pot's own income (`0c35284`),
    // and what she is booked as having paid towards its bills is not.
    expect(res.json()).toMatchObject([
      { currency: "EUR", incomeMinor: 80_000, plannedMinor: 12_000, contributedMinor: 2_500 },
      { currency: "GBP", incomeMinor: 350_000, plannedMinor: 99_900, contributedMinor: 102_400 },
    ]);

    // And the same figures the domain derives, over the same estate: the
    // endpoint's job is to call `closeForUser`, not to recompute it.
    const scope = await scopeForAccount(
      store,
      seeded.accounts.get("acc-alice-current")!,
      new Date().toISOString().slice(0, 10),
    );
    const contributions = (
      await Promise.all(
        scope.accountIds.map((id) => store.listContributionsForAccount(id, `${month}-01`)),
      )
    ).flat();
    expect(res.json()).toMatchObject(
      closeForUser(scope.plan, contributions, seeded.userIds.get("u-alice")!),
    );

    expect((await closesOf(alice)).map((c) => c.currency)).toEqual(["EUR", "GBP"]);
  });

  /**
   * **The identity the deleted pin could not state.** Add up what every member
   * of a partition says they earned and you get what the partition earned —
   * exactly, in each currency, with nothing counted twice.
   *
   * The two location-scoped producers could not do this: summing account closes
   * over a household counted every funded transfer at both ends (£6,094 against
   * the household's own £5,500, at `21ec4e1`, one confirmed £594 transfer
   * apart), because an account's "income" had to be redefined as what arrived in
   * it. A person's income needs no redefinition, so the sum is just a sum.
   */
  it("sums its members' closes to the partition, per currency", async () => {
    const month = thisMonth();
    const seeded = await seedEstate(store, app, `${month}-01`);

    const rows = [];
    for (const member of ["u-alice", "u-bob"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/closes",
        headers: seeded.auth.get(member)!,
        payload: { month },
      });
      expect(res.statusCode).toBe(201);
      rows.push(...(res.json() as { currency: string; incomeMinor: number }[]));
    }

    const direct = computeScopePlan(estate.scope, ESTATE_ASOF);
    for (const partition of direct.partitions) {
      const summed = rows
        .filter((r) => r.currency === partition.currency)
        .reduce((sum, r) => sum + r.incomeMinor, 0);
      expect(summed).toBe(partition.monthlyIncomeMinor);
    }
    // Not vacuously: both partitions earned something, and both members were
    // asked. Bob's euro row is the zero it should be — he is in the household
    // whose estate holds that account and earns nothing in it — and it is what
    // makes the EUR sum a sum over *every* member rather than over Alice alone.
    expect(rows.filter((r) => r.currency === "EUR")).toHaveLength(2);
    expect(direct.partitions.map((p) => p.monthlyIncomeMinor)).toEqual([80_000, 550_000]);
  });

  it("refuses a second close of the same month, and writes nothing", async () => {
    const month = thisMonth();
    const seeded = await seedEstate(store, app, `${month}-01`);
    const alice = seeded.auth.get("u-alice")!;
    const close = () =>
      app.inject({ method: "POST", url: "/api/me/closes", headers: alice, payload: { month } });

    expect((await close()).statusCode).toBe(201);
    const before = await closesOf(alice);

    const again = await close();
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("already_closed");
    // All partitions or none: the second attempt left the first alone and added
    // nothing of its own, in either currency.
    expect(await closesOf(alice)).toEqual(before);

    // A month that has not started yet has no plan to freeze.
    const future = await app.inject({
      method: "POST",
      url: "/api/me/closes",
      headers: alice,
      payload: { month: `${new Date().getUTCFullYear() + 1}-01` },
    });
    expect(future.statusCode).toBe(422);
    expect(future.json().error.code).toBe("future_month");
  });

  it("keeps one person's scorecard out of everybody else's hands", async () => {
    const month = thisMonth();
    const seeded = await seedEstate(store, app, `${month}-01`);
    const alice = seeded.auth.get("u-alice")!;
    const bob = seeded.auth.get("u-bob")!;

    for (const headers of [alice, bob]) {
      expect(
        (await app.inject({ method: "POST", url: "/api/me/closes", headers, payload: { month } }))
          .statusCode,
      ).toBe(201);
    }

    // Listing is self-scoped: sharing a household, an estate and a bills pot
    // does not put Bob's month on Alice's list or hers on his.
    const hers = await closesOf(alice);
    const his = await closesOf(bob);
    expect(hers.every((c) => c.userId === seeded.userIds.get("u-alice"))).toBe(true);
    expect(his.every((c) => c.userId === seeded.userIds.get("u-bob"))).toBe(true);
    expect(hers.map((c) => c.id).some((id) => his.map((c) => c.id).includes(id))).toBe(false);

    // Nor can either of them re-open the other's. 404 rather than 403: a close
    // they cannot touch is a close they are not told about.
    const stolen = await app.inject({
      method: "DELETE",
      url: `/api/me/closes/${hers[0]!.id}`,
      headers: bob,
    });
    expect(stolen.statusCode).toBe(404);
    expect(await closesOf(alice)).toEqual(hers);

    // Her own, she re-opens.
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/me/closes/${hers[0]!.id}`,
      headers: alice,
    });
    expect(removed.statusCode).toBe(204);
    expect((await closesOf(alice)).map((c) => c.id)).toEqual(hers.slice(1).map((c) => c.id));

    // And nobody at all, without a token.
    expect((await app.inject({ method: "GET", url: "/api/me/closes" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/api/me/closes", payload: { month } })).statusCode,
    ).toBe(401);
  });

  /**
   * The two location-scoped producers are gone, not hidden. Superseded code is
   * deleted, not left: a route that still answered would read as a live
   * alternative, and it was two of them disagreeing that started this.
   */
  it("has no account-scoped or household-scoped close left to call", async () => {
    const month = thisMonth();
    const seeded = await seedEstate(store, app, `${month}-01`);
    const alice = seeded.auth.get("u-alice")!;
    const accountId = seeded.accounts.get("acc-alice-current")!.id;

    for (const [method, url] of [
      ["POST", `/api/accounts/${accountId}/close`],
      ["GET", `/api/accounts/${accountId}/closes`],
      ["DELETE", `/api/accounts/${accountId}/closes/whatever`],
      ["POST", `/api/households/${seeded.householdId}/close`],
      ["GET", `/api/households/${seeded.householdId}/closes`],
      ["DELETE", `/api/households/${seeded.householdId}/closes/whatever`],
    ] as const) {
      const res = await app.inject({ method, url, headers: alice, payload: { month } });
      expect([method, url, res.statusCode]).toEqual([method, url, 404]);
    }
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
    // The owner's own frozen July, in the currency this account is in. Not
    // hung off the account: a close is per user, per currency.
    await store.createMonthClose({
      householdId: null,
      accountId: null,
      userId: ownerId,
      currency: "GBP",
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
    // At the file's top level, naming its currency: a close is one person's
    // month, and no account is the one it is about.
    expect(account.closes).toBeUndefined();
    expect(file.closes).toEqual([
      {
        month: "2026-07-01",
        currency: "GBP",
        incomeMinor: 300_000,
        plannedMinor: 20_000,
        contributedMinor: 20_000,
      },
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
      derivedTransferConfirmations: 0,
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

    const first = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: auth,
      payload: file,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: auth,
      payload: file,
    });
    expect(await store.listAccountsForOwner(user.id)).toHaveLength(3); // original + 2

    // …but not of the scorecard. A second account is a coherent thing to own; a
    // second July is not, and the row that is already there is the record of a
    // month that was closed once. The importer already had it, so both runs
    // leave it alone.
    expect(first.json().closes).toBe(0);
    expect(second.json().closes).toBe(0);
    expect(await store.listMonthCloses({ userId: user.id })).toHaveLength(1);
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
   * Alice is in one household with Bob — a user belongs to exactly one (WP-W) —
   * and also keeps a savings pair of her own that no household has ever heard
   * of, joined by a movement she authored. One diagram, two scopes, all of it.
   *
   * This fixture used to give Alice a second household, which is now an
   * unreachable state. It does not need one. What it is really testing is a
   * diagram drawn over more than one *scope*, and money arriving across the
   * scope's edge from a sender the caller left out — and a household of two
   * supplies the second better than a second household did: Bob's own current
   * account funds his 40% of the rent and is deliberately left out of every
   * picture below, so his share arrives from nowhere while Alice's is drawn
   * account to account.
   */
  async function seedHouseholdAndAPot() {
    const { user: alice, auth } = await seedUser(store, "alice@example.com");
    const { user: bob, auth: bobAuth } = await seedUser(store, "bob@example.com");

    const make = async (
      name: string,
      incomeMinor?: number,
      who: { authorization: string } = auth,
    ) => {
      const account = (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers: who,
          payload: { name, currency: "GBP" },
        })
      ).json();
      if (incomeMinor) {
        await app.inject({
          method: "POST",
          url: `/api/accounts/${account.id}/incomes`,
          headers: who,
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
    // Bob's, and his alone. Left out of the diagram below, so his share of the
    // rent arrives across the scope's edge while Alice's arrives account to
    // account.
    const bobCurrent = await make("bob-current", 200_000, bobAuth);
    // Alice's savings pair, in no household at all: the second scope.
    const savings = await make("savings", 150_000);
    const isa = await make("isa");

    const bill = (accountId: string, name: string, amountMinor: number) =>
      app.inject({
        method: "POST",
        url: `/api/accounts/${accountId}/payments`,
        headers: auth,
        payload: { name, category: "monthly_recurring", amountMinor, scope: "shared" },
      });
    await bill(homeBills.id, "Rent", 100_000);

    const home = await store.createHousehold("Home", alice.id);
    await store.addMembership(home.id, bob.id, "member");
    await store.updateMembershipRole(home.id, bob.id, "admin");
    await store.updateMembershipShare(home.id, alice.id, 6000);
    await store.updateMembershipShare(home.id, bob.id, 4000);
    const assign = (
      householdId: string,
      accountId: string,
      payload: object,
      who: { authorization: string } = auth,
    ) =>
      app.inject({
        method: "PUT",
        url: `/api/households/${householdId}/accounts/${accountId}`,
        headers: who,
        payload,
      });
    await assign(home.id, current.id, { role: "personal", memberUserId: alice.id });
    await assign(home.id, homeBills.id, { role: "shared" });
    // Bob puts his own account in the plan; nobody else can see it, and nobody
    // needs to.
    await assign(home.id, bobCurrent.id, { role: "personal", memberUserId: bob.id }, bobAuth);

    // The standalone leg: £600 a month out of the savings account into the ISA,
    // with no household anywhere in it.
    const movement = (
      await app.inject({
        method: "POST",
        url: `/api/accounts/${isa.id}/inflows`,
        headers: auth,
        payload: {
          name: "Monthly saving",
          source: "account",
          sourceAccountId: savings.id,
          amountMinor: 60_000,
          frequency: "monthly",
          anchorDate: "2026-01-01",
        },
      })
    ).json();

    return { auth, alice, current, homeBills, bobCurrent, savings, isa, movement };
  }

  it("draws a scope spanning a household and a standalone pot", async () => {
    const { auth, alice, current, homeBills, savings, isa, movement } =
      await seedHouseholdAndAPot();

    const res = await flow(auth, [current.id, homeBills.id, savings.id, isa.id]);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.accounts.map((a: { name: string }) => a.name)).toEqual([
      "current",
      "home-bills",
      "savings",
      "isa",
    ]);
    expect(body.currency).toBe("GBP");

    // The authored movement is drawn account to account, by its own id.
    const internal = body.edges.find((e: { inflowId?: string }) => e.inflowId === movement.id);
    expect(internal).toMatchObject({
      fromAccountId: savings.id,
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
          e.toAccountId === homeBills.id && e.memberUserId === alice.id,
      ),
    ).toMatchObject({
      fromAccountId: current.id,
      memberUserId: alice.id,
      memberName: "Owner",
      amountMinor: 60_000,
    });

    // Bob's share of the same rent leaves an account the user left out, so it
    // arrives across the scope's edge instead of out of thin air. Same pot, two
    // feeds, one drawn and one crossing the boundary.
    const arriving = body.edges.filter((e: { fromAccountId: null }) => e.fromAccountId === null);
    expect(arriving.map((e: { toAccountId: string }) => e.toAccountId)).toEqual([homeBills.id]);

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
    expect(body.totalInflowMinor).toBe(400_000 + 150_000 + fromOutside);
  });

  /**
   * The whole point of the endpoint taking the *set* rather than the household:
   * a subset of the same accounts is a different picture of the same money, and
   * the money crossing the edge of the smaller scope is still drawn.
   */
  it("draws a subset of the same accounts without inventing or losing money", async () => {
    const { auth, savings, isa } = await seedHouseholdAndAPot();
    const body = (await flow(auth, [isa.id])).json();
    expect(body.accounts).toHaveLength(1);
    expect(body.edges).toEqual([
      expect.objectContaining({ fromAccountId: null, toAccountId: isa.id, amountMinor: 60_000 }),
    ]);
    expect(body.totalInflowMinor).toBe(60_000);
    // ...and the sender is untouched by not being drawn.
    const sender = (await flow(auth, [savings.id])).json();
    expect(sender.accounts[0].incomeMinor).toBe(150_000);
  });

  it("is exactly as visible as the least visible account in the set", async () => {
    const { auth, current } = await seedHouseholdAndAPot();
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
    const { auth, current } = await seedHouseholdAndAPot();

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
    const { auth, current, isa } = await seedHouseholdAndAPot();
    const body = (await flow(auth, [isa.id, current.id, isa.id])).json();
    expect(body.accounts.map((a: { name: string }) => a.name)).toEqual(["isa", "current"]);
  });

  /**
   * Visibility is presentation, and the endpoint is where that promise is kept
   * by having nowhere to break it: there is no parameter for hiding an account,
   * so a hidden account cannot be dropped from the pass that funds the others.
   */
  it("has no notion of a hidden account, so hiding one cannot move a figure", async () => {
    const { auth, savings, isa } = await seedHouseholdAndAPot();
    const scope = [savings.id, isa.id];
    const before = (await flow(auth, scope)).json();
    // The client hiding the ISA still asks for the whole set.
    const after = (await flow(auth, scope)).json();
    expect(after).toEqual(before);
    // ...and asking for a smaller set is a different question, which is why
    // hiding must never be expressed that way: the movement's money leaves the
    // savings account either way, but the ISA's own node goes with it.
    const narrowed = (await flow(auth, [savings.id])).json();
    expect(narrowed.accounts).toHaveLength(1);
    expect(narrowed.edges[0]).toMatchObject({ fromAccountId: savings.id, toAccountId: null });
  });
});

// ---------------------------------------------------------------------------
// The overview is the caller's own money
// ---------------------------------------------------------------------------

/**
 * `crossowner.fixture.ts`, walked into a store, the same way `seedEstate` walks
 * the estate.
 *
 * Deliberately mechanical, and deliberately here rather than in the domain
 * package, for `seedEstate`'s reason: `@finance-planner/domain` does not depend
 * on `@finance-planner/data` and a fixture is not a reason to make it.
 *
 * Simpler than the estate's walk in exactly one way — nothing is confirmed. A
 * confirmation would change what the checklist says and none of the figures
 * this fixture exists for, and the fixture's own comment says so.
 */
async function seedCrossOwner(store: Store): Promise<SeededEstate> {
  const userIds = new Map<string, string>();
  const auth = new Map<string, { authorization: string }>();
  for (const m of crossOwnerScope.members) {
    const email = `${m.userId}@crossowner.example.com`;
    const user = await store.createUser({
      email,
      passwordHash: "x",
      displayName: m.displayName ?? m.userId,
    });
    userIds.set(m.userId, user.id);
    auth.set(m.userId, {
      authorization: `Bearer ${await signAccessToken(env.jwtSecret, { sub: user.id, email })}`,
    });
  }
  const [founder, ...rest] = crossOwnerScope.members;
  const household = await store.createHousehold("Cross", userIds.get(founder!.userId)!);
  for (const m of rest) await store.addMembership(household.id, userIds.get(m.userId)!, "member");
  for (const m of crossOwnerScope.members) {
    await store.updateMembershipShare(household.id, userIds.get(m.userId)!, m.shareBp);
  }

  const accounts = new Map<string, Account>();
  for (const a of crossOwnerScope.accounts) {
    accounts.set(
      a.accountId,
      await store.createAccount({
        ownerUserId: userIds.get(a.ownerUserId)!,
        name: a.name ?? a.accountId,
        currency: a.currency,
        monthlyBufferMinor: a.monthlyBufferMinor,
      }),
    );
  }
  for (const accountId of CROSS_OWNER_ASSIGNED_ACCOUNT_IDS) {
    const a = crossOwnerScope.accounts.find((x) => x.accountId === accountId)!;
    await store.upsertAccountAssignment({
      householdId: household.id,
      accountId: accounts.get(accountId)!.id,
      role: a.role,
      memberUserId: a.memberUserId ? userIds.get(a.memberUserId)! : null,
    });
  }

  for (const a of crossOwnerScope.accounts) {
    const accountId = accounts.get(a.accountId)!.id;
    for (const i of a.incomes) {
      await store.createIncome({
        accountId,
        name: i.id,
        amountMinor: i.amountMinor,
        frequency: i.frequency,
        recurrence: i.recurrence ?? null,
        anchorDate: i.anchorDate,
        active: i.active ?? true,
      });
    }
    for (const p of a.payments) {
      await store.createPayment({
        accountId,
        name: p.name,
        category: p.category,
        amountMinor: p.amountMinor,
        dueDate: p.dueDate ?? null,
        recurrence: p.recurrence ?? null,
        targetDate: p.targetDate ?? null,
        priority: p.priority ?? 100,
        alreadySavedMinor: p.alreadySavedMinor ?? 0,
        autoRenew: true,
        active: true,
        notes: null,
        projectId: null,
        scope: p.scope,
        bearerUserId: p.bearerUserId ? userIds.get(p.bearerUserId)! : null,
        fixedMonthlyMinor: null,
        tag: null,
      });
    }
    // One row with two faces, authored on the account the money arrives in —
    // the sending account's `outboundInflows` are the same row read from the
    // other end, so they are not seeded again.
    for (const f of a.inflows ?? []) {
      await store.createInflow({
        accountId,
        name: f.id,
        source: f.source,
        sourceAccountId: f.sourceAccountId ? accounts.get(f.sourceAccountId)!.id : null,
        amountMinor: f.amountMinor,
        frequency: f.frequency,
        recurrence: f.recurrence ?? null,
        anchorDate: f.anchorDate,
        priority: f.priority ?? 100,
        active: f.active ?? true,
      });
    }
  }

  return { householdId: household.id, userIds, accounts, auth };
}

/** One currency bucket of an overview response, as far as these tests read it. */
interface OverviewBucket {
  currency: string;
  leftoverMinor: number;
  shortfallMinor: number;
  you: { leftoverMinor: number; shortfallMinor: number; paymentCount: number };
  accounts: {
    accountId: string;
    ownerUserId: string;
    leftoverMinor: number;
    residualMinor: number;
  }[];
}

describe("the overview is the caller's own money", () => {
  let store: Store;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    store = new MemoryStore();
    app = buildServer({ store, env, registerAuthProxy: false });
  });

  const bucketsFor = async (
    headers: { authorization: string },
    asOf: string,
  ): Promise<OverviewBucket[]> =>
    (await app.inject({ method: "GET", url: `/api/overview?asOf=${asOf}`, headers })).json()
      .perCurrency;

  const gbpFor = async (headers: { authorization: string }, asOf: string) =>
    (await bucketsFor(headers, asOf)).find((c) => c.currency === "GBP")!;

  const householdPlan = async (
    id: string,
    headers: { authorization: string },
    asOf: string,
  ): Promise<{
    membersLeftoverMinor: number;
    householdLeftoverMinor: number;
    committedMinor: number;
    members: {
      userId: string;
      displayName?: string;
      personalLeftoverMinor: number;
      arrivedFromOthers?: { ownerUserId: string; amountMinor: number }[];
    }[];
    accounts: { accountId: string; leftoverMinor: number }[];
  }> =>
    (
      await app.inject({ method: "GET", url: `/api/households/${id}/plan?asOf=${asOf}`, headers })
    ).json();

  /**
   * **The three altitudes, at the API.** `mine.test.ts` pins them in the domain;
   * this is the same three figures read off the wire the dashboard reads, so a
   * handler cannot quietly hand a screen a different basis than the pass
   * computed.
   */
  it("reports each member their own left over on the estate", async () => {
    const seeded = await seedEstate(store, app, `${thisMonth()}-01`);
    const alice = await gbpFor(seeded.auth.get("u-alice")!, ESTATE_ASOF);
    const bob = await gbpFor(seeded.auth.get("u-bob")!, ESTATE_ASOF);

    expect(alice.you.leftoverMinor).toBe(250_100);
    expect(bob.you.leftoverMinor).toBe(152_400);

    // And the rows on the screen add up to the figure above them — over the
    // accounts the caller **owns**, which is the whole of decision 20.
    const ownedSum = (bucket: OverviewBucket, userId: string) =>
      bucket.accounts
        .filter((a) => a.ownerUserId === userId)
        .reduce((n, a) => n + a.residualMinor, 0);
    expect(ownedSum(alice, seeded.userIds.get("u-alice")!)).toBe(250_100);
    expect(ownedSum(bob, seeded.userIds.get("u-bob")!)).toBe(152_400);

    // Bob's figure holds nothing of Alice's, and hers nothing of his.
    expect(bob.accounts.some((a) => a.ownerUserId === seeded.userIds.get("u-alice"))).toBe(false);
    expect(alice.you.leftoverMinor + bob.you.leftoverMinor).toBe(402_500);
  });

  /** A second currency is a second answer, never a term in the first
   *  (decision 10) — Alice's EUR account sits in its own bucket with its own
   *  `you`, and the GBP figure is untouched by it. */
  it("keeps a second currency in a second bucket and never adds it in", async () => {
    const seeded = await seedEstate(store, app, `${thisMonth()}-01`);
    const buckets = await bucketsFor(seeded.auth.get("u-alice")!, ESTATE_ASOF);

    expect(buckets.map((c) => c.currency)).toEqual(["EUR", "GBP"]);
    const eur = buckets.find((c) => c.currency === "EUR")!;
    const gbp = buckets.find((c) => c.currency === "GBP")!;
    expect(gbp.you.leftoverMinor).toBe(250_100);
    expect(eur.you.leftoverMinor).toBe(
      eur.accounts
        .filter((a) => a.ownerUserId === seeded.userIds.get("u-alice"))
        .reduce((n, a) => n + a.residualMinor, 0),
    );
    expect(eur.you.leftoverMinor).not.toBe(0);
    expect(gbp.you.leftoverMinor).not.toBe(gbp.you.leftoverMinor + eur.you.leftoverMinor);
  });

  /**
   * **The shape every fixture in this repo used to be**, and the one a defect
   * hides behind: a user with no household at all. `you` is read off the pass's
   * partition members, and a solo owner is a member of their own scope — a
   * household of one — so their whole bucket is theirs.
   */
  it("gives a solo user with no household their whole bucket", async () => {
    const { user, auth } = await seedUser(store, "solo-you@example.com");
    const account = await store.createAccount({
      ownerUserId: user.id,
      name: "Current",
      currency: "GBP",
    });
    await store.createIncome({
      accountId: account.id,
      name: "Salary",
      amountMinor: 240_000,
      frequency: "monthly",
      recurrence: null,
      anchorDate: "2026-01-01",
      active: true,
    });
    await store.createPayment({
      accountId: account.id,
      name: "Rent",
      category: "monthly_recurring",
      amountMinor: 90_000,
      dueDate: null,
      recurrence: null,
      targetDate: null,
      priority: 10,
      alreadySavedMinor: 0,
      autoRenew: true,
      active: true,
      notes: null,
      projectId: null,
      scope: "personal",
      bearerUserId: null,
      fixedMonthlyMinor: null,
      tag: null,
    });

    const gbp = await gbpFor(auth, "2026-08-04");
    expect(gbp.you).toEqual({ leftoverMinor: 150_000, shortfallMinor: 0, paymentCount: 1 });
    // Nothing to be different from: with one owner and one account, the
    // ownership figure and the access figure are the same money.
    expect(gbp.you.leftoverMinor).toBe(gbp.leftoverMinor);
    expect(gbp.accounts[0]!.ownerUserId).toBe(user.id);
  });

  /**
   * **Decision 20, pinned.** An account a co-member shared into your household
   * is a legitimate row in your list — you can see it, and there are things on
   * it you may be asked to act on — and it is not one penny of your money.
   */
  it("lists an account shared to the caller and leaves it out of their figure", async () => {
    const { user: alice, auth: aliceAuth } = await seedUser(store, "alice-share@example.com");
    const { user: bob, auth: bobAuth } = await seedUser(store, "bob-share@example.com");
    const household = await store.createHousehold("Ours", alice.id);
    await store.addMembership(household.id, bob.id, "member");

    const mine = await store.createAccount({
      ownerUserId: alice.id,
      name: "Alice current",
      currency: "GBP",
    });
    const theirs = await store.createAccount({
      ownerUserId: bob.id,
      name: "Bob current",
      currency: "GBP",
    });
    for (const [accountId, amountMinor] of [
      [mine.id, 200_000],
      [theirs.id, 150_000],
    ] as const) {
      await store.createIncome({
        accountId,
        name: "Salary",
        amountMinor,
        frequency: "monthly",
        recurrence: null,
        anchorDate: "2026-01-01",
        active: true,
      });
    }
    await store.createAccountShare(theirs.id, household.id, "view");

    const gbp = await gbpFor(aliceAuth, "2026-08-04");
    // In the list, named as his.
    expect(gbp.accounts.map((a) => a.accountId).sort()).toEqual([mine.id, theirs.id].sort());
    expect(gbp.accounts.find((a) => a.accountId === theirs.id)!.ownerUserId).toBe(bob.id);
    // Out of the figure. The access-basis total beside it still counts both,
    // keeps its meaning to the penny, and is not what any screen reads.
    expect(gbp.you.leftoverMinor).toBe(200_000);
    expect(gbp.leftoverMinor).toBe(350_000);
    // And it is his in his own overview, not nobody's.
    expect((await gbpFor(bobAuth, "2026-08-04")).you.leftoverMinor).toBe(150_000);
  });

  /**
   * **Decision 24.** The shortfall and the payment count follow the left over
   * onto the ownership basis, because a headline pairing a left over that is
   * yours with a shortfall that is the household's states two bases in one
   * sentence.
   */
  it("counts the shortfall and the payments over the accounts the caller owns", async () => {
    const { user: alice, auth: aliceAuth } = await seedUser(store, "alice-short@example.com");
    const { user: bob, auth: bobAuth } = await seedUser(store, "bob-short@example.com");
    const household = await store.createHousehold("Ours", alice.id);
    await store.addMembership(household.id, bob.id, "member");

    const mine = await store.createAccount({
      ownerUserId: alice.id,
      name: "Alice current",
      currency: "GBP",
    });
    const theirs = await store.createAccount({
      ownerUserId: bob.id,
      name: "Bob current",
      currency: "GBP",
    });
    await store.createIncome({
      accountId: mine.id,
      name: "Salary",
      amountMinor: 100_000,
      frequency: "monthly",
      recurrence: null,
      anchorDate: "2026-01-01",
      active: true,
    });
    // Bob has no income at all, so his bill is entirely short — and it is his
    // bill, on his account, in a household Alice can see it through.
    for (const [accountId, name, amountMinor] of [
      [mine.id, "Phone", 4_500],
      [theirs.id, "Gym", 6_000],
    ] as const) {
      await store.createPayment({
        accountId,
        name,
        category: "monthly_recurring",
        amountMinor,
        dueDate: null,
        recurrence: null,
        targetDate: null,
        priority: 10,
        alreadySavedMinor: 0,
        autoRenew: true,
        active: true,
        notes: null,
        projectId: null,
        scope: "personal",
        bearerUserId: null,
        fixedMonthlyMinor: null,
        tag: null,
      });
    }
    await store.createAccountShare(theirs.id, household.id, "view");

    const gbp = await gbpFor(aliceAuth, "2026-08-04");
    expect(gbp.you).toEqual({ leftoverMinor: 95_500, shortfallMinor: 0, paymentCount: 1 });
    // The access-basis figures beside it, unchanged, counting both accounts.
    expect(gbp.shortfallMinor).toBe(6_000);
    expect(gbp.accounts).toHaveLength(2);
    // His shortfall is his, and it is still reported — to him.
    expect((await gbpFor(bobAuth, "2026-08-04")).you).toEqual({
      leftoverMinor: 0,
      shortfallMinor: 6_000,
      paymentCount: 1,
    });
  });

  /**
   * The household response carries the same three altitudes: what each member
   * has, and their sum. Names are gated on membership — this endpoint is
   * members-only — and no amount is gated, which is asserted rather than
   * assumed.
   */
  it("reports the members' left over on the household plan", async () => {
    const seeded = await seedEstate(store, app, `${thisMonth()}-01`);
    const plan = await householdPlan(
      seeded.householdId,
      seeded.auth.get("u-bob")!,
      thisMonth() + "-04",
    );

    expect(plan.membersLeftoverMinor).toBe(402_500);
    const personal = new Map(plan.members.map((m) => [m.userId, m.personalLeftoverMinor]));
    expect(personal.get(seeded.userIds.get("u-alice")!)).toBe(250_100);
    expect(personal.get(seeded.userIds.get("u-bob")!)).toBe(152_400);
    // The rows on the screen add to the total above them.
    expect(plan.members.reduce((n, m) => n + m.personalLeftoverMinor, 0)).toBe(402_500);

    // Names for a member, amounts for anyone the endpoint admits — and it
    // admits members only, which is the gate.
    expect(plan.members.map((m) => m.displayName).sort()).toEqual(["Alice", "Bob"]);
    const { auth: strangerAuth } = await seedUser(store, "stranger-hh@example.com");
    const refused = await app.inject({
      method: "GET",
      url: `/api/households/${seeded.householdId}/plan`,
      headers: strangerAuth,
    });
    expect(refused.statusCode).toBe(404);
  });

  /**
   * **The cross-owner fixture, at the API altitude.**
   *
   * The only shape that tells the ownership basis from the roster basis: on the
   * estate the two coincide to the penny, so an estate-only pin proves nothing
   * about which one shipped. Here an implementation wired to the roster reads
   * £3,300 for the household and £1,200 for Bob; the ownership basis reads
   * £2,900 and £800, and both roster figures are still on the wire beside them.
   */
  it("reports the ownership basis, not the roster basis, on the cross-owner fixture", async () => {
    const seeded = await seedCrossOwner(store);
    const alice = await gbpFor(seeded.auth.get("u-alice")!, CROSS_OWNER_ASOF);
    const bob = await gbpFor(seeded.auth.get("u-bob")!, CROSS_OWNER_ASOF);

    expect(alice.you.leftoverMinor).toBe(210_000);
    expect(bob.you.leftoverMinor).toBe(80_000);

    const plan = await householdPlan(
      seeded.householdId,
      seeded.auth.get("u-alice")!,
      CROSS_OWNER_ASOF,
    );
    expect(plan.membersLeftoverMinor).toBe(290_000);
    expect(
      new Map(plan.members.map((m) => [m.userId, m.personalLeftoverMinor])).get(
        seeded.userIds.get("u-bob")!,
      ),
    ).toBe(80_000);

    // The roster basis, unchanged on the wire and demonstrably a different
    // answer: Bob's £400 is added back into his own account's row *and* counted
    // again in the pot's residual.
    expect(plan.householdLeftoverMinor).toBe(330_000);
    expect(
      plan.accounts.find((a) => a.accountId === seeded.accounts.get("acc-x-bob-cur")!.id)!
        .leftoverMinor,
    ).toBe(120_000);

    // £400 of what Alice's figure counts is genuinely in an account of hers and
    // genuinely Bob's money. The household total is unaffected: added to her,
    // subtracted from him.
    expect(alice.you.leftoverMinor + bob.you.leftoverMinor).toBe(290_000);
  });

  /**
   * **Decision 25 on the wire.** Alice's row reads INCOME £2,000 · THEIR COSTS
   * £300 · COMMITTED £100 · LEFT OVER £2,100, and a reader adding it up gets
   * £1,600. £400 of the £500 gap is Bob's money in a pot Alice owns, and the
   * page can now say so.
   *
   * A label and nothing else: every figure the test above pins is asserted
   * again here, unchanged, because that is the acceptance criterion.
   */
  it("names whose money is in a member's left over, and moves none of it", async () => {
    const seeded = await seedCrossOwner(store);
    const plan = await householdPlan(
      seeded.householdId,
      seeded.auth.get("u-alice")!,
      CROSS_OWNER_ASOF,
    );
    const byId = new Map(plan.members.map((m) => [m.userId, m]));
    const alice = byId.get(seeded.userIds.get("u-alice")!)!;
    const bob = byId.get(seeded.userIds.get("u-bob")!)!;

    expect(alice.arrivedFromOthers).toEqual([
      { ownerUserId: seeded.userIds.get("u-bob")!, amountMinor: 40_000 },
    ]);
    // Nothing of anybody else's is in Bob's accounts, and the annotation is
    // absent rather than an empty list — the ordinary case says nothing at all.
    expect(bob).not.toHaveProperty("arrivedFromOthers");

    // Unmoved, to the penny.
    expect(alice.personalLeftoverMinor).toBe(210_000);
    expect(bob.personalLeftoverMinor).toBe(80_000);
    expect(plan.membersLeftoverMinor).toBe(290_000);
    expect(plan.householdLeftoverMinor).toBe(330_000);
  });

  /** Month 0 of the household's walk is its plan for the same date — one
   *  derivation, so the strip and the headline above it cannot disagree. */
  it("agrees between the household projection strip and the household headline", async () => {
    const seeded = await seedCrossOwner(store);
    const headers = seeded.auth.get("u-alice")!;
    const plan = await householdPlan(seeded.householdId, headers, CROSS_OWNER_ASOF);
    const projection = (
      await app.inject({
        method: "GET",
        url: `/api/households/${seeded.householdId}/projection?asOf=${CROSS_OWNER_ASOF}&months=3`,
        headers,
      })
    ).json() as { months: { membersLeftoverMinor: number; leftoverMinor: number }[] };

    expect(projection.months[0]!.membersLeftoverMinor).toBe(plan.membersLeftoverMinor);
    expect(projection.months.map((m) => m.membersLeftoverMinor)).toEqual([
      290_000, 290_000, 290_000,
    ]);
  });
});
