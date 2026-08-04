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

export interface NewUser {
  email: string;
  /** Null for identity-provider (OIDC) accounts, which have no local password. */
  passwordHash: string | null;
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
export type NewContribution = Omit<Contribution, "id" | "createdAt">;
export type NewBalanceSnapshot = Omit<BalanceSnapshot, "id" | "createdAt">;
export type NewTransferConfirmation = Omit<TransferConfirmation, "id" | "createdAt">;
export type NewMonthClose = Omit<MonthClose, "id" | "closedAt">;

/** Per-payment all-time contribution total for one account. */
export interface ContributionTotal {
  paymentId: string;
  totalMinor: number;
}

/** Identifies whose scorecard a month close belongs to. */
export type MonthCloseScope = { householdId: string } | { accountId: string };

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
  /** Replace the user's local password hash (reset flow). */
  updateUserPassword(userId: string, passwordHash: string): Promise<void>;
  /** Turn the daily email digest on or off for one user. */
  setUserNotifyEmail(userId: string, on: boolean): Promise<void>;
  /** Everyone who has opted into email notifications. The notifier's work list. */
  listUsersWithNotifications(): Promise<User[]>;
  /**
   * Erase a user and everything that is theirs alone: their owned accounts (via
   * the deleteAccount cascade), their projects, the households they created,
   * their memberships elsewhere, sessions, tokens, recovery codes, notification
   * log, and finally the user row. Accounts merely *shared with* them are left
   * alone — those belong to their owners.
   */
  deleteUserCascade(userId: string): Promise<void>;

  // ---- two-factor ----
  /** Stage (or clear) the TOTP secret. Passing null also clears totpEnabledAt,
   *  so abandoning setup can never leave 2FA half-on. */
  setUserTotpSecret(userId: string, secret: string | null): Promise<void>;
  /** Mark two-factor live for the user (first valid code proven). */
  enableUserTotp(userId: string): Promise<void>;
  /** Swap the user's recovery codes for a fresh set. An empty array clears them. */
  replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void>;
  /** Unused recovery codes for a user; the caller verifies a presented code
   *  against each hash (they are salted, so lookup-by-hash is impossible). */
  listUnusedRecoveryCodes(userId: string): Promise<RecoveryCode[]>;
  /** Burn one recovery code. False when it is unknown or already spent. */
  consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean>;

  createSession(session: Omit<Session, "id" | "createdAt" | "revokedAt">): Promise<Session>;
  getSessionByTokenHash(hash: string): Promise<Session | null>;
  revokeSession(id: string): Promise<void>;
  /** Revoke every non-revoked session for a user. Drives refresh-token reuse
   *  detection — if a revoked token is presented again, nuke them all. */
  revokeAllUserSessions(userId: string): Promise<void>;

  createEmailVerificationToken(token: EmailVerificationToken): Promise<void>;
  consumeEmailVerificationToken(token: string): Promise<EmailVerificationToken | null>;

  createPasswordResetToken(token: PasswordResetToken): Promise<void>;
  /** Single-use: the row is removed on read. Expiry is passed through for the
   *  caller to judge (mirrors consumeEmailVerificationToken). */
  consumePasswordResetToken(token: string): Promise<PasswordResetToken | null>;

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

  // ---- contributions (dated money-set-aside ledger) ----
  createContribution(input: NewContribution): Promise<Contribution>;
  getContribution(id: string): Promise<Contribution | null>;
  /** Contributions on an account, optionally narrowed to one month
   *  (`month` = ISO date of the month's first day). Ordered oldest first. */
  listContributionsForAccount(accountId: string, month?: string): Promise<Contribution[]>;
  /** All-time contribution totals per payment for one account. */
  sumContributionsByPayment(accountId: string): Promise<ContributionTotal[]>;
  deleteContribution(id: string): Promise<void>;

  // ---- balance snapshots (manual check-ins) ----
  /** Insert or overwrite the snapshot for (account, asOfDate). */
  upsertBalanceSnapshot(input: NewBalanceSnapshot): Promise<BalanceSnapshot>;
  /** Snapshots for an account, ordered by asOfDate ascending. */
  listBalanceSnapshots(accountId: string): Promise<BalanceSnapshot[]>;

  // ---- transfer confirmations ----
  createTransferConfirmation(input: NewTransferConfirmation): Promise<TransferConfirmation>;
  getTransferConfirmation(id: string): Promise<TransferConfirmation | null>;
  /** Confirmations for a household in one month (ISO first-of-month date). */
  listTransferConfirmations(householdId: string, month: string): Promise<TransferConfirmation[]>;
  /** Deleting a confirmation also removes the contributions it created. */
  deleteTransferConfirmation(id: string): Promise<void>;

  // ---- month closes (frozen scorecards) ----
  createMonthClose(input: NewMonthClose): Promise<MonthClose>;
  getMonthCloseById(id: string): Promise<MonthClose | null>;
  getMonthClose(scope: MonthCloseScope, month: string): Promise<MonthClose | null>;
  /** Closes for a scope, newest month first. */
  listMonthCloses(scope: MonthCloseScope): Promise<MonthClose[]>;
  deleteMonthClose(id: string): Promise<void>;

  // ---- notification log (send-once guard) ----
  /**
   * Claim the right to send one notification. True the first time for a given
   * (user, date, kind); false ever after. Insert-on-conflict-do-nothing in
   * Postgres, so two notifiers racing still send exactly one message.
   */
  tryLogNotification(userId: string, date: string, kind: string): Promise<boolean>;

  // ---- calc snapshots ----
  saveSnapshot(snapshot: Omit<PlanSnapshot, "id" | "computedAt">): Promise<PlanSnapshot>;
}
