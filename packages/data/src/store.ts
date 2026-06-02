import type {
  Account,
  AccountShare,
  EmailVerificationToken,
  Household,
  HouseholdAccountAssignment,
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

export interface NewUser {
  email: string;
  passwordHash: string;
  displayName: string;
}

export interface NewAccount {
  ownerUserId: string;
  name: string;
  description?: string | null;
  currency: string;
  openingBalanceMinor?: number;
  monthlyBufferMinor?: number;
}

export type NewIncome = Omit<Income, "id" | "createdAt" | "updatedAt">;
export type NewPayment = Omit<Payment, "id" | "createdAt" | "updatedAt">;
export type NewProject = Omit<Project, "id" | "createdAt" | "updatedAt">;
export type NewAccountAssignment = Omit<
  HouseholdAccountAssignment,
  "id" | "createdAt" | "updatedAt"
>;

/** Effective access a user has to an account. */
export interface AccountAccess {
  accountId: string;
  permission: SharePermission;
  owner: boolean;
}

/**
 * Persistence boundary. Two implementations: MemoryStore (tests/dev) and
 * PgStore (Drizzle + Postgres). Methods are async so both satisfy one contract.
 */
export interface Store {
  // ---- users / sessions ----
  createUser(input: NewUser): Promise<User>;
  getUserById(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  setUserVerified(id: string): Promise<void>;

  createSession(session: Omit<Session, "id" | "createdAt" | "revokedAt">): Promise<Session>;
  getSessionByTokenHash(hash: string): Promise<Session | null>;
  revokeSession(id: string): Promise<void>;
  /** Revoke every non-revoked session for a user. Drives refresh-token reuse
   *  detection — if a revoked token is presented again, nuke them all. */
  revokeAllUserSessions(userId: string): Promise<void>;

  createEmailVerificationToken(token: EmailVerificationToken): Promise<void>;
  consumeEmailVerificationToken(token: string): Promise<EmailVerificationToken | null>;

  // ---- households / sharing ----
  createHousehold(name: string, createdBy: string): Promise<Household>;
  getHousehold(id: string): Promise<Household | null>;
  /** Hard-delete a household: removes its shares, memberships, then itself. */
  deleteHousehold(id: string): Promise<void>;
  listHouseholdsForUser(userId: string): Promise<Household[]>;
  addMembership(
    householdId: string,
    userId: string,
    role: HouseholdRole,
  ): Promise<HouseholdMembership>;
  getMembership(householdId: string, userId: string): Promise<HouseholdMembership | null>;
  listMembersForHousehold(householdId: string): Promise<HouseholdMembership[]>;
  removeMember(householdId: string, userId: string): Promise<void>;
  updateMembershipRole(
    householdId: string,
    userId: string,
    role: HouseholdRole,
  ): Promise<HouseholdMembership | null>;
  /** Set a member's proportional contribution share (basis points). */
  updateMembershipShare(
    householdId: string,
    userId: string,
    shareBp: number,
  ): Promise<HouseholdMembership | null>;

  // ---- household account assignments (plan roles) ----
  /** Create or update the account's role within a household (upsert on the
   *  (household, account) pair). */
  upsertAccountAssignment(input: NewAccountAssignment): Promise<HouseholdAccountAssignment>;
  listAccountAssignments(householdId: string): Promise<HouseholdAccountAssignment[]>;
  getAccountAssignment(
    householdId: string,
    accountId: string,
  ): Promise<HouseholdAccountAssignment | null>;
  deleteAccountAssignment(householdId: string, accountId: string): Promise<void>;

  createAccountShare(
    accountId: string,
    householdId: string,
    permission: SharePermission,
  ): Promise<AccountShare>;
  listSharesForAccount(accountId: string): Promise<AccountShare[]>;
  listSharesForHousehold(householdId: string): Promise<AccountShare[]>;
  deleteAccountShare(id: string): Promise<void>;

  /** Owned + shared accounts, with the user's effective permission. */
  listAccessibleAccounts(userId: string): Promise<AccountAccess[]>;
  getAccess(userId: string, accountId: string): Promise<AccountAccess | null>;

  // ---- accounts ----
  createAccount(input: NewAccount): Promise<Account>;
  getAccount(id: string): Promise<Account | null>;
  listAccountsForOwner(ownerUserId: string): Promise<Account[]>;
  updateAccount(id: string, patch: Partial<NewAccount>): Promise<Account | null>;
  deleteAccount(id: string): Promise<void>;

  // ---- incomes ----
  createIncome(input: NewIncome): Promise<Income>;
  getIncome(id: string): Promise<Income | null>;
  listIncomes(accountId: string): Promise<Income[]>;
  updateIncome(id: string, patch: Partial<NewIncome>): Promise<Income | null>;
  deleteIncome(id: string): Promise<void>;

  // ---- payments ----
  createPayment(input: NewPayment): Promise<Payment>;
  getPayment(id: string): Promise<Payment | null>;
  listPayments(accountId: string): Promise<Payment[]>;
  updatePayment(id: string, patch: Partial<NewPayment>): Promise<Payment | null>;
  deletePayment(id: string): Promise<void>;
  reorderPayments(accountId: string, orderedIds: string[]): Promise<void>;

  // ---- projects ----
  createProject(input: NewProject): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  listProjectsForOwner(ownerUserId: string): Promise<Project[]>;
  updateProject(id: string, patch: Partial<NewProject>): Promise<Project | null>;
  deleteProject(id: string): Promise<void>;
  listPaymentsForProject(projectId: string): Promise<Payment[]>;

  // ---- calc snapshots ----
  saveSnapshot(snapshot: Omit<PlanSnapshot, "id" | "computedAt">): Promise<PlanSnapshot>;
}
