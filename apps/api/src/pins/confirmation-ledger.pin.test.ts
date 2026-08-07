import { MemoryStore, type Store } from "@finance-planner/data";
import { signAccessToken } from "@finance-planner/security";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "../env.js";
import { buildServer } from "../server.js";

/**
 * **Red pin — issue #49. Flipped by WP-AP.**
 *
 * > A confirmation and the ledger rows it wrote are one fact, and one of them
 * > can be deleted on its own.
 *
 * Confirming a transfer writes two kinds of row in one breath: the
 * confirmation, and a contribution against every payment the transfer funds,
 * each stamped with `transferConfirmationId: confirmation.id`
 * (`apps/api/src/server.ts:2088`, and again at `:2327`). Un-confirming takes
 * both — `store.deleteTransferConfirmation` cascades, which is the whole reason
 * the stamp exists.
 *
 * `DELETE /api/contributions/:contributionId` (`apps/api/src/server.ts:1252`)
 * reads the row, checks `edit` on its account, and deletes it. It never looks
 * at `transferConfirmationId`. So one half of a two-part fact can be removed
 * and the other half goes on standing: a confirmation that says £220.00 moved,
 * over a ledger that accounts for £120.00 of it.
 *
 * This is the plan's standing assumption at its plainest:
 *
 * > **that writing a record and the event it records are the same fact.**
 *
 * Here it is the inverse and it bites the same way. The contribution is not a
 * fact of its own — it is one line of somebody's statement that they moved
 * money — and the ledger treats it as a free-standing row because that is the
 * shape it is stored in. `POST /api/payments/:paymentId/contributions`
 * (`:1226`) writes `transferConfirmationId: null` at `:1239`, so the two kinds
 * of row are already distinguishable; nothing reads the distinction.
 *
 * ## What this pin does **not** decide
 *
 * WP-AP chooses the mechanism — refuse the delete, or cascade it up into the
 * confirmation. The invariant is the same either way and is all that is
 * asserted here:
 *
 * > **refused ⟹ everything survives; accepted ⟹ nothing survives.**
 *
 * Any third outcome is a ledger disagreeing with itself. Decision 32 is worth
 * reading before flipping this: atomicity comes from a compound `Store` method,
 * not a transaction primitive, and if `PgStore` has no usable handle the
 * instruction is to say so and stop.
 *
 * ## The shape this fixture refuses to avoid
 *
 * **A ledger row that is not a standalone fact.** Every contribution in every
 * test in this tree is authored by hand through `POST
 * /api/payments/:paymentId/contributions`, which stamps `null`, so no test has
 * ever deleted a row a confirmation wrote. And the pot holds **two** payments
 * on purpose: with one, deleting the row and deleting the confirmation would be
 * indistinguishable in the ledger, and the half-standing state this is about
 * would be invisible.
 *
 * ## Observed on `76ee2f2`
 *
 * | figure                                             | minor    | GBP      |
 * | -------------------------------------------------- | -------- | -------- |
 * | Alice's derived transfer into the pot, confirmed    | 22_000   | £220.00  |
 * | rows it wrote (`Rent`, `Insurance`)                 | 2        | —        |
 * | `DELETE /api/contributions/:id` on the `Rent` row   | **204**  | —        |
 * | confirmations still standing afterwards             | **1**    | —        |
 * | ledger under it                                     | 12_000   | £120.00  |
 *
 * £220.00 confirmed, £120.00 accounted for, and nothing on any screen that
 * would say so.
 *
 * ## How WP-AP flipped it
 *
 * **Refused**, with `409 confirmation_generated` pointing at unconfirm — the
 * branch this test calls `intact`. Un-confirming already unwinds both halves
 * and already asks what confirming asked, that the caller is the member who
 * made it; `DELETE /api/contributions/:id` asks only for `edit` on the account,
 * so cascading from here would have been a second way to undo one fact **and**
 * a way around decision 28. `PATCH` is refused on the same rows for the same
 * reason. The write side was half the defect and is fixed with it: both confirm
 * handlers now write the confirmation and its rows through one compound store
 * method, so a failure part-way can no longer leave the state this pin names.
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

/** The pot's two bills. Two, so that removing one row leaves the other. */
const RENT_MINOR = 10_000;
const INSURANCE_MINOR = 12_000;

/** The month everything here happens in, the way the confirm routes default it. */
const thisMonth = (): string => new Date().toISOString().slice(0, 7);

interface ContributionRow {
  id: string;
  amountMinor: number;
  transferConfirmationId: string | null;
}

async function seedUser(store: Store, email: string, displayName: string) {
  const user = await store.createUser({ email, passwordHash: "x", displayName });
  const token = await signAccessToken(env.jwtSecret, { sub: user.id, email });
  return { user, auth: { authorization: `Bearer ${token}` } };
}

/** One user, one current account, one pot holding two bills. Nothing about this
 *  defect needs a second person, and a second person would only obscure it. */
async function seed(store: MemoryStore, app: ReturnType<typeof buildServer>) {
  const { user: alice, auth } = await seedUser(store, "alice@example.com", "Alice");

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
      amountMinor: 300_000,
      frequency: "monthly",
      anchorDate: "2026-01-01",
    },
  });
  for (const [name, amountMinor] of [
    ["Rent", RENT_MINOR],
    ["Insurance", INSURANCE_MINOR],
  ] as const) {
    await app.inject({
      method: "POST",
      url: `/api/accounts/${pot.id}/payments`,
      headers: auth,
      payload: { name, category: "monthly_recurring", amountMinor },
    });
  }

  return { alice, auth, current, pot };
}

describe("a confirmation and the ledger rows it wrote", () => {
  let store: MemoryStore;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    store = new MemoryStore();
    app = buildServer({ store, env, registerAuthProxy: false });
  });

  /** Alice confirms the feed into the pot, which books a row per bill. */
  async function confirm(s: Awaited<ReturnType<typeof seed>>) {
    const res = await app.inject({
      method: "POST",
      url: `/api/accounts/${s.pot.id}/transfers/confirm`,
      headers: s.auth,
      payload: {
        fromAccountId: s.current.id,
        toAccountId: s.pot.id,
        memberUserId: s.alice.id,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as {
      confirmation: { id: string; amountMinor: number };
      contributions: ContributionRow[];
    };
  }

  /** What the ledger and the confirmation list say right now. */
  async function world(s: Awaited<ReturnType<typeof seed>>, confirmationId: string) {
    const [ledger, confirmations] = await Promise.all([
      app.inject({
        method: "GET",
        url: `/api/accounts/${s.pot.id}/contributions?month=${thisMonth()}`,
        headers: s.auth,
      }),
      app.inject({
        method: "GET",
        url: `/api/accounts/${s.pot.id}/transfers/confirmations?month=${thisMonth()}`,
        headers: s.auth,
      }),
    ]);
    const rows = (ledger.json() as ContributionRow[]).filter(
      (c) => c.transferConfirmationId === confirmationId,
    );
    return {
      rows: rows.length,
      ledgerMinor: rows.reduce((sum, c) => sum + c.amountMinor, 0),
      confirmationStands: (confirmations.json() as { id: string }[]).some(
        (c) => c.id === confirmationId,
      ),
    };
  }

  /**
   * The fixture's precondition, and **a plain `it` on purpose**.
   *
   * The pin below says nothing at all unless the confirmation really did write
   * more than one stamped row. Kept out of the `it.fails` so that a fixture
   * which stops writing them turns the build red instead of joining the
   * expected failures.
   */
  it("writes a stamped ledger row for every bill the transfer funds", async () => {
    const s = await seed(store, app);
    const { confirmation, contributions } = await confirm(s);

    expect(confirmation.amountMinor).toBe(RENT_MINOR + INSURANCE_MINOR);
    expect(contributions).toHaveLength(2);
    expect(contributions.every((c) => c.transferConfirmationId === confirmation.id)).toBe(true);
    expect(await world(s, confirmation.id)).toEqual({
      rows: 2,
      ledgerMinor: RENT_MINOR + INSURANCE_MINOR,
      confirmationStands: true,
    });
  });

  /**
   * **The pin.** Delete one row of the statement and ask what is left.
   *
   * Deliberately silent on *how*: refusing the delete and cascading it are both
   * whole answers, and both satisfy the assertion. What is refused is the third
   * outcome — half the fact standing.
   */
  it("cannot be half deleted", async () => {
    const s = await seed(store, app);
    const { confirmation, contributions } = await confirm(s);
    const rent = contributions.find((c) => c.amountMinor === RENT_MINOR)!;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/contributions/${rent.id}`,
      headers: s.auth,
    });
    const refused = res.statusCode >= 400;
    const after = await world(s, confirmation.id);

    // One fact: it is all there, or it is all gone. Nothing in between.
    const intact = after.confirmationStands && after.rows === contributions.length;
    const gone = !after.confirmationStands && after.rows === 0;
    expect(
      refused ? intact : gone,
      `a confirmation and its rows came apart: ` +
        `delete=${res.statusCode}, confirmation ${after.confirmationStands ? "stands" : "gone"}, ` +
        `${after.rows} of ${contributions.length} rows left, ` +
        `ledger ${after.ledgerMinor} against a confirmed ${confirmation.amountMinor}`,
    ).toBe(true);
  });
});
