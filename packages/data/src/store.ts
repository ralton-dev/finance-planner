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
  InflowSourceKind,
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

/** What an existing account will accept: a `NewAccount` minus the two things
 *  settled at creation — whose it is, and what money it is counted in. */
export type AccountPatch = Partial<Omit<NewAccount, "ownerUserId" | "currency">>;

export type NewIncome = Omit<Income, "id" | "createdAt" | "updatedAt">;
export type NewInflow = Omit<Inflow, "id" | "createdAt" | "updatedAt">;

/**
 * An inflow whose source and `sourceAccountId` disagree, or which funds itself.
 *
 * The database refuses both with CHECK constraints, but a store must not depend
 * on which implementation it is: MemoryStore has no constraints and PgStore's
 * would surface as an opaque driver error. Both raise this instead, so the rule
 * reads the same either side of the boundary and the contract test can pin it.
 */
export class InvalidInflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInflowError";
  }
}

/**
 * Enforce, in code, exactly what `core.inflows`' CHECK constraints enforce in
 * the database. Throws `InvalidInflowError`; returns nothing when the row is
 * well-formed.
 */
export function assertInflowShape(row: {
  accountId: string;
  source: InflowSourceKind;
  sourceAccountId: string | null;
}): void {
  if (row.source === "account" && !row.sourceAccountId) {
    throw new InvalidInflowError("An account-sourced inflow needs a sourceAccountId");
  }
  if (row.source !== "account" && row.sourceAccountId) {
    throw new InvalidInflowError("Only an account-sourced inflow may carry a sourceAccountId");
  }
  if (row.sourceAccountId && row.sourceAccountId === row.accountId) {
    throw new InvalidInflowError("An inflow cannot be sourced from the account it arrives in");
  }
}
export type NewPayment = Omit<Payment, "id" | "createdAt" | "updatedAt">;
/**
 * `visibility` is optional here and required nowhere else: a project is personal
 * unless it says otherwise, which is both the database's default
 * (`0014_shared_projects.sql`) and the only thing a caller who has never heard
 * of sharing can mean. Omitting it writes `"personal"`.
 */
export type NewProject = Omit<Project, "id" | "createdAt" | "updatedAt" | "visibility"> &
  Partial<Pick<Project, "visibility">>;
export type NewAccountAssignment = Omit<
  HouseholdAccountAssignment,
  "id" | "createdAt" | "updatedAt"
>;
export type NewContribution = Omit<Contribution, "id" | "createdAt">;
export type NewBalanceSnapshot = Omit<BalanceSnapshot, "id" | "createdAt">;
export type NewTransferConfirmation = Omit<TransferConfirmation, "id" | "createdAt">;
/**
 * `userId` and `currency` are optional here and required nowhere else: a
 * household or account close names neither, so writing one should not have to
 * say so twice. A user close names both — and the Store refuses one that names
 * a user without a currency, which is the rule `month_close_user_currency`
 * (0013) states in the database.
 */
export type NewMonthClose = Omit<MonthClose, "id" | "closedAt" | "userId" | "currency"> &
  Partial<Pick<MonthClose, "userId" | "currency">>;

/**
 * An external inflow seen through the income API's eyes — the same row, minus
 * the fields only a movement between accounts has. Callers filter to
 * `source === "external"` first; an account-sourced inflow has no income face.
 */
export function toIncome(i: Inflow): Income {
  return {
    id: i.id,
    accountId: i.accountId,
    name: i.name,
    amountMinor: i.amountMinor,
    frequency: i.frequency,
    recurrence: i.recurrence,
    anchorDate: i.anchorDate,
    active: i.active,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

/** Per-payment all-time contribution total for one account. */
export interface ContributionTotal {
  paymentId: string;
  totalMinor: number;
}

/**
 * Identifies whose scorecard a month close belongs to.
 *
 * A user's closes are keyed by currency as well, because closing a month closes
 * every partition they hold at once. Naming the currency asks about one
 * partition; leaving it off asks the scope-level question — "is this month
 * closed for me at all" — and answers with the lowest currency code's row, so
 * two callers asking the same thing get the same row.
 */
export type MonthCloseScope =
  | { householdId: string }
  | { accountId: string }
  | { userId: string; currency?: string };

/** Effective access a user has to an account. */
export interface AccountAccess {
  accountId: string;
  permission: SharePermission;
  owner: boolean;
}

/**
 * Refusal to put one user in a second household.
 *
 * A user belongs to exactly one household — product direction, and the thing
 * that keeps a scope's member vector single-valued (see
 * `db/migrations/0011_one_household_per_user.sql`). This is raised by
 * `createHousehold` and `addMembership`, which are the only two ways in.
 *
 * It carries `validation` because that is the one hook both services'
 * error handlers already share. `apps/api` and `apps/auth` each define their
 * own private `HttpError`, so neither can recognise the other's — but both
 * answer `422 validation_error` with this message for any error carrying
 * `validation`, and unprocessable is exactly what such a request is. Without
 * it a perfectly ordinary "they are already in a household" would surface as a
 * 500, and the auth service's add-member route is not ours to edit.
 */
export class HouseholdExclusivityError extends Error {
  /** Fastify's marker for "the request did not validate". See above. */
  readonly validation = true;

  constructor(
    readonly userId: string,
    /** The household they are already in. */
    readonly householdId: string,
  ) {
    super("That user already belongs to a household; they must leave it before joining another.");
    this.name = "HouseholdExclusivityError";
  }
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
  /**
   * Found a household, with the founder as its owner.
   *
   * Throws `HouseholdExclusivityError` when the founder is already in one, and
   * throws it **before** the household row is written, so a refused call leaves
   * nothing behind: `createHousehold` is `addMembership` with a household
   * attached, and a household whose founder could not join it would be an
   * orphan nobody could reach or delete.
   */
  createHousehold(name: string, createdBy: string): Promise<Household>;
  getHousehold(id: string): Promise<Household | null>;
  /**
   * Hard-delete a household: dissolves what every member held through it (see
   * `removeMember`), then its shares, assignments, confirmations, closes,
   * memberships, and itself.
   */
  deleteHousehold(id: string): Promise<void>;
  /**
   * The user's household, as a list of at most one.
   *
   * Still a list, and deliberately. The rule is enforced from
   * `0011_one_household_per_user.sql` forward, not retroactively — no migration
   * may delete the rows of an instance that predates it — so data written
   * before then can still hold a second membership, and every reader takes the
   * first in a stable order rather than pretending the second cannot exist.
   */
  listHouseholdsForUser(userId: string): Promise<Household[]>;
  /**
   * Add a user to a household.
   *
   * Throws `HouseholdExclusivityError` when they already belong to a different
   * one: a user is in exactly one household, and the way into a second is out
   * of the first. Re-adding someone to the household they are already in is
   * not this rule's business (the auth service answers 409 for it).
   */
  addMembership(
    householdId: string,
    userId: string,
    role: HouseholdRole,
  ): Promise<HouseholdMembership>;
  getMembership(householdId: string, userId: string): Promise<HouseholdMembership | null>;
  listMembersForHousehold(householdId: string): Promise<HouseholdMembership[]>;
  /**
   * Take a member out of a household, and dissolve what they held through it.
   *
   * "You don't get to keep any of the household's benefits if you leave" (Ben,
   * 2026-08-04), and the household does not get to keep theirs either. In
   * order — each step still true of a member, so a failure part-way leaves the
   * household smaller but never leaves a non-member's money attached to it:
   *
   *  1. **Their shared projects come back personal.** Every project the leaver
   *     owns that is `shared` drops the payments on accounts they do not own,
   *     and flips to `personal`. Steps 3 and 4 dissolve what the household held
   *     of the leaver; this dissolves what the leaver held of the household —
   *     without it an ex-member keeps a live window, payment names and amounts,
   *     into a household they are no longer in (Ben, 2026-08-05, MINE-AND-OURS
   *     decision 23). Flipping to `personal` also stops a household they later
   *     join from inheriting a still-"shared" project full of stale links,
   *     since "shared" resolves through the owner's membership on the day it is
   *     read; a re-share must pass the personal→shared gate like any other.
   *
   *     **First, and that ordering is load-bearing.** Step 4 clears each
   *     unshared account's payments out of every *shared* project, so a project
   *     still shared at that moment would lose the leaver's own payments on
   *     their own accounts too. Personal by then, it keeps them — which is what
   *     "you keep your projects" has to mean to mean anything.
   *  2. **Movements across the boundary are deactivated.** An account-sourced
   *     inflow with one end owned by the leaver and the other owned by another
   *     member existed only because the household's share grant made both ends
   *     editable by one person. Deactivated rather than deleted: an inactive
   *     inflow is not a funding edge and funds nothing, so the forward-looking
   *     claim dissolves, while the row and every confirmation and contribution
   *     hanging off it survive — deleting it would cascade those away and make
   *     the ledger lie about money that really did move.
   *  3. **Plan roles go.** The household's assignments for the leaver's
   *     accounts, and any assignment naming them as its personal member.
   *  4. **Access grants go, and take their project links with them.** Shares of
   *     the leaver's accounts into the household, each followed by
   *     `clearProjectLinksForAccount` — an account that is no longer shared into
   *     the household has no business in anybody's shared project (decision 23).
   *     Accounts shared the *other* way need nothing: the leaver's access to
   *     them was only ever their membership.
   *  5. **The membership row goes.** The commit point.
   *
   * Retained throughout: transfer confirmations, contributions and month
   * closes. Those record what happened, and what happened does not stop having
   * happened.
   */
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
  /**
   * Withdraw an account from a household — and, with it, that account's
   * payments from every **shared** project (`clearProjectLinksForAccount`).
   *
   * A shared project may only hold payments on accounts shared into the
   * household, which is what makes showing every payment with its account name
   * leak nothing: every viewer already has access. Take the access away and the
   * payment has to go with it, or the leak reopens silently (Ben, 2026-08-05,
   * MINE-AND-OURS decision 23). Personal projects are untouched — there is no
   * leak to prevent in a project only its owner can read.
   */
  deleteAccountShare(id: string): Promise<void>;

  /** Owned + shared accounts, with the user's effective permission. */
  listAccessibleAccounts(userId: string): Promise<AccountAccess[]>;
  getAccess(userId: string, accountId: string): Promise<AccountAccess | null>;

  // ---- accounts ----
  createAccount(input: NewAccount): Promise<Account>;
  getAccount(id: string): Promise<Account | null>;
  listAccountsForOwner(ownerUserId: string): Promise<Account[]>;
  /**
   * Everything about an account is editable except its `currency`, which is
   * fixed when the account is created and never afterwards (Ben, 2026-08-05).
   * The rule is stated in the type so the API is not the only thing holding it:
   * the pass plans per currency, and an account that changes the money it is
   * denominated in moves between partitions under a plan that has already
   * refused to author anything crossing between them.
   *
   * `db/migrations/0012_account_currency_is_fixed.sql` is the floor under this,
   * for writes that never come through a Store at all.
   */
  updateAccount(id: string, patch: AccountPatch): Promise<Account | null>;
  deleteAccount(id: string): Promise<void>;

  // ---- inflows (money arriving, whatever its source) ----
  /** Rejects a malformed row with `InvalidInflowError` — see
   *  `assertInflowShape` for the three rules, which mirror the DB CHECKs. */
  createInflow(input: NewInflow): Promise<Inflow>;
  getInflow(id: string): Promise<Inflow | null>;
  /** Inflows **arriving into** an account — external and account-sourced alike.
   *  Ordered by priority, then creation, so a plan is deterministic. */
  listInflows(accountId: string): Promise<Inflow[]>;
  /**
   * Inflows **leaving** an account: the same rows `listInflows` returns to the
   * receiving account, read from the sending end. One authored row, two sides —
   * so a movement can never be half-recorded.
   */
  listOutboundInflows(accountId: string): Promise<Inflow[]>;
  /** Patches are validated as a whole, so a patch cannot leave the row in a
   *  shape `createInflow` would have refused. */
  updateInflow(id: string, patch: Partial<NewInflow>): Promise<Inflow | null>;
  deleteInflow(id: string): Promise<void>;

  // ---- incomes (external inflows, in the shape the income API speaks) ----
  // These are a projection of `inflows` where source = 'external'; there is no
  // separate income storage. An account-sourced inflow is invisible here on
  // purpose — the income API must not be able to reach one.
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
  /**
   * What this user **owns** — every project of theirs, shared or not.
   *
   * Deliberately kept beside `listProjectsForUser` rather than superseded by
   * it: they answer two different questions, and the export needs this one. A
   * backup is of your own things, so it must not carry a co-member's shared
   * project (`apps/api/src/portability.ts:211`).
   */
  listProjectsForOwner(ownerUserId: string): Promise<Project[]>;
  /**
   * What this user can **see**: every project they own, plus the `shared`
   * projects owned by a co-member of their household.
   *
   * Membership is read here and now — a shared project's audience is not stored
   * anywhere (see `ProjectVisibility`), so an owner with no household shares
   * with nobody, and the answer changes the moment somebody joins or leaves.
   * Ordered oldest first, so two implementations agree row for row.
   */
  listProjectsForUser(userId: string): Promise<Project[]>;
  updateProject(id: string, patch: Partial<NewProject>): Promise<Project | null>;
  deleteProject(id: string): Promise<void>;
  listPaymentsForProject(projectId: string): Promise<Payment[]>;
  /**
   * Take this account's payments out of every **shared** project, leaving the
   * payments themselves intact — the same unlinking `deleteProject` does, over a
   * different set.
   *
   * Called wherever an account stops being visible to a household: a share
   * deleted, a member removed, a household deleted. **Shared** projects only,
   * and that scoping is what lets a leaver keep their own payments in their own
   * project: by the time this runs on their behalf, the departure cascade has
   * already flipped their projects to `personal` (see `removeMember`, step 1).
   */
  clearProjectLinksForAccount(accountId: string): Promise<void>;

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
  /**
   * Record a movement. Rejects a second confirmation of the same thing in the
   * same month: for a household row that is the same member's same transfer,
   * for an authored row the same inflow, for a derived row (no household, no
   * inflow) the same `(from, to, month, member)` — the three unique keys the
   * database enforces (`transfer_confirmation_unique`,
   * `transfer_confirmations_inflow_month_unique` and
   * `transfer_confirmations_derived_month_unique`).
   */
  createTransferConfirmation(input: NewTransferConfirmation): Promise<TransferConfirmation>;
  getTransferConfirmation(id: string): Promise<TransferConfirmation | null>;
  /** Confirmations for a household in one month (ISO first-of-month date). */
  listTransferConfirmations(householdId: string, month: string): Promise<TransferConfirmation[]>;
  /**
   * Confirmations of **authored inflows** touching an account in one month,
   * from either side: money that arrived here and money that left here are the
   * same row read two ways.
   *
   * Household-derived confirmations are not here — they confirm a transfer the
   * plan derived rather than an inflow anyone authored, and they are read
   * through `listTransferConfirmations`. Asking this question needs no
   * household, which is the point: "has this movement happened?" is a fact
   * about two accounts.
   */
  listTransferConfirmationsForAccount(
    accountId: string,
    month: string,
  ): Promise<TransferConfirmation[]>;
  /**
   * Confirmations of **derived transfers** touching an account in one month,
   * from either side — the rows carrying neither a household nor an inflow.
   *
   * These are the feeds the plan works out for itself: an expense pot with no
   * income of its own, fed from the member's source account, for a scope no
   * household applies to. Nobody authored the movement, so there is no inflow
   * to ask about; the question is the same one `listTransferConfirmationsForAccount`
   * asks and the answer is a fact about two accounts and a month.
   *
   * Deliberately its own method rather than a widening of the authored list: a
   * derived feed and an authored movement between the same two accounts are
   * two different movements, each confirmed on its own, and a caller totalling
   * both must be able to see them apart.
   */
  listDerivedTransferConfirmationsForAccount(
    accountId: string,
    month: string,
  ): Promise<TransferConfirmation[]>;
  /** Deleting a confirmation also removes the contributions it created. */
  deleteTransferConfirmation(id: string): Promise<void>;

  // ---- month closes (frozen scorecards) ----
  /**
   * Rejects a second close of the same scope and month — of the same
   * *currency* too, for a user scope, since one month there is one row per
   * partition. Rejects a user close that names no currency.
   */
  createMonthClose(input: NewMonthClose): Promise<MonthClose>;
  getMonthCloseById(id: string): Promise<MonthClose | null>;
  getMonthClose(scope: MonthCloseScope, month: string): Promise<MonthClose | null>;
  /** Closes for a scope, newest month first, currency ascending within a month. */
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
