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

  // --- digest opt-in: off until asked for, and listable once on ---
  expect(user.notifyEmail).toBe(false);
  expect((await store.listUsersWithNotifications()).map((u) => u.id)).not.toContain(user.id);
  await store.setUserNotifyEmail(user.id, true);
  expect((await store.getUserById(user.id))?.notifyEmail).toBe(true);
  expect((await store.listUsersWithNotifications()).map((u) => u.id)).toEqual([user.id]);
  await store.setUserNotifyEmail(user.id, false);
  expect(await store.listUsersWithNotifications()).toEqual([]);

  // --- notification log: one claim per (user, day, kind) ---
  expect(await store.tryLogNotification(user.id, "2026-08-04", "daily_digest")).toBe(true);
  expect(await store.tryLogNotification(user.id, "2026-08-04", "daily_digest")).toBe(false);
  expect(await store.tryLogNotification(user.id, "2026-08-05", "daily_digest")).toBe(true);
  expect(await store.tryLogNotification(user.id, "2026-08-04", "weekly_digest")).toBe(true);
  expect(await store.tryLogNotification(federated.id, "2026-08-04", "daily_digest")).toBe(true);

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

  // --- inflows: money arriving, with a source ---
  // An income *is* an external inflow. Same row, same id, seen two ways —
  // there is no second table behind the income API.
  const asInflow = await store.getInflow(income.id);
  expect(asInflow?.source).toBe("external");
  expect(asInflow?.sourceAccountId).toBeNull();
  expect(asInflow?.amountMinor).toBe(320_000);
  expect((await store.listInflows(account.id)).map((i) => i.id)).toEqual([income.id]);

  const pot = await store.createAccount({
    ownerUserId: user.id,
    name: "Bills pot",
    currency: "GBP",
  });
  const topUp = await store.createInflow({
    accountId: pot.id,
    name: "Monthly top-up",
    source: "account",
    sourceAccountId: account.id,
    amountMinor: 50_000,
    frequency: "monthly",
    recurrence: null,
    anchorDate: "2026-01-28",
    priority: 50,
    active: true,
  });
  // One authored row, read from both ends: arriving on the pot, leaving the
  // account that sends it. Never two records that could drift apart.
  expect((await store.listInflows(pot.id)).map((i) => i.id)).toEqual([topUp.id]);
  expect((await store.listOutboundInflows(account.id)).map((i) => i.id)).toEqual([topUp.id]);
  expect((await store.listOutboundInflows(pot.id)).length).toBe(0);
  // The sending account is not also a receiving one.
  expect((await store.listInflows(account.id)).map((i) => i.id)).toEqual([income.id]);

  // The income API cannot reach it. Money out of another account you own is not
  // income, so nothing that speaks income may read, edit or delete one.
  expect(await store.getIncome(topUp.id)).toBeNull();
  expect(await store.updateIncome(topUp.id, { amountMinor: 1 })).toBeNull();
  await store.deleteIncome(topUp.id);
  expect(await store.getInflow(topUp.id)).not.toBeNull();
  expect((await store.listIncomes(pot.id)).length).toBe(0);

  // Outbound order is the sending account's service order: priority, oldest first.
  const isaTopUp = await store.createInflow({
    accountId: pot.id,
    name: "ISA sweep",
    source: "account",
    sourceAccountId: account.id,
    amountMinor: 10_000,
    frequency: "monthly",
    recurrence: null,
    anchorDate: "2026-01-28",
    priority: 10,
    active: true,
  });
  expect((await store.listOutboundInflows(account.id)).map((i) => i.id)).toEqual([
    isaTopUp.id,
    topUp.id,
  ]);

  // The three rules the table's CHECK constraints enforce, enforced by the
  // store too, so both implementations refuse identically.
  const wellFormed = {
    accountId: pot.id,
    name: "Bad",
    amountMinor: 1_000,
    frequency: "monthly" as const,
    recurrence: null,
    anchorDate: "2026-01-28",
    priority: 100,
    active: true,
  };
  // source = 'account' with nothing to source from
  await expect(
    store.createInflow({ ...wellFormed, source: "account", sourceAccountId: null }),
  ).rejects.toThrow();
  // source = 'external' carrying a source account anyway
  await expect(
    store.createInflow({ ...wellFormed, source: "external", sourceAccountId: account.id }),
  ).rejects.toThrow();
  // an account funding itself — money arriving out of nowhere
  await expect(
    store.createInflow({ ...wellFormed, source: "account", sourceAccountId: pot.id }),
  ).rejects.toThrow();
  // A patch is judged on the row it produces, not on itself: flipping `source`
  // alone would strand a source account on an external inflow.
  await expect(store.updateInflow(topUp.id, { source: "external" })).rejects.toThrow();
  expect((await store.getInflow(topUp.id))?.source).toBe("account");

  const repriced = await store.updateInflow(topUp.id, { amountMinor: 60_000 });
  expect(repriced?.amountMinor).toBe(60_000);
  expect(
    await store.updateInflow("00000000-0000-0000-0000-000000000000", { amountMinor: 1 }),
  ).toBeNull();
  await store.deleteInflow(isaTopUp.id);
  expect(await store.getInflow(isaTopUp.id)).toBeNull();

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
    fixedMonthlyMinor: 20_000,
    tag: "travel",
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
    fixedMonthlyMinor: null,
    tag: null,
  });
  expect((await store.listPayments(account.id)).length).toBe(2);

  // Contribution-first pace + grouping tag survive the round trip, and both are
  // optional (a plain bill carries neither).
  const storedGoal = await store.getPayment(p1.id);
  expect(storedGoal?.fixedMonthlyMinor).toBe(20_000);
  expect(storedGoal?.tag).toBe("travel");
  const storedBill = await store.getPayment(p2.id);
  expect(storedBill?.fixedMonthlyMinor).toBeNull();
  expect(storedBill?.tag).toBeNull();

  // …and both are patchable, including back to null.
  const retagged = await store.updatePayment(p2.id, { tag: "phone", fixedMonthlyMinor: 5_000 });
  expect(retagged?.tag).toBe("phone");
  expect(retagged?.fixedMonthlyMinor).toBe(5_000);
  const untagged = await store.updatePayment(p2.id, { tag: null, fixedMonthlyMinor: null });
  expect(untagged?.tag).toBeNull();
  expect(untagged?.fixedMonthlyMinor).toBeNull();

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
    inflowId: null,
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

  // --- standalone confirmations: "I moved the money", with no household ---
  // `topUp` is an authored movement out of `account` into `pot`. Nothing about
  // recording that it happened involves a household.
  const movedInput = {
    householdId: null,
    inflowId: topUp.id,
    month: "2026-08-01",
    fromAccountId: account.id,
    toAccountId: pot.id,
    memberUserId: user.id,
    amountMinor: 50_000,
  };
  const moved = await store.createTransferConfirmation(movedInput);
  expect((await store.getTransferConfirmation(moved.id))?.householdId).toBeNull();
  // Read from both ends — arriving in the pot, leaving the account that sends it.
  expect(
    (await store.listTransferConfirmationsForAccount(pot.id, "2026-08-01")).map((t) => t.id),
  ).toEqual([moved.id]);
  expect(
    (await store.listTransferConfirmationsForAccount(account.id, "2026-08-01")).map((t) => t.id),
  ).toEqual([moved.id]);
  expect((await store.listTransferConfirmationsForAccount(pot.id, "2026-09-01")).length).toBe(0);
  // The household confirmation above lands on `account` too, and is deliberately
  // not in that list: it confirms a derived transfer, not an authored inflow.
  expect(await store.listTransferConfirmations(household.id, "2026-08-01")).toHaveLength(1);
  // One movement, one confirmation a month — the hole a plain UNIQUE leaves over
  // NULL household ids.
  await expect(store.createTransferConfirmation(movedInput)).rejects.toThrow();
  // A different month is a different movement.
  const movedSeptember = await store.createTransferConfirmation({
    ...movedInput,
    month: "2026-09-01",
  });
  await store.deleteTransferConfirmation(movedSeptember.id);

  // Deleting the inflow takes the confirmation of it — and that confirmation's
  // contributions — with it. Uses its own movement so `topUp` survives.
  const doomedMovement = await store.createInflow({
    accountId: currentAccount.id,
    name: "Doomed movement",
    source: "account",
    sourceAccountId: account.id,
    amountMinor: 1_000,
    frequency: "monthly",
    recurrence: null,
    anchorDate: "2026-08-01",
    priority: 100,
    active: true,
  });
  const doomedMovementConfirmation = await store.createTransferConfirmation({
    householdId: null,
    inflowId: doomedMovement.id,
    month: "2026-08-01",
    fromAccountId: account.id,
    toAccountId: currentAccount.id,
    memberUserId: user.id,
    amountMinor: 1_000,
  });
  const doomedMovementContribution = await store.createContribution({
    paymentId: p2.id,
    accountId: account.id,
    userId: user.id,
    month: "2026-08-01",
    amountMinor: 1_000,
    note: null,
    transferConfirmationId: doomedMovementConfirmation.id,
  });
  await store.deleteInflow(doomedMovement.id);
  expect(await store.getTransferConfirmation(doomedMovementConfirmation.id)).toBeNull();
  expect(await store.getContribution(doomedMovementContribution.id)).toBeNull();
  // The household confirmation is untouched by any of it.
  expect(await store.getTransferConfirmation(confirmation.id)).not.toBeNull();

  // Un-confirming a standalone movement cleans up its contributions, exactly as
  // the household path does.
  const movedContribution = await store.createContribution({
    paymentId: p2.id,
    accountId: account.id,
    userId: user.id,
    month: "2026-08-01",
    amountMinor: 50_000,
    note: null,
    transferConfirmationId: moved.id,
  });
  await store.deleteTransferConfirmation(moved.id);
  expect(await store.getTransferConfirmation(moved.id)).toBeNull();
  expect(await store.getContribution(movedContribution.id)).toBeNull();
  expect((await store.listTransferConfirmationsForAccount(pot.id, "2026-08-01")).length).toBe(0);

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
    fixedMonthlyMinor: null,
    tag: "fitness",
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
    inflowId: null,
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
  // An inflow arriving elsewhere *out of* the doomed account: it must die with
  // it. A movement cannot outlive the account it comes out of, and the
  // receiving account must not be left planning money nothing sends.
  const doomedOutbound = await store.createInflow({
    accountId: pot.id,
    name: "From the doomed account",
    source: "account",
    sourceAccountId: doomedAccount.id,
    amountMinor: 7_000,
    frequency: "monthly",
    recurrence: null,
    anchorDate: "2026-08-01",
    priority: 100,
    active: true,
  });
  await store.deleteAccount(doomedAccount.id);
  expect(await store.getContribution(doomedContribution.id)).toBeNull();
  expect((await store.listBalanceSnapshots(doomedAccount.id)).length).toBe(0);
  expect(await store.getTransferConfirmation(doomedConfirmation.id)).toBeNull();
  expect(await store.getMonthCloseById(doomedClose.id)).toBeNull();
  expect(await store.getInflow(doomedOutbound.id)).toBeNull();
  expect((await store.listInflows(pot.id)).map((i) => i.id)).toEqual([topUp.id]);

  // --- deleting a household clears its confirmations (and their contributions) ---
  const doomedHousehold = await store.createHousehold("Doomed", user.id);
  const householdConfirmation = await store.createTransferConfirmation({
    householdId: doomedHousehold.id,
    inflowId: null,
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

  // --- erasure: everything of the user's own, and nothing of anyone else's ---
  const leaver = await store.createUser({
    email: "leaver@example.com",
    passwordHash: "hash",
    displayName: "Leaver",
  });
  const leaverAccount = await store.createAccount({
    ownerUserId: leaver.id,
    name: "Leaver Current",
    currency: "GBP",
  });
  const leaverPayment = await store.createPayment({
    accountId: leaverAccount.id,
    name: "Gym",
    category: "monthly_recurring",
    amountMinor: 3_000,
    dueDate: null,
    recurrence: null,
    targetDate: null,
    priority: 10,
    alreadySavedMinor: 0,
    autoRenew: true,
    active: true,
    notes: null,
    projectId: null,
    scope: "personal",
    bearerUserId: leaver.id,
    fixedMonthlyMinor: null,
    tag: null,
  });
  const leaverContribution = await store.createContribution({
    paymentId: leaverPayment.id,
    accountId: leaverAccount.id,
    userId: leaver.id,
    month: "2026-08-01",
    amountMinor: 3_000,
    note: null,
    transferConfirmationId: null,
  });
  const leaverProject = await store.createProject({
    ownerUserId: leaver.id,
    name: "Leaver project",
    description: null,
    color: null,
    targetDate: null,
  });
  const leaverClose = await store.createMonthClose({
    householdId: null,
    accountId: leaverAccount.id,
    month: "2026-07-01",
    incomeMinor: 0,
    plannedMinor: 3_000,
    contributedMinor: 3_000,
    closedBy: leaver.id,
  });
  // A household they founded, and one they merely joined.
  const foundedHousehold = await store.createHousehold("Leaver's place", leaver.id);
  const joinedHousehold = await store.createHousehold("Someone else's place", user.id);
  await store.addMembership(joinedHousehold.id, leaver.id, "member");
  // An account of someone else's, shared into the household they joined: it must
  // survive, because it belongs to its owner.
  await store.createAccountShare(account.id, joinedHousehold.id, "view");
  expect(await store.getAccess(leaver.id, account.id)).not.toBeNull();
  // Credentials + session state.
  const leaverSession = await store.createSession({
    userId: leaver.id,
    refreshTokenHash: "leaver-refresh",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  await store.createEmailVerificationToken({
    token: "leaver-verify",
    userId: leaver.id,
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  await store.createPasswordResetToken({
    token: "leaver-reset",
    userId: leaver.id,
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  await store.replaceRecoveryCodes(leaver.id, ["leaver-code"]);
  await store.setUserNotifyEmail(leaver.id, true);
  await store.tryLogNotification(leaver.id, "2026-08-04", "daily_digest");

  await store.deleteUserCascade(leaver.id);

  expect(await store.getUserById(leaver.id)).toBeNull();
  expect(await store.getAccount(leaverAccount.id)).toBeNull();
  expect(await store.getPayment(leaverPayment.id)).toBeNull();
  expect(await store.getContribution(leaverContribution.id)).toBeNull();
  expect(await store.getProject(leaverProject.id)).toBeNull();
  expect(await store.getMonthCloseById(leaverClose.id)).toBeNull();
  expect(await store.getHousehold(foundedHousehold.id)).toBeNull();
  expect(await store.getMembership(joinedHousehold.id, leaver.id)).toBeNull();
  expect(await store.getSessionByTokenHash(leaverSession.refreshTokenHash)).toBeNull();
  expect(await store.consumeEmailVerificationToken("leaver-verify")).toBeNull();
  expect(await store.consumePasswordResetToken("leaver-reset")).toBeNull();
  expect(await store.listUnusedRecoveryCodes(leaver.id)).toEqual([]);
  expect((await store.listUsersWithNotifications()).map((u) => u.id)).not.toContain(leaver.id);
  // The other user's household and account are untouched.
  expect(await store.getHousehold(joinedHousehold.id)).not.toBeNull();
  expect(await store.getAccount(account.id)).not.toBeNull();
}
