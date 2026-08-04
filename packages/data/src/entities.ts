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

export interface Project {
  id: string;
  ownerUserId: string;
  name: string;
  description: string | null;
  color: string | null;
  targetDate: string | null;
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

/** A member's confirmation that a planned monthly transfer was made. */
export interface TransferConfirmation {
  id: string;
  householdId: string;
  /** ISO date of the first day of the month. */
  month: string;
  fromAccountId: string;
  toAccountId: string;
  memberUserId: string;
  amountMinor: number;
  createdAt: string;
}

/** A frozen month scorecard for a household or a standalone account. */
export interface MonthClose {
  id: string;
  /** Exactly one of householdId / accountId is set. */
  householdId: string | null;
  accountId: string | null;
  /** ISO date of the first day of the closed month. */
  month: string;
  incomeMinor: number;
  plannedMinor: number;
  contributedMinor: number;
  closedBy: string | null;
  closedAt: string;
}
