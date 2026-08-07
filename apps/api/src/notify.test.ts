import { MemoryStore, type Store, type User } from "@finance-planner/data";
import type { Mailer } from "@finance-planner/mailer";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildDailyDigest,
  DAILY_DIGEST_KIND,
  type DigestAttempts,
  formatMoney,
  runNotifierOnce,
} from "./notify.js";
import { accessibleAccounts, scopesFor } from "./plan.js";

/** Captures what would have been sent. No transport, no timers. */
class FakeMailer implements Mailer {
  public readonly digests: { to: string; subject: string; textBody: string }[] = [];
  async sendVerificationEmail(): Promise<void> {}
  async sendPasswordReset(): Promise<void> {}
  async sendDigest(to: string, subject: string, textBody: string): Promise<void> {
    this.digests.push({ to, subject, textBody });
  }
}

/**
 * A mailer whose first `failures` sends throw and whose later ones deliver.
 *
 * `attempts` and `digests` are counted separately on purpose: an attempt is not
 * a delivery, and reading one as the other is the whole defect these tests
 * exist for. Every other mailer in this file has always worked.
 */
class FlakyMailer implements Mailer {
  public readonly digests: { to: string; subject: string; textBody: string }[] = [];
  public attempts = 0;
  constructor(private readonly failures: number) {}
  async sendVerificationEmail(): Promise<void> {}
  async sendPasswordReset(): Promise<void> {}
  async sendDigest(to: string, subject: string, textBody: string): Promise<void> {
    this.attempts += 1;
    if (this.attempts <= this.failures) throw new Error("smtp: connection reset by peer");
    this.digests.push({ to, subject, textBody });
  }
}

/** A mailer that never delivers, however often it is asked. */
class DeadMailer implements Mailer {
  public readonly digests: { to: string; subject: string; textBody: string }[] = [];
  public attempts = 0;
  async sendVerificationEmail(): Promise<void> {}
  async sendPasswordReset(): Promise<void> {}
  async sendDigest(): Promise<void> {
    this.attempts += 1;
    throw new Error("smtp: 550 mailbox unavailable");
  }
}

/** A store whose first `failures` household reads throw, to fail the builder
 *  rather than the mailer — the other half of the claimed-but-not-sent window. */
class FlakyStore extends MemoryStore {
  public reads = 0;
  constructor(private readonly failures: number) {
    super();
  }
  override async listHouseholdsForUser(userId: string) {
    this.reads += 1;
    if (this.reads <= this.failures) throw new Error("db: connection lost");
    return super.listHouseholdsForUser(userId);
  }
}

const AS_OF = "2026-08-04";

async function seedUser(store: Store, email: string, notify = true): Promise<User> {
  const user = await store.createUser({ email, passwordHash: "x", displayName: email });
  if (notify) await store.setUserNotifyEmail(user.id, true);
  return user;
}

/** An account with one monthly bill due `dueDate`. */
async function seedAccountWithBill(
  store: Store,
  ownerUserId: string,
  name: string,
  dueDate: string,
  amountMinor = 4_500,
): Promise<string> {
  const account = await store.createAccount({ ownerUserId, name, currency: "GBP" });
  await store.createPayment({
    accountId: account.id,
    name: "Phone bill",
    category: "monthly_recurring",
    amountMinor,
    dueDate,
    recurrence: null,
    targetDate: null,
    priority: 10,
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
  return account.id;
}

describe("formatMoney", () => {
  it("renders minor units as major units with the currency code", () => {
    expect(formatMoney(4_500, "GBP")).toBe("45.00 GBP");
    expect(formatMoney(5, "EUR")).toBe("0.05 EUR");
    expect(formatMoney(0, "GBP")).toBe("0.00 GBP");
    expect(formatMoney(-2_500, "GBP")).toBe("-25.00 GBP");
    expect(formatMoney(1_234_567, "USD")).toBe("12345.67 USD");
  });
});

describe("buildDailyDigest", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it("is null when nothing is due and nothing needs moving", async () => {
    const user = await seedUser(store, "quiet@example.com");
    await store.createAccount({ ownerUserId: user.id, name: "Empty", currency: "GBP" });
    expect(await buildDailyDigest(store, user.id, AS_OF)).toBeNull();
  });

  it("is null when the only bill falls outside the seven-day window", async () => {
    const user = await seedUser(store, "later@example.com");
    await seedAccountWithBill(store, user.id, "Everyday", "2026-08-20");
    expect(await buildDailyDigest(store, user.id, AS_OF)).toBeNull();
  });

  it("lists what falls due in the next week, with the account and the money", async () => {
    const user = await seedUser(store, "due@example.com");
    await seedAccountWithBill(store, user.id, "Everyday", "2026-08-06");

    const digest = await buildDailyDigest(store, user.id, AS_OF);
    expect(digest).toContain("Your Finance Planner digest for 2026-08-04.");
    expect(digest).toContain("Due in the next 7 days");
    expect(digest).toContain("- 2026-08-06 (in 2 days) — Phone bill: 45.00 GBP [Everyday]");
    expect(digest).not.toContain("Transfers for the next 7 days");
  });

  it("counts something due today as today, and includes the far edge of the window", async () => {
    const user = await seedUser(store, "edges@example.com");
    await seedAccountWithBill(store, user.id, "Today", AS_OF);
    await seedAccountWithBill(store, user.id, "Edge", "2026-08-11", 1_000);

    const digest = await buildDailyDigest(store, user.id, AS_OF);
    expect(digest).toContain("(today)");
    expect(digest).toContain("- 2026-08-11 (in 7 days) — Phone bill: 10.00 GBP [Edge]");
  });

  it("lists this member's transfers, and nobody else's", async () => {
    const alice = await seedUser(store, "alice@example.com");
    const bob = await seedUser(store, "bob@example.com");
    const household = await store.createHousehold("Home", alice.id);
    await store.addMembership(household.id, bob.id, "member");
    await store.updateMembershipShare(household.id, alice.id, 5_000);
    await store.updateMembershipShare(household.id, bob.id, 5_000);

    const personal = async (userId: string, name: string, incomeMinor: number) => {
      const account = await store.createAccount({ ownerUserId: userId, name, currency: "GBP" });
      await store.createIncome({
        accountId: account.id,
        name: "Pay",
        amountMinor: incomeMinor,
        frequency: "monthly",
        recurrence: null,
        anchorDate: "2026-08-06", // a payday inside the digest window
        active: true,
      });
      await store.upsertAccountAssignment({
        householdId: household.id,
        accountId: account.id,
        role: "personal",
        memberUserId: userId,
      });
      return account.id;
    };
    await personal(alice.id, "Alice current", 300_000);
    await personal(bob.id, "Bob current", 300_000);

    const bills = await store.createAccount({
      ownerUserId: alice.id,
      name: "Bills",
      currency: "GBP",
    });
    await store.createPayment({
      accountId: bills.id,
      name: "Rent",
      category: "monthly_recurring",
      amountMinor: 100_000,
      dueDate: "2026-08-25", // outside the window: this is a transfers-only digest
      recurrence: null,
      targetDate: null,
      priority: 10,
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
    await store.upsertAccountAssignment({
      householdId: household.id,
      accountId: bills.id,
      role: "shared",
      memberUserId: null,
    });

    const digest = await buildDailyDigest(store, alice.id, AS_OF);
    expect(digest).toContain("Transfers for the next 7 days");
    expect(digest).toContain("- 2026-08-06 — 500.00 GBP from Alice current to Bills (Home)");
    expect(digest).not.toContain("Bob current"); // bob's identical transfer is bob's business
    expect(digest).not.toContain("Due in the next 7 days");

    // Bob gets his own, from his own account.
    const bobDigest = await buildDailyDigest(store, bob.id, AS_OF);
    expect(bobDigest).toContain("from Bob current to Bills");
    expect(bobDigest).not.toContain("Alice current");
  });

  /**
   * The "what to move" section asked `listHouseholdsForUser` and nothing else,
   * so a movement between two accounts one person owns — plannable since WP-F,
   * confirmable since WP-H — could never appear in it however overdue. The
   * standalone user's whole to-do list was invisible.
   */
  it("lists a movement between your own accounts, with no household anywhere", async () => {
    const user = await seedUser(store, "solo@example.com");
    const current = await store.createAccount({
      ownerUserId: user.id,
      name: "Current",
      currency: "GBP",
    });
    const pot = await store.createAccount({ ownerUserId: user.id, name: "Pot", currency: "GBP" });
    await store.createIncome({
      accountId: current.id,
      name: "Salary",
      amountMinor: 300_000,
      frequency: "monthly",
      recurrence: null,
      anchorDate: "2026-01-01",
      active: true,
    });
    const movement = await store.createInflow({
      accountId: pot.id,
      name: "Top-up",
      source: "account",
      sourceAccountId: current.id,
      amountMinor: 20_000,
      frequency: "monthly",
      recurrence: null,
      anchorDate: "2026-01-01",
      priority: 50,
      active: true,
    });

    const digest = await buildDailyDigest(store, user.id, AS_OF);
    expect(digest).toContain("Money to move between your own accounts");
    expect(digest).toContain("- 200.00 GBP from Current to Pot");
    // Nothing is due, and there is no household: this section alone is reason
    // enough to send the mail.
    expect(digest).not.toContain("Due in the next 7 days");
    expect(digest).not.toContain("Transfers for the next 7 days");

    // Once it is confirmed it stops being asked for.
    await store.createTransferConfirmation({
      householdId: null,
      inflowId: movement.id,
      month: "2026-08-01",
      fromAccountId: current.id,
      toAccountId: pot.id,
      memberUserId: user.id,
      amountMinor: 20_000,
    });
    expect(await buildDailyDigest(store, user.id, AS_OF)).toBeNull();
  });

  /**
   * **The digest told you to make a co-member's transfers.**
   *
   * `movementLines` built its "mine" from every **accessible** account, so a
   * co-member's current account shared into your household was in it and every
   * authored movement leaving it landed in your daily email as a thing for you
   * to do. The comment above the filter already stated the rule — "money
   * leaving somebody else's account is not on it" — so the code simply did not
   * do what it said, in a message the reader cannot correct afterwards.
   *
   * Ownership, never access (decision 20). The account stays visible to Alice
   * everywhere a list of accounts is the point; it is the instruction that is
   * Bob's.
   */
  it("does not ask you to move money out of a co-member's account", async () => {
    const alice = await seedUser(store, "alice@example.com");
    const bob = await seedUser(store, "bob@example.com");
    const household = await store.createHousehold("Ours", alice.id);
    await store.addMembership(household.id, bob.id, "member");

    /** A current account with a salary, a pot beside it, and a monthly sweep. */
    const estateFor = async (userId: string, label: string, sweepMinor: number) => {
      const current = await store.createAccount({
        ownerUserId: userId,
        name: `${label} current`,
        currency: "GBP",
      });
      const pot = await store.createAccount({
        ownerUserId: userId,
        name: `${label} pot`,
        currency: "GBP",
      });
      await store.createIncome({
        accountId: current.id,
        name: "Salary",
        amountMinor: 300_000,
        frequency: "monthly",
        recurrence: null,
        anchorDate: "2026-01-01",
        active: true,
      });
      await store.createInflow({
        accountId: pot.id,
        name: `${label} sweep`,
        source: "account",
        sourceAccountId: current.id,
        amountMinor: sweepMinor,
        frequency: "monthly",
        recurrence: null,
        anchorDate: "2026-01-01",
        priority: 50,
        active: true,
      });
      return current;
    };

    await estateFor(alice.id, "Alice", 10_000);
    const bobCurrent = await estateFor(bob.id, "Bob", 20_000);
    // Bob shares his current account into the household, which is the only
    // thing that has to happen for the old code to put his sweep in Alice's
    // inbox.
    await store.createAccountShare(bobCurrent.id, household.id, "view");

    const digest = await buildDailyDigest(store, alice.id, AS_OF);
    // Hers, still there — the section is not simply gone.
    expect(digest).toContain("- 100.00 GBP from Alice current to Alice pot");
    // His, gone. The account is still one she can see; the instruction is not
    // hers to act on.
    expect(digest).not.toContain("from Bob current");
    expect(digest).not.toContain("200.00 GBP");

    // And it really is in the pass Alice's digest reads — this is a predicate
    // doing work, not a movement that was never there.
    const scopes = await scopesFor(store, await accessibleAccounts(store, alice.id), AS_OF);
    expect(
      scopes.flatMap((s) => s.plan.movements).map((m) => [m.fromAccountId, m.fundedMinor]),
    ).toContainEqual([bobCurrent.id, 20_000]);

    // Bob's own digest is where it belongs.
    expect(await buildDailyDigest(store, bob.id, AS_OF)).toContain(
      "- 200.00 GBP from Bob current to Bob pot",
    );
  });

  /**
   * **The other end of WP-AF's fix: a heading that lied about the destination.**
   *
   * The sender predicate above made every line's *from* an account the reader
   * owns. Nothing ever looked at the *to*, and the section heading was pushed
   * unconditionally — so a movement out of your current account into a
   * co-member's pot, an honest instruction genuinely yours to make, was printed
   * under "Money to move between your own accounts". `needsYou.ts`'s
   * `movementEnds` calls that reading `leaving for somebody else's account`;
   * this is the same falsehood on the one surface a reader cannot correct
   * afterwards.
   *
   * Three destinations, because this surface can reach exactly two readings and
   * the third case has to be shown collapsing into one of them:
   *
   * - **Alice pot**, hers — stays where it was;
   * - **Bob pot (shared)**, his, visible to her because he shared it into the
   *   household — the case the old heading lied about;
   * - **Bob vault**, his and *not* shared, so it is in the scope (a scope closes
   *   over funding relationships) but not in her account list. It is safely
   *   "not yours" rather than "cannot say": every account you own is in
   *   `listAccessibleAccounts` by construction, so absence proves non-ownership.
   *   It keeps its honest "another account" name and belongs with Bob's pot.
   *
   * No figure moves. The same three amounts appear, under headings each true of
   * every line beneath it.
   */
  it("does not put money bound for a co-member's account under your own accounts", async () => {
    const alice = await seedUser(store, "alice-dest@example.com");
    const bob = await seedUser(store, "bob-dest@example.com");
    const household = await store.createHousehold("Ours", alice.id);
    await store.addMembership(household.id, bob.id, "member");

    const current = await store.createAccount({
      ownerUserId: alice.id,
      name: "Alice current",
      currency: "GBP",
    });
    await store.createIncome({
      accountId: current.id,
      name: "Salary",
      amountMinor: 300_000,
      frequency: "monthly",
      recurrence: null,
      anchorDate: "2026-01-01",
      active: true,
    });

    const sweepInto = async (accountId: string, name: string, amountMinor: number) =>
      store.createInflow({
        accountId,
        name,
        source: "account",
        sourceAccountId: current.id,
        amountMinor,
        frequency: "monthly",
        recurrence: null,
        anchorDate: "2026-01-01",
        priority: 50,
        active: true,
      });

    const alicePot = await store.createAccount({
      ownerUserId: alice.id,
      name: "Alice pot",
      currency: "GBP",
    });
    const bobPot = await store.createAccount({
      ownerUserId: bob.id,
      name: "Bob pot",
      currency: "GBP",
    });
    const bobVault = await store.createAccount({
      ownerUserId: bob.id,
      name: "Bob vault",
      currency: "GBP",
    });
    // Shared, so Alice can see it and read its name. Ownership is unchanged by
    // that (decision 20) — it is still Bob's account.
    await store.createAccountShare(bobPot.id, household.id, "view");

    await sweepInto(alicePot.id, "Alice sweep", 10_000);
    await sweepInto(bobPot.id, "To Bob's pot", 40_000);
    await sweepInto(bobVault.id, "To Bob's vault", 25_000);

    const digest = await buildDailyDigest(store, alice.id, AS_OF);
    expect(digest).not.toBeNull();

    // The heading is a claim about every line beneath it, so read the sections
    // rather than the whole body: `toContain` on the two together would pass
    // however they were grouped, which is the entire defect.
    const sectionOf = (heading: string): string[] => {
      const section = digest!.split("\n\n").find((s) => s.startsWith(`${heading}\n`));
      return section ? section.split("\n").slice(1) : [];
    };

    expect(sectionOf("Money to move between your own accounts")).toEqual([
      "- 100.00 GBP from Alice current to Alice pot",
    ]);
    expect(sectionOf("Money to move into somebody else's account")).toEqual([
      "- 250.00 GBP from Alice current to another account",
      "- 400.00 GBP from Alice current to Bob pot",
    ]);

    // Every one of the three is still asked for, at the same figure: this is a
    // labelling change and moves no money.
    for (const line of ["100.00 GBP", "400.00 GBP", "250.00 GBP"]) {
      expect(digest).toContain(line);
    }

    // And they really are in the pass Alice's digest reads — the unshared vault
    // is in her scope because a scope closes over funding relationships, which
    // is what makes the "cannot see it" case reachable at all.
    const scopes = await scopesFor(store, await accessibleAccounts(store, alice.id), AS_OF);
    expect(scopes.flatMap((s) => s.plan.movements).map((m) => m.toAccountId)).toEqual(
      expect.arrayContaining([alicePot.id, bobPot.id, bobVault.id]),
    );
    expect((await accessibleAccounts(store, alice.id)).map((a) => a.id)).not.toContain(bobVault.id);
  });

  /**
   * The other half of the same blindness, and the one WP-S closes: a solo user's
   * derived feed into a bills pot is a transfer with a member, a source account
   * and a payday, exactly like a household member's share of the rent — but the
   * only thing that produced a transfer was a household plan, so
   * `splitTransfersByPayday` had nothing to schedule and the section was empty.
   * One pass derives both, so the digest serves both.
   */
  it("dates a solo user's derived feed to their payday, with no household anywhere", async () => {
    const user = await seedUser(store, "pot@example.com");
    const current = await store.createAccount({
      ownerUserId: user.id,
      name: "Current",
      currency: "GBP",
    });
    const pot = await store.createAccount({ ownerUserId: user.id, name: "Bills", currency: "GBP" });
    await store.createIncome({
      accountId: current.id,
      name: "Salary",
      amountMinor: 300_000,
      frequency: "monthly",
      recurrence: null,
      anchorDate: "2026-08-06",
      active: true,
    });
    await store.createPayment({
      accountId: pot.id,
      name: "Council tax",
      category: "monthly_recurring",
      amountMinor: 15_000,
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

    // Nobody authored a movement, and there is no household to name.
    expect(await store.listInflows(pot.id)).toEqual([]);
    const digest = await buildDailyDigest(store, user.id, AS_OF);
    expect(digest).toContain("Transfers for the next 7 days");
    expect(digest).toContain("- 2026-08-06 — 150.00 GBP from Current to Bills");
    expect(digest).not.toContain("(");
  });

  /**
   * Every transfer line took its currency from `scope.input.accounts[0]`, and a
   * scope holds as many currencies as its accounts do — the pass partitions by
   * currency and plans each on its own (decision 10), which is precisely why
   * `DerivedTransfer` carries the field the digest was dropping. A EUR feed went
   * out labelled GBP: the wrong money, in an email nobody can correct after the
   * fact.
   */
  it("labels each transfer with its own currency, not the scope's first account", async () => {
    const user = await seedUser(store, "two-currencies@example.com");
    const pay = async (accountId: string, amountMinor: number) =>
      store.createIncome({
        accountId,
        name: "Salary",
        amountMinor,
        frequency: "monthly",
        recurrence: null,
        anchorDate: "2026-08-06", // a payday inside the digest window
        active: true,
      });
    const bill = async (accountId: string, amountMinor: number) =>
      store.createPayment({
        accountId,
        name: "Council tax",
        category: "monthly_recurring",
        amountMinor,
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
    const make = (name: string, currency: string) =>
      store.createAccount({ ownerUserId: user.id, name, currency });

    // One scope, two partitions: the owner's accounts are all one scope, and
    // "Euro current" sorts before "Current" on nothing — `accounts[0]` was
    // whichever id sorted first, which is not a fact about anybody's money.
    const gbpCurrent = await make("Current", "GBP");
    const gbpBills = await make("Bills", "GBP");
    const eurCurrent = await make("Euro current", "EUR");
    const eurBills = await make("Euro bills", "EUR");
    await pay(gbpCurrent.id, 300_000);
    await pay(eurCurrent.id, 200_000);
    await bill(gbpBills.id, 15_000);
    await bill(eurBills.id, 8_000);

    const digest = await buildDailyDigest(store, user.id, AS_OF);
    expect(digest).toContain("- 2026-08-06 — 150.00 GBP from Current to Bills");
    expect(digest).toContain("- 2026-08-06 — 80.00 EUR from Euro current to Euro bills");
    expect(digest).not.toContain("80.00 GBP");
  });

  it("drops transfers scheduled outside the window", async () => {
    const alice = await seedUser(store, "late@example.com");
    const household = await store.createHousehold("Home", alice.id);
    await store.updateMembershipShare(household.id, alice.id, 10_000);
    const current = await store.createAccount({
      ownerUserId: alice.id,
      name: "Current",
      currency: "GBP",
    });
    await store.createIncome({
      accountId: current.id,
      name: "Pay",
      amountMinor: 300_000,
      frequency: "monthly",
      recurrence: null,
      anchorDate: "2026-08-28", // payday well past the seven-day window
      active: true,
    });
    await store.upsertAccountAssignment({
      householdId: household.id,
      accountId: current.id,
      role: "personal",
      memberUserId: alice.id,
    });
    const bills = await store.createAccount({
      ownerUserId: alice.id,
      name: "Bills",
      currency: "GBP",
    });
    await store.createPayment({
      accountId: bills.id,
      name: "Rent",
      category: "monthly_recurring",
      amountMinor: 100_000,
      dueDate: "2026-08-25",
      recurrence: null,
      targetDate: null,
      priority: 10,
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
    await store.upsertAccountAssignment({
      householdId: household.id,
      accountId: bills.id,
      role: "shared",
      memberUserId: null,
    });

    expect(await buildDailyDigest(store, alice.id, AS_OF)).toBeNull();
  });
});

describe("runNotifierOnce", () => {
  let store: MemoryStore;
  let mailer: FakeMailer;
  beforeEach(() => {
    store = new MemoryStore();
    mailer = new FakeMailer();
  });

  it("mails only the users who opted in, and only those with something to say", async () => {
    const optedIn = await seedUser(store, "in@example.com");
    const optedOut = await seedUser(store, "out@example.com", false);
    const quiet = await seedUser(store, "nothing@example.com");
    await seedAccountWithBill(store, optedIn.id, "Everyday", "2026-08-06");
    await seedAccountWithBill(store, optedOut.id, "Everyday", "2026-08-06");
    await store.createAccount({ ownerUserId: quiet.id, name: "Empty", currency: "GBP" });

    const sent = await runNotifierOnce(store, mailer, new Date(`${AS_OF}T08:30:00.000Z`));
    expect(sent).toBe(1);
    expect(mailer.digests).toHaveLength(1);
    expect(mailer.digests[0]!.to).toBe("in@example.com");
    expect(mailer.digests[0]!.subject).toBe("Finance Planner: your 2026-08-04 digest");
    expect(mailer.digests[0]!.textBody).toContain("Phone bill");
  });

  it("sends at most one digest per user per day, however often it runs", async () => {
    const user = await seedUser(store, "once@example.com");
    await seedAccountWithBill(store, user.id, "Everyday", "2026-08-06");

    expect(await runNotifierOnce(store, mailer, new Date(`${AS_OF}T08:00:00.000Z`))).toBe(1);
    expect(await runNotifierOnce(store, mailer, new Date(`${AS_OF}T09:00:00.000Z`))).toBe(0);
    expect(await runNotifierOnce(store, mailer, new Date(`${AS_OF}T23:59:00.000Z`))).toBe(0);
    expect(mailer.digests).toHaveLength(1);

    // A new day is a new claim.
    expect(await runNotifierOnce(store, mailer, new Date("2026-08-05T08:00:00.000Z"))).toBe(1);
    expect(mailer.digests).toHaveLength(2);
    expect(mailer.digests[1]!.subject).toContain("2026-08-05");
  });

  it("claims the day even when the digest turns out to be empty", async () => {
    // The claim is taken before the digest is built, so a user with nothing to
    // report doesn't get re-examined every fifteen minutes for the rest of the day.
    const user = await seedUser(store, "empty@example.com");
    expect(await runNotifierOnce(store, mailer, new Date(`${AS_OF}T08:00:00.000Z`))).toBe(0);
    expect(await store.tryLogNotification(user.id, AS_OF, DAILY_DIGEST_KIND)).toBe(false);
  });

  it("does nothing at all when nobody has opted in", async () => {
    await seedUser(store, "silent@example.com", false);
    expect(await runNotifierOnce(store, mailer, new Date(`${AS_OF}T08:00:00.000Z`))).toBe(0);
    expect(mailer.digests).toEqual([]);
  });
});

/**
 * What happens when the send does not work. Nothing in this repository had ever
 * exercised a failing mailer, so the log could say a digest had gone out when
 * the throw meant it never had — and the day was then unrecoverable.
 */
describe("runNotifierOnce when delivery fails", () => {
  let store: MemoryStore;
  /** One replica's memory of what it claimed and failed to deliver. */
  let replica: DigestAttempts;
  beforeEach(() => {
    store = new MemoryStore();
    replica = new Map();
  });

  const at = (time: string, date = AS_OF): Date => new Date(`${date}T${time}:00.000Z`);

  it("delivers on the retry, the same day, when the first send throws", async () => {
    const user = await seedUser(store, "flaky@example.com");
    await seedAccountWithBill(store, user.id, "Everyday", "2026-08-06");
    const mailer = new FlakyMailer(1);

    // The claim is taken and the send throws: nothing sent, nothing delivered.
    expect(await runNotifierOnce(store, mailer, at("08:00"), { attempts: replica })).toBe(0);
    expect(mailer.digests).toEqual([]);

    // The next tick, still the same date. The day was claimed by this pass, so
    // it is this pass's to finish — and it does.
    expect(await runNotifierOnce(store, mailer, at("08:15"), { attempts: replica })).toBe(1);
    expect(mailer.attempts).toBe(2);
    expect(mailer.digests).toHaveLength(1);
    expect(mailer.digests[0]!.to).toBe("flaky@example.com");
    expect(mailer.digests[0]!.subject).toContain(AS_OF);
    expect(mailer.digests[0]!.textBody).toContain("Phone bill");

    // And having delivered, it stops: the day is finished, not owed.
    expect(await runNotifierOnce(store, mailer, at("08:30"), { attempts: replica })).toBe(0);
    expect(mailer.attempts).toBe(2);
  });

  it("retries the day when building the digest throws, not only the send", async () => {
    const flaky = new FlakyStore(1);
    const user = await seedUser(flaky, "builder@example.com");
    await seedAccountWithBill(flaky, user.id, "Everyday", "2026-08-06");
    const mailer = new FakeMailer();

    expect(await runNotifierOnce(flaky, mailer, at("08:00"), { attempts: replica })).toBe(0);
    expect(mailer.digests).toEqual([]);
    expect(await runNotifierOnce(flaky, mailer, at("08:15"), { attempts: replica })).toBe(1);
    expect(mailer.digests).toHaveLength(1);
  });

  it("does not send twice when the pass runs twice against a mailer that always throws", async () => {
    const user = await seedUser(store, "dead@example.com");
    await seedAccountWithBill(store, user.id, "Everyday", "2026-08-06");
    const mailer = new DeadMailer();

    expect(await runNotifierOnce(store, mailer, at("08:00"), { attempts: replica })).toBe(0);
    expect(await runNotifierOnce(store, mailer, at("08:15"), { attempts: replica })).toBe(0);
    expect(mailer.digests).toEqual([]);

    // Two attempts for the two passes, and then the day is given up rather than
    // retried every quarter of an hour until midnight.
    expect(mailer.attempts).toBe(2);
    for (const time of ["08:30", "08:45", "09:00"]) {
      expect(await runNotifierOnce(store, mailer, at(time), { attempts: replica })).toBe(0);
    }
    expect(mailer.attempts).toBe(2);
  });

  it("does not let a second replica take over a failed pass's day", async () => {
    const user = await seedUser(store, "shared@example.com");
    await seedAccountWithBill(store, user.id, "Everyday", "2026-08-06");
    const mailer = new FlakyMailer(1);
    const other: DigestAttempts = new Map();

    // Replica one claims the day and its send throws.
    expect(await runNotifierOnce(store, mailer, at("08:00"), { attempts: replica })).toBe(0);

    // Replica two runs a full pass against the same store. It lost the claim,
    // owes no retry, and asks the log for nothing else — so it sends nothing.
    expect(await runNotifierOnce(store, mailer, at("08:05"), { attempts: other })).toBe(0);
    expect(mailer.attempts).toBe(1);

    // The retry belongs to the replica that failed, and exactly one digest
    // reaches the user across both.
    expect(await runNotifierOnce(store, mailer, at("08:15"), { attempts: replica })).toBe(1);
    expect(mailer.digests).toHaveLength(1);
  });

  it("keeps two replicas from both sending while the first is still mid-send", async () => {
    const user = await seedUser(store, "race@example.com");
    await seedAccountWithBill(store, user.id, "Everyday", "2026-08-06");

    // A mailer that parks its first send, so a second replica's whole pass runs
    // inside the window between replica one's claim and its delivery — the
    // window a retry token in the notification log would have opened.
    let releaseSend!: () => void;
    let sendEntered!: () => void;
    const parked = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      sendEntered = resolve;
    });
    const digests: string[] = [];
    let attempts = 0;
    const mailer: Mailer = {
      async sendVerificationEmail() {},
      async sendPasswordReset() {},
      async sendDigest(to: string) {
        attempts += 1;
        if (attempts === 1) {
          sendEntered();
          await parked;
        }
        digests.push(to);
      },
    };

    const first = runNotifierOnce(store, mailer, at("08:00"), { attempts: replica });
    // Not a yield count: the first pass has genuinely reached the send, holding
    // the claim, before the second replica starts its own pass.
    await entered;
    const second = await runNotifierOnce(store, mailer, at("08:00"), { attempts: new Map() });
    expect(second).toBe(0);
    expect(digests).toEqual([]);

    releaseSend();
    expect(await first).toBe(1);
    expect(digests).toEqual(["race@example.com"]);
    expect(attempts).toBe(1);
  });

  it("keeps one user's failure from costing everybody after them their digest", async () => {
    // Alphabetical by nothing in particular — the point is that the pass used to
    // throw out of the loop, so whoever the store listed next got nothing.
    const first = await seedUser(store, "first@example.com");
    const second = await seedUser(store, "second@example.com");
    await seedAccountWithBill(store, first.id, "Everyday", "2026-08-06");
    await seedAccountWithBill(store, second.id, "Everyday", "2026-08-06");
    const mailer = new FlakyMailer(1);

    expect(await runNotifierOnce(store, mailer, at("08:00"), { attempts: replica })).toBe(1);
    expect(mailer.digests.map((d) => d.to)).toEqual(["second@example.com"]);

    // And the one that failed is still owed its day.
    expect(await runNotifierOnce(store, mailer, at("08:15"), { attempts: replica })).toBe(1);
    expect(mailer.digests.map((d) => d.to)).toEqual(["second@example.com", "first@example.com"]);
  });

  it("reports a failed attempt rather than swallowing it", async () => {
    const user = await seedUser(store, "logged@example.com");
    await seedAccountWithBill(store, user.id, "Everyday", "2026-08-06");
    const lines: string[] = [];
    const mailer = new DeadMailer();

    await runNotifierOnce(store, mailer, at("08:00"), {
      attempts: replica,
      log: (msg) => lines.push(msg),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(user.id);
    expect(lines[0]).toContain(AS_OF);
    expect(lines[0]).toContain("550 mailbox unavailable");
  });

  it("does not carry a failed day into the next one", async () => {
    const user = await seedUser(store, "yesterday@example.com");
    await seedAccountWithBill(store, user.id, "Everyday", "2026-08-06");
    const mailer = new FlakyMailer(1);

    expect(await runNotifierOnce(store, mailer, at("08:00"), { attempts: replica })).toBe(0);
    // A new day claims a new slot and sends its own digest — one attempt, not a
    // second go at yesterday's.
    expect(
      await runNotifierOnce(store, mailer, at("08:00", "2026-08-05"), { attempts: replica }),
    ).toBe(1);
    expect(mailer.digests).toHaveLength(1);
    expect(mailer.digests[0]!.subject).toContain("2026-08-05");
    expect(replica.size).toBe(0);
  });
});
