import type {
  AccountRole,
  Frequency,
  PaymentCategory,
  PaymentScope,
  Recurrence,
} from "@finance-planner/contracts";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Database } from "./db.js";
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
  MonthClose,
  Payment,
  PlanSnapshot,
  Project,
  Session,
  SharePermission,
  TransferConfirmation,
  User,
  UserStatus,
} from "./entities.js";
import * as s from "./schema.js";
import type {
  AccountAccess,
  ContributionTotal,
  MonthCloseScope,
  NewAccount,
  NewAccountAssignment,
  NewBalanceSnapshot,
  NewContribution,
  NewIncome,
  NewMonthClose,
  NewPayment,
  NewProject,
  NewTransferConfirmation,
  NewUser,
  Store,
} from "./store.js";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const rec = (v: unknown): Recurrence | null => (v as Recurrence | null) ?? null;

function mapUser(r: typeof s.users.$inferSelect): User {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.passwordHash ?? null,
    displayName: r.displayName,
    status: r.status as UserStatus,
    emailVerified: r.emailVerified,
    createdAt: r.createdAt.toISOString(),
  };
}

function mapMembership(r: typeof s.memberships.$inferSelect): HouseholdMembership {
  return {
    id: r.id,
    householdId: r.householdId,
    userId: r.userId,
    role: r.role as HouseholdRole,
    contributionShareBp: r.contributionShareBp,
    createdAt: r.createdAt.toISOString(),
  };
}

function mapAssignment(
  r: typeof s.householdAccountAssignments.$inferSelect,
): HouseholdAccountAssignment {
  return {
    id: r.id,
    householdId: r.householdId,
    accountId: r.accountId,
    role: r.role as AccountRole,
    memberUserId: r.memberUserId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Postgres-backed Store via Drizzle. Production persistence. */
export class PgStore implements Store {
  constructor(private readonly db: Database) {}

  async createUser(input: NewUser): Promise<User> {
    const [row] = await this.db
      .insert(s.users)
      .values({
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
        displayName: input.displayName,
      })
      .returning();
    return mapUser(row!);
  }

  async getUserById(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(s.users).where(eq(s.users.id, id));
    return row ? mapUser(row) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(s.users)
      .where(eq(s.users.email, email.toLowerCase()));
    return row ? mapUser(row) : null;
  }

  async setUserVerified(id: string): Promise<void> {
    await this.db.update(s.users).set({ emailVerified: true }).where(eq(s.users.id, id));
  }

  async createSession(session: Omit<Session, "id" | "createdAt" | "revokedAt">): Promise<Session> {
    const [row] = await this.db
      .insert(s.sessions)
      .values({
        userId: session.userId,
        refreshTokenHash: session.refreshTokenHash,
        expiresAt: new Date(session.expiresAt),
      })
      .returning();
    return {
      id: row!.id,
      userId: row!.userId,
      refreshTokenHash: row!.refreshTokenHash,
      expiresAt: row!.expiresAt.toISOString(),
      revokedAt: iso(row!.revokedAt),
      createdAt: row!.createdAt.toISOString(),
    };
  }

  async getSessionByTokenHash(hash: string): Promise<Session | null> {
    const [row] = await this.db
      .select()
      .from(s.sessions)
      .where(eq(s.sessions.refreshTokenHash, hash));
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      refreshTokenHash: row.refreshTokenHash,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: iso(row.revokedAt),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async revokeSession(id: string): Promise<void> {
    await this.db.update(s.sessions).set({ revokedAt: new Date() }).where(eq(s.sessions.id, id));
  }

  async revokeAllUserSessions(userId: string): Promise<void> {
    await this.db
      .update(s.sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.sessions.userId, userId), isNull(s.sessions.revokedAt)));
  }

  async createEmailVerificationToken(token: EmailVerificationToken): Promise<void> {
    await this.db.insert(s.emailVerificationTokens).values({
      token: token.token,
      userId: token.userId,
      expiresAt: new Date(token.expiresAt),
    });
  }

  async consumeEmailVerificationToken(token: string): Promise<EmailVerificationToken | null> {
    const [row] = await this.db
      .select()
      .from(s.emailVerificationTokens)
      .where(eq(s.emailVerificationTokens.token, token));
    if (!row) return null;
    await this.db
      .delete(s.emailVerificationTokens)
      .where(eq(s.emailVerificationTokens.token, token));
    return { token: row.token, userId: row.userId, expiresAt: row.expiresAt.toISOString() };
  }

  async createHousehold(name: string, createdBy: string): Promise<Household> {
    const [row] = await this.db.insert(s.households).values({ name, createdBy }).returning();
    await this.addMembership(row!.id, createdBy, "owner");
    return {
      id: row!.id,
      name: row!.name,
      createdBy: row!.createdBy,
      createdAt: row!.createdAt.toISOString(),
    };
  }

  async getHousehold(id: string): Promise<Household | null> {
    const [row] = await this.db.select().from(s.households).where(eq(s.households.id, id));
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async deleteHousehold(id: string): Promise<void> {
    // account_shares + assignments live in other schemas with no FK back to
    // households, so wipe them first; memberships cascade via ON DELETE CASCADE.
    await this.db.delete(s.accountShares).where(eq(s.accountShares.householdId, id));
    await this.db
      .delete(s.householdAccountAssignments)
      .where(eq(s.householdAccountAssignments.householdId, id));
    // Confirmations (and their linked contributions, via FK cascade) + closes
    // have no FK to households either.
    const confs = await this.db
      .select({ id: s.transferConfirmations.id })
      .from(s.transferConfirmations)
      .where(eq(s.transferConfirmations.householdId, id));
    for (const c of confs) await this.deleteTransferConfirmation(c.id);
    await this.db.delete(s.monthCloses).where(eq(s.monthCloses.householdId, id));
    await this.db.delete(s.households).where(eq(s.households.id, id));
  }

  async listHouseholdsForUser(userId: string): Promise<Household[]> {
    const rows = await this.db
      .select({ h: s.households })
      .from(s.memberships)
      .innerJoin(s.households, eq(s.households.id, s.memberships.householdId))
      .where(eq(s.memberships.userId, userId));
    return rows.map(({ h }) => ({
      id: h.id,
      name: h.name,
      createdBy: h.createdBy,
      createdAt: h.createdAt.toISOString(),
    }));
  }

  async addMembership(
    householdId: string,
    userId: string,
    role: HouseholdRole,
  ): Promise<HouseholdMembership> {
    const [row] = await this.db
      .insert(s.memberships)
      .values({ householdId, userId, role })
      .returning();
    return mapMembership(row!);
  }

  async getMembership(householdId: string, userId: string): Promise<HouseholdMembership | null> {
    const [row] = await this.db
      .select()
      .from(s.memberships)
      .where(and(eq(s.memberships.householdId, householdId), eq(s.memberships.userId, userId)));
    return row ? mapMembership(row) : null;
  }

  async listMembersForHousehold(householdId: string): Promise<HouseholdMembership[]> {
    const rows = await this.db
      .select()
      .from(s.memberships)
      .where(eq(s.memberships.householdId, householdId));
    return rows.map(mapMembership);
  }

  async removeMember(householdId: string, userId: string): Promise<void> {
    await this.db
      .delete(s.memberships)
      .where(and(eq(s.memberships.householdId, householdId), eq(s.memberships.userId, userId)));
  }

  async updateMembershipRole(
    householdId: string,
    userId: string,
    role: HouseholdRole,
  ): Promise<HouseholdMembership | null> {
    const [row] = await this.db
      .update(s.memberships)
      .set({ role })
      .where(and(eq(s.memberships.householdId, householdId), eq(s.memberships.userId, userId)))
      .returning();
    return row ? mapMembership(row) : null;
  }

  async updateMembershipShare(
    householdId: string,
    userId: string,
    shareBp: number,
  ): Promise<HouseholdMembership | null> {
    const [row] = await this.db
      .update(s.memberships)
      .set({ contributionShareBp: shareBp })
      .where(and(eq(s.memberships.householdId, householdId), eq(s.memberships.userId, userId)))
      .returning();
    return row ? mapMembership(row) : null;
  }

  async upsertAccountAssignment(input: NewAccountAssignment): Promise<HouseholdAccountAssignment> {
    const existing = await this.getAccountAssignment(input.householdId, input.accountId);
    if (existing) {
      const [row] = await this.db
        .update(s.householdAccountAssignments)
        .set({ role: input.role, memberUserId: input.memberUserId, updatedAt: new Date() })
        .where(eq(s.householdAccountAssignments.id, existing.id))
        .returning();
      return mapAssignment(row!);
    }
    const [row] = await this.db
      .insert(s.householdAccountAssignments)
      .values({
        householdId: input.householdId,
        accountId: input.accountId,
        role: input.role,
        memberUserId: input.memberUserId,
      })
      .returning();
    return mapAssignment(row!);
  }

  async listAccountAssignments(householdId: string): Promise<HouseholdAccountAssignment[]> {
    const rows = await this.db
      .select()
      .from(s.householdAccountAssignments)
      .where(eq(s.householdAccountAssignments.householdId, householdId));
    return rows.map(mapAssignment);
  }

  async getAccountAssignment(
    householdId: string,
    accountId: string,
  ): Promise<HouseholdAccountAssignment | null> {
    const [row] = await this.db
      .select()
      .from(s.householdAccountAssignments)
      .where(
        and(
          eq(s.householdAccountAssignments.householdId, householdId),
          eq(s.householdAccountAssignments.accountId, accountId),
        ),
      );
    return row ? mapAssignment(row) : null;
  }

  async deleteAccountAssignment(householdId: string, accountId: string): Promise<void> {
    await this.db
      .delete(s.householdAccountAssignments)
      .where(
        and(
          eq(s.householdAccountAssignments.householdId, householdId),
          eq(s.householdAccountAssignments.accountId, accountId),
        ),
      );
  }

  async listSharesForHousehold(householdId: string): Promise<AccountShare[]> {
    const rows = await this.db
      .select()
      .from(s.accountShares)
      .where(eq(s.accountShares.householdId, householdId));
    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      householdId: r.householdId,
      permission: r.permission as SharePermission,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createAccountShare(
    accountId: string,
    householdId: string,
    permission: SharePermission,
  ): Promise<AccountShare> {
    const [row] = await this.db
      .insert(s.accountShares)
      .values({ accountId, householdId, permission })
      .returning();
    return {
      id: row!.id,
      accountId: row!.accountId,
      householdId: row!.householdId,
      permission: row!.permission as SharePermission,
      createdAt: row!.createdAt.toISOString(),
    };
  }

  async listSharesForAccount(accountId: string): Promise<AccountShare[]> {
    const rows = await this.db
      .select()
      .from(s.accountShares)
      .where(eq(s.accountShares.accountId, accountId));
    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      householdId: r.householdId,
      permission: r.permission as SharePermission,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async deleteAccountShare(id: string): Promise<void> {
    await this.db.delete(s.accountShares).where(eq(s.accountShares.id, id));
  }

  async listAccessibleAccounts(userId: string): Promise<AccountAccess[]> {
    const result = new Map<string, AccountAccess>();
    const owned = await this.db
      .select({ id: s.accounts.id })
      .from(s.accounts)
      .where(eq(s.accounts.ownerUserId, userId));
    for (const o of owned) result.set(o.id, { accountId: o.id, permission: "edit", owner: true });

    const shared = await this.db
      .select({ accountId: s.accountShares.accountId, permission: s.accountShares.permission })
      .from(s.memberships)
      .innerJoin(s.accountShares, eq(s.accountShares.householdId, s.memberships.householdId))
      .where(eq(s.memberships.userId, userId));
    for (const sh of shared) {
      const existing = result.get(sh.accountId);
      if (existing?.owner) continue;
      const perm = sh.permission as SharePermission;
      if (!existing || (existing.permission === "view" && perm === "edit")) {
        result.set(sh.accountId, { accountId: sh.accountId, permission: perm, owner: false });
      }
    }
    return [...result.values()];
  }

  async getAccess(userId: string, accountId: string): Promise<AccountAccess | null> {
    const all = await this.listAccessibleAccounts(userId);
    return all.find((a) => a.accountId === accountId) ?? null;
  }

  async createAccount(input: NewAccount): Promise<Account> {
    const [row] = await this.db
      .insert(s.accounts)
      .values({
        ownerUserId: input.ownerUserId,
        name: input.name,
        description: input.description ?? null,
        currency: input.currency,
        openingBalanceMinor: input.openingBalanceMinor ?? 0,
        monthlyBufferMinor: input.monthlyBufferMinor ?? 0,
      })
      .returning();
    return this.mapAccount(row!);
  }

  async getAccount(id: string): Promise<Account | null> {
    const [row] = await this.db.select().from(s.accounts).where(eq(s.accounts.id, id));
    return row ? this.mapAccount(row) : null;
  }

  async listAccountsForOwner(ownerUserId: string): Promise<Account[]> {
    const rows = await this.db
      .select()
      .from(s.accounts)
      .where(eq(s.accounts.ownerUserId, ownerUserId));
    return rows.map((r) => this.mapAccount(r));
  }

  async updateAccount(id: string, patch: Partial<NewAccount>): Promise<Account | null> {
    const [row] = await this.db
      .update(s.accounts)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
        ...(patch.openingBalanceMinor !== undefined
          ? { openingBalanceMinor: patch.openingBalanceMinor }
          : {}),
        ...(patch.monthlyBufferMinor !== undefined
          ? { monthlyBufferMinor: patch.monthlyBufferMinor }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(s.accounts.id, id))
      .returning();
    return row ? this.mapAccount(row) : null;
  }

  async deleteAccount(id: string): Promise<void> {
    await this.db.delete(s.contributions).where(eq(s.contributions.accountId, id));
    await this.db.delete(s.balanceSnapshots).where(eq(s.balanceSnapshots.accountId, id));
    await this.db
      .delete(s.transferConfirmations)
      .where(
        or(
          eq(s.transferConfirmations.fromAccountId, id),
          eq(s.transferConfirmations.toAccountId, id),
        ),
      );
    await this.db.delete(s.monthCloses).where(eq(s.monthCloses.accountId, id));
    await this.db.delete(s.incomes).where(eq(s.incomes.accountId, id));
    await this.db.delete(s.payments).where(eq(s.payments.accountId, id));
    await this.db.delete(s.accountShares).where(eq(s.accountShares.accountId, id));
    await this.db
      .delete(s.householdAccountAssignments)
      .where(eq(s.householdAccountAssignments.accountId, id));
    await this.db.delete(s.accounts).where(eq(s.accounts.id, id));
  }

  async createIncome(input: NewIncome): Promise<Income> {
    const [row] = await this.db
      .insert(s.incomes)
      .values({
        accountId: input.accountId,
        name: input.name,
        amountMinor: input.amountMinor,
        frequency: input.frequency,
        recurrence: input.recurrence,
        anchorDate: input.anchorDate,
        active: input.active,
      })
      .returning();
    return this.mapIncome(row!);
  }

  async getIncome(id: string): Promise<Income | null> {
    const [row] = await this.db.select().from(s.incomes).where(eq(s.incomes.id, id));
    return row ? this.mapIncome(row) : null;
  }

  async listIncomes(accountId: string): Promise<Income[]> {
    const rows = await this.db.select().from(s.incomes).where(eq(s.incomes.accountId, accountId));
    return rows.map((r) => this.mapIncome(r));
  }

  async updateIncome(id: string, patch: Partial<NewIncome>): Promise<Income | null> {
    const [row] = await this.db
      .update(s.incomes)
      .set({ ...stripUndefined(patch), updatedAt: new Date() })
      .where(eq(s.incomes.id, id))
      .returning();
    return row ? this.mapIncome(row) : null;
  }

  async deleteIncome(id: string): Promise<void> {
    await this.db.delete(s.incomes).where(eq(s.incomes.id, id));
  }

  async createPayment(input: NewPayment): Promise<Payment> {
    const [row] = await this.db
      .insert(s.payments)
      .values({
        accountId: input.accountId,
        name: input.name,
        category: input.category,
        amountMinor: input.amountMinor,
        dueDate: input.dueDate,
        recurrence: input.recurrence,
        targetDate: input.targetDate,
        priority: input.priority,
        alreadySavedMinor: input.alreadySavedMinor,
        autoRenew: input.autoRenew,
        active: input.active,
        notes: input.notes,
        projectId: input.projectId,
        scope: input.scope,
        bearerUserId: input.bearerUserId,
      })
      .returning();
    return this.mapPayment(row!);
  }

  async getPayment(id: string): Promise<Payment | null> {
    const [row] = await this.db.select().from(s.payments).where(eq(s.payments.id, id));
    return row ? this.mapPayment(row) : null;
  }

  async listPayments(accountId: string): Promise<Payment[]> {
    const rows = await this.db.select().from(s.payments).where(eq(s.payments.accountId, accountId));
    return rows.map((r) => this.mapPayment(r));
  }

  async updatePayment(id: string, patch: Partial<NewPayment>): Promise<Payment | null> {
    const [row] = await this.db
      .update(s.payments)
      .set({ ...stripUndefined(patch), updatedAt: new Date() })
      .where(eq(s.payments.id, id))
      .returning();
    return row ? this.mapPayment(row) : null;
  }

  async deletePayment(id: string): Promise<void> {
    // contributions cascade via their FK, but stay explicit like the rest.
    await this.db.delete(s.contributions).where(eq(s.contributions.paymentId, id));
    await this.db.delete(s.payments).where(eq(s.payments.id, id));
  }

  async reorderPayments(accountId: string, orderedIds: string[]): Promise<void> {
    for (let i = 0; i < orderedIds.length; i++) {
      await this.db
        .update(s.payments)
        .set({ priority: i + 1, updatedAt: new Date() })
        .where(and(eq(s.payments.id, orderedIds[i]!), eq(s.payments.accountId, accountId)));
    }
  }

  async saveSnapshot(snapshot: Omit<PlanSnapshot, "id" | "computedAt">): Promise<PlanSnapshot> {
    const [row] = await this.db
      .insert(s.planSnapshots)
      .values({
        accountId: snapshot.accountId,
        asOfDate: snapshot.asOfDate,
        inputsHash: snapshot.inputsHash,
        detail: snapshot.detail,
      })
      .returning();
    return {
      id: row!.id,
      accountId: row!.accountId,
      computedAt: row!.computedAt.toISOString(),
      asOfDate: row!.asOfDate,
      inputsHash: row!.inputsHash,
      detail: row!.detail,
    };
  }

  async createContribution(input: NewContribution): Promise<Contribution> {
    const [row] = await this.db
      .insert(s.contributions)
      .values({
        paymentId: input.paymentId,
        accountId: input.accountId,
        userId: input.userId,
        month: input.month,
        amountMinor: input.amountMinor,
        note: input.note,
        transferConfirmationId: input.transferConfirmationId,
      })
      .returning();
    return mapContribution(row!);
  }

  async getContribution(id: string): Promise<Contribution | null> {
    const [row] = await this.db.select().from(s.contributions).where(eq(s.contributions.id, id));
    return row ? mapContribution(row) : null;
  }

  async listContributionsForAccount(accountId: string, month?: string): Promise<Contribution[]> {
    const rows = await this.db
      .select()
      .from(s.contributions)
      .where(
        month
          ? and(eq(s.contributions.accountId, accountId), eq(s.contributions.month, month))
          : eq(s.contributions.accountId, accountId),
      )
      .orderBy(asc(s.contributions.createdAt));
    return rows.map(mapContribution);
  }

  async sumContributionsByPayment(accountId: string): Promise<ContributionTotal[]> {
    const rows = await this.db
      .select({
        paymentId: s.contributions.paymentId,
        total: sql<string>`coalesce(sum(${s.contributions.amountMinor}), 0)`,
      })
      .from(s.contributions)
      .where(eq(s.contributions.accountId, accountId))
      .groupBy(s.contributions.paymentId);
    return rows.map((r) => ({ paymentId: r.paymentId, totalMinor: Number(r.total) }));
  }

  async deleteContribution(id: string): Promise<void> {
    await this.db.delete(s.contributions).where(eq(s.contributions.id, id));
  }

  async upsertBalanceSnapshot(input: NewBalanceSnapshot): Promise<BalanceSnapshot> {
    const [row] = await this.db
      .insert(s.balanceSnapshots)
      .values({
        accountId: input.accountId,
        asOfDate: input.asOfDate,
        balanceMinor: input.balanceMinor,
      })
      .onConflictDoUpdate({
        target: [s.balanceSnapshots.accountId, s.balanceSnapshots.asOfDate],
        set: { balanceMinor: input.balanceMinor },
      })
      .returning();
    return mapBalanceSnapshot(row!);
  }

  async listBalanceSnapshots(accountId: string): Promise<BalanceSnapshot[]> {
    const rows = await this.db
      .select()
      .from(s.balanceSnapshots)
      .where(eq(s.balanceSnapshots.accountId, accountId))
      .orderBy(asc(s.balanceSnapshots.asOfDate));
    return rows.map(mapBalanceSnapshot);
  }

  async createTransferConfirmation(input: NewTransferConfirmation): Promise<TransferConfirmation> {
    const [row] = await this.db
      .insert(s.transferConfirmations)
      .values({
        householdId: input.householdId,
        month: input.month,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        memberUserId: input.memberUserId,
        amountMinor: input.amountMinor,
      })
      .returning();
    return mapTransferConfirmation(row!);
  }

  async getTransferConfirmation(id: string): Promise<TransferConfirmation | null> {
    const [row] = await this.db
      .select()
      .from(s.transferConfirmations)
      .where(eq(s.transferConfirmations.id, id));
    return row ? mapTransferConfirmation(row) : null;
  }

  async listTransferConfirmations(
    householdId: string,
    month: string,
  ): Promise<TransferConfirmation[]> {
    const rows = await this.db
      .select()
      .from(s.transferConfirmations)
      .where(
        and(
          eq(s.transferConfirmations.householdId, householdId),
          eq(s.transferConfirmations.month, month),
        ),
      )
      .orderBy(asc(s.transferConfirmations.createdAt));
    return rows.map(mapTransferConfirmation);
  }

  async deleteTransferConfirmation(id: string): Promise<void> {
    // Linked contributions cascade via FK; stay explicit for parity with
    // MemoryStore semantics.
    await this.db.delete(s.contributions).where(eq(s.contributions.transferConfirmationId, id));
    await this.db.delete(s.transferConfirmations).where(eq(s.transferConfirmations.id, id));
  }

  async createMonthClose(input: NewMonthClose): Promise<MonthClose> {
    const [row] = await this.db
      .insert(s.monthCloses)
      .values({
        householdId: input.householdId,
        accountId: input.accountId,
        month: input.month,
        incomeMinor: input.incomeMinor,
        plannedMinor: input.plannedMinor,
        contributedMinor: input.contributedMinor,
        closedBy: input.closedBy,
      })
      .returning();
    return mapMonthClose(row!);
  }

  async getMonthCloseById(id: string): Promise<MonthClose | null> {
    const [row] = await this.db.select().from(s.monthCloses).where(eq(s.monthCloses.id, id));
    return row ? mapMonthClose(row) : null;
  }

  async getMonthClose(scope: MonthCloseScope, month: string): Promise<MonthClose | null> {
    const scopeCond =
      "householdId" in scope
        ? eq(s.monthCloses.householdId, scope.householdId)
        : eq(s.monthCloses.accountId, scope.accountId);
    const [row] = await this.db
      .select()
      .from(s.monthCloses)
      .where(and(scopeCond, eq(s.monthCloses.month, month)));
    return row ? mapMonthClose(row) : null;
  }

  async listMonthCloses(scope: MonthCloseScope): Promise<MonthClose[]> {
    const scopeCond =
      "householdId" in scope
        ? eq(s.monthCloses.householdId, scope.householdId)
        : eq(s.monthCloses.accountId, scope.accountId);
    const rows = await this.db
      .select()
      .from(s.monthCloses)
      .where(scopeCond)
      .orderBy(desc(s.monthCloses.month));
    return rows.map(mapMonthClose);
  }

  async deleteMonthClose(id: string): Promise<void> {
    await this.db.delete(s.monthCloses).where(eq(s.monthCloses.id, id));
  }

  private mapAccount(r: typeof s.accounts.$inferSelect): Account {
    return {
      id: r.id,
      ownerUserId: r.ownerUserId,
      name: r.name,
      description: r.description,
      currency: r.currency,
      openingBalanceMinor: r.openingBalanceMinor,
      monthlyBufferMinor: r.monthlyBufferMinor,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private mapIncome(r: typeof s.incomes.$inferSelect): Income {
    return {
      id: r.id,
      accountId: r.accountId,
      name: r.name,
      amountMinor: r.amountMinor,
      frequency: r.frequency as Frequency,
      recurrence: rec(r.recurrence),
      anchorDate: r.anchorDate,
      active: r.active,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private mapPayment(r: typeof s.payments.$inferSelect): Payment {
    return {
      id: r.id,
      accountId: r.accountId,
      name: r.name,
      category: r.category as PaymentCategory,
      amountMinor: r.amountMinor,
      dueDate: r.dueDate,
      recurrence: rec(r.recurrence),
      targetDate: r.targetDate,
      priority: r.priority,
      alreadySavedMinor: r.alreadySavedMinor,
      autoRenew: r.autoRenew,
      active: r.active,
      notes: r.notes,
      projectId: r.projectId,
      scope: r.scope as PaymentScope,
      bearerUserId: r.bearerUserId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private mapProject(r: typeof s.projects.$inferSelect): Project {
    return {
      id: r.id,
      ownerUserId: r.ownerUserId,
      name: r.name,
      description: r.description,
      color: r.color,
      targetDate: r.targetDate,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async createProject(input: NewProject): Promise<Project> {
    const [row] = await this.db
      .insert(s.projects)
      .values({
        ownerUserId: input.ownerUserId,
        name: input.name,
        description: input.description,
        color: input.color,
        targetDate: input.targetDate,
      })
      .returning();
    return this.mapProject(row!);
  }

  async getProject(id: string): Promise<Project | null> {
    const [row] = await this.db.select().from(s.projects).where(eq(s.projects.id, id));
    return row ? this.mapProject(row) : null;
  }

  async listProjectsForOwner(ownerUserId: string): Promise<Project[]> {
    const rows = await this.db
      .select()
      .from(s.projects)
      .where(eq(s.projects.ownerUserId, ownerUserId));
    return rows.map((r) => this.mapProject(r));
  }

  async updateProject(id: string, patch: Partial<NewProject>): Promise<Project | null> {
    const [row] = await this.db
      .update(s.projects)
      .set({ ...stripUndefined(patch), updatedAt: new Date() })
      .where(eq(s.projects.id, id))
      .returning();
    return row ? this.mapProject(row) : null;
  }

  async deleteProject(id: string): Promise<void> {
    // Member payments lose their link via the FK's ON DELETE SET NULL.
    await this.db.delete(s.projects).where(eq(s.projects.id, id));
  }

  async listPaymentsForProject(projectId: string): Promise<Payment[]> {
    const rows = await this.db.select().from(s.payments).where(eq(s.payments.projectId, projectId));
    return rows.map((r) => this.mapPayment(r));
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function mapContribution(r: typeof s.contributions.$inferSelect): Contribution {
  return {
    id: r.id,
    paymentId: r.paymentId,
    accountId: r.accountId,
    userId: r.userId,
    month: r.month,
    amountMinor: r.amountMinor,
    note: r.note,
    transferConfirmationId: r.transferConfirmationId,
    createdAt: r.createdAt.toISOString(),
  };
}

function mapBalanceSnapshot(r: typeof s.balanceSnapshots.$inferSelect): BalanceSnapshot {
  return {
    id: r.id,
    accountId: r.accountId,
    asOfDate: r.asOfDate,
    balanceMinor: r.balanceMinor,
    createdAt: r.createdAt.toISOString(),
  };
}

function mapTransferConfirmation(
  r: typeof s.transferConfirmations.$inferSelect,
): TransferConfirmation {
  return {
    id: r.id,
    householdId: r.householdId,
    month: r.month,
    fromAccountId: r.fromAccountId,
    toAccountId: r.toAccountId,
    memberUserId: r.memberUserId,
    amountMinor: r.amountMinor,
    createdAt: r.createdAt.toISOString(),
  };
}

function mapMonthClose(r: typeof s.monthCloses.$inferSelect): MonthClose {
  return {
    id: r.id,
    householdId: r.householdId,
    accountId: r.accountId,
    month: r.month,
    incomeMinor: r.incomeMinor,
    plannedMinor: r.plannedMinor,
    contributedMinor: r.contributedMinor,
    closedBy: r.closedBy,
    closedAt: r.closedAt.toISOString(),
  };
}
