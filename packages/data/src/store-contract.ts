import { expect } from "vitest";
import type { Store } from "./store.js";

/**
 * One behavioural contract exercised against every Store implementation
 * (MemoryStore and the Postgres-backed PgStore), so both stay in lockstep.
 */
export async function exerciseStore(store: Store): Promise<void> {
  // --- users ---
  const user = await store.createUser({
    email: "Owner@Example.com",
    passwordHash: "hash",
    displayName: "Owner",
  });
  expect(user.email).toBe("owner@example.com");
  expect(await store.getUserByEmail("owner@example.com")).not.toBeNull();
  await store.setUserVerified(user.id);
  expect((await store.getUserById(user.id))?.emailVerified).toBe(true);

  // --- account + income + payment ---
  const account = await store.createAccount({
    ownerUserId: user.id,
    name: "Everyday",
    currency: "GBP",
    monthlyBufferMinor: 10_000,
  });
  expect(account.monthlyBufferMinor).toBe(10_000);

  const income = await store.createIncome({
    accountId: account.id,
    name: "Salary",
    amountMinor: 300_000,
    frequency: "monthly",
    recurrence: null,
    anchorDate: "2026-01-25",
    active: true,
  });
  expect((await store.listIncomes(account.id)).length).toBe(1);
  const updatedIncome = await store.updateIncome(income.id, { amountMinor: 320_000 });
  expect(updatedIncome?.amountMinor).toBe(320_000);

  const p1 = await store.createPayment({
    accountId: account.id,
    name: "Holiday",
    category: "fixed_point",
    amountMinor: 120_000,
    dueDate: "2026-09-01",
    recurrence: null,
    targetDate: null,
    priority: 5,
    alreadySavedMinor: 0,
    autoRenew: true,
    active: true,
    notes: null,
  });
  const p2 = await store.createPayment({
    accountId: account.id,
    name: "Phone",
    category: "monthly_recurring",
    amountMinor: 4_500,
    dueDate: null,
    recurrence: null,
    targetDate: null,
    priority: 10,
    alreadySavedMinor: 0,
    autoRenew: true,
    active: true,
    notes: null,
  });
  expect((await store.listPayments(account.id)).length).toBe(2);

  await store.reorderPayments(account.id, [p2.id, p1.id]);
  expect((await store.getPayment(p2.id))?.priority).toBe(1);
  expect((await store.getPayment(p1.id))?.priority).toBe(2);

  // --- households + sharing + ACL ---
  const other = await store.createUser({
    email: "partner@example.com",
    passwordHash: "hash",
    displayName: "Partner",
  });
  const household = await store.createHousehold("Home", user.id);
  await store.addMembership(household.id, other.id, "member");
  await store.createAccountShare(account.id, household.id, "edit");

  const ownerAccess = await store.getAccess(user.id, account.id);
  expect(ownerAccess?.owner).toBe(true);
  expect(ownerAccess?.permission).toBe("edit");

  const partnerAccess = await store.getAccess(other.id, account.id);
  expect(partnerAccess?.owner).toBe(false);
  expect(partnerAccess?.permission).toBe("edit");

  const partnerVisible = await store.listAccessibleAccounts(other.id);
  expect(partnerVisible.map((a) => a.accountId)).toContain(account.id);

  const stranger = await store.createUser({
    email: "stranger@example.com",
    passwordHash: "hash",
    displayName: "Stranger",
  });
  expect(await store.getAccess(stranger.id, account.id)).toBeNull();

  // --- snapshot ---
  const snap = await store.saveSnapshot({
    accountId: account.id,
    asOfDate: "2026-01-01",
    inputsHash: "abc",
    detail: { leftoverMinor: 1 },
  });
  expect(snap.id).toBeTruthy();

  // --- delete cascade ---
  await store.deletePayment(p1.id);
  expect((await store.listPayments(account.id)).length).toBe(1);
}
