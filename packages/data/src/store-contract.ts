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
    projectId: null,
    scope: "shared",
    bearerUserId: null,
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
    projectId: null,
    scope: "shared",
    bearerUserId: null,
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

  // members + household share listings
  const members = await store.listMembersForHousehold(household.id);
  expect(members.map((m) => m.userId).sort()).toEqual([user.id, other.id].sort());
  const householdShares = await store.listSharesForHousehold(household.id);
  expect(householdShares.map((s) => s.accountId)).toEqual([account.id]);

  // promote the partner to admin, then demote back
  const promoted = await store.updateMembershipRole(household.id, other.id, "admin");
  expect(promoted?.role).toBe("admin");
  const demoted = await store.updateMembershipRole(household.id, other.id, "member");
  expect(demoted?.role).toBe("member");

  // contribution shares: default 0, then set proportionally.
  expect((await store.getMembership(household.id, other.id))?.contributionShareBp).toBe(0);
  const shared = await store.updateMembershipShare(household.id, other.id, 3400);
  expect(shared?.contributionShareBp).toBe(3400);
  await store.updateMembershipShare(household.id, user.id, 6600);
  expect((await store.getMembership(household.id, user.id))?.contributionShareBp).toBe(6600);

  // account assignments: upsert is idempotent on (household, account).
  const assignment = await store.upsertAccountAssignment({
    householdId: household.id,
    accountId: account.id,
    role: "shared",
    memberUserId: null,
  });
  expect(assignment.role).toBe("shared");
  const reassigned = await store.upsertAccountAssignment({
    householdId: household.id,
    accountId: account.id,
    role: "personal",
    memberUserId: user.id,
  });
  expect(reassigned.id).toBe(assignment.id); // same row, updated in place
  expect(reassigned.role).toBe("personal");
  expect(reassigned.memberUserId).toBe(user.id);
  expect((await store.listAccountAssignments(household.id)).length).toBe(1);
  expect((await store.getAccountAssignment(household.id, account.id))?.role).toBe("personal");
  await store.deleteAccountAssignment(household.id, account.id);
  expect(await store.getAccountAssignment(household.id, account.id)).toBeNull();

  // remove the partner from the household; their access goes away.
  await store.removeMember(household.id, other.id);
  expect(await store.getAccess(other.id, account.id)).toBeNull();

  // deleting the household removes its shares and memberships
  const tempHousehold = await store.createHousehold("Temp", user.id);
  const tempAccount = await store.createAccount({
    ownerUserId: user.id,
    name: "Temp",
    currency: "GBP",
  });
  await store.createAccountShare(tempAccount.id, tempHousehold.id, "view");
  expect((await store.listSharesForHousehold(tempHousehold.id)).length).toBe(1);
  await store.deleteHousehold(tempHousehold.id);
  expect(await store.getHousehold(tempHousehold.id)).toBeNull();
  expect((await store.listSharesForHousehold(tempHousehold.id)).length).toBe(0);
  expect((await store.listMembersForHousehold(tempHousehold.id)).length).toBe(0);

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

  // --- projects ---
  const project = await store.createProject({
    ownerUserId: user.id,
    name: "House move 2026",
    description: null,
    color: null,
    targetDate: "2026-09-01",
  });
  expect((await store.listProjectsForOwner(user.id)).length).toBe(1);
  // Assign p1 to the project, then list payments for it.
  await store.updatePayment(p1.id, { projectId: project.id });
  const projectMembers = await store.listPaymentsForProject(project.id);
  expect(projectMembers.map((m) => m.id)).toEqual([p1.id]);
  // Deleting the project leaves the payment intact but unlinked.
  await store.deleteProject(project.id);
  expect(await store.getProject(project.id)).toBeNull();
  expect((await store.getPayment(p1.id))?.projectId ?? null).toBeNull();

  // --- delete cascade ---
  await store.deletePayment(p1.id);
  expect((await store.listPayments(account.id)).length).toBe(1);
}
