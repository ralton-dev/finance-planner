import type {
  AccountRole,
  Frequency,
  PaymentCategory,
  PaymentScope,
  Recurrence,
} from "@finance-planner/contracts";

export type UserStatus = "active" | "invited" | "disabled";
export type SharePermission = "view" | "edit";
export type HouseholdRole = "owner" | "admin" | "member";

export interface User {
  id: string;
  email: string;
  passwordHash: string | null;
  displayName: string;
  status: UserStatus;
  emailVerified: boolean;
  /** Base32 TOTP shared secret. Set at enrolment; cleared when 2FA is removed. */
  totpSecret: string | null;
  /** When two-factor became mandatory for this user. Null while a secret is
   *  merely staged (setup started but the first code hasn't been proven). */
  totpEnabledAt: string | null;
  /** Opt-in to the daily email digest. Off until the user asks for it. */
  notifyEmail: boolean;
  createdAt: string;
}

/** A single-use fallback for when the authenticator app is gone. Stored hashed. */
export interface RecoveryCode {
  id: string;
  userId: string;
  codeHash: string;
  usedAt: string | null;
  createdAt: string;
}

/** Short-lived "set a new password" ticket, mailed as a link. */
export interface PasswordResetToken {
  token: string;
  userId: string;
  expiresAt: string;
}

export interface Session {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface EmailVerificationToken {
  token: string;
  userId: string;
  expiresAt: string;
}

export interface Household {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

export interface HouseholdMembership {
  id: string;
  householdId: string;
  userId: string;
  role: HouseholdRole;
  /** Proportional contribution to shared costs, in basis points (0–10000).
   *  Normalised against the household total by the plan engine. */
  contributionShareBp: number;
  createdAt: string;
}

/**
 * Assigns an account a role within a household plan: a shared pot, or personal
 * to one member. Distinct from `AccountShare` (which grants view/edit access);
 * this drives cost attribution + transfer computation in the engine.
 */
export interface HouseholdAccountAssignment {
  id: string;
  householdId: string;
  accountId: string;
  role: AccountRole;
  /** Set when role === "personal": the member who owns this account. */
  memberUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountShare {
  id: string;
  accountId: string;
  householdId: string;
  permission: SharePermission;
  createdAt: string;
}

export interface Account {
  id: string;
  ownerUserId: string;
  name: string;
  description: string | null;
  currency: string;
  openingBalanceMinor: number;
  monthlyBufferMinor: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where money arriving into an account comes from.
 *
 * `external` is the old `Income`: salary, gift, interest — money entering the
 * estate. `account` is another account the same person owns, which is not income
 * at all but redistribution of money already counted once. Only `external` adds
 * to the total money in.
 */
export type InflowSourceKind = "external" | "account";

/**
 * Money arriving into an account, authored by the user and symmetric with a
 * payment.
 *
 * An `account`-sourced inflow is **one row with two faces**: it arrives on
 * `accountId` and leaves `sourceAccountId`. It is never two records — two could
 * drift, one cannot.
 */
export interface Inflow {
  id: string;
  /** The account the money arrives into. */
  accountId: string;
  name: string;
  source: InflowSourceKind;
  /** The account the money leaves. Set exactly when `source === "account"`,
   *  null otherwise; never equal to `accountId`. */
  sourceAccountId: string | null;
  amountMinor: number;
  frequency: Frequency;
  recurrence: Recurrence | null;
  anchorDate: string;
  /** Rank among the *sending* account's outbound inflows, lower first. Carried
   *  for every row but only meaningful when `source === "account"` — nothing
   *  sends an external inflow. */
  priority: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * An external inflow, in the shape the income API has always spoken.
 *
 * There is no `core.incomes` behind this any more: an income *is* an
 * `Inflow` with `source: "external"`, and the store projects one onto the
 * other. Kept as its own type because the HTTP contract, the export format and
 * the web client all still call it an income.
 */
export interface Income {
  id: string;
  accountId: string;
  name: string;
  amountMinor: number;
  frequency: Frequency;
  recurrence: Recurrence | null;
  anchorDate: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  accountId: string;
  name: string;
  category: PaymentCategory;
  amountMinor: number;
  dueDate: string | null;
  recurrence: Recurrence | null;
  targetDate: string | null;
  priority: number;
  alreadySavedMinor: number;
  autoRenew: boolean;
  active: boolean;
  notes: string | null;
  /** Optional grouping into a cross-account project. */
  projectId: string | null;
  /** Household cost-sharing: "shared" (split by share) or "personal". */
  scope: PaymentScope;
  /** When scope === "personal": the member who bears it. Null falls back to the
   *  owning member of a personal account at compute time. */
  bearerUserId: string | null;
  /** Contribution-first goals: the monthly amount the user commits to setting
   *  aside. Only meaningful for category "fixed_point"; the engine ignores it
   *  elsewhere. Null = derive the contribution from the date, as before. */
  fixedMonthlyMinor: number | null;
  /** Free-text grouping label ("housing", "car", …) for charts. */
  tag: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Whose a project is: one person's, or their household's.
 *
 * "shared" carries no household id, deliberately. A user belongs to exactly one
 * household (`0011_one_household_per_user.sql`), so the audience resolves
 * through the owner's membership **at read time** — a stored id would be a
 * second copy of a fact that changes underneath it when the owner leaves, is
 * removed, or joins another. A shared project whose owner has no household is
 * shared with nobody, which is what reading through the membership says on the
 * day it is read.
 */
export type ProjectVisibility = "personal" | "shared";

export interface Project {
  id: string;
  ownerUserId: string;
  name: string;
  description: string | null;
  color: string | null;
  targetDate: string | null;
  /** Personal, or shared into the owner's household. See `ProjectVisibility`
   *  for why there is no household id beside it. */
  visibility: ProjectVisibility;
  createdAt: string;
  updatedAt: string;
}

export interface PlanSnapshot {
  id: string;
  accountId: string;
  computedAt: string;
  asOfDate: string;
  inputsHash: string;
  detail: unknown;
}

/**
 * A dated record of money set aside toward a payment. A payment's effective
 * already-saved = its manual base (`Payment.alreadySavedMinor`) + the sum of
 * its contributions.
 */
export interface Contribution {
  id: string;
  paymentId: string;
  accountId: string;
  /** Whose money / who recorded it. Null for single-user flows. */
  userId: string | null;
  /** ISO date of the first day of the month this belongs to. */
  month: string;
  amountMinor: number;
  note: string | null;
  /** Set when created by confirming a household transfer; deleting the
   *  confirmation cascades to these rows. */
  transferConfirmationId: string | null;
  createdAt: string;
}

/** A manual balance check-in. One per account per day; newest day wins. */
export interface BalanceSnapshot {
  id: string;
  accountId: string;
  asOfDate: string;
  /** May be negative (overdraft). */
  balanceMinor: number;
  createdAt: string;
}

/**
 * "I moved this month's money" — one recorded movement between two accounts.
 *
 * It comes in three shapes, and the pair of nullable attribution fields is
 * which:
 *
 * - **Household**: `householdId` set, `inflowId` null. One member's share of a
 *   transfer the household plan derived.
 * - **Authored**: `inflowId` set, `householdId` null. An account-sourced
 *   inflow (`Inflow.source === "account"`) you authored and then acted on —
 *   money moved between two accounts you own, which no household is part of.
 * - **Derived**: both null. A transfer the plan derived for a scope with no
 *   household — an expense pot fed from the member's source account, which
 *   nobody authored and no household attributes.
 *
 * A movement attributed to a household *and* authored as an inflow may set
 * both. Neither field locates the movement, though: every row is scoped by
 * `(fromAccountId, toAccountId, month, memberUserId)`, which is what the
 * derived shape leans on and what the database's `transfer_confirmation_scope`
 * constraint states since 0010. `memberUserId` is never null: it is the actor,
 * and a solo movement still has one.
 */
export interface TransferConfirmation {
  id: string;
  /** The household attributing this movement, when one does. */
  householdId: string | null;
  /** The account-sourced inflow this confirms, when it confirms one. */
  inflowId: string | null;
  /** ISO date of the first day of the month. */
  month: string;
  fromAccountId: string;
  toAccountId: string;
  /** Who moved it — a household member, or just the person who owns both ends. */
  memberUserId: string;
  amountMinor: number;
  createdAt: string;
}

/**
 * One row per notification actually sent. The (userId, date, kind) key is the
 * idempotency guard: a second attempt on the same day for the same kind is
 * refused by the unique index rather than by the sender remembering.
 */
export interface NotificationLogEntry {
  id: string;
  userId: string;
  /** ISO date (local day) the notification covers. */
  date: string;
  /** What was sent, e.g. "daily_digest". */
  kind: string;
  createdAt: string;
}

/** A frozen month scorecard for a user, a household, or a standalone account. */
export interface MonthClose {
  id: string;
  /** Exactly one of householdId / accountId / userId is set. */
  householdId: string | null;
  accountId: string | null;
  /** Whose month this scores — the scope a close is written with today. */
  userId: string | null;
  /**
   * Which currency partition it scores. Required of a user close (planning
   * partitions by currency, so a scorecard has to say which one it read); null
   * on the two location scopes, which never partitioned.
   */
  currency: string | null;
  /** ISO date of the first day of the closed month. */
  month: string;
  incomeMinor: number;
  plannedMinor: number;
  contributedMinor: number;
  closedBy: string | null;
  closedAt: string;
}
