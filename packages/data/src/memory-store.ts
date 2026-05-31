import { randomUUID } from "node:crypto";
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
  Project,
  Session,
  SharePermission,
  User,
} from "./entities.js";
import type {
  AccountAccess,
  NewAccount,
  NewIncome,
  NewPayment,
  NewProject,
  NewUser,
  Store,
} from "./store.js";

const now = (): string => new Date().toISOString();

/** In-memory Store for tests and DB-less local dev. Not for production. */
export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private sessions = new Map<string, Session>();
  private verifyTokens = new Map<string, EmailVerificationToken>();
  private households = new Map<string, Household>();
  private memberships = new Map<string, HouseholdMembership>();
  private shares = new Map<string, AccountShare>();
  private accounts = new Map<string, Account>();
  private incomes = new Map<string, Income>();
  private payments = new Map<string, Payment>();
  private projects = new Map<string, Project>();
  private snapshots = new Map<string, PlanSnapshot>();

  async createUser(input: NewUser): Promise<User> {
    const user: User = {
      id: randomUUID(),
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      status: "active",
      emailVerified: false,
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

  async createHousehold(name: string, createdBy: string): Promise<Household> {
    const h: Household = { id: randomUUID(), name, createdBy, createdAt: now() };
    this.households.set(h.id, h);
    await this.addMembership(h.id, createdBy, "owner");
    return h;
  }

  async getHousehold(id: string): Promise<Household | null> {
    return this.households.get(id) ?? null;
  }

  async deleteHousehold(id: string): Promise<void> {
    for (const [k, s] of this.shares) if (s.householdId === id) this.shares.delete(k);
    for (const [k, m] of this.memberships) if (m.householdId === id) this.memberships.delete(k);
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
    const m: HouseholdMembership = {
      id: randomUUID(),
      householdId,
      userId,
      role,
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
    for (const [k, m] of this.memberships) {
      if (m.householdId === householdId && m.userId === userId) this.memberships.delete(k);
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

  async updateAccount(id: string, patch: Partial<NewAccount>): Promise<Account | null> {
    const a = this.accounts.get(id);
    if (!a) return null;
    const updated: Account = {
      ...a,
      name: patch.name ?? a.name,
      description: patch.description === undefined ? a.description : patch.description,
      currency: patch.currency ?? a.currency,
      openingBalanceMinor: patch.openingBalanceMinor ?? a.openingBalanceMinor,
      monthlyBufferMinor: patch.monthlyBufferMinor ?? a.monthlyBufferMinor,
      updatedAt: now(),
    };
    this.accounts.set(id, updated);
    return updated;
  }

  async deleteAccount(id: string): Promise<void> {
    this.accounts.delete(id);
    for (const [k, v] of this.incomes) if (v.accountId === id) this.incomes.delete(k);
    for (const [k, v] of this.payments) if (v.accountId === id) this.payments.delete(k);
    for (const [k, v] of this.shares) if (v.accountId === id) this.shares.delete(k);
  }

  async createIncome(input: NewIncome): Promise<Income> {
    const ts = now();
    const income: Income = { ...input, id: randomUUID(), createdAt: ts, updatedAt: ts };
    this.incomes.set(income.id, income);
    return income;
  }

  async getIncome(id: string): Promise<Income | null> {
    return this.incomes.get(id) ?? null;
  }

  async listIncomes(accountId: string): Promise<Income[]> {
    return [...this.incomes.values()].filter((i) => i.accountId === accountId);
  }

  async updateIncome(id: string, patch: Partial<NewIncome>): Promise<Income | null> {
    const i = this.incomes.get(id);
    if (!i) return null;
    const updated: Income = { ...i, ...patch, id: i.id, updatedAt: now() };
    this.incomes.set(id, updated);
    return updated;
  }

  async deleteIncome(id: string): Promise<void> {
    this.incomes.delete(id);
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
  }

  async reorderPayments(accountId: string, orderedIds: string[]): Promise<void> {
    orderedIds.forEach((id, index) => {
      const p = this.payments.get(id);
      if (p && p.accountId === accountId) {
        this.payments.set(id, { ...p, priority: index + 1, updatedAt: now() });
      }
    });
  }

  async saveSnapshot(snapshot: Omit<PlanSnapshot, "id" | "computedAt">): Promise<PlanSnapshot> {
    const full: PlanSnapshot = { ...snapshot, id: randomUUID(), computedAt: now() };
    this.snapshots.set(full.id, full);
    return full;
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
