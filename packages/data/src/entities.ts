import type { Frequency, PaymentCategory, Recurrence } from "@finance-planner/contracts";

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
  createdAt: string;
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
