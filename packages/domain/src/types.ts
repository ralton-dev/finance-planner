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

/**
 * Where money arriving into an account comes from.
 *
 * Only `external` is money entering the estate. `account` is the user moving
 * their own money, which nets to zero across everything they own — so any figure
 * that sums "money in" over more than one account must count `external` alone.
 */
export type InflowSourceKind = "external" | "account";

/**
 * Money arriving into an account, as the user authored it.
 *
 * An `account`-sourced inflow is one record with two faces: it arrives on the
 * account that owns it and leaves `sourceAccountId`. It is not two records — two
 * could drift apart, one cannot.
 *
 * **The engine does not read this yet.** `computeAccountPlan` still plans from
 * `incomes`, and an account-sourced inflow has no effect on any figure until
 * WP-G teaches the engine to walk the accounts in dependency order. It is
 * carried on `AccountInput` so the records reach the engine unchanged when that
 * lands; setting it today is inert, not wrong.
 */
export interface InflowInput {
  id: string;
  amountMinor: number;
  frequency: Frequency;
  recurrence?: Recurrence | null;
  /** ISO date (YYYY-MM-DD) of the first/next occurrence. */
  anchorDate: string;
  active?: boolean;
  source: InflowSourceKind;
  /** The account the money leaves. Set exactly when `source === "account"`, and
   *  never this account — an account cannot fund itself. */
  sourceAccountId?: string | null;
  /** Rank among the *sending* account's outbound inflows, lower first. It only
   *  ever ranks against other outbound inflows: every expense on the sending
   *  account is funded first, whatever this says (decision 6). */
  priority?: number;
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

/**
 * Money arriving into the account from outside it this month — today, the slice
 * a household plan has allocated to it (`HouseholdAccountPlan.transferInMinor`).
 *
 * It exists because an account is not always funded by its own income: a bills
 * pot has none, and planning it from its own incomes alone reports every line at
 * risk while the household plan says the same bills are covered. Optional, so a
 * standalone account is planned exactly as before.
 */
export interface AllocatedInflow {
  /** Total allocated into this account for the month (>= 0). */
  allocatedMinor: number;
  /**
   * How much of `allocatedMinor` has actually been moved. The rest is planned
   * but unconfirmed: it funds the arithmetic (decision #1) while marking the
   * lines that lean on it `awaiting_transfer`. Clamped to `allocatedMinor`.
   */
  confirmedMinor: number;
}

export interface AccountInput {
  accountId: string;
  currency: string;
  /** Optional monthly amount reserved off the top before funding goals. */
  monthlyBufferMinor?: number;
  /** The account's external inflows, in the shape the engine has always read.
   *  Every row here is also in `inflows` with `source: "external"`. */
  incomes: IncomeInput[];
  payments: PaymentInput[];
  /** What the household has allocated into this account. Absent for a
   *  standalone account, which is funded entirely by its own income. */
  inflow?: AllocatedInflow | null;
  /** Every inflow authored on this account, external and account-sourced alike.
   *  Not read by the engine yet — see `InflowInput`. */
  inflows?: InflowInput[];
}

/**
 * Why a line is where it is — the axis `onTrack` cannot express.
 *
 * `onTrack` answers "does the plan cover this?"; it cannot separate *the plan
 * cannot fund this* (cut something, or raise a share) from *the plan funds this,
 * you have not moved the money yet* (make the transfer). Two different problems
 * with two different remedies, so they get two different statuses.
 */
export type PaymentPlanStatus = "funded" | "awaiting_transfer" | "at_risk";

/** Computed plan line for a single payment. */
export interface PaymentPlanLine {
  paymentId: string;
  name: string;
  category: PaymentCategory;
  amountMinor: number;
  dueDate: string;
  targetDate: string;
  /**
   * True when the date on this line is one the engine worked out rather than
   * one the user set: a contribution-capped goal carrying no `targetDate` and
   * no `dueDate`, whose finish date is a consequence of the pace.
   *
   * It exists because the answer is not recoverable downstream — `dueDate` is
   * emitted as `p.dueDate ?? effectiveDate`, so a date you typed and a date the
   * plan derived are byte-identical on the wire. A UI inferring it from the cap
   * alone gets the two ordinary cases right and mislabels the third: a goal
   * that carries *both* a cap and a deadline keeps the user's date.
   */
  dueDateIsDerived: boolean;
  monthsUntilDue: number;
  requiredMonthlyMinor: number;
  fundedMonthlyMinor: number;
  /** Of `fundedMonthlyMinor`, the part paid for by the account's own income.
   *  Sums with `fundedFromInflowMinor` to `fundedMonthlyMinor` exactly. */
  fundedFromOwnMinor: number;
  /** Of `fundedMonthlyMinor`, the part paid for by allocated inflow. */
  fundedFromInflowMinor: number;
  alreadySavedMinor: number;
  /** Times this payment falls due within the as-of month. Usually 1; a
   *  sub-monthly custom cadence (e.g. every 2 weeks) can be 2 or 3. */
  occurrencesThisMonth: number;
  onTrack: boolean;
  /**
   * `at_risk` when `!onTrack`; `awaiting_transfer` when the plan covers the line
   * but part of what covers it is inflow nobody has moved yet; `funded`
   * otherwise. `onTrack` keeps its meaning — an `awaiting_transfer` line is
   * `onTrack: true`.
   */
  status: PaymentPlanStatus;
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
  /** The account's **own** income only — never the allocated inflow. Folding
   *  the two together would double-count the same money in any figure that sums
   *  income across accounts, because the paying account still reports it too. */
  monthlyIncomeMinor: number;
  /** What the household allocated into this account this month (>= 0). */
  allocatedInflowMinor: number;
  /** How much of `allocatedInflowMinor` has actually been moved (>= 0). */
  confirmedInflowMinor: number;
  /** Monthly amount reserved before funding goals (>= 0). */
  bufferMinor: number;
  totalRequiredMinor: number;
  /** Funded from own income *and* allocated inflow, so this can exceed
   *  `monthlyIncomeMinor - bufferMinor`. */
  totalFundedMinor: number;
  /**
   * Surplus of the account's **own** income after funding all goals (>= 0).
   *
   * Allocated inflow that was never needed is deliberately **not** counted here.
   * The account that sent it has no idea it left — its own plan still reports
   * that money as its leftover — so counting it at both ends would double it in
   * every figure that sums leftover across accounts (`computeOverview`). Unspent
   * inflow is still recoverable: `allocatedInflowMinor` minus the sum of
   * `fundedFromInflowMinor` over the lines.
   */
  leftoverMinor: number;
  /** Gap the month's money — own income plus allocated inflow — cannot cover
   *  (>= 0). Inflow that covers the gap takes this to 0. */
  shortfallMinor: number;
  lines: PaymentPlanLine[];
}
