import { randomUUID } from "node:crypto";
import type {
  Account,
  AccountShare,
  BalanceSnapshot,
  Contribution,
  EmailVerificationToken,
  Household,
  HouseholdAccountAssignment,
  HouseholdMembership,
  HouseholdRole,
  Income,
  Inflow,
  MonthClose,
  PasswordResetToken,
  Payment,
  PlanSnapshot,
  Project,
  RecoveryCode,
  Session,
  SharePermission,
  TransferConfirmation,
  User,
} from "./entities.js";
import {
  type AccountAccess,
  type AccountPatch,
  assertInflowShape,
  type ContributionTotal,
  HouseholdExclusivityError,
  type MonthCloseScope,
  type NewAccount,
  type NewAccountAssignment,
  type NewBalanceSnapshot,
  type NewContribution,
  type NewIncome,
  type NewInflow,
  type NewMonthClose,
  type NewPayment,
  type NewProject,
  type NewTransferConfirmation,
  type NewUser,
  type Store,
  toIncome,
} from "./store.js";

const now = (): string => new Date().toISOString();

/** Oldest first. Rows written in the same millisecond keep insertion order —
 *  returning 0 on a tie leaves the (stable) sort alone. */
const byCreatedAt = (a: { createdAt: string }, b: { createdAt: string }): number =>
  a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1;

/** Inflow order: the priority the sending account serves them in, oldest first
 *  within a rank. Mirrors PgStore's ORDER BY so both agree row for row. */
const byPriority = (a: Inflow, b: Inflow): number => a.priority - b.priority || byCreatedAt(a, b);

/** Month close order: newest month first, and — since a user's month holds one
 *  row per currency — currency ascending inside it. Mirrors PgStore's ORDER BY. */
const byMonthDesc = (a: MonthClose, b: MonthClose): number =>
  a.month === b.month
    ? (a.currency ?? "").localeCompare(b.currency ?? "")
    : a.month > b.month
      ? -1
      : 1;

/** In-memory Store for tests and DB-less local dev. Not for production. */
export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private sessions = new Map<string, Session>();
  private verifyTokens = new Map<string, EmailVerificationToken>();
  private resetTokens = new Map<string, PasswordResetToken>();
  private recoveryCodes = new Map<string, RecoveryCode>();
  private households = new Map<string, Household>();
  private memberships = new Map<string, HouseholdMembership>();
  private shares = new Map<string, AccountShare>();
  private assignments = new Map<string, HouseholdAccountAssignment>();
  private accounts = new Map<string, Account>();
  private inflows = new Map<string, Inflow>();
  private payments = new Map<string, Payment>();
  private projects = new Map<string, Project>();
  private snapshots = new Map<string, PlanSnapshot>();
  private contributions = new Map<string, Contribution>();
  private balanceSnapshots = new Map<string, BalanceSnapshot>();
  private transferConfirmations = new Map<string, TransferConfirmation>();
  private monthCloses = new Map<string, MonthClose>();
  /** Keys are `${userId}|${date}|${kind}` — the PG unique index, in a Set. */
  private notificationLog = new Set<string>();

  async createUser(input: NewUser): Promise<User> {
    const user: User = {
      id: randomUUID(),
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      status: "active",
      emailVerified: false,
      totpSecret: null,
      totpEnabledAt: null,
      notifyEmail: false,
      createdAt: now(),
    };
    this.users.set(user.id, user);
    return user;
  }

  async getUserById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const lower = email.toLowerCase();
    for (const u of this.users.values()) if (u.email === lower) return u;
    return null;
  }

  async setUserVerified(id: string): Promise<void> {
    const u = this.users.get(id);
    if (u) u.emailVerified = true;
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    const u = this.users.get(userId);
    if (u) u.passwordHash = passwordHash;
  }

  async setUserNotifyEmail(userId: string, on: boolean): Promise<void> {
    const u = this.users.get(userId);
    if (u) u.notifyEmail = on;
  }

  async listUsersWithNotifications(): Promise<User[]> {
    return [...this.users.values()].filter((u) => u.notifyEmail).sort(byCreatedAt);
  }

  async deleteUserCascade(userId: string): Promise<void> {
    for (const account of await this.listAccountsForOwner(userId)) {
      await this.deleteAccount(account.id);
    }
    for (const [k, p] of this.projects) if (p.ownerUserId === userId) this.projects.delete(k);
    for (const h of [...this.households.values()]) {
      // Households the user founded go with them; membership of someone else's
      // household is just dropped.
      if (h.createdBy === userId) await this.deleteHousehold(h.id);
    }
    // Their own scorecards. Account-scoped ones went with the accounts above;
    // a close scoped to the person hangs off nothing else.
    for (const [k, c] of this.monthCloses) if (c.userId === userId) this.monthCloses.delete(k);
    for (const [k, m] of this.memberships) if (m.userId === userId) this.memberships.delete(k);
    for (const [k, s] of this.sessions) if (s.userId === userId) this.sessions.delete(k);
    for (const [k, t] of this.verifyTokens) if (t.userId === userId) this.verifyTokens.delete(k);
    for (const [k, t] of this.resetTokens) if (t.userId === userId) this.resetTokens.delete(k);
    for (const [k, c] of this.recoveryCodes) if (c.userId === userId) this.recoveryCodes.delete(k);
    for (const key of this.notificationLog) {
      if (key.startsWith(`${userId}|`)) this.notificationLog.delete(key);
    }
    this.users.delete(userId);
  }

  async setUserTotpSecret(userId: string, secret: string | null): Promise<void> {
    const u = this.users.get(userId);
    if (!u) return;
    u.totpSecret = secret;
    // Clearing the secret must also clear the flag: no secret, no second factor.
    if (secret === null) u.totpEnabledAt = null;
  }

  async enableUserTotp(userId: string): Promise<void> {
    const u = this.users.get(userId);
    if (u) u.totpEnabledAt = now();
  }

  async replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void> {
    for (const [k, c] of this.recoveryCodes) {
      if (c.userId === userId) this.recoveryCodes.delete(k);
    }
    for (const codeHash of codeHashes) {
      const code: RecoveryCode = {
        id: randomUUID(),
        userId,
        codeHash,
        usedAt: null,
        createdAt: now(),
      };
      this.recoveryCodes.set(code.id, code);
    }
  }

  async listUnusedRecoveryCodes(userId: string): Promise<RecoveryCode[]> {
    return [...this.recoveryCodes.values()]
      .filter((c) => c.userId === userId && !c.usedAt)
      .sort(byCreatedAt);
  }

  async consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    for (const c of this.recoveryCodes.values()) {
      if (c.userId !== userId || c.codeHash !== codeHash || c.usedAt) continue;
      c.usedAt = now();
      return true;
    }
    return false;
  }

  async createSession(session: Omit<Session, "id" | "createdAt" | "revokedAt">): Promise<Session> {
    const full: Session = { ...session, id: randomUUID(), revokedAt: null, createdAt: now() };
    this.sessions.set(full.id, full);
    return full;
  }

  async getSessionByTokenHash(hash: string): Promise<Session | null> {
    for (const s of this.sessions.values()) if (s.refreshTokenHash === hash) return s;
    return null;
  }

  async revokeSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.revokedAt = now();
  }

  async revokeAllUserSessions(userId: string): Promise<void> {
    const ts = now();
    for (const s of this.sessions.values()) {
      if (s.userId === userId && !s.revokedAt) s.revokedAt = ts;
    }
  }

  async createEmailVerificationToken(token: EmailVerificationToken): Promise<void> {
    this.verifyTokens.set(token.token, token);
  }

  async consumeEmailVerificationToken(token: string): Promise<EmailVerificationToken | null> {
    const t = this.verifyTokens.get(token);
    if (!t) return null;
    this.verifyTokens.delete(token);
    return t;
  }

  async createPasswordResetToken(token: PasswordResetToken): Promise<void> {
    this.resetTokens.set(token.token, token);
  }

  async consumePasswordResetToken(token: string): Promise<PasswordResetToken | null> {
    const t = this.resetTokens.get(token);
    if (!t) return null;
    this.resetTokens.delete(token);
    return t;
  }

  /** The household this user is already in, if any — the exclusivity rule's
   *  one question. `exceptHouseholdId` is the household being joined, which is
   *  never an answer to it. */
  private otherHouseholdOf(userId: string, exceptHouseholdId?: string): string | null {
    for (const m of this.memberships.values()) {
      if (m.userId === userId && m.householdId !== exceptHouseholdId) return m.householdId;
    }
    return null;
  }

  async createHousehold(name: string, createdBy: string): Promise<Household> {
    // Before the row, not after: a household whose founder was refused
    // membership would be an orphan nobody could reach or delete.
    const already = this.otherHouseholdOf(createdBy);
    if (already) throw new HouseholdExclusivityError(createdBy, already);
    const h: Household = { id: randomUUID(), name, createdBy, createdAt: now() };
    this.households.set(h.id, h);
    await this.addMembership(h.id, createdBy, "owner");
    return h;
  }

  async getHousehold(id: string): Promise<Household | null> {
    return this.households.get(id) ?? null;
  }

  async deleteHousehold(id: string): Promise<void> {
    // Every member leaves at once, so a movement that only existed because two
    // people were in this household stops claiming money — the same dissolution
    // `removeMember` performs, for everybody.
    for (const m of await this.listMembersForHousehold(id)) {
      await this.dissolveMembershipBenefits(id, m.userId);
    }
    for (const [k, s] of this.shares) if (s.householdId === id) this.shares.delete(k);
    for (const [k, m] of this.memberships) if (m.householdId === id) this.memberships.delete(k);
    for (const [k, a] of this.assignments) if (a.householdId === id) this.assignments.delete(k);
    for (const [k, t] of this.transferConfirmations) {
      if (t.householdId === id) await this.deleteTransferConfirmation(k);
    }
    for (const [k, c] of this.monthCloses) if (c.householdId === id) this.monthCloses.delete(k);
    this.households.delete(id);
  }

  async listHouseholdsForUser(userId: string): Promise<Household[]> {
    const ids = new Set(
      [...this.memberships.values()].filter((m) => m.userId === userId).map((m) => m.householdId),
    );
    return [...this.households.values()].filter((h) => ids.has(h.id));
  }

  async addMembership(
    householdId: string,
    userId: string,
    role: HouseholdRole,
  ): Promise<HouseholdMembership> {
    const already = this.otherHouseholdOf(userId, householdId);
    if (already) throw new HouseholdExclusivityError(userId, already);
    const m: HouseholdMembership = {
      id: randomUUID(),
      householdId,
      userId,
      role,
      contributionShareBp: 0,
      createdAt: now(),
    };
    this.memberships.set(m.id, m);
    return m;
  }

  async getMembership(householdId: string, userId: string): Promise<HouseholdMembership | null> {
    for (const m of this.memberships.values())
      if (m.householdId === householdId && m.userId === userId) return m;
    return null;
  }

  async listMembersForHousehold(householdId: string): Promise<HouseholdMembership[]> {
    return [...this.memberships.values()].filter((m) => m.householdId === householdId);
  }

  async removeMember(householdId: string, userId: string): Promise<void> {
    await this.dissolveMembershipBenefits(householdId, userId);
    for (const [k, m] of this.memberships) {
      if (m.householdId === householdId && m.userId === userId) this.memberships.delete(k);
    }
  }

  /**
   * Steps 1–3 of the departure cascade (see `Store.removeMember`). Called
   * while the membership still stands, so the ordering guarantee holds: at no
   * point is a non-member's account still attached to the household.
   *
   * Idempotent, so `deleteHousehold` may run it for every member in turn and
   * `removeMember` may run it for a membership that has already gone.
   */
  private async dissolveMembershipBenefits(householdId: string, userId: string): Promise<void> {
    const mine = new Set(
      [...this.accounts.values()].filter((a) => a.ownerUserId === userId).map((a) => a.id),
    );
    const otherMembers = new Set(
      (await this.listMembersForHousehold(householdId))
        .map((m) => m.userId)
        .filter((id) => id !== userId),
    );

    // 1. Movements across the boundary: deactivated, never deleted. The row's
    //    confirmations — and the contributions they booked — are the record of
    //    money that really moved, and `deleteInflow` would cascade them away.
    for (const [k, i] of this.inflows) {
      if (i.source !== "account" || !i.sourceAccountId) continue;
      const ends = [i.accountId, i.sourceAccountId];
      if (!ends.some((id) => mine.has(id))) continue;
      const acrossBoundary = ends.some((id) => {
        const owner = this.accounts.get(id)?.ownerUserId;
        return owner !== undefined && owner !== userId && otherMembers.has(owner);
      });
      if (acrossBoundary && i.active)
        this.inflows.set(k, { ...i, active: false, updatedAt: now() });
    }

    // 2. Plan roles: their accounts' roles here, and any role naming them.
    for (const [k, a] of this.assignments) {
      if (a.householdId !== householdId) continue;
      if (mine.has(a.accountId) || a.memberUserId === userId) this.assignments.delete(k);
    }

    // 3. Access grants of their accounts into this household. What the
    //    household shared with *them* needs nothing: that access was their
    //    membership, and the membership is about to go.
    for (const [k, s] of this.shares) {
      if (s.householdId === householdId && mine.has(s.accountId)) this.shares.delete(k);
    }
  }

  async updateMembershipRole(
    householdId: string,
    userId: string,
    role: HouseholdRole,
  ): Promise<HouseholdMembership | null> {
    for (const [k, m] of this.memberships) {
      if (m.householdId === householdId && m.userId === userId) {
        const updated: HouseholdMembership = { ...m, role };
        this.memberships.set(k, updated);
        return updated;
      }
    }
    return null;
  }

  async updateMembershipShare(
    householdId: string,
    userId: string,
    shareBp: number,
  ): Promise<HouseholdMembership | null> {
    for (const [k, m] of this.memberships) {
      if (m.householdId === householdId && m.userId === userId) {
        const updated: HouseholdMembership = { ...m, contributionShareBp: shareBp };
        this.memberships.set(k, updated);
        return updated;
      }
    }
    return null;
  }

  async upsertAccountAssignment(input: NewAccountAssignment): Promise<HouseholdAccountAssignment> {
    const existing = await this.getAccountAssignment(input.householdId, input.accountId);
    if (existing) {
      const updated: HouseholdAccountAssignment = {
        ...existing,
        role: input.role,
        memberUserId: input.memberUserId,
        updatedAt: now(),
      };
      this.assignments.set(existing.id, updated);
      return updated;
    }
    const ts = now();
    const a: HouseholdAccountAssignment = {
      id: randomUUID(),
      householdId: input.householdId,
      accountId: input.accountId,
      role: input.role,
      memberUserId: input.memberUserId,
      createdAt: ts,
      updatedAt: ts,
    };
    this.assignments.set(a.id, a);
    return a;
  }

  async listAccountAssignments(householdId: string): Promise<HouseholdAccountAssignment[]> {
    return [...this.assignments.values()].filter((a) => a.householdId === householdId);
  }

  async getAccountAssignment(
    householdId: string,
    accountId: string,
  ): Promise<HouseholdAccountAssignment | null> {
    for (const a of this.assignments.values()) {
      if (a.householdId === householdId && a.accountId === accountId) return a;
    }
    return null;
  }

  async deleteAccountAssignment(householdId: string, accountId: string): Promise<void> {
    for (const [k, a] of this.assignments) {
      if (a.householdId === householdId && a.accountId === accountId) this.assignments.delete(k);
    }
  }

  async listSharesForHousehold(householdId: string): Promise<AccountShare[]> {
    return [...this.shares.values()].filter((s) => s.householdId === householdId);
  }

  async createAccountShare(
    accountId: string,
    householdId: string,
    permission: SharePermission,
  ): Promise<AccountShare> {
    const s: AccountShare = {
      id: randomUUID(),
      accountId,
      householdId,
      permission,
      createdAt: now(),
    };
    this.shares.set(s.id, s);
    return s;
  }

  async listSharesForAccount(accountId: string): Promise<AccountShare[]> {
    return [...this.shares.values()].filter((s) => s.accountId === accountId);
  }

  async deleteAccountShare(id: string): Promise<void> {
    this.shares.delete(id);
  }

  async listAccessibleAccounts(userId: string): Promise<AccountAccess[]> {
    const result = new Map<string, AccountAccess>();
    for (const a of this.accounts.values()) {
      if (a.ownerUserId === userId) {
        result.set(a.id, { accountId: a.id, permission: "edit", owner: true });
      }
    }
    const householdIds = new Set(
      [...this.memberships.values()].filter((m) => m.userId === userId).map((m) => m.householdId),
    );
    for (const s of this.shares.values()) {
      if (!householdIds.has(s.householdId)) continue;
      const existing = result.get(s.accountId);
      if (existing?.owner) continue;
      if (!existing || (existing.permission === "view" && s.permission === "edit")) {
        result.set(s.accountId, {
          accountId: s.accountId,
          permission: s.permission,
          owner: false,
        });
      }
    }
    return [...result.values()];
  }

  async getAccess(userId: string, accountId: string): Promise<AccountAccess | null> {
    const all = await this.listAccessibleAccounts(userId);
    return all.find((a) => a.accountId === accountId) ?? null;
  }

  async createAccount(input: NewAccount): Promise<Account> {
    const ts = now();
    const a: Account = {
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      name: input.name,
      description: input.description ?? null,
      currency: input.currency,
      openingBalanceMinor: input.openingBalanceMinor ?? 0,
      monthlyBufferMinor: input.monthlyBufferMinor ?? 0,
      createdAt: ts,
      updatedAt: ts,
    };
    this.accounts.set(a.id, a);
    return a;
  }

  async getAccount(id: string): Promise<Account | null> {
    return this.accounts.get(id) ?? null;
  }

  async listAccountsForOwner(ownerUserId: string): Promise<Account[]> {
    return [...this.accounts.values()].filter((a) => a.ownerUserId === ownerUserId);
  }

  async updateAccount(id: string, patch: AccountPatch): Promise<Account | null> {
    const a = this.accounts.get(id);
    if (!a) return null;
    const updated: Account = {
      ...a,
      name: patch.name ?? a.name,
      description: patch.description === undefined ? a.description : patch.description,
      // `currency` is deliberately absent: an account is denominated once, when
      // it is created. `AccountPatch` says so, so there is nothing to carry over.
      openingBalanceMinor: patch.openingBalanceMinor ?? a.openingBalanceMinor,
      monthlyBufferMinor: patch.monthlyBufferMinor ?? a.monthlyBufferMinor,
      updatedAt: now(),
    };
    this.accounts.set(id, updated);
    return updated;
  }

  async deleteAccount(id: string): Promise<void> {
    this.accounts.delete(id);
    // Both faces: what arrived here, and what this account was sending
    // elsewhere. The PG side gets the same from the two ON DELETE CASCADE FKs.
    for (const [k, v] of this.inflows) {
      if (v.accountId === id || v.sourceAccountId === id) this.inflows.delete(k);
    }
    for (const [k, v] of this.payments) if (v.accountId === id) this.payments.delete(k);
    for (const [k, v] of this.shares) if (v.accountId === id) this.shares.delete(k);
    for (const [k, v] of this.assignments) if (v.accountId === id) this.assignments.delete(k);
    for (const [k, v] of this.contributions) if (v.accountId === id) this.contributions.delete(k);
    for (const [k, v] of this.balanceSnapshots) {
      if (v.accountId === id) this.balanceSnapshots.delete(k);
    }
    // Through deleteTransferConfirmation, not a bare delete: a confirmation
    // books contributions against the payments it funded, and those sit on the
    // *receiving* account — another account entirely, which the accountId sweep
    // above never touches. Postgres gets this for free from `contributions
    // .transfer_confirmation_id ON DELETE CASCADE` (0004_reality_loop.sql:37),
    // so dropping the row here alone left the two stores disagreeing about
    // whether money was still set aside for a transfer nobody can make.
    for (const [k, v] of this.transferConfirmations) {
      if (v.fromAccountId === id || v.toAccountId === id) {
        await this.deleteTransferConfirmation(k);
      }
    }
    for (const [k, v] of this.monthCloses) if (v.accountId === id) this.monthCloses.delete(k);
  }

  async createInflow(input: NewInflow): Promise<Inflow> {
    assertInflowShape(input);
    const ts = now();
    const inflow: Inflow = { ...input, id: randomUUID(), createdAt: ts, updatedAt: ts };
    this.inflows.set(inflow.id, inflow);
    return inflow;
  }

  async getInflow(id: string): Promise<Inflow | null> {
    return this.inflows.get(id) ?? null;
  }

  async listInflows(accountId: string): Promise<Inflow[]> {
    return [...this.inflows.values()].filter((i) => i.accountId === accountId).sort(byPriority);
  }

  async listOutboundInflows(accountId: string): Promise<Inflow[]> {
    return [...this.inflows.values()]
      .filter((i) => i.sourceAccountId === accountId)
      .sort(byPriority);
  }

  async updateInflow(id: string, patch: Partial<NewInflow>): Promise<Inflow | null> {
    const i = this.inflows.get(id);
    if (!i) return null;
    const updated: Inflow = { ...i, ...patch, id: i.id, updatedAt: now() };
    // The whole row is checked, not the patch: flipping `source` alone must not
    // be able to leave behind a shape createInflow would have refused.
    assertInflowShape(updated);
    this.inflows.set(id, updated);
    return updated;
  }

  async deleteInflow(id: string): Promise<void> {
    this.inflows.delete(id);
    // A standalone confirmation confirms *this inflow*; with the inflow gone it
    // is a record of nothing, and the contributions it booked go with it
    // exactly as un-confirming would take them. The PG side gets the same from
    // the ON DELETE CASCADE FK added in 0009.
    for (const [k, c] of this.transferConfirmations) {
      if (c.inflowId === id) await this.deleteTransferConfirmation(k);
    }
  }

  async createIncome(input: NewIncome): Promise<Income> {
    return toIncome(
      await this.createInflow({
        ...input,
        source: "external",
        sourceAccountId: null,
        priority: 100,
      }),
    );
  }

  async getIncome(id: string): Promise<Income | null> {
    const i = this.inflows.get(id);
    return i && i.source === "external" ? toIncome(i) : null;
  }

  async listIncomes(accountId: string): Promise<Income[]> {
    return (await this.listInflows(accountId))
      .filter((i) => i.source === "external")
      .map((i) => toIncome(i));
  }

  async updateIncome(id: string, patch: Partial<NewIncome>): Promise<Income | null> {
    if (!(await this.getIncome(id))) return null;
    const updated = await this.updateInflow(id, patch);
    return updated ? toIncome(updated) : null;
  }

  async deleteIncome(id: string): Promise<void> {
    if (await this.getIncome(id)) this.inflows.delete(id);
  }

  async createPayment(input: NewPayment): Promise<Payment> {
    const ts = now();
    const payment: Payment = { ...input, id: randomUUID(), createdAt: ts, updatedAt: ts };
    this.payments.set(payment.id, payment);
    return payment;
  }

  async getPayment(id: string): Promise<Payment | null> {
    return this.payments.get(id) ?? null;
  }

  async listPayments(accountId: string): Promise<Payment[]> {
    return [...this.payments.values()].filter((p) => p.accountId === accountId);
  }

  async updatePayment(id: string, patch: Partial<NewPayment>): Promise<Payment | null> {
    const p = this.payments.get(id);
    if (!p) return null;
    const updated: Payment = { ...p, ...patch, id: p.id, updatedAt: now() };
    this.payments.set(id, updated);
    return updated;
  }

  async deletePayment(id: string): Promise<void> {
    this.payments.delete(id);
    for (const [k, c] of this.contributions) if (c.paymentId === id) this.contributions.delete(k);
  }

  async reorderPayments(accountId: string, orderedIds: string[]): Promise<void> {
    orderedIds.forEach((id, index) => {
      const p = this.payments.get(id);
      if (p && p.accountId === accountId) {
        this.payments.set(id, { ...p, priority: index + 1, updatedAt: now() });
      }
    });
  }

  async tryLogNotification(userId: string, date: string, kind: string): Promise<boolean> {
    const key = `${userId}|${date}|${kind}`;
    if (this.notificationLog.has(key)) return false;
    this.notificationLog.add(key);
    return true;
  }

  async saveSnapshot(snapshot: Omit<PlanSnapshot, "id" | "computedAt">): Promise<PlanSnapshot> {
    const full: PlanSnapshot = { ...snapshot, id: randomUUID(), computedAt: now() };
    this.snapshots.set(full.id, full);
    return full;
  }

  async createContribution(input: NewContribution): Promise<Contribution> {
    const c: Contribution = { ...input, id: randomUUID(), createdAt: now() };
    this.contributions.set(c.id, c);
    return c;
  }

  async getContribution(id: string): Promise<Contribution | null> {
    return this.contributions.get(id) ?? null;
  }

  async listContributionsForAccount(accountId: string, month?: string): Promise<Contribution[]> {
    return [...this.contributions.values()]
      .filter((c) => c.accountId === accountId && (!month || c.month === month))
      .sort(byCreatedAt);
  }

  async sumContributionsByPayment(accountId: string): Promise<ContributionTotal[]> {
    const totals = new Map<string, number>();
    for (const c of this.contributions.values()) {
      if (c.accountId !== accountId) continue;
      totals.set(c.paymentId, (totals.get(c.paymentId) ?? 0) + c.amountMinor);
    }
    return [...totals.entries()].map(([paymentId, totalMinor]) => ({ paymentId, totalMinor }));
  }

  async deleteContribution(id: string): Promise<void> {
    this.contributions.delete(id);
  }

  async upsertBalanceSnapshot(input: NewBalanceSnapshot): Promise<BalanceSnapshot> {
    for (const [k, b] of this.balanceSnapshots) {
      if (b.accountId === input.accountId && b.asOfDate === input.asOfDate) {
        const updated: BalanceSnapshot = { ...b, balanceMinor: input.balanceMinor };
        this.balanceSnapshots.set(k, updated);
        return updated;
      }
    }
    const snap: BalanceSnapshot = { ...input, id: randomUUID(), createdAt: now() };
    this.balanceSnapshots.set(snap.id, snap);
    return snap;
  }

  async listBalanceSnapshots(accountId: string): Promise<BalanceSnapshot[]> {
    return [...this.balanceSnapshots.values()]
      .filter((b) => b.accountId === accountId)
      .sort((a, b) => (a.asOfDate < b.asOfDate ? -1 : 1));
  }

  async createTransferConfirmation(input: NewTransferConfirmation): Promise<TransferConfirmation> {
    for (const t of this.transferConfirmations.values()) {
      if (t.month !== input.month) continue;
      // Three keys, mirroring the three unique indexes in the database. A
      // household transfer is one *member's* share of a transfer the plan
      // derived, so it is keyed by who moved it and between which accounts. An
      // authored movement with no household is one inflow, confirmed at most
      // once a month. A movement with neither — one the plan derived for a
      // scope no household applies to — is keyed by what locates every row
      // anyway: the two accounts, the month and the actor.
      const duplicate =
        input.householdId !== null
          ? t.householdId === input.householdId &&
            t.fromAccountId === input.fromAccountId &&
            t.toAccountId === input.toAccountId &&
            t.memberUserId === input.memberUserId
          : input.inflowId !== null
            ? t.householdId === null && t.inflowId === input.inflowId
            : t.householdId === null &&
              t.inflowId === null &&
              t.fromAccountId === input.fromAccountId &&
              t.toAccountId === input.toAccountId &&
              t.memberUserId === input.memberUserId;
      if (duplicate) throw new Error("transfer already confirmed");
    }
    const t: TransferConfirmation = { ...input, id: randomUUID(), createdAt: now() };
    this.transferConfirmations.set(t.id, t);
    return t;
  }

  async getTransferConfirmation(id: string): Promise<TransferConfirmation | null> {
    return this.transferConfirmations.get(id) ?? null;
  }

  async listTransferConfirmations(
    householdId: string,
    month: string,
  ): Promise<TransferConfirmation[]> {
    return [...this.transferConfirmations.values()]
      .filter((t) => t.householdId === householdId && t.month === month)
      .sort(byCreatedAt);
  }

  async listTransferConfirmationsForAccount(
    accountId: string,
    month: string,
  ): Promise<TransferConfirmation[]> {
    return [...this.transferConfirmations.values()]
      .filter(
        (t) =>
          t.inflowId !== null &&
          t.month === month &&
          (t.fromAccountId === accountId || t.toAccountId === accountId),
      )
      .sort(byCreatedAt);
  }

  async listDerivedTransferConfirmationsForAccount(
    accountId: string,
    month: string,
  ): Promise<TransferConfirmation[]> {
    return [...this.transferConfirmations.values()]
      .filter(
        (t) =>
          t.householdId === null &&
          t.inflowId === null &&
          t.month === month &&
          (t.fromAccountId === accountId || t.toAccountId === accountId),
      )
      .sort(byCreatedAt);
  }

  async deleteTransferConfirmation(id: string): Promise<void> {
    this.transferConfirmations.delete(id);
    for (const [k, c] of this.contributions) {
      if (c.transferConfirmationId === id) this.contributions.delete(k);
    }
  }

  async createMonthClose(input: NewMonthClose): Promise<MonthClose> {
    const userId = input.userId ?? null;
    const currency = input.currency ?? null;
    // What `month_close_user_currency` (0013) says at the database: a close
    // scoped to a person has to name the partition it scored.
    if (userId && !currency) {
      throw new Error("a user close must name its currency");
    }
    // A user's month holds one row per currency, so the duplicate to refuse is
    // the same partition twice — the key the partial unique index carries.
    const scope: MonthCloseScope = userId
      ? { userId, currency: currency! }
      : input.householdId
        ? { householdId: input.householdId }
        : { accountId: input.accountId! };
    if (await this.getMonthClose(scope, input.month)) {
      throw new Error("month already closed");
    }
    const c: MonthClose = { ...input, userId, currency, id: randomUUID(), closedAt: now() };
    this.monthCloses.set(c.id, c);
    return c;
  }

  async getMonthCloseById(id: string): Promise<MonthClose | null> {
    return this.monthCloses.get(id) ?? null;
  }

  async getMonthClose(scope: MonthCloseScope, month: string): Promise<MonthClose | null> {
    // Through the sorted list, so a user scope asked without a currency gets
    // the same row every time rather than whichever was written first.
    const [first] = (await this.listMonthCloses(scope)).filter((c) => c.month === month);
    return first ?? null;
  }

  async listMonthCloses(scope: MonthCloseScope): Promise<MonthClose[]> {
    return [...this.monthCloses.values()]
      .filter((c) => {
        if ("householdId" in scope) return c.householdId === scope.householdId;
        if ("accountId" in scope) return c.accountId === scope.accountId;
        return (
          c.userId === scope.userId &&
          (scope.currency === undefined || c.currency === scope.currency)
        );
      })
      .sort(byMonthDesc);
  }

  async deleteMonthClose(id: string): Promise<void> {
    this.monthCloses.delete(id);
  }

  async createProject(input: NewProject): Promise<Project> {
    const ts = now();
    const project: Project = {
      ...input,
      id: randomUUID(),
      createdAt: ts,
      updatedAt: ts,
    };
    this.projects.set(project.id, project);
    return project;
  }

  async getProject(id: string): Promise<Project | null> {
    return this.projects.get(id) ?? null;
  }

  async listProjectsForOwner(ownerUserId: string): Promise<Project[]> {
    return [...this.projects.values()].filter((p) => p.ownerUserId === ownerUserId);
  }

  async updateProject(id: string, patch: Partial<NewProject>): Promise<Project | null> {
    const p = this.projects.get(id);
    if (!p) return null;
    const updated: Project = { ...p, ...patch, id: p.id, updatedAt: now() };
    this.projects.set(id, updated);
    return updated;
  }

  async deleteProject(id: string): Promise<void> {
    // Member payments lose their project link (FK ON DELETE SET NULL in PG).
    for (const [k, p] of this.payments) {
      if (p.projectId === id) this.payments.set(k, { ...p, projectId: null, updatedAt: now() });
    }
    this.projects.delete(id);
  }

  async listPaymentsForProject(projectId: string): Promise<Payment[]> {
    return [...this.payments.values()].filter((p) => p.projectId === projectId);
  }
}
