import { MemoryStore, type Store, type User } from "@finance-planner/data";
import type { Mailer } from "@finance-planner/mailer";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDailyDigest, DAILY_DIGEST_KIND, formatMoney, runNotifierOnce } from "./notify.js";

/** Captures what would have been sent. No transport, no timers. */
class FakeMailer implements Mailer {
  public readonly digests: { to: string; subject: string; textBody: string }[] = [];
  async sendVerificationEmail(): Promise<void> {}
  async sendPasswordReset(): Promise<void> {}
  async sendDigest(to: string, subject: string, textBody: string): Promise<void> {
    this.digests.push({ to, subject, textBody });
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
