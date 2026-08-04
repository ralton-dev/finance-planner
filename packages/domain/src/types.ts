import type { Frequency, PaymentCategory, Recurrence } from "@finance-planner/contracts";

/** An income stream on an account. Amounts in integer minor units. */
export interface IncomeInput {
  id: string;
  amountMinor: number;
  frequency: Frequency;
  recurrence?: Recurrence | null;
  /** ISO date (YYYY-MM-DD) of the first/next occurrence. */
  anchorDate: string;
  active?: boolean;
}

/** A payment (outgoing) on an account. Amounts in integer minor units. */
export interface PaymentInput {
  id: string;
  name: string;
  category: PaymentCategory;
  amountMinor: number;
  /** ISO date. Required for fixed_point; next due date for recurring. */
  dueDate?: string | null;
  recurrence?: Recurrence | null;
  /** Optional override of "by when" the goal must be met (defaults to dueDate). */
  targetDate?: string | null;
  /** Lower is funded first when income is short. Defaults to 100. */
  priority?: number;
  alreadySavedMinor?: number;
  autoRenew?: boolean;
  active?: boolean;
  /**
   * Contribution-first goal: "set aside this much per month". Honoured **only**
   * for category "fixed_point" — every other category is a bill with a real
   * deadline, so the engine ignores the cap there. With a cap set the dueDate
   * becomes optional; see `requiredMonthlyForPayment`.
   */
  fixedMonthlyMinor?: number | null;
  /** Free-text grouping label ("housing", "car", …). Never drives the maths. */
  tag?: string | null;
}

export interface AccountInput {
  accountId: string;
  currency: string;
  /** Optional monthly amount reserved off the top before funding goals. */
  monthlyBufferMinor?: number;
  incomes: IncomeInput[];
  payments: PaymentInput[];
}

/** Computed plan line for a single payment. */
export interface PaymentPlanLine {
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
  /** Times this payment falls due within the as-of month. Usually 1; a
   *  sub-monthly custom cadence (e.g. every 2 weeks) can be 2 or 3. */
  occurrencesThisMonth: number;
  onTrack: boolean;
  /**
   * When the goal actually finishes, if that is worth saying: the pace-derived
   * date for an underfunded line, or — for a contribution-capped goal with a
   * date it will not make — the date the cap really lands on.
   */
  projectedCompletionDate?: string;
  /** Passthrough of the goal's monthly contribution cap (fixed_point only). */
  fixedMonthlyMinor?: number | null;
  /** Passthrough of the payment's grouping label, so charts can group without
   *  refetching the payments. */
  tag?: string | null;
}

/** Full computed plan for an account, as of a reference date. */
export interface AccountPlan {
  accountId: string;
  asOfDate: string;
  currency: string;
  monthlyIncomeMinor: number;
  /** Monthly amount reserved before funding goals (>= 0). */
  bufferMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  /** Surplus available after funding all goals (>= 0). */
  leftoverMinor: number;
  /** Unfunded gap when income is insufficient (>= 0). */
  shortfallMinor: number;
  lines: PaymentPlanLine[];
}
