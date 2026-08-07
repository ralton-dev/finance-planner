import { MemoryStore, type Account, type Store } from "@finance-planner/data";
import { exportFileSchema } from "@finance-planner/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { buildExport, importExport } from "./portability.js";

/**
 * Portability's job is to lose nothing. Account-sourced inflows were read
 * through `listIncomes`, which projects the external rows only — so a movement
 * between two of the user's own accounts vanished from the export, and from the
 * import that reads it back. These pin that it survives the round trip.
 */

let store: Store;

beforeEach(() => {
  store = new MemoryStore();
});

async function seedUser(email = "owner@example.com") {
  const user = await store.createUser({ email, passwordHash: null, displayName: "Owner" });
  return user.id;
}

/** Every export in here is taken on one fixed day: the months a confirmation
 *  is looked for are relative to it (see `buildExport`), and a clock-dependent
 *  fixture would be a fixture that fails on the first of some month. */
const ASOF = "2026-08-04";

const account = (userId: string, name: string): Promise<Account> =>
  store.createAccount({ ownerUserId: userId, name, currency: "GBP" });

async function movement(from: Account, to: Account, amountMinor: number, priority = 50) {
  return store.createInflow({
    accountId: to.id,
    name: `${from.name} top-up`,
    source: "account",
    sourceAccountId: from.id,
    amountMinor,
    frequency: "monthly",
    recurrence: null,
    anchorDate: "2026-08-25",
    priority,
    active: true,
  });
}

async function salary(target: Account, amountMinor: number) {
  return store.createIncome({
    accountId: target.id,
    name: "Salary",
    amountMinor,
    frequency: "monthly",
    recurrence: null,
    anchorDate: "2026-08-25",
    active: true,
  });
}

describe("buildExport — movements between your own accounts", () => {
  it("exports a movement, naming the account it leaves by name", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Holiday pot");
    await salary(current, 300_000);
    await movement(current, pot, 40_000, 20);

    const file = await buildExport(store, userId, ASOF);
    const exported = file.accounts.find((a) => a.name === "Holiday pot")!;

    expect(exported.incomes).toEqual([]);
    expect(exported.accountInflows).toEqual([
      {
        name: "Current top-up",
        fromAccountName: "Current",
        amountMinor: 40_000,
        frequency: "monthly",
        recurrence: null,
        anchorDate: "2026-08-25",
        priority: 20,
        active: true,
        // Nobody has said this one moved yet.
        confirmations: [],
      },
    ]);

    // The sending account still exports its salary, and does not export the
    // movement a second time: one row, one place in the file.
    const sender = file.accounts.find((a) => a.name === "Current")!;
    expect(sender.incomes.map((i) => i.name)).toEqual(["Salary"]);
    expect(sender.accountInflows).toEqual([]);
  });

  it("keeps external inflows out of the movements and vice versa", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Pot");
    await salary(pot, 10_000);
    await movement(current, pot, 40_000);

    const exported = (await buildExport(store, userId, ASOF)).accounts.find(
      (a) => a.name === "Pot",
    )!;
    expect(exported.incomes.map((i) => i.name)).toEqual(["Salary"]);
    expect(exported.accountInflows.map((i) => i.name)).toEqual(["Current top-up"]);
  });

  it("drops a movement out of an account the file does not carry", async () => {
    // Somebody else's account: exporting a movement out of it would produce a
    // name the importer cannot resolve to anything.
    const userId = await seedUser();
    const otherId = await seedUser("other@example.com");
    const theirs = await account(otherId, "Their current");
    const mine = await account(userId, "My pot");
    await movement(theirs, mine, 40_000);

    const file = await buildExport(store, userId, ASOF);
    expect(file.accounts).toHaveLength(1);
    expect(file.accounts[0]!.accountInflows).toEqual([]);
  });

  it("produces a file the import schema accepts", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Pot");
    await salary(current, 300_000);
    await movement(current, pot, 40_000);

    const file = await buildExport(store, userId, ASOF);
    expect(() => exportFileSchema.parse(file)).not.toThrow();
  });
});

describe("importExport — movements survive the round trip", () => {
  it("recreates a movement pointing at the freshly created account", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Pot");
    await salary(current, 300_000);
    await movement(current, pot, 40_000, 20);

    const targetId = await seedUser("restore@example.com");
    const counts = await importExport(store, targetId, await buildExport(store, userId, ASOF));
    expect(counts).toMatchObject({ accounts: 2, incomes: 1, accountInflows: 1 });

    const restored = await store.listAccountsForOwner(targetId);
    const newPot = restored.find((a) => a.name === "Pot")!;
    const newCurrent = restored.find((a) => a.name === "Current")!;
    const [inflow] = await store.listInflows(newPot.id);
    expect(inflow).toMatchObject({
      name: "Current top-up",
      source: "account",
      sourceAccountId: newCurrent.id,
      amountMinor: 40_000,
      priority: 20,
    });
    // Fresh ids throughout: the movement points into the restored estate, not
    // back at the one it came from.
    expect(inflow!.sourceAccountId).not.toBe(current.id);
    expect(newPot.id).not.toBe(pot.id);

    // And it is the same row from the sending end.
    expect((await store.listOutboundInflows(newCurrent.id)).map((i) => i.id)).toEqual([inflow!.id]);
  });

  /**
   * A standalone confirmation is not household data. It is a fact about two
   * accounts one person owns, and since WP-H it decides whether a line reads
   * funded or still awaiting a transfer — so a backup that dropped it would
   * quietly un-move money that moved.
   */
  it("carries a standalone confirmation, and not a household one", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Pot");
    await salary(current, 300_000);
    const moved = await movement(current, pot, 40_000, 20);
    await store.createTransferConfirmation({
      householdId: null,
      inflowId: moved.id,
      month: "2026-08-01",
      fromAccountId: current.id,
      toAccountId: pot.id,
      memberUserId: userId,
      amountMinor: 40_000,
    });
    // A household transfer between the same two accounts stays behind: it
    // describes an arrangement between people.
    const household = await store.createHousehold("Home", userId);
    await store.createTransferConfirmation({
      householdId: household.id,
      inflowId: null,
      month: "2026-08-01",
      fromAccountId: current.id,
      toAccountId: pot.id,
      memberUserId: userId,
      amountMinor: 1_000,
    });

    const file = await buildExport(store, userId, ASOF);
    const exported = file.accounts.find((a) => a.name === "Pot")!;
    expect(exported.accountInflows[0]!.confirmations).toEqual([
      { month: "2026-08-01", amountMinor: 40_000 },
    ]);

    const targetId = await seedUser("restore@example.com");
    expect(await importExport(store, targetId, file)).toMatchObject({
      accountInflows: 1,
      accountInflowConfirmations: 1,
    });
    const restored = await store.listAccountsForOwner(targetId);
    const newPot = restored.find((a) => a.name === "Pot")!;
    const [inflow] = await store.listInflows(newPot.id);
    const [confirmation] = await store.listTransferConfirmationsForAccount(newPot.id, "2026-08-01");
    expect(confirmation).toMatchObject({
      householdId: null,
      inflowId: inflow!.id,
      toAccountId: newPot.id,
      memberUserId: targetId,
      amountMinor: 40_000,
    });
    // The household row did not come with it, under any scope.
    expect(await store.listTransferConfirmations(household.id, "2026-08-01")).toHaveLength(1);
  });

  /**
   * The other kind of "I moved it", and the one the export could not see.
   *
   * A pot with bills and no income of its own is fed by a transfer the *plan*
   * derives — nobody authors a movement for it (decision 9) — and since
   * migration 0010 a user with no household can confirm one. It carries neither
   * a household id nor an inflow id, so the movements-only export walked
   * straight past it and a restore flipped those lines back to
   * `awaiting_transfer`. There is deliberately no authored movement anywhere in
   * this fixture: the whole point is that this confirmation exists without one.
   */
  it("carries a confirmation of a transfer the plan derived, with no movement to hang it on", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    const pot = await account(userId, "Bills pot");
    await salary(current, 300_000);
    await store.createTransferConfirmation({
      householdId: null,
      inflowId: null,
      month: "2026-08-01",
      fromAccountId: current.id,
      toAccountId: pot.id,
      memberUserId: userId,
      amountMinor: 30_320,
    });

    const file = await buildExport(store, userId, ASOF);
    const exported = file.accounts.find((a) => a.name === "Bills pot")!;
    expect(exported.accountInflows).toEqual([]);
    expect(exported.derivedTransferConfirmations).toEqual([
      { fromAccountName: "Current", month: "2026-08-01", amountMinor: 30_320 },
    ]);
    // Once, under the account the money lands in — not again under the sender.
    expect(file.accounts.find((a) => a.name === "Current")!.derivedTransferConfirmations).toEqual(
      [],
    );
    expect(exportFileSchema.parse(JSON.parse(JSON.stringify(file)))).toBeTruthy();

    const targetId = await seedUser("restore@example.com");
    expect(await importExport(store, targetId, file)).toMatchObject({
      accountInflowConfirmations: 0,
      derivedTransferConfirmations: 1,
    });
    const restored = await store.listAccountsForOwner(targetId);
    const newPot = restored.find((a) => a.name === "Bills pot")!;
    const newCurrent = restored.find((a) => a.name === "Current")!;
    expect(await store.listDerivedTransferConfirmationsForAccount(newPot.id, "2026-08-01")).toEqual(
      [
        expect.objectContaining({
          householdId: null,
          inflowId: null,
          fromAccountId: newCurrent.id,
          toAccountId: newPot.id,
          memberUserId: targetId,
          amountMinor: 30_320,
        }),
      ],
    );
  });

  /** Whose record it is decides whether it travels. A derived confirmation
   *  belonging to a household is an arrangement between people; one another
   *  member recorded on your account is their fact about their own money. Both
   *  stay behind, for the reason the file header gives. */
  it("leaves behind a derived confirmation that is not the exporter's own", async () => {
    const userId = await seedUser();
    const otherId = await seedUser("other@example.com");
    const current = await account(userId, "Current");
    const pot = await account(userId, "Bills pot");
    await salary(current, 300_000);
    const household = await store.createHousehold("Home", userId);
    await store.createTransferConfirmation({
      householdId: household.id,
      inflowId: null,
      month: "2026-08-01",
      fromAccountId: current.id,
      toAccountId: pot.id,
      memberUserId: userId,
      amountMinor: 10_000,
    });
    await store.createTransferConfirmation({
      householdId: null,
      inflowId: null,
      month: "2026-08-01",
      fromAccountId: current.id,
      toAccountId: pot.id,
      memberUserId: otherId,
      amountMinor: 20_000,
    });

    const file = await buildExport(store, userId, ASOF);
    expect(file.accounts.find((a) => a.name === "Bills pot")!.derivedTransferConfirmations).toEqual(
      [],
    );
  });

  it("restores a chain whatever order the accounts appear in", async () => {
    // The account a movement comes from can appear after the account it pays
    // into — which is why accounts are all created before anything inside them.
    const userId = await seedUser();
    const a = await account(userId, "A");
    const b = await account(userId, "B");
    const c = await account(userId, "C");
    await movement(a, b, 30_000);
    await movement(b, c, 20_000);

    const file = await buildExport(store, userId, ASOF);
    file.accounts.reverse();

    const targetId = await seedUser("restore@example.com");
    expect(await importExport(store, targetId, file)).toMatchObject({ accountInflows: 2 });

    const restored = await store.listAccountsForOwner(targetId);
    const byName = new Map(restored.map((r) => [r.name, r.id]));
    expect((await store.listInflows(byName.get("B")!))[0]!.sourceAccountId).toBe(byName.get("A"));
    expect((await store.listInflows(byName.get("C")!))[0]!.sourceAccountId).toBe(byName.get("B"));
    // Nothing dangles: the ids point at accounts that exist.
    expect(byName.size).toBe(3);
  });

  it("drops a movement whose source account is missing from the file", async () => {
    const userId = await seedUser();
    const file = exportFileSchema.parse({
      version: 1,
      exportedAt: "2026-08-04T00:00:00.000Z",
      accounts: [
        {
          name: "Pot",
          currency: "GBP",
          accountInflows: [
            {
              name: "Ghost",
              fromAccountName: "An account that is not here",
              amountMinor: 10_000,
              frequency: "monthly",
              anchorDate: "2026-08-25",
            },
          ],
        },
      ],
    });
    expect(await importExport(store, userId, file)).toMatchObject({
      accounts: 1,
      accountInflows: 0,
    });
    const [pot] = await store.listAccountsForOwner(userId);
    expect(await store.listInflows(pot!.id)).toEqual([]);
  });

  it("drops a movement an account makes to itself", async () => {
    // The store refuses a self-funding inflow, and a hand-edited file must not
    // be able to take the whole import down with one bad row.
    const userId = await seedUser();
    const file = exportFileSchema.parse({
      version: 1,
      exportedAt: "2026-08-04T00:00:00.000Z",
      accounts: [
        {
          name: "Pot",
          currency: "GBP",
          accountInflows: [
            {
              name: "Itself",
              fromAccountName: "Pot",
              amountMinor: 10_000,
              frequency: "monthly",
              anchorDate: "2026-08-25",
            },
          ],
        },
      ],
    });
    expect(await importExport(store, userId, file)).toMatchObject({ accountInflows: 0 });
  });

  it("imports a file written before movements existed", async () => {
    const userId = await seedUser();
    const file = exportFileSchema.parse({
      version: 1,
      exportedAt: "2026-08-04T00:00:00.000Z",
      accounts: [
        {
          name: "Current",
          currency: "GBP",
          incomes: [
            {
              name: "Salary",
              amountMinor: 300_000,
              frequency: "monthly",
              anchorDate: "2026-08-25",
            },
          ],
        },
      ],
    });
    expect(await importExport(store, userId, file)).toMatchObject({
      accounts: 1,
      incomes: 1,
      accountInflows: 0,
    });
  });

  it("round-trips everything else it always did", async () => {
    const userId = await seedUser();
    const current = await account(userId, "Current");
    await salary(current, 300_000);
    const payment = await store.createPayment({
      accountId: current.id,
      name: "Rent",
      category: "monthly_recurring",
      amountMinor: 100_000,
      dueDate: null,
      recurrence: null,
      targetDate: null,
      priority: 1,
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
    await store.createContribution({
      paymentId: payment.id,
      accountId: current.id,
      userId,
      month: "2026-07-01",
      amountMinor: 5_000,
      note: null,
      transferConfirmationId: null,
    });
    await store.upsertBalanceSnapshot({
      accountId: current.id,
      asOfDate: "2026-08-01",
      balanceMinor: 12_345,
    });

    const targetId = await seedUser("restore@example.com");
    expect(
      await importExport(store, targetId, await buildExport(store, userId, ASOF)),
    ).toMatchObject({
      accounts: 1,
      incomes: 1,
      accountInflows: 0,
      payments: 1,
      contributions: 1,
      balanceSnapshots: 1,
    });
  });
});

/**
 * Two accounts with the same name — the fixture nothing else in this repository
 * has, and without which #52 is invisible.
 *
 * An account name is the file's only way of saying *which* account: a movement
 * names the account it leaves, a derived confirmation names its sender, a
 * contribution names the confirmation that wrote it. The import used to resolve
 * a repeated name to whichever account came first, which is a guess, so a file
 * carrying one is now refused whole (decision 29).
 *
 * The figures here are deliberately not round. A restore reassembles somebody's
 * actual money, and £122.37 is what that looks like.
 */
describe("importExport — a file whose names are not identities is refused", () => {
  const twinFile = () =>
    exportFileSchema.parse({
      version: 1,
      exportedAt: "2026-08-04T00:00:00.000Z",
      accounts: [
        { name: "Savings", currency: "GBP", openingBalanceMinor: 12_237 },
        { name: "Everyday", currency: "GBP", openingBalanceMinor: 41_908 },
        { name: "Savings", currency: "GBP", openingBalanceMinor: 409 },
        {
          name: "Bills pot",
          currency: "GBP",
          accountInflows: [
            {
              name: "Savings top-up",
              fromAccountName: "Savings",
              amountMinor: 8_144,
              frequency: "monthly",
              anchorDate: "2026-08-25",
            },
          ],
        },
      ],
      projects: [{ name: "Kitchen" }],
      closes: [
        {
          month: "2026-07-01",
          currency: "GBP",
          incomeMinor: 301_17,
          plannedMinor: 88_43,
          contributedMinor: 88_43,
        },
      ],
    });

  it("refuses a file with two accounts of the same name, naming the duplicate", async () => {
    const userId = await seedUser();

    const refused = await importExport(store, userId, twinFile()).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/2 accounts in this file are named 'Savings'/);
    // The duplicate, named — not a shrug about a bad file. The account that is
    // only there once is not accused of anything.
    expect((refused as Error).message).not.toMatch(/Everyday/);
  });

  it("writes nothing when it refuses", async () => {
    const userId = await seedUser();

    await expect(importExport(store, userId, twinFile())).rejects.toThrow();

    // Not merely "the call failed". Accounts are the first thing an import
    // creates and projects and closes the last, so an estate with none of any
    // of them is proof it stopped before the first row rather than part-way
    // through leaving half a restore behind.
    expect(await store.listAccountsForOwner(userId)).toEqual([]);
    expect(await store.listProjectsForOwner(userId)).toEqual([]);
    expect(await store.listMonthCloses({ userId })).toEqual([]);
  });

  it("refuses a repeated name even when nothing in the file points at it", async () => {
    // What is wrong is the document, not one reference in it. "It would have
    // been fine this time" is not a property to trust a backup on.
    const userId = await seedUser();
    const file = exportFileSchema.parse({
      version: 1,
      exportedAt: "2026-08-04T00:00:00.000Z",
      accounts: [
        { name: "Joint", currency: "GBP" },
        { name: "Joint", currency: "GBP" },
      ],
    });

    await expect(importExport(store, userId, file)).rejects.toThrow(/named 'Joint'/);
    expect(await store.listAccountsForOwner(userId)).toEqual([]);
  });

  /**
   * The asymmetry, stated on purpose: a person really can own two accounts
   * called "Savings", and the export of that estate is an honest record of it.
   * What it is not is restorable, and saying so at the restore is better than a
   * backup that silently reassembles their money under the wrong account.
   */
  it("still exports an estate whose accounts share a name — it is the restore that refuses", async () => {
    const userId = await seedUser();
    await account(userId, "Savings");
    await account(userId, "Savings");

    const file = await buildExport(store, userId, ASOF);
    expect(file.accounts.map((a) => a.name)).toEqual(["Savings", "Savings"]);
    expect(exportFileSchema.safeParse(file).success).toBe(true);

    await expect(importExport(store, await seedUser("restore@example.com"), file)).rejects.toThrow(
      /named 'Savings'/,
    );
  });
});

/**
 * A backup is of *your* things, and `visibility` is deliberately not one of
 * them (Ben, 2026-08-05, at review).
 *
 * The estate shape, never a lone user: a household of two, both members owning
 * a project, one of them shared. Only a fixture with somebody else in it can
 * tell "exported nothing of theirs" apart from "exported everything there
 * was".
 */
describe("buildExport — projects are yours, and a restored one is personal", () => {
  it("carries only the exporter's own projects, and brings a shared one back personal", async () => {
    const aliceId = await seedUser("alice@example.com");
    const bobId = await seedUser("bob@example.com");
    const household = await store.createHousehold("Home", aliceId);
    await store.addMembership(household.id, bobId, "member");

    const current = await account(aliceId, "Alice current");
    await store.createAccountShare(current.id, household.id, "edit");

    const kitchen = await store.createProject({
      ownerUserId: aliceId,
      name: "Kitchen",
      description: "shared with the household",
      color: null,
      targetDate: "2026-12-01",
      visibility: "shared",
    });
    await store.createProject({
      ownerUserId: aliceId,
      name: "Rainy day",
      description: null,
      color: null,
      targetDate: null,
      visibility: "personal",
    });
    // Bob's, shared into the same household — so Alice can see it, and it must
    // still stay out of her backup.
    await store.createProject({
      ownerUserId: bobId,
      name: "Bathroom",
      description: null,
      color: null,
      targetDate: null,
      visibility: "shared",
    });
    expect((await store.listProjectsForUser(aliceId)).map((p) => p.name)).toContain("Bathroom");

    const file = await buildExport(store, aliceId, ASOF);
    // Owner-scoped: a co-member's shared project is theirs, not part of your
    // backup, even though you can read it today.
    expect(file.projects.map((p) => p.name)).toEqual(["Kitchen", "Rainy day"]);
    // Four fields, and `visibility` is not among them — the export schema does
    // not even have a place to put it.
    expect(Object.keys(file.projects[0]!).sort()).toEqual([
      "color",
      "description",
      "name",
      "targetDate",
    ]);
    expect(exportFileSchema.parse(file).projects).toHaveLength(2);

    // Restored into a *different* household, which is the whole reason the word
    // does not travel: carrying "shared" would auto-share Alice's kitchen into
    // whoever's household the importer belongs to by then.
    const carolId = await seedUser("carol@example.com");
    const carolHousehold = await store.createHousehold("Elsewhere", carolId);
    expect(carolHousehold.id).not.toBe(household.id);
    expect(await importExport(store, carolId, file)).toMatchObject({ projects: 2 });

    const restored = await store.listProjectsForOwner(carolId);
    expect(restored.map((p) => `${p.name}:${p.visibility}`).sort()).toEqual([
      "Kitchen:personal",
      "Rainy day:personal",
    ]);
    // And Alice's original is untouched — an export is a copy, not a move.
    expect((await store.getProject(kitchen.id))?.visibility).toBe("shared");
  });
});
