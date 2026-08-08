import { MemoryStore, type Store } from "@finance-planner/data";
import { signAccessToken } from "@finance-planner/security";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "../env.js";
import { buildServer } from "../server.js";

/**
 * **Issue #50 — green since WP-AO.** Everything below describes the defect as it
 * stood at `76ee2f2`; it is kept in the past tense it was written in, because a
 * pin is the record of what went wrong and stays readable as one.
 *
 * > A confirmation names a month. The handler plans **today**.
 *
 * `POST /api/households/:id/transfers/confirm` takes a `month` in its body,
 * writes it onto the confirmation row, books contributions against it — and
 * derives the amount from `scopeForHousehold(store, id, today())`
 * (`apps/api/src/server.ts:2050`). The other two confirm handlers do the same
 * thing with the same words: `const asOfDate = today()` at `server.ts:2146` and
 * `:2273`. So confirming June's transfer in August books August's figure and
 * calls it June.
 *
 * This is the plan's standing assumption wearing a calendar:
 *
 * > **that writing a record and the event it records are the same fact.**
 *
 * The month is written down. The month is not asked about.
 *
 * ## The repository already knows the rule
 *
 * `closeAsOfDate` said it in a comment, and only closing obeyed it — which is
 * why WP-AO renamed it `asOfDateForMonth` and gave both verbs the same rule:
 *
 * > *"As-of date for closing a month: today when closing the month still
 * > running, otherwise that month's last day, so a past month is scored on the
 * > plan it actually had."*
 *
 * A close obeys it. A confirmation does not, and nothing in the tree asks it
 * to — which is why this pin's fixture had to be built rather than borrowed:
 * **every fixture in this repository plans today**, so no existing plan differs
 * between two months and no existing test could have noticed. The as-of below
 * is the last day of the target month for exactly that reason: it is the house
 * rule, not this pin's invention. WP-AO owns which day inside the month it
 * lands on, and the fixture is deliberately built so that every day of the
 * target month gives the same answer — see the guard test, which is a plain
 * `it` and must stay green.
 *
 * ## The shape this fixture refuses to avoid
 *
 * A plan **that differs between two months**. The household's shared pot holds
 * one `fixed_point` goal of £1,600.00 due on the 31st of December next year, so
 * the pass spreads what remains over the months left and the monthly figure
 * shrinks as the horizon lengthens backwards. The 31st is load-bearing:
 * `wholeMonthsBetween` (`packages/domain/src/dates.ts:20`) drops a month when
 * `to.getUTCDate() < from.getUTCDate()`, and no day of any month is greater
 * than 31 — so the count is a whole-calendar-month difference and is constant
 * across each month rather than sliding day by day.
 *
 * A pin whose two months agree proves nothing and passes on the broken code.
 * That is asserted separately and in a plain `it`, so that a fixture which
 * collapses goes **red** instead of quietly joining the expected failures.
 *
 * ## Observed on `76ee2f2`, run at 2026-08-07
 *
 * | figure                                                   | minor  | GBP     |
 * | -------------------------------------------------------- | ------ | ------- |
 * | Alice's derived transfer, planned as of **today**          | 6_600  | £66.00  |
 * | Alice's derived transfer, planned as of **last month**     | 6_212  | £62.12  |
 * | what the handler booked when told `month = last month`     | 6_600  | £66.00  |
 *
 * £3.88 of a household's money attributed to the wrong month, from a fixture
 * built to be gentle. The figures move with the date the suite runs — the goal
 * is anchored to next December, so the divisor grows by one every month — which
 * is why the assertion is computed from the server's own answer for that month
 * (`GET /api/households/:id/plan?asOf=`) rather than written as a literal. The
 * fact being pinned does not move: **booked ≠ that month's**.
 */

const env: ApiEnv = {
  port: 0,
  host: "127.0.0.1",
  jwtSecret: "test-secret",
  authUrl: "http://localhost:4001",
  mailFrom: "Finance Planner <no-reply@test.local>",
  notifyEnabled: false,
  notifyHour: 8,
  enableDemoSeed: false,
  enablePlanDebug: false,
};

/** The goal the pot is saving for, and the date it is due. Day 31 on purpose —
 *  see the header. */
const GOAL_MINOR = 160_000;
const goalDueDate = (): string => `${new Date().getUTCFullYear() + 1}-12-31`;

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** The month before the one running now, as `YYYY-MM`. */
function lastMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
}

/** The first and last day of a `YYYY-MM`, as ISO dates. */
function boundsOf(month: string): { first: string; last: string } {
  const [year, mon] = month.split("-").map(Number);
  return {
    first: iso(new Date(Date.UTC(year!, mon! - 1, 1))),
    last: iso(new Date(Date.UTC(year!, mon!, 0))),
  };
}

async function seedUser(store: Store, email: string, displayName: string) {
  const user = await store.createUser({ email, passwordHash: "x", displayName });
  const token = await signAccessToken(env.jwtSecret, { sub: user.id, email });
  return { user, auth: { authorization: `Bearer ${token}` } };
}

/**
 * A household of two, and one shared pot whose only line is a dated goal.
 *
 * Deliberately *not* a monthly bill: a bill costs the same every month, and a
 * fixture made of bills is a fixture whose months agree.
 */
async function seedHousehold(store: MemoryStore, app: ReturnType<typeof buildServer>) {
  const { user: alice, auth } = await seedUser(store, "alice@example.com", "Alice");
  const { user: bob, auth: bobAuth } = await seedUser(store, "bob@example.com", "Bob");
  const household = await store.createHousehold("Home", alice.id);
  await store.addMembership(household.id, bob.id, "member");
  await store.updateMembershipShare(household.id, alice.id, 6600);
  await store.updateMembershipShare(household.id, bob.id, 3400);

  const make = async (name: string, incomeMinor: number, who: { authorization: string }) => {
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: who,
        payload: { name, currency: "GBP" },
      })
    ).json();
    if (incomeMinor > 0) {
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

  const aliceCur = await make("alice-cur", 300_000, auth);
  const bobCur = await make("bob-cur", 200_000, bobAuth);
  const pot = await make("pot", 0, auth);

  await app.inject({
    method: "POST",
    url: `/api/accounts/${pot.id}/payments`,
    headers: auth,
    payload: {
      name: "Kitchen",
      category: "fixed_point",
      amountMinor: GOAL_MINOR,
      dueDate: goalDueDate(),
      scope: "shared",
    },
  });

  await app.inject({
    method: "PUT",
    url: `/api/households/${household.id}/accounts/${aliceCur.id}`,
    headers: auth,
    payload: { role: "personal", memberUserId: alice.id },
  });
  // Bob's account goes on the roster through the store: the endpoint needs the
  // caller to be able to see it, and Alice cannot. `server.test.ts` does the
  // same thing for the same reason.
  await store.upsertAccountAssignment({
    householdId: household.id,
    accountId: bobCur.id,
    role: "personal",
    memberUserId: bob.id,
  });
  await app.inject({
    method: "PUT",
    url: `/api/households/${household.id}/accounts/${pot.id}`,
    headers: auth,
    payload: { role: "shared" },
  });

  return { alice, bob, auth, bobAuth, household, aliceCur, pot };
}

describe("a confirmation for a past month", () => {
  let store: MemoryStore;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    store = new MemoryStore();
    app = buildServer({ store, env, registerAuthProxy: false });
  });

  /** What the household plan asks Alice to move into the pot, on a given day. */
  async function plannedTransferMinor(
    h: Awaited<ReturnType<typeof seedHousehold>>,
    asOf: string,
  ): Promise<number> {
    const plan = (
      await app.inject({
        method: "GET",
        url: `/api/households/${h.household.id}/plan?asOf=${asOf}`,
        headers: h.auth,
      })
    ).json();
    const transfer = plan.transfers.find(
      (t: { fromAccountId: string; toAccountId: string; memberUserId: string }) =>
        t.fromAccountId === h.aliceCur.id &&
        t.toAccountId === h.pot.id &&
        t.memberUserId === h.alice.id,
    );
    expect(transfer, `no planned transfer as of ${asOf}`).toBeDefined();
    return transfer.amountMinor as number;
  }

  /**
   * The fixture's own precondition, and **a separate test on purpose**.
   *
   * If the two months ever agree, the pin below asserts nothing: it would pass
   * on a handler that had gone back to planning today. It was kept out of the
   * `it.fails` while the pin was red, so that a collapsed fixture turned the
   * build red rather than joining the expected failures; it stays a test of its
   * own now for the same reason, because a green pin over a fixture whose two
   * months have converged is the failure mode a pin is most likely to die of.
   */
  it("plans a different amount last month than it plans this month", async () => {
    const h = await seedHousehold(store, app);
    const month = lastMonth();
    const { first, last } = boundsOf(month);

    const thisMonth = await plannedTransferMinor(h, iso(new Date()));
    const target = await plannedTransferMinor(h, last);

    expect(target, "the fixture's two months agree — it proves nothing").not.toBe(thisMonth);
    // ...and the target month gives one answer whichever day of it is asked,
    // so the pin does not quietly depend on which day WP-AO picks.
    expect(await plannedTransferMinor(h, first)).toBe(target);
  });

  /**
   * **The pin.** Confirm last month's transfer, and read what was booked.
   *
   * Nothing here says *how* the handler should learn the month's plan; it says
   * the amount on a June confirmation has to be June's.
   */
  it("books the amount that month's plan derived, not today's", async () => {
    const h = await seedHousehold(store, app);
    const month = lastMonth();
    const { last } = boundsOf(month);
    const thatMonths = await plannedTransferMinor(h, last);

    const res = await app.inject({
      method: "POST",
      url: `/api/transfers/confirm`,
      headers: h.auth,
      payload: {
        fromAccountId: h.aliceCur.id,
        toAccountId: h.pot.id,
        memberUserId: h.alice.id,
        month,
      },
    });
    expect(res.statusCode).toBe(201);

    const { confirmation, contributions } = res.json();
    // The row says the month it was told.
    expect(confirmation.month.slice(0, 7)).toBe(month);
    // The amount on it does not.
    expect(confirmation.amountMinor).toBe(thatMonths);
    // And so does the ledger it wrote: a contribution filed under that month
    // carries that month's slice, or it is money attributed to a month it did
    // not belong to.
    expect(
      contributions.reduce((sum: number, c: { amountMinor: number }) => sum + c.amountMinor, 0),
    ).toBe(thatMonths);
  });
});
