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
  createdAt: string;
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
