export type Frequency = "monthly" | "yearly" | "custom" | "one_off";
export type PaymentCategory =
  | "monthly_recurring"
  | "yearly_recurring"
  | "custom_recurring"
  | "fixed_point";

export interface Recurrence {
  interval: number;
  unit: "day" | "week" | "month" | "year";
  anchor: string;
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  emailVerified?: boolean;
  households?: HouseholdDto[];
}

export interface HouseholdDto {
  id: string;
  name: string;
}

export type HouseholdRole = "owner" | "admin" | "member";

export interface HouseholdMemberDto {
  membershipId: string;
  userId: string;
  role: HouseholdRole;
  displayName: string;
  email: string;
  isSelf: boolean;
}

export interface HouseholdShareDto {
  shareId: string;
  accountId: string;
  accountName: string;
  currency: string;
  permission: "view" | "edit";
}

export interface HouseholdDetailDto {
  id: string;
  name: string;
  createdAt: string;
  yourRole: HouseholdRole;
  members: HouseholdMemberDto[];
  shares: HouseholdShareDto[];
}

export interface AccountDto {
  id: string;
  name: string;
  description?: string | null;
  currency: string;
  openingBalanceMinor: number;
  monthlyBufferMinor: number;
  permission?: "view" | "edit";
  owner?: boolean;
}

export interface IncomeDto {
  id: string;
  accountId: string;
  name: string;
  amountMinor: number;
  frequency: Frequency;
  recurrence: Recurrence | null;
  anchorDate: string;
  active: boolean;
}

export interface PaymentDto {
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
  projectId: string | null;
}

export interface ProjectDto {
  id: string;
  ownerUserId: string;
  name: string;
  description: string | null;
  color: string | null;
  targetDate: string | null;
}

export interface ProjectMemberPaymentDto {
  id: string;
  accountId: string;
  accountName: string;
  currency: string;
  name: string;
  category: PaymentCategory;
  amountMinor: number;
  alreadySavedMinor: number;
  dueDate: string | null;
}

export interface ProjectDetailDto extends ProjectDto {
  payments: ProjectMemberPaymentDto[];
}

export interface PlanLineDto {
  paymentId: string;
  name: string;
  category: PaymentCategory;
  amountMinor: number;
  dueDate: string;
  targetDate: string;
  monthsUntilDue: number;
  requiredMonthlyMinor: number;
  fundedMonthlyMinor: number;
  alreadySavedMinor: number;
  /** Times the payment falls due this month; >1 for sub-monthly recurrences. */
  occurrencesThisMonth?: number;
  onTrack: boolean;
  projectedCompletionDate?: string;
}

export interface AccountPlanDto {
  accountId: string;
  currency: string;
  monthlyIncomeMinor: number;
  bufferMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  leftoverMinor: number;
  shortfallMinor: number;
  lines: PlanLineDto[];
}

export interface CurrencyOverviewDto {
  currency: string;
  monthlyIncomeMinor: number;
  bufferMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  leftoverMinor: number;
  shortfallMinor: number;
  accounts: {
    accountId: string;
    leftoverMinor: number;
    shortfallMinor: number;
    atRiskCount: number;
  }[];
}

export interface OverviewDto {
  asOfDate: string;
  perCurrency: CurrencyOverviewDto[];
}
