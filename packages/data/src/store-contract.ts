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
  // Identity-provider accounts carry no local password.
  const federated = await store.createUser({
    email: "sso@example.com",
    passwordHash: null,
    displayName: "SSO",
  });
  expect(federated.passwordHash).toBeNull();

  // --- passwords ---
  await store.updateUserPassword(user.id, "hash-2");
  expect((await store.getUserById(user.id))?.passwordHash).toBe("hash-2");

  // --- two-factor: staged secret, then enabled, then torn down ---
  expect(user.totpSecret).toBeNull();
  expect(user.totpEnabledAt).toBeNull();
  await store.setUserTotpSecret(user.id, "JBSWY3DPEHPK3PXP");
  const staged = await store.getUserById(user.id);
  expect(staged?.totpSecret).toBe("JBSWY3DPEHPK3PXP");
  expect(staged?.totpEnabledAt).toBeNull(); // staging alone doesn't turn 2FA on
  await store.enableUserTotp(user.id);
  expect((await store.getUserById(user.id))?.totpEnabledAt).toBeTruthy();

  // Recovery codes: replace wholesale, spend once, never twice.
  await store.replaceRecoveryCodes(user.id, ["hash-a", "hash-b"]);
  await store.replaceRecoveryCodes(user.id, ["hash-c", "hash-d"]); // replaces, not appends
  expect((await store.listUnusedRecoveryCodes(user.id)).map((c) => c.codeHash)).toEqual([
    "hash-c",
    "hash-d",
  ]);
  expect(await store.consumeRecoveryCode(user.id, "hash-c")).toBe(true);
  expect(await store.consumeRecoveryCode(user.id, "hash-c")).toBe(false); // already spent
  expect(await store.consumeRecoveryCode(user.id, "hash-a")).toBe(false); // never issued
  expect(await store.consumeRecoveryCode(federated.id, "hash-d")).toBe(false); // not their code
  expect((await store.listUnusedRecoveryCodes(user.id)).map((c) => c.codeHash)).toEqual(["hash-d"]);
  await store.replaceRecoveryCodes(user.id, []);
  expect(await store.listUnusedRecoveryCodes(user.id)).toEqual([]);

  // Clearing the secret disables 2FA in the same stroke.
  await store.setUserTotpSecret(user.id, null);
  const disabled = await store.getUserById(user.id);
  expect(disabled?.totpSecret).toBeNull();
  expect(disabled?.totpEnabledAt).toBeNull();

  // --- password reset tokens: single-use, expiry passed through ---
  await store.createPasswordResetToken({
    token: "reset-token",
    userId: user.id,
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  const consumed = await store.consumePasswordResetToken("reset-token");
  expect(consumed?.userId).toBe(user.id);
  expect(new Date(consumed!.expiresAt).getTime()).toBe(Date.parse("2030-01-01T00:00:00.000Z"));
  expect(await store.consumePasswordResetToken("reset-token")).toBeNull(); // one shot
  expect(await store.consumePasswordResetToken("never-issued")).toBeNull();
  // Expired tokens still round-trip — the caller decides, like email verification.
  await store.createPasswordResetToken({
    token: "stale-token",
    userId: user.id,
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  const stale = await store.consumePasswordResetToken("stale-token");
  expect(new Date(stale!.expiresAt) < new Date()).toBe(true);

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

  // --- contributions ---
  const c1 = await store.createContribution({
    paymentId: p1.id,
    accountId: account.id,
    userId: user.id,
    month: "2026-07-01",
    amountMinor: 20_000,
    note: "July",
    transferConfirmationId: null,
  });
  const c2 = await store.createContribution({
    paymentId: p1.id,
    accountId: account.id,
    userId: user.id,
    month: "2026-08-01",
    amountMinor: 30_000,
    note: null,
    transferConfirmationId: null,
  });
  const c3 = await store.createContribution({
    paymentId: p2.id,
    accountId: account.id,
    userId: null,
    month: "2026-08-01",
    amountMinor: 4_500,
    note: null,
    transferConfirmationId: null,
  });
  expect((await store.getContribution(c1.id))?.amountMinor).toBe(20_000);
  expect((await store.getContribution(c1.id))?.note).toBe("July");
  // Oldest first, and the month filter narrows to one month.
  expect((await store.listContributionsForAccount(account.id)).map((c) => c.id)).toEqual([
    c1.id,
    c2.id,
    c3.id,
  ]);
  expect(
    (await store.listContributionsForAccount(account.id, "2026-08-01")).map((c) => c.id),
  ).toEqual([c2.id, c3.id]);
  expect((await store.listContributionsForAccount(account.id, "2026-09-01")).length).toBe(0);

  // All-time totals per payment drive the derived already-saved.
  const totals = new Map(
    (await store.sumContributionsByPayment(account.id)).map((t) => [t.paymentId, t.totalMinor]),
  );
  expect(totals.get(p1.id)).toBe(50_000);
  expect(totals.get(p2.id)).toBe(4_500);

  await store.deleteContribution(c2.id);
  expect(await store.getContribution(c2.id)).toBeNull();
  const afterDelete = new Map(
    (await store.sumContributionsByPayment(account.id)).map((t) => [t.paymentId, t.totalMinor]),
  );
  expect(afterDelete.get(p1.id)).toBe(20_000);

  // --- balance snapshots ---
  const b1 = await store.upsertBalanceSnapshot({
    accountId: account.id,
    asOfDate: "2026-08-01",
    balanceMinor: 125_000,
  });
  await store.upsertBalanceSnapshot({
    accountId: account.id,
    asOfDate: "2026-07-01",
    balanceMinor: -2_500, // overdrafts are legal
  });
  // Re-stating a day overwrites that day's row rather than stacking another.
  const restated = await store.upsertBalanceSnapshot({
    accountId: account.id,
    asOfDate: "2026-08-01",
    balanceMinor: 130_000,
  });
  expect(restated.id).toBe(b1.id);
  const balances = await store.listBalanceSnapshots(account.id);
  expect(balances.map((b) => b.asOfDate)).toEqual(["2026-07-01", "2026-08-01"]);
  expect(balances.map((b) => b.balanceMinor)).toEqual([-2_500, 130_000]);

  // --- transfer confirmations ---
  const currentAccount = await store.createAccount({
    ownerUserId: user.id,
    name: "Current",
    currency: "GBP",
  });
  const confirmationInput = {
    householdId: household.id,
    month: "2026-08-01",
    fromAccountId: currentAccount.id,
    toAccountId: account.id,
    memberUserId: user.id,
    amountMinor: 66_000,
  };
  const confirmation = await store.createTransferConfirmation(confirmationInput);
  expect((await store.getTransferConfirmation(confirmation.id))?.amountMinor).toBe(66_000);
  expect(
    (await store.listTransferConfirmations(household.id, "2026-08-01")).map((t) => t.id),
  ).toEqual([confirmation.id]);
  expect((await store.listTransferConfirmations(household.id, "2026-09-01")).length).toBe(0);
  // The same transfer can only be confirmed once per month.
  await expect(store.createTransferConfirmation(confirmationInput)).rejects.toThrow();

  // Contributions a confirmation created die with it.
  const linked = await store.createContribution({
    paymentId: p2.id,
    accountId: account.id,
    userId: user.id,
    month: "2026-08-01",
    amountMinor: 66_000,
    note: null,
    transferConfirmationId: confirmation.id,
  });
  await store.deleteTransferConfirmation(confirmation.id);
  expect(await store.getTransferConfirmation(confirmation.id)).toBeNull();
  expect(await store.getContribution(linked.id)).toBeNull();
  expect(await store.getContribution(c3.id)).not.toBeNull(); // unlinked ones survive

  // --- month closes ---
  const julyClose = await store.createMonthClose({
    householdId: household.id,
    accountId: null,
    month: "2026-07-01",
    incomeMinor: 500_000,
    plannedMinor: 120_000,
    contributedMinor: 100_000,
    closedBy: user.id,
  });
  expect((await store.getMonthCloseById(julyClose.id))?.contributedMinor).toBe(100_000);
  expect((await store.getMonthClose({ householdId: household.id }, "2026-07-01"))?.id).toBe(
    julyClose.id,
  );
  expect(await store.getMonthClose({ householdId: household.id }, "2026-06-01")).toBeNull();
  await store.createMonthClose({
    householdId: household.id,
    accountId: null,
    month: "2026-08-01",
    incomeMinor: 500_000,
    plannedMinor: 130_000,
    contributedMinor: 130_000,
    closedBy: user.id,
  });
  // Newest month first.
  expect((await store.listMonthCloses({ householdId: household.id })).map((c) => c.month)).toEqual([
    "2026-08-01",
    "2026-07-01",
  ]);
  // A month can only be closed once per scope.
  await expect(
    store.createMonthClose({
      householdId: household.id,
      accountId: null,
      month: "2026-07-01",
      incomeMinor: 1,
      plannedMinor: 1,
      contributedMinor: 1,
      closedBy: user.id,
    }),
  ).rejects.toThrow();
  // Account-scoped closes are tracked separately from household ones.
  const accountClose = await store.createMonthClose({
    householdId: null,
    accountId: account.id,
    month: "2026-07-01",
    incomeMinor: 320_000,
    plannedMinor: 15_000,
    contributedMinor: 20_000,
    closedBy: user.id,
  });
  expect((await store.listMonthCloses({ accountId: account.id })).map((c) => c.id)).toEqual([
    accountClose.id,
  ]);
  await store.deleteMonthClose(accountClose.id);
  expect(await store.getMonthCloseById(accountClose.id)).toBeNull();

  // --- deleting an account clears everything hanging off it ---
  const doomedAccount = await store.createAccount({
    ownerUserId: user.id,
    name: "Doomed",
    currency: "GBP",
  });
  const doomedPayment = await store.createPayment({
    accountId: doomedAccount.id,
    name: "Gym",
    category: "monthly_recurring",
    amountMinor: 3_000,
    dueDate: null,
    recurrence: null,
    targetDate: null,
    priority: 20,
    alreadySavedMinor: 0,
    autoRenew: true,
    active: true,
    notes: null,
    projectId: null,
    scope: "personal",
    bearerUserId: user.id,
  });
  const doomedContribution = await store.createContribution({
    paymentId: doomedPayment.id,
    accountId: doomedAccount.id,
    userId: user.id,
    month: "2026-08-01",
    amountMinor: 3_000,
    note: null,
    transferConfirmationId: null,
  });
  await store.upsertBalanceSnapshot({
    accountId: doomedAccount.id,
    asOfDate: "2026-08-01",
    balanceMinor: 5_000,
  });
  const doomedConfirmation = await store.createTransferConfirmation({
    householdId: household.id,
    month: "2026-08-01",
    fromAccountId: doomedAccount.id,
    toAccountId: account.id,
    memberUserId: user.id,
    amountMinor: 3_000,
  });
  const doomedClose = await store.createMonthClose({
    householdId: null,
    accountId: doomedAccount.id,
    month: "2026-06-01",
    incomeMinor: 0,
    plannedMinor: 3_000,
    contributedMinor: 3_000,
    closedBy: user.id,
  });
  await store.deleteAccount(doomedAccount.id);
  expect(await store.getContribution(doomedContribution.id)).toBeNull();
  expect((await store.listBalanceSnapshots(doomedAccount.id)).length).toBe(0);
  expect(await store.getTransferConfirmation(doomedConfirmation.id)).toBeNull();
  expect(await store.getMonthCloseById(doomedClose.id)).toBeNull();

  // --- deleting a household clears its confirmations (and their contributions) ---
  const doomedHousehold = await store.createHousehold("Doomed", user.id);
  const householdConfirmation = await store.createTransferConfirmation({
    householdId: doomedHousehold.id,
    month: "2026-08-01",
    fromAccountId: currentAccount.id,
    toAccountId: account.id,
    memberUserId: user.id,
    amountMinor: 12_000,
  });
  const householdContribution = await store.createContribution({
    paymentId: p2.id,
    accountId: account.id,
    userId: user.id,
    month: "2026-08-01",
    amountMinor: 12_000,
    note: null,
    transferConfirmationId: householdConfirmation.id,
  });
  const householdClose = await store.createMonthClose({
    householdId: doomedHousehold.id,
    accountId: null,
    month: "2026-08-01",
    incomeMinor: 12_000,
    plannedMinor: 12_000,
    contributedMinor: 12_000,
    closedBy: user.id,
  });
  await store.deleteHousehold(doomedHousehold.id);
  expect(await store.getTransferConfirmation(householdConfirmation.id)).toBeNull();
  expect(await store.getContribution(householdContribution.id)).toBeNull();
  expect(await store.getMonthCloseById(householdClose.id)).toBeNull();

  // --- delete cascade ---
  await store.deletePayment(p1.id);
  expect((await store.listPayments(account.id)).length).toBe(1);
  expect(await store.getContribution(c1.id)).toBeNull(); // its contributions go too
}
