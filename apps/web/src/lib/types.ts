export type Frequency = "monthly" | "yearly" | "custom" | "one_off";
export type PaymentCategory =
  | "monthly_recurring"
  | "yearly_recurring"
  | "custom_recurring"
  | "fixed_point";
export type PaymentScope = "shared" | "personal";
export type AccountRole = "shared" | "personal";

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
  /** Whether an authenticator app is enrolled. Optional so a payload from an
   *  older API (or a test fixture) still satisfies the type — absent reads as
   *  "not enabled". */
  totpEnabled?: boolean;
  /** Opt-in to the daily digest email. Optional for the same reason as
   *  totpEnabled — absent reads as "off". */
  notifyEmail?: boolean;
  households?: HouseholdDto[];
}

/** What this deployment has switched on. Public: asked before logging in. */
export interface MetaDto {
  demoSeedEnabled: boolean;
}

// --- auth: second factor, password reset, SSO --------------------------------

/** A completed login: an access token in memory plus the refresh cookie. */
export interface LoginSessionDto {
  accessToken: string;
  user: UserDto;
}

/** Credentials were right, but the account has 2FA — finish at /login/totp.
 *  `pendingToken` is short-lived and is never persisted anywhere. */
export interface TotpChallengeDto {
  totpRequired: true;
  pendingToken: string;
}

export type LoginResultDto = LoginSessionDto | TotpChallengeDto;

/** Shared secret to enter into an authenticator app, plus the otpauth:// URI. */
export interface TotpSetupDto {
  secret: string;
  otpauthUri: string;
}

/** The one and only time the recovery codes are readable. */
export interface TotpEnableDto {
  enabled: true;
  recoveryCodes: string[];
}

export interface TotpDisableDto {
  enabled: false;
}

/** Whether this deployment has an OIDC provider wired up. */
export type OidcMetaDto = { enabled: false } | { enabled: true; issuer: string };

export interface HouseholdDto {
  id: string;
  name: string;
}

export type HouseholdRole = "owner" | "admin" | "member";

export interface HouseholdMemberDto {
  membershipId: string;
  userId: string;
  role: HouseholdRole;
  /** Proportional contribution to shared costs, in basis points (0–10000). */
  shareBp: number;
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
  scope: PaymentScope;
  bearerUserId: string | null;
  /** Contribution-first goal: "set aside this much per month". fixed_point only;
   *  with one set the due date is optional. */
  fixedMonthlyMinor?: number | null;
  /** Free-text grouping label ("housing", "car", …). Never drives the maths. */
  tag?: string | null;
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
  /** Passthrough of the goal's monthly contribution cap (fixed_point only). */
  fixedMonthlyMinor?: number | null;
  /** Passthrough of the payment's grouping label, so charts can group without
   *  refetching the payments. */
  tag?: string | null;
}

/** Money already set aside toward a payment during the current month. */
export interface ContributionTotalDto {
  paymentId: string;
  amountMinor: number;
}

/** The most recent balance check-in on an account. */
export interface LatestBalanceDto {
  asOfDate: string;
  balanceMinor: number;
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
  /** Per-payment totals contributed this month — the "reality" half of the plan. */
  contributionsMTD: ContributionTotalDto[];
  /** Last manual balance check-in, or null when the account has never been reconciled. */
  latestBalance: LatestBalanceDto | null;
  /** Sum of every line's already-saved: what the plan believes is spoken for. */
  reservedMinor: number;
}

/**
 * The answer to "what would this do to my plan?": the account's plan as it
 * stands, alongside the plan it would have with the drafted payments/incomes
 * added. Both computed for the same as-of date; nothing is persisted.
 */
export interface PlanPreviewDto {
  base: AccountPlanDto;
  preview: AccountPlanDto;
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

// --- household plan ---------------------------------------------------------

export interface HouseholdAccountAssignmentDto {
  accountId: string;
  accountName: string;
  currency: string;
  role: AccountRole;
  memberUserId: string | null;
}

export interface MemberAllocationDto {
  userId: string;
  requiredMinor: number;
  fundedMinor: number;
}

export interface HouseholdPlanLineDto {
  paymentId: string;
  accountId: string;
  name: string;
  category: PaymentCategory;
  scope: PaymentScope;
  amountMinor: number;
  dueDate: string;
  targetDate: string;
  priority: number;
  requiredMonthlyMinor: number;
  fundedMonthlyMinor: number;
  occurrencesThisMonth: number;
  onTrack: boolean;
  /** Passthrough of the payment's grouping label, for charts. */
  tag?: string | null;
  allocations: MemberAllocationDto[];
}

export interface HouseholdMemberPlanDto {
  userId: string;
  displayName?: string;
  shareBp: number;
  monthlyIncomeMinor: number;
  obligationMinor: number;
  fundedMinor: number;
  leftoverMinor: number;
  shortfallMinor: number;
}

export interface HouseholdAccountPlanDto {
  accountId: string;
  name?: string;
  role: AccountRole;
  memberUserId: string | null;
  currency: string;
  monthlyIncomeMinor: number;
  requiredOutflowMinor: number;
  fundedOutflowMinor: number;
  transferInMinor: number;
  transferOutMinor: number;
  leftoverMinor: number;
  shortfallMinor: number;
}

export interface TransferDto {
  fromAccountId: string;
  toAccountId: string;
  memberUserId: string;
  amountMinor: number;
}

/** One payday, with the slices of the month's transfers that land on it. */
export interface PayEventDto {
  /** ISO date ("YYYY-MM-DD"). A member with no payday at all gets one synthetic
   *  event on the 1st, which the UI labels "start of month". */
  date: string;
  transfers: { fromAccountId: string; toAccountId: string; amountMinor: number }[];
  totalMinor: number;
}

/** Roster order; a member with no transfers to make has an empty `events`. */
export interface MemberPaydayScheduleDto {
  memberUserId: string;
  events: PayEventDto[];
}

export interface HouseholdPlanDto {
  householdId: string;
  asOfDate: string;
  currency: string;
  monthlyIncomeMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  leftoverMinor: number;
  shortfallMinor: number;
  members: HouseholdMemberPlanDto[];
  accounts: HouseholdAccountPlanDto[];
  lines: HouseholdPlanLineDto[];
  transfers: TransferDto[];
  /** When to move the money, not just how much. Optional so a plan served by an
   *  older API (or built in a test) still satisfies the type. */
  paydaySchedule?: MemberPaydayScheduleDto[];
}

// --- projections ------------------------------------------------------------
// The plan simulated month by month, so the UI can show where the money lands
// rather than only this month's slice.

export interface ProjectionLineDto {
  paymentId: string;
  name: string;
  category: PaymentCategory;
  requiredMonthlyMinor: number;
  fundedMonthlyMinor: number;
  /** Set aside for this payment at the end of the month, after any bill it paid. */
  alreadySavedEndMinor: number;
  dueThisMonth: boolean;
  /** amountMinor × occurrences this month; 0 when nothing falls due. */
  dueAmountMinor: number;
}

export interface MonthProjectionDto {
  /** "YYYY-MM". */
  month: string;
  monthlyIncomeMinor: number;
  bufferMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  leftoverMinor: number;
  shortfallMinor: number;
  reservedEndMinor: number;
  /** null on every month when the account has no balance check-in to start from. */
  projectedBalanceMinor: number | null;
  lines: ProjectionLineDto[];
}

export interface AccountProjectionDto {
  accountId: string;
  currency: string;
  asOfDate: string;
  months: MonthProjectionDto[];
}

export interface HouseholdProjectionLineDto extends ProjectionLineDto {
  accountId: string;
}

export interface HouseholdMonthProjectionDto {
  month: string;
  monthlyIncomeMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  leftoverMinor: number;
  shortfallMinor: number;
  /** Money members must move between accounts this month. */
  transfersTotalMinor: number;
  reservedEndMinor: number;
  lines: HouseholdProjectionLineDto[];
}

export interface HouseholdProjectionDto {
  householdId: string;
  currency: string;
  asOfDate: string;
  months: HouseholdMonthProjectionDto[];
}

// --- upcoming payments ------------------------------------------------------

/** One dated hit of a payment inside the look-ahead window. */
export interface UpcomingItemDto {
  paymentId: string;
  name: string;
  category: PaymentCategory;
  amountMinor: number;
  dueDate: string;
  /** Whole days from the as-of date; 0 means "today". */
  daysUntil: number;
  accountId: string;
  accountName: string;
  currency: string;
}

export interface UpcomingDto {
  asOfDate: string;
  /** The window the server actually used, after clamping. */
  days: number;
  items: UpcomingItemDto[];
}

// --- the reality loop ------------------------------------------------------
// Plans say what *should* happen; these record what *did*.

/** A dated record of money set aside toward a payment. */
export interface ContributionDto {
  id: string;
  paymentId: string;
  accountId: string;
  userId: string | null;
  /** ISO date of the first day of the month it belongs to ("YYYY-MM-01"). */
  month: string;
  amountMinor: number;
  note: string | null;
  /** Set when the contribution was created by confirming a household transfer. */
  transferConfirmationId: string | null;
  createdAt: string;
}

/** A manual balance check-in. One per account per day; newest day wins. */
export interface BalanceSnapshotDto {
  id: string;
  accountId: string;
  asOfDate: string;
  /** May be negative (overdraft). */
  balanceMinor: number;
  createdAt: string;
}

/** A member's confirmation that a planned monthly transfer was actually made. */
export interface TransferConfirmationDto {
  id: string;
  householdId: string;
  month: string;
  fromAccountId: string;
  toAccountId: string;
  memberUserId: string;
  amountMinor: number;
  createdAt: string;
}

/** A frozen month scorecard for a household or a standalone account. */
export interface MonthCloseDto {
  id: string;
  /** Exactly one of householdId / accountId is set. */
  householdId: string | null;
  accountId: string | null;
  month: string;
  incomeMinor: number;
  plannedMinor: number;
  contributedMinor: number;
  closedBy: string | null;
  closedAt: string;
}

/** POST /transfers/confirm returns the confirmation plus the contributions it booked. */
export interface ConfirmTransferResultDto {
  confirmation: TransferConfirmationDto;
  contributions: ContributionDto[];
}

// --- portability + demo data ------------------------------------------------

/** Rows an import created. Import is additive, so these are always creations,
 *  never updates. */
export interface ImportCountsDto {
  accounts: number;
  incomes: number;
  payments: number;
  contributions: number;
  balanceSnapshots: number;
  closes: number;
  projects: number;
}

/** Rows the demo seed planted. No projects or month closes in the worked
 *  example, so it is a narrower shape than an import. */
export interface DemoSeedCountsDto {
  accounts: number;
  incomes: number;
  payments: number;
  contributions: number;
  balanceSnapshots: number;
}
