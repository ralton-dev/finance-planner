import { MemoryStore, type Account, type Store } from "@finance-planner/data";
import { computeScopePlan } from "@finance-planner/domain";
import { signAccessToken } from "@finance-planner/security";
import { beforeEach, describe, expect, it } from "vitest";
// Not `@finance-planner/domain`: the package exports its index and nothing else,
// and a fixture is not part of a package's public surface. WP-C owns `index.ts`
// and may re-export it there if it turns out to want to.
import { estate, ESTATE_ASOF } from "../../../packages/domain/src/estate.fixture.js";
import type { ApiEnv } from "./env.js";
import { scopeForAccount } from "./plan.js";
import { buildServer } from "./server.js";

/**
 * **A dated specification of a divergence, written before the fix.**
 *
 * The two producers of the one `MonthClose` DTO disagree about what
 * `incomeMinor` means. The account close (`server.ts:896`) writes
 * `plan.monthlyIncomeMinor + plan.confirmedInflowMinor` — money that *arrived*
 * counts — behind a nineteen-line comment defending the addition and asserting
 * that the household close is right not to make it. The household close
 * (`server.ts:1914`) writes `plan.monthlyIncomeMinor` alone. The same
 * `MonthScorecard` component renders both.
 *
 * Two meanings of one field, each defensible in its own scope, is the signature
 * of a question asked at the wrong altitude, and `MONTH-CLOSE.md` decision 14
 * answers it: a month close is per user, per currency, and both location-scoped
 * producers are deleted.
 *
 * ## This file is WP-D's to delete
 *
 * **WP-D is its executioner.** The pin below is not a bug to be fixed — it is
 * evidence, dated at `21ec4e1`, that the two handlers cannot both be right. It
 * dies with the handlers it condemns, in the same commit. Nobody should ever
 * make it green; a green pin here would mean the two location-scoped closes had
 * been reconciled with each other instead of replaced.
 *
 * WP-D: `seedEstate` below is meant to be **lifted, not rewritten**. It is the
 * only walk from `packages/domain/src/estate.fixture.ts` into a `Store` that
 * exists, and `server.test.ts` will want it to close `POST /api/me/closes` over
 * the same estate.
 *
 * ## `it.fails` has a blind spot — read this before touching the pin
 *
 * Vitest's `it.fails` passes when the body throws and fails when it does not, so
 * CI stays green while the defect stands. It **cannot tell "the assertion
 * failed" from "the module is gone"**: after a deletion, an `undefined` import
 * throws on the first property access and the pin still "passes". So the pin
 * carries exactly one assertion and nothing that can throw on its own, and the
 * test above it — an ordinary, green one over the same seeding — is what
 * actually guards the fixture. If the estate stops composing, that one fails
 * loudly; the pin would have gone on saying nothing.
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
};

/** The current month, the way the reality-loop routes default it. */
const thisMonth = (): string => new Date().toISOString().slice(0, 7);

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
 */
async function seedEstate(
  store: Store,
  app: ReturnType<typeof buildServer>,
  month: string,
): Promise<SeededEstate> {
  const userIds = new Map<string, string>();
  const auth = new Map<string, { authorization: string }>();
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
  // In the fixture's order: a household is denominated in its first assigned
  // account's currency, so the order is part of the estate's shape.
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
        const res = await app.inject({
          method: "POST",
          url: `/api/inflows/${inflowIds.get(c.inflowId)!}/confirm?month=${month.slice(0, 7)}`,
          headers: owner,
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().confirmation.amountMinor).toBe(c.confirmedMinor);
      } else {
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

  return { householdId: household.id, userIds, accounts, auth };
}

describe("a month close asks two locations and never a person", () => {
  let store: Store;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    store = new MemoryStore();
    app = buildServer({ store, env, registerAuthProxy: false });
  });

  /**
   * The fixture composes: seeded into a store and read back through the real
   * loader, it plans to exactly what `computeScopePlan` makes of it directly.
   *
   * This is the test that guards the estate. The pin below cannot — `it.fails`
   * passes on any throw, including the one a deleted import makes — so if the
   * fixture ever stops being a thing the loader can build, it is this that says
   * so.
   *
   * It also settles the date question: the fixture is planned at `ESTATE_ASOF`
   * and the store is planned as of today, and the two agree, because every
   * income in the estate is monthly and every payment a monthly recurring bill.
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
      // Whole. £424 rather than the £594 this file was written against: the
      // pot's own £500 of lodger rent is Alice's, because the pot is
      // (MONTH-CLOSE.md decision 15, WP-C), so it is her share of the pot's
      // bills that the £500 already sitting there nets off. The two members
      // still transport £900 between them — the pot's £1,400 less its own £500,
      // which is `0c35284`'s netting and did not move.
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
   * **The pin.** Deleted by WP-D together with the two handlers it condemns.
   *
   * The scorecard semantic: closing every account of a household and adding up
   * what each says the household earned should come to what the household's own
   * close says it earned. It does not, and cannot, because the account producer
   * counts money that *arrived* — so every funded transfer inside the household
   * is counted twice, once in the sending account's income and again in the
   * receiving account's confirmed inflow.
   *
   * Observed at `21ec4e1`, on the estate fixture:
   *
   * | Close               | `incomeMinor` | minor units |
   * | ------------------- | ------------- | ----------- |
   * | `acc-alice-current` |     £3,000.00 |     300,000 |
   * | `acc-bob-current`   |     £2,000.00 |     200,000 |
   * | `acc-house-pot`     |     £1,094.00 |     109,400 | £500 own + £594 confirmed
   * | **sum**             |     £6,094.00 | **609,400** |
   * | `hh-estate`         |     £5,500.00 | **550,000** |
   *
   * £594.00 apart — exactly alice's confirmed derived transfer into the pot,
   * money the estate never earned and the sum counts a second time. Bob's £306
   * is unconfirmed, so today it does not diverge; the day he ticks it, it will,
   * by £900 in total. The divergence is not a rounding error or a currency
   * artefact — it is the definition of the field.
   *
   * **The sum is over the GBP accounts only**, and that is a second finding
   * rather than a workaround: the household close is denominated in its first
   * assigned account's currency and cannot see `acc-alice-eur` at all, so the
   * household's own €800 of income appears in no close anywhere. Adding it to a
   * sterling sum would be a different defect. Decision 14 — one row per user,
   * per month, per **currency** — is the answer to both, which is why this test
   * pins the one semantic and names the other here instead of asserting it.
   */
  it.fails("sums the account closes to the household close", async () => {
    const month = thisMonth();
    const seeded = await seedEstate(store, app, `${month}-01`);

    const close = async (fixtureAccountId: string, member: string) =>
      (
        await app.inject({
          method: "POST",
          url: `/api/accounts/${seeded.accounts.get(fixtureAccountId)!.id}/close`,
          headers: seeded.auth.get(member)!,
          payload: { month },
        })
      ).json().incomeMinor as number;

    const accountsTotal =
      (await close("acc-alice-current", "u-alice")) +
      (await close("acc-bob-current", "u-bob")) +
      (await close("acc-house-pot", "u-alice"));

    const household = (
      await app.inject({
        method: "POST",
        url: `/api/households/${seeded.householdId}/close`,
        headers: seeded.auth.get("u-alice")!,
        payload: { month },
      })
    ).json().incomeMinor as number;

    // The one assertion. `it.fails` cannot say which line threw, so there is
    // only ever one line here that can.
    expect(accountsTotal).toBe(household);
  });
});
