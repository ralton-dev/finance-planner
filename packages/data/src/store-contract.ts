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

  // An account is denominated once, when it is created. `AccountPatch` has no
  // `currency` for a caller to pass, so both stores must leave the column where
  // it is under every patch they *can* be handed — and in Postgres the column
  // never reaches a SET clause, so `accounts_currency_is_fixed` (0012) never
  // fires on this path.
  const renamed = await store.updateAccount(account.id, { name: "Everyday spending" });
  expect(renamed?.name).toBe("Everyday spending");
  expect(renamed?.currency).toBe("GBP");
  await store.updateAccount(account.id, { name: "Everyday" });

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

  // --- a user belongs to exactly one household ---
  // The way into a second is out of the first, and the Store is the choke
  // point both services go through, so it is the Store that refuses.
  const joiner = await store.createUser({
    email: "joiner@example.com",
    passwordHash: "hash",
    displayName: "Joiner",
  });
  const elsewhere = await store.createHousehold("Elsewhere", joiner.id);
  await expect(store.addMembership(household.id, joiner.id, "member")).rejects.toThrow(
    /already belongs to a household/,
  );
  await expect(store.createHousehold("A third", joiner.id)).rejects.toThrow(
    /already belongs to a household/,
  );
  // Refused before the row is written: no orphan household is left behind.
  expect((await store.listHouseholdsForUser(joiner.id)).map((h) => h.id)).toEqual([elsewhere.id]);
  // Leaving is what lets them in.
  await store.removeMember(elsewhere.id, joiner.id);
  expect(await store.addMembership(household.id, joiner.id, "member")).toBeTruthy();
  await store.removeMember(household.id, joiner.id);

  // --- leaving dissolves what the household gave, and keeps what happened ---
  // The partner's own account, shared into the household and fed by a movement
  // out of the founder's — an arrangement that only exists because they are in
  // a household together.
  const partnerPot = await store.createAccount({
    ownerUserId: other.id,
    name: "Partner pot",
    currency: "GBP",
  });
  const partnerShare = await store.createAccountShare(partnerPot.id, household.id, "edit");
  await store.upsertAccountAssignment({
    householdId: household.id,
    accountId: partnerPot.id,
    role: "personal",
    memberUserId: other.id,
  });
  expect(await store.getAccountAssignment(household.id, partnerPot.id)).not.toBeNull();
  const crossMovement = await store.createInflow({
    accountId: partnerPot.id,
    name: "Top-up from the founder",
    source: "account",
    sourceAccountId: account.id,
    amountMinor: 20_000,
    frequency: "monthly",
    recurrence: null,
    anchorDate: "2026-08-01",
    priority: 50,
    active: true,
  });
  // In a month of its own, so it does not join the confirmation listings the
  // household's own assertions further down count row for row.
  const movedMoney = await store.createTransferConfirmation({
    householdId: household.id,
    inflowId: crossMovement.id,
    month: "2026-06-01",
    fromAccountId: account.id,
    toAccountId: partnerPot.id,
    memberUserId: other.id,
    amountMinor: 20_000,
  });

  await store.removeMember(household.id, other.id);

  // Gone: the membership, the access it carried, the plan role, the share.
  expect(await store.getMembership(household.id, other.id)).toBeNull();
  expect(await store.getAccess(other.id, account.id)).toBeNull();
  expect(await store.getAccountAssignment(household.id, partnerPot.id)).toBeNull();
  expect((await store.listSharesForHousehold(household.id)).map((s) => s.id)).not.toContain(
    partnerShare.id,
  );
  // Dissolved, not deleted: the movement stops claiming money — an inactive
  // inflow is not a funding edge — and the account itself is untouched.
  expect((await store.getInflow(crossMovement.id))?.active).toBe(false);
  expect(await store.getAccount(partnerPot.id)).not.toBeNull();
  // Retained: money that really moved still says so.
  expect(await store.getTransferConfirmation(movedMoney.id)).not.toBeNull();

  // deleting the household removes its shares and memberships
  const temper = await store.createUser({
    email: "temper@example.com",
    passwordHash: "hash",
    displayName: "Temper",
  });
  const tempHousehold = await store.createHousehold("Temp", temper.id);
  const tempAccount = await store.createAccount({
    ownerUserId: temper.id,
    name: "Temp",
    currency: "GBP",
  });
  await store.createAccountShare(tempAccount.id, tempHousehold.id, "view");
  expect((await store.listSharesForHousehold(tempHousehold.id)).length).toBe(1);
  await store.deleteHousehold(tempHousehold.id);
  expect(await store.getHousehold(tempHousehold.id)).toBeNull();
  expect((await store.listSharesForHousehold(tempHousehold.id)).length).toBe(0);
  expect((await store.listMembersForHousehold(tempHousehold.id)).length).toBe(0);
  // ...and the founder is free to join another one.
  expect(await store.addMembership(household.id, temper.id, "member")).toBeTruthy();
  await store.removeMember(household.id, temper.id);

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
  // Personal unless it says otherwise: what every project written before
  // 0014 existed reads back as, and what a caller who says nothing gets.
  expect(project.visibility).toBe("personal");
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

  // A recorded contribution is correctable: a mistyped amount is an edit, not a
  // delete and a re-record (decision 30). What is left unsaid is left alone.
  const amended = await store.updateContribution(c1.id, { amountMinor: 21_000 });
  expect(amended?.amountMinor).toBe(21_000);
  expect(amended?.month).toBe("2026-07-01");
  expect(amended?.note).toBe("July");
  // The derived already-saved moves with it, which is the point of editing.
  const afterPatch = new Map(
    (await store.sumContributionsByPayment(account.id)).map((t) => [t.paymentId, t.totalMinor]),
  );
  expect(afterPatch.get(p1.id)).toBe(21_000);
  // A null note is a note removed; a patch that says nothing changes nothing.
  expect(
    (await store.updateContribution(c1.id, { month: "2026-06-01", note: null }))?.note,
  ).toBeNull();
  const untouched = await store.updateContribution(c1.id, {});
  expect(untouched?.month).toBe("2026-06-01");
  expect(untouched?.amountMinor).toBe(21_000);
  // Nothing to correct reads back as nothing, not as a throw.
  expect(await store.updateContribution("00000000-0000-0000-0000-000000000000", {})).toBeNull();
  await store.updateContribution(c1.id, { month: "2026-07-01" }); // put July back

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

  // --- derived confirmations: a feed the plan worked out, with no household ---
  // An expense pot with no income of its own is fed by the plan rather than by
  // anything the user authored: no inflow row to point at, and no household
  // either. The row is scoped by what every row already carries — the two
  // accounts, the month, and whoever moved it.
  const derivedInput = {
    householdId: null,
    inflowId: null,
    month: "2026-08-01",
    fromAccountId: account.id,
    toAccountId: pot.id,
    memberUserId: user.id,
    amountMinor: 30_320,
  };
  const derived = await store.createTransferConfirmation(derivedInput);
  expect((await store.getTransferConfirmation(derived.id))?.householdId).toBeNull();
  expect((await store.getTransferConfirmation(derived.id))?.inflowId).toBeNull();
  // Read from both ends, like any other movement.
  expect(
    (await store.listDerivedTransferConfirmationsForAccount(pot.id, "2026-08-01")).map((t) => t.id),
  ).toEqual([derived.id]);
  expect(
    (await store.listDerivedTransferConfirmationsForAccount(account.id, "2026-08-01")).map(
      (t) => t.id,
    ),
  ).toEqual([derived.id]);
  expect(
    (await store.listDerivedTransferConfirmationsForAccount(pot.id, "2026-09-01")).length,
  ).toBe(0);
  // `moved` is an authored movement between these very same two accounts in the
  // same month. The two coexist and are read apart, because a feed the plan
  // derived and a movement someone authored are two different movements.
  expect(
    (await store.listTransferConfirmationsForAccount(pot.id, "2026-08-01")).map((t) => t.id),
  ).toEqual([moved.id]);
  // Nor does the derived row show up in the household's list.
  expect(await store.listTransferConfirmations(household.id, "2026-08-01")).toHaveLength(1);
  // One feed, one confirmation a month — the hole neither older unique key can
  // see, both of its scope columns being null.
  await expect(store.createTransferConfirmation(derivedInput)).rejects.toThrow();
  // A different destination, a different actor and a different month are each a
  // different movement.
  const derivedElsewhere = await store.createTransferConfirmation({
    ...derivedInput,
    toAccountId: currentAccount.id,
  });
  const derivedByAnother = await store.createTransferConfirmation({
    ...derivedInput,
    memberUserId: federated.id,
  });
  const derivedSeptember = await store.createTransferConfirmation({
    ...derivedInput,
    month: "2026-09-01",
  });
  expect(
    (await store.listDerivedTransferConfirmationsForAccount(account.id, "2026-08-01")).map(
      (t) => t.id,
    ),
  ).toEqual([derived.id, derivedElsewhere.id, derivedByAnother.id]);
  for (const spare of [derivedElsewhere, derivedByAnother, derivedSeptember]) {
    await store.deleteTransferConfirmation(spare.id);
  }

  // Un-confirming a derived feed cleans up its contributions, exactly as the
  // other two shapes do.
  const derivedContribution = await store.createContribution({
    paymentId: p2.id,
    accountId: account.id,
    userId: user.id,
    month: "2026-08-01",
    amountMinor: 30_320,
    note: null,
    transferConfirmationId: derived.id,
  });
  await store.deleteTransferConfirmation(derived.id);
  expect(await store.getTransferConfirmation(derived.id)).toBeNull();
  expect(await store.getContribution(derivedContribution.id)).toBeNull();
  expect(
    (await store.listDerivedTransferConfirmationsForAccount(pot.id, "2026-08-01")).length,
  ).toBe(0);

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

  // --- a movement and the rows it writes are one write ---
  // Un-confirming has always taken both halves. Writing them did not: the
  // confirm handlers created the confirmation and then appended contributions
  // one at a time, so a failure part-way left a confirmation standing over a
  // ledger that accounted for less than it claimed. This is the other half of
  // that cascade, and the only writer that stamps `transferConfirmationId`.
  const octoberInput = {
    householdId: null,
    inflowId: null,
    month: "2026-10-01",
    fromAccountId: currentAccount.id,
    toAccountId: account.id,
    memberUserId: user.id,
    amountMinor: 24_500,
  };
  const slice = (paymentId: string, month: string, amountMinor: number) => ({
    paymentId,
    accountId: account.id,
    userId: user.id,
    month,
    amountMinor,
    note: null,
  });
  const october = await store.createTransferConfirmationWithContributions(octoberInput, [
    slice(p1.id, "2026-10-01", 20_000),
    slice(p2.id, "2026-10-01", 4_500),
  ]);
  expect(october.contributions).toHaveLength(2);
  // Stamped by the method: the caller never supplies the id, and so can never
  // supply one pointing at a different confirmation.
  expect(
    october.contributions.every((c) => c.transferConfirmationId === october.confirmation.id),
  ).toBe(true);
  // Compared as a set, not a sequence: written in one Postgres transaction these
  // rows share a `created_at` — `now()` is the transaction's clock — so their
  // order among themselves is not a fact either store promises.
  expect(
    (await store.listContributionsForAccount(account.id, "2026-10-01"))
      .map((c) => c.amountMinor)
      .sort((a, b) => a - b),
  ).toEqual([4_500, 20_000]);

  // The partial failure, which is the whole reason this method exists. The
  // confirmation is written, the first slice lands, and the second names a
  // payment that does not exist — the FK `contributions.payment_id` has carried
  // since 0004. Nothing survives it.
  const novemberInput = { ...octoberInput, month: "2026-11-01" };
  await expect(
    store.createTransferConfirmationWithContributions(novemberInput, [
      slice(p1.id, "2026-11-01", 20_000),
      slice("00000000-0000-0000-0000-000000000000", "2026-11-01", 4_500),
    ]),
  ).rejects.toThrow();
  expect(await store.listContributionsForAccount(account.id, "2026-11-01")).toEqual([]);
  expect(await store.listDerivedTransferConfirmationsForAccount(account.id, "2026-11-01")).toEqual(
    [],
  );
  // And the proof that the confirmation is really gone rather than merely
  // unlisted: November is still confirmable. A row left behind would be refused
  // by `transfer_confirmations_derived_month_unique`.
  const november = await store.createTransferConfirmationWithContributions(novemberInput, [
    slice(p1.id, "2026-11-01", 20_000),
  ]);
  expect(november.contributions).toHaveLength(1);
  // Un-confirming still takes both halves of what this wrote.
  await store.deleteTransferConfirmation(november.confirmation.id);
  expect(await store.getContribution(november.contributions[0]!.id)).toBeNull();

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

  // --- a close the person owns, one row per currency ---
  // Closing a month closes every currency partition the user holds at once, so
  // two rows for one month is the ordinary state and only a repeated partition
  // is a duplicate.
  const julyGbp = await store.createMonthClose({
    householdId: null,
    accountId: null,
    userId: user.id,
    currency: "GBP",
    month: "2026-07-01",
    incomeMinor: 400_000,
    plannedMinor: 90_000,
    contributedMinor: 85_000,
    closedBy: user.id,
  });
  const julyEur = await store.createMonthClose({
    householdId: null,
    accountId: null,
    userId: user.id,
    currency: "EUR",
    month: "2026-07-01",
    incomeMinor: 20_000,
    plannedMinor: 5_000,
    contributedMinor: 5_000,
    closedBy: user.id,
  });
  expect((await store.getMonthCloseById(julyGbp.id))?.currency).toBe("GBP");
  // Named, it answers about that partition…
  expect((await store.getMonthClose({ userId: user.id, currency: "GBP" }, "2026-07-01"))?.id).toBe(
    julyGbp.id,
  );
  // …unnamed, it answers "is this month closed for me at all", the same way
  // every time: the lowest currency code's row.
  expect((await store.getMonthClose({ userId: user.id }, "2026-07-01"))?.id).toBe(julyEur.id);
  expect(await store.getMonthClose({ userId: user.id }, "2026-06-01")).toBeNull();
  await store.createMonthClose({
    householdId: null,
    accountId: null,
    userId: user.id,
    currency: "GBP",
    month: "2026-08-01",
    incomeMinor: 400_000,
    plannedMinor: 95_000,
    contributedMinor: 95_000,
    closedBy: user.id,
  });
  // Newest month first, currency ascending inside a month.
  expect(
    (await store.listMonthCloses({ userId: user.id })).map((c) => [c.month, c.currency]),
  ).toEqual([
    ["2026-08-01", "GBP"],
    ["2026-07-01", "EUR"],
    ["2026-07-01", "GBP"],
  ]);
  expect(
    (await store.listMonthCloses({ userId: user.id, currency: "EUR" })).map((c) => c.id),
  ).toEqual([julyEur.id]);
  // The same partition twice is the duplicate to refuse — and the only one.
  await expect(
    store.createMonthClose({
      householdId: null,
      accountId: null,
      userId: user.id,
      currency: "GBP",
      month: "2026-07-01",
      incomeMinor: 1,
      plannedMinor: 1,
      contributedMinor: 1,
      closedBy: user.id,
    }),
  ).rejects.toThrow();
  // A close scoped to a person has to name the partition it scored.
  await expect(
    store.createMonthClose({
      householdId: null,
      accountId: null,
      userId: user.id,
      currency: null,
      month: "2026-09-01",
      incomeMinor: 1,
      plannedMinor: 1,
      contributedMinor: 1,
      closedBy: user.id,
    }),
  ).rejects.toThrow();
  // The three scopes are filed apart: neither location list has grown, and the
  // person's list holds nothing of theirs.
  expect((await store.listMonthCloses({ householdId: household.id })).map((c) => c.month)).toEqual([
    "2026-08-01",
    "2026-07-01",
  ]);
  expect(await store.listMonthCloses({ accountId: account.id })).toEqual([]);
  expect(
    (await store.listMonthCloses({ userId: user.id })).every((c) => c.userId === user.id),
  ).toBe(true);
  await store.deleteMonthClose(julyEur.id);
  expect(await store.getMonthCloseById(julyEur.id)).toBeNull();

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
  // What the confirmation booked, and it does *not* sit on the doomed account:
  // a transfer's contributions land against the payments it funded, which are
  // on the receiving one. Deleting the account must take them with it, or a
  // payment reads as part-saved by a transfer that can no longer be made.
  const doomedLinkedContribution = await store.createContribution({
    paymentId: p2.id,
    accountId: account.id,
    userId: user.id,
    month: "2026-08-01",
    amountMinor: 3_000,
    note: null,
    transferConfirmationId: doomedConfirmation.id,
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
  // And the contribution that confirmation booked on the *other* account, which
  // no sweep over `accountId` would have reached.
  expect(await store.getContribution(doomedLinkedContribution.id)).toBeNull();
  expect(await store.getMonthCloseById(doomedClose.id)).toBeNull();
  expect(await store.getInflow(doomedOutbound.id)).toBeNull();
  expect((await store.listInflows(pot.id)).map((i) => i.id)).toEqual([topUp.id]);

  // --- deleting a household clears its confirmations (and their contributions) ---
  // Founded by somebody with no household of their own: `user` already has
  // one, and a user belongs to exactly one.
  const doomer = await store.createUser({
    email: "doomer@example.com",
    passwordHash: "hash",
    displayName: "Doomer",
  });
  const doomedHousehold = await store.createHousehold("Doomed", doomer.id);
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
  // Scoped to the person rather than to any account of theirs, so nothing else
  // being erased below can carry it away.
  const leaverOwnClose = await store.createMonthClose({
    householdId: null,
    accountId: null,
    userId: leaver.id,
    currency: "GBP",
    month: "2026-07-01",
    incomeMinor: 0,
    plannedMinor: 3_000,
    contributedMinor: 3_000,
    closedBy: leaver.id,
  });
  // Somebody else's household, which they merely joined — `user`'s, the one
  // `account` is already shared into. It used to be a household they founded
  // *and* one they joined; a user belongs to exactly one now, so the founded
  // case is erased on its own below.
  const joinedHousehold = household;
  await store.addMembership(joinedHousehold.id, leaver.id, "member");
  // An account of someone else's, shared into the household they joined: it must
  // survive, because it belongs to its owner.
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
  expect(await store.getMonthCloseById(leaverOwnClose.id)).toBeNull();
  expect(await store.getMembership(joinedHousehold.id, leaver.id)).toBeNull();
  expect(await store.getSessionByTokenHash(leaverSession.refreshTokenHash)).toBeNull();
  expect(await store.consumeEmailVerificationToken("leaver-verify")).toBeNull();
  expect(await store.consumePasswordResetToken("leaver-reset")).toBeNull();
  expect(await store.listUnusedRecoveryCodes(leaver.id)).toEqual([]);
  expect((await store.listUsersWithNotifications()).map((u) => u.id)).not.toContain(leaver.id);
  // The other user's household and account are untouched.
  expect(await store.getHousehold(joinedHousehold.id)).not.toBeNull();
  expect(await store.getAccount(account.id)).not.toBeNull();

  // The other half of erasure, which used to ride on the same user: a
  // household you *founded* goes with you, and takes its memberships with it.
  const founder = await store.createUser({
    email: "founder@example.com",
    passwordHash: "hash",
    displayName: "Founder",
  });
  const guest = await store.createUser({
    email: "guest@example.com",
    passwordHash: "hash",
    displayName: "Guest",
  });
  const foundedHousehold = await store.createHousehold("Founder's place", founder.id);
  await store.addMembership(foundedHousehold.id, guest.id, "member");
  await store.deleteUserCascade(founder.id);
  expect(await store.getHousehold(foundedHousehold.id)).toBeNull();
  expect(await store.getMembership(foundedHousehold.id, guest.id)).toBeNull();
  // The guest survives their household's founder, and is free to join another.
  expect(await store.getUserById(guest.id)).not.toBeNull();
  expect(await store.listHouseholdsForUser(guest.id)).toEqual([]);

  await exerciseSharedProjects(store);
}

/**
 * A project is personal or shared, and the two rules that follow from it
 * (MINE-AND-OURS decision 23) — the asymmetric one, and the one that runs the
 * other way.
 *
 * Every cast below is a **household of two**, never a lone user: the shape that
 * once let five field-by-field audits miss a live defect, and the only shape in
 * which either rule says anything at all.
 */
async function exerciseSharedProjects(store: Store): Promise<void> {
  let seq = 0;
  const person = (name: string) =>
    store.createUser({
      email: `${name}-${(seq += 1)}@shared-projects.example.com`,
      passwordHash: "hash",
      displayName: name,
    });
  const payment = (accountId: string, name: string, projectId: string | null) =>
    store.createPayment({
      accountId,
      name,
      category: "monthly_recurring",
      amountMinor: 1_000,
      dueDate: null,
      recurrence: null,
      targetDate: null,
      priority: 100,
      alreadySavedMinor: 0,
      autoRenew: true,
      active: true,
      notes: null,
      projectId,
      scope: "shared",
      bearerUserId: null,
      fixedMonthlyMinor: null,
      tag: null,
    });
  const projectOf = async (paymentId: string) => (await store.getPayment(paymentId))?.projectId;
  const visibilityOf = async (projectId: string) => (await store.getProject(projectId))?.visibility;

  // ---- who can see a shared project ----
  // Two in a household, one outside it. `outsider` is in no household at all,
  // which is also the case that proves membership is read rather than stored:
  // there is nothing to match against.
  const alice = await person("alice");
  const bob = await person("bob");
  const outsider = await person("outsider");
  const h1 = await store.createHousehold("Flat 1", alice.id);
  await store.addMembership(h1.id, bob.id, "member");

  const aliceAcc = await store.createAccount({
    ownerUserId: alice.id,
    name: "Alice Current",
    currency: "GBP",
  });
  const bobAcc = await store.createAccount({
    ownerUserId: bob.id,
    name: "Bob Current",
    currency: "GBP",
  });
  await store.createAccountShare(aliceAcc.id, h1.id, "edit");
  const bobShare = await store.createAccountShare(bobAcc.id, h1.id, "edit");

  const joint = await store.createProject({
    ownerUserId: alice.id,
    name: "Kitchen",
    description: null,
    color: null,
    targetDate: null,
    visibility: "shared",
  });
  const solo = await store.createProject({
    ownerUserId: alice.id,
    name: "Alice's surprise",
    description: null,
    color: null,
    targetDate: null,
  });
  const bobSolo = await store.createProject({
    ownerUserId: bob.id,
    name: "Bob's surprise",
    description: null,
    color: null,
    targetDate: null,
  });
  expect(solo.visibility).toBe("personal");

  const aliceInJoint = await payment(aliceAcc.id, "Worktop", joint.id);
  const bobInJoint = await payment(bobAcc.id, "Sink", joint.id);
  const bobInSolo = await payment(bobAcc.id, "Present", bobSolo.id);

  const seen = async (userId: string) =>
    (await store.listProjectsForUser(userId)).map((p) => p.id).sort();
  // A co-member sees the shared one and neither personal one; a stranger sees
  // nothing of either of theirs.
  expect(await seen(bob.id)).toEqual([bobSolo.id, joint.id].sort());
  expect(await seen(alice.id)).toEqual([joint.id, solo.id].sort());
  expect(await seen(outsider.id)).toEqual([]);
  // `listProjectsForOwner` still answers its own, different question: what do I
  // own. It is what a backup asks (`apps/api/src/portability.ts:211`), and a
  // backup must not carry a co-member's shared project.
  expect((await store.listProjectsForOwner(bob.id)).map((p) => p.id)).toEqual([bobSolo.id]);

  // Flipping visibility is an ordinary patch, in both directions.
  expect((await store.updateProject(solo.id, { visibility: "shared" }))?.visibility).toBe("shared");
  expect(await seen(bob.id)).toEqual([bobSolo.id, joint.id, solo.id].sort());
  await store.updateProject(solo.id, { visibility: "personal" });
  expect(await seen(bob.id)).toEqual([bobSolo.id, joint.id].sort());

  // ---- the share that goes away ----
  // Bob's account leaves the household, so its payments leave every shared
  // project. His own personal project keeps its payment on the same account:
  // there is no leak to prevent in a project only he can read.
  await store.deleteAccountShare(bobShare.id);
  expect(await projectOf(bobInJoint.id)).toBeNull();
  expect(await projectOf(bobInSolo.id)).toBe(bobSolo.id);
  expect(await projectOf(aliceInJoint.id)).toBe(joint.id);
  // The payment itself is untouched — only its link went.
  expect((await store.getPayment(bobInJoint.id))?.name).toBe("Sink");

  // ---- the leaver keeps their projects, never the household's contents ----
  const carol = await person("carol");
  const dave = await person("dave");
  const h2 = await store.createHousehold("Flat 2", carol.id);
  await store.addMembership(h2.id, dave.id, "member");
  const carolAcc = await store.createAccount({
    ownerUserId: carol.id,
    name: "Carol Current",
    currency: "GBP",
  });
  const daveAcc = await store.createAccount({
    ownerUserId: dave.id,
    name: "Dave Current",
    currency: "GBP",
  });
  await store.createAccountShare(carolAcc.id, h2.id, "edit");
  await store.createAccountShare(daveAcc.id, h2.id, "edit");
  const carolShared = await store.createProject({
    ownerUserId: carol.id,
    name: "Bathroom",
    description: null,
    color: null,
    targetDate: null,
    visibility: "shared",
  });
  const carolsOwn = await payment(carolAcc.id, "Tiles", carolShared.id);
  const davesInHers = await payment(daveAcc.id, "Taps", carolShared.id);

  await store.removeMember(h2.id, carol.id);

  // The project is hers and stays hers — flipped personal, because "shared"
  // resolves through a membership she no longer has, and a household she later
  // joins must not inherit it still claiming to be shared.
  expect(await visibilityOf(carolShared.id)).toBe("personal");
  // Dave's payment is gone from it: an ex-member keeps no window into the
  // household's money, names or amounts.
  expect(await projectOf(davesInHers.id)).toBeNull();
  // And her own payment on her own account survives in it — which is what
  // "you keep your projects" has to mean to mean anything, and what the
  // ordering inside the cascade exists to protect.
  expect(await projectOf(carolsOwn.id)).toBe(carolShared.id);
  // It is nobody else's to see any more.
  expect(await seen(dave.id)).toEqual([]);
  expect((await store.listSharesForAccount(carolAcc.id)).length).toBe(0);

  // ---- and the same, per member, when the household itself goes ----
  const erin = await person("erin");
  const frank = await person("frank");
  const h3 = await store.createHousehold("Flat 3", erin.id);
  await store.addMembership(h3.id, frank.id, "member");
  const erinAcc = await store.createAccount({
    ownerUserId: erin.id,
    name: "Erin Current",
    currency: "GBP",
  });
  const frankAcc = await store.createAccount({
    ownerUserId: frank.id,
    name: "Frank Current",
    currency: "GBP",
  });
  await store.createAccountShare(erinAcc.id, h3.id, "edit");
  await store.createAccountShare(frankAcc.id, h3.id, "edit");
  const erinShared = await store.createProject({
    ownerUserId: erin.id,
    name: "Garden",
    description: null,
    color: null,
    targetDate: null,
    visibility: "shared",
  });
  const frankSolo = await store.createProject({
    ownerUserId: frank.id,
    name: "Frank's shed",
    description: null,
    color: null,
    targetDate: null,
  });
  const erinsOwn = await payment(erinAcc.id, "Turf", erinShared.id);
  const franksInHers = await payment(frankAcc.id, "Fence", erinShared.id);
  const franksOwn = await payment(frankAcc.id, "Shelving", frankSolo.id);

  await store.deleteHousehold(h3.id);

  expect(await visibilityOf(erinShared.id)).toBe("personal");
  expect(await projectOf(franksInHers.id)).toBeNull();
  expect(await projectOf(erinsOwn.id)).toBe(erinShared.id);
  // A personal project is nobody's business but its owner's, whatever becomes
  // of the household.
  expect(await visibilityOf(frankSolo.id)).toBe("personal");
  expect(await projectOf(franksOwn.id)).toBe(frankSolo.id);

  // ---- the method the three sites call, on its own ----
  // Directly, so its rule is pinned where it is stated rather than only where
  // it is used: shared projects only, this account only.
  const gina = await person("gina");
  const ginaAcc = await store.createAccount({
    ownerUserId: gina.id,
    name: "Gina Current",
    currency: "GBP",
  });
  const ginaShared = await store.createProject({
    ownerUserId: gina.id,
    name: "Loft",
    description: null,
    color: null,
    targetDate: null,
    visibility: "shared",
  });
  const ginaPersonal = await store.createProject({
    ownerUserId: gina.id,
    name: "Loft ladder",
    description: null,
    color: null,
    targetDate: null,
  });
  const inShared = await payment(ginaAcc.id, "Insulation", ginaShared.id);
  const inPersonal = await payment(ginaAcc.id, "Ladder", ginaPersonal.id);

  await store.clearProjectLinksForAccount(ginaAcc.id);
  expect(await projectOf(inShared.id)).toBeNull();
  expect(await projectOf(inPersonal.id)).toBe(ginaPersonal.id);
  // Idempotent — the three sites may each reach the same account.
  await store.clearProjectLinksForAccount(ginaAcc.id);
  expect(await projectOf(inPersonal.id)).toBe(ginaPersonal.id);
}
