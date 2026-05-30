import type { Frequency, PaymentCategory, Recurrence } from "@finance-planner/contracts";
import { and, eq } from "drizzle-orm";
import type { Database } from "./db.js";
import type {
  Account,
  AccountShare,
  EmailVerificationToken,
  Household,
  HouseholdMembership,
  HouseholdRole,
  Income,
  Payment,
  PlanSnapshot,
  Session,
  SharePermission,
  User,
  UserStatus,
} from "./entities.js";
import * as s from "./schema.js";
import type { AccountAccess, NewAccount, NewIncome, NewPayment, NewUser, Store } from "./store.js";

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
    // account_shares has no FK to households, so wipe them first; memberships
    // cascade automatically via the schema's ON DELETE CASCADE.
    await this.db.delete(s.accountShares).where(eq(s.accountShares.householdId, id));
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
    return {
      id: row!.id,
      householdId: row!.householdId,
      userId: row!.userId,
      role: row!.role as HouseholdRole,
      createdAt: row!.createdAt.toISOString(),
    };
  }

  async getMembership(householdId: string, userId: string): Promise<HouseholdMembership | null> {
    const [row] = await this.db
      .select()
      .from(s.memberships)
      .where(and(eq(s.memberships.householdId, householdId), eq(s.memberships.userId, userId)));
    if (!row) return null;
    return {
      id: row.id,
      householdId: row.householdId,
      userId: row.userId,
      role: row.role as HouseholdRole,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listMembersForHousehold(householdId: string): Promise<HouseholdMembership[]> {
    const rows = await this.db
      .select()
      .from(s.memberships)
      .where(eq(s.memberships.householdId, householdId));
    return rows.map((r) => ({
      id: r.id,
      householdId: r.householdId,
      userId: r.userId,
      role: r.role as HouseholdRole,
      createdAt: r.createdAt.toISOString(),
    }));
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
    if (!row) return null;
    return {
      id: row.id,
      householdId: row.householdId,
      userId: row.userId,
      role: row.role as HouseholdRole,
      createdAt: row.createdAt.toISOString(),
    };
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
    await this.db.delete(s.incomes).where(eq(s.incomes.accountId, id));
    await this.db.delete(s.payments).where(eq(s.payments.accountId, id));
    await this.db.delete(s.accountShares).where(eq(s.accountShares.accountId, id));
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
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
