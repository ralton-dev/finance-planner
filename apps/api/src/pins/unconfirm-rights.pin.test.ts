import { MemoryStore, type Store } from "@finance-planner/data";
import { signAccessToken } from "@finance-planner/security";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "../env.js";
import { buildServer } from "../server.js";

/**
 * **Issue #47 — green since WP-AO.** Everything below describes the defect as it
 * stood at `76ee2f2`; it is kept in the past tense it was written in, because a
 * pin is the record of what went wrong and stays readable as one. The sibling
 * site named further down was closed in the same change.
 *
 * > Un-confirming asks for less than confirming does.
 *
 * `POST /api/accounts/:id/transfers/confirm` (`apps/api/src/server.ts:2257`)
 * refuses in three ways: `edit` on the receiving account, `view` on the sending
 * one, and — explicitly, at `:2268` —
 *
 * > *"Only your own: a derived transfer is a member's own money moving, and
 * > there is no household roster here to make anybody an admin of it."*
 *
 * `DELETE /api/accounts/:id/transfers/confirmations/:confId`
 * (`apps/api/src/server.ts:2342`) asks for one thing: `edit` on the receiving
 * account (`:2354`). It never reads `confirmation.memberUserId`. So anybody
 * who can edit the pot can withdraw somebody else's statement that they moved
 * their own money — a claim they were forbidden from making in the first place.
 *
 * Decision 28 settles which side wins: **unconfirm requires exactly what
 * confirm requires**, the stricter side, and losing this ability is intended
 * rather than a regression.
 *
 * The standing assumption, in its access-control clothes:
 *
 * > **that writing a record and the event it records are the same fact.**
 *
 * Deleting the row is treated as an edit to the receiving account, because the
 * row lives there. But the *fact* is Alice's — "I moved my money" — and un-
 * saying it is not an edit to a pot, it is contradicting a person.
 *
 * ## The sibling site, for whoever flips this
 *
 * `DELETE /api/inflows/:inflowId/confirmations/:confId` (`server.ts:2367`)
 * holds the same shape: `requireAccess(userId, confirmation.toAccountId,
 * "edit")` and nothing about who confirmed. Its confirm half (`:2131`) records
 * `memberUserId: userId` at `:2202`, so there is always a person on the row to
 * check against. Only the household route (`:2104`) already checks — it falls
 * back to owner/admin, which is its own rule and is not what this pin is about.
 *
 * ## The shape this fixture refuses to avoid
 *
 * **A second editor who is not the confirmer.** Every access test in the tree
 * either grants `view` (and checks the 403 that follows) or gives the one
 * person both roles; nothing has a co-editor standing beside a confirmation
 * that is not theirs, which is precisely the gap the defect lives in. Bob has
 * `edit` on the pot via a household share and no claim whatever on Alice's
 * transfer.
 *
 * The asymmetry itself is asserted in a plain `it` below — Bob is refused when
 * he tries to *make* the statement — so if a future change ever loosens the
 * confirm side to close the gap from the wrong end, the build goes red rather
 * than green.
 *
 * ## Observed on `76ee2f2`
 *
 * | act                                           | who        | status  |
 * | --------------------------------------------- | ---------- | ------- |
 * | confirm Alice's derived transfer               | **Alice**  | **201** |
 * | confirm Alice's derived transfer               | **Bob**    | **403** |
 * | un-confirm the same, `memberUserId` = Alice    | **Bob**    | **204** |
 *
 * The confirmation booked £150.00 (15_000 minor) and Bob's `204` took it, and
 * the contribution it wrote, with it — leaving the pot's line back at
 * `awaiting_transfer` on the word of somebody who was not allowed to have an
 * opinion about it.
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

/** The pot's one bill, and therefore the size of the derived feed into it. */
const BILL_MINOR = 15_000;

async function seedUser(store: Store, email: string, displayName: string) {
  const user = await store.createUser({ email, passwordHash: "x", displayName });
  const token = await signAccessToken(env.jwtSecret, { sub: user.id, email });
  return { user, auth: { authorization: `Bearer ${token}` } };
}

/**
 * Alice's two accounts, and Bob standing next to one of them with a pen.
 *
 * The accounts are Alice's alone — no roster assignment, so the pass plans her
 * estate and derives her feed, exactly as the solo case at
 * `server.test.ts:2069` does. The household exists for one reason: an account
 * share is scoped to one (`shareAccountBody`), so it is the only way to hand
 * somebody `edit` on an account they do not own.
 */
async function seed(store: MemoryStore, app: ReturnType<typeof buildServer>) {
  const { user: alice, auth } = await seedUser(store, "alice@example.com", "Alice");
  const { user: bob, auth: bobAuth } = await seedUser(store, "bob@example.com", "Bob");

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
  await app.inject({
    method: "POST",
    url: `/api/accounts/${pot.id}/payments`,
    headers: auth,
    payload: { name: "Council tax", category: "monthly_recurring", amountMinor: BILL_MINOR },
  });

  const household = await store.createHousehold("Home", alice.id);
  await store.addMembership(household.id, bob.id, "member");
  // The whole fixture, in one call: Bob may edit the receiving account and has
  // no other claim on anything.
  await app.inject({
    method: "POST",
    url: `/api/accounts/${pot.id}/shares`,
    headers: auth,
    payload: { householdId: household.id, permission: "edit" },
  });

  return { alice, bob, auth, bobAuth, current, pot };
}

describe("un-confirming somebody else's transfer", () => {
  let store: MemoryStore;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    store = new MemoryStore();
    app = buildServer({ store, env, registerAuthProxy: false });
  });

  /** Alice says she moved her money, and the server agrees she is the one who
   *  may say it. */
  async function aliceConfirms(s: Awaited<ReturnType<typeof seed>>) {
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
    return res.json().confirmation as { id: string; memberUserId: string; amountMinor: number };
  }

  /**
   * The other half of the asymmetry, and **a plain `it` on purpose**.
   *
   * If this ever stops being a 403 the pin below is meaningless — the two sides
   * would agree by the confirm side giving way, which is the opposite of
   * decision 28. Kept green so that direction of collapse is a red build.
   */
  it("refuses to let a co-editor make the statement in the first place", async () => {
    const s = await seed(store, app);
    // The fixture's precondition: Bob really can edit the receiving account, so
    // the refusal below is about whose claim it is and not about access.
    const seen = await app.inject({
      method: "GET",
      url: `/api/accounts/${s.pot.id}`,
      headers: s.bobAuth,
    });
    expect(seen.json()).toMatchObject({ owner: false, permission: "edit" });

    const res = await app.inject({
      method: "POST",
      url: `/api/accounts/${s.pot.id}/transfers/confirm`,
      headers: s.bobAuth,
      payload: {
        fromAccountId: s.current.id,
        toAccountId: s.pot.id,
        // Alice's transfer. Bob may edit the pot and is refused anyway.
        memberUserId: s.alice.id,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  /**
   * **The pin.** The same person, the same claim, the opposite verb.
   */
  it("refuses to let a co-editor take it back", async () => {
    const s = await seed(store, app);
    const confirmation = await aliceConfirms(s);
    expect(confirmation.memberUserId).toBe(s.alice.id);
    expect(confirmation.memberUserId).not.toBe(s.bob.id);
    // The figure in the header, so it cannot go stale unnoticed.
    expect(confirmation.amountMinor).toBe(BILL_MINOR);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/accounts/${s.pot.id}/transfers/confirmations/${confirmation.id}`,
      headers: s.bobAuth,
    });
    expect(res.statusCode).toBe(403);

    // ...and Alice's statement, and the ledger row under it, are still standing.
    const listed = await app.inject({
      method: "GET",
      url: `/api/accounts/${s.pot.id}/transfers/confirmations`,
      headers: s.auth,
    });
    expect(listed.json()).toHaveLength(1);
  });
});
