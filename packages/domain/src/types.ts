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
 * This is the **arriving** face. `computeAccountPlan` does not read it: what
 * actually arrives is whatever the sending account could afford to send, which
 * only the ordered pass over the estate knows (`computeEstatePlan`). The pass
 * reads these rows to work out which account must be planned before which, then
 * hands the resulting amount down as `AllocatedInflow`. The **leaving** face is
 * `OutboundInflowInput`, which the engine does read.
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

/**
 * The same account-sourced inflow, seen from the account the money **leaves**.
 *
 * One authored row, read from its other end: `id` is that row's id, so the two
 * faces can never disagree about how much moves. It is a type of its own rather
 * than a flag on `InflowInput` because the two faces genuinely differ — arriving
 * money names where it came from, leaving money names where it goes — and a
 * single type would have to make both nullable and hope callers read the right
 * one.
 *
 * The engine funds these **after every expense on this account**, in their own
 * priority order (decision 6): a pot can never starve a real bill, however
 * eagerly it is ranked.
 */
export interface OutboundInflowInput {
  id: string;
  /** The account the money arrives in. Never this account. */
  toAccountId: string;
  amountMinor: number;
  frequency: Frequency;
  recurrence?: Recurrence | null;
  /** ISO date (YYYY-MM-DD) of the first/next occurrence. */
  anchorDate: string;
  active?: boolean;
  /** Rank among this account's outbound movements, lower first. Defaults to 100,
   *  matching a payment's default priority. */
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
 * Money arriving into the account from outside it this month — the slice a
 * household plan has allocated to it (`HouseholdAccountPlan.transferInMinor`),
 * plus whatever another account you own actually managed to send it.
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
  /**
   * Of `allocatedMinor`, the part that arrived from **another account in the
   * same estate**, itemised by the movement that delivered it. The rest came
   * from outside the estate — a household member's account — and is not
   * itemised, because the engine is deliberately never told who sent it.
   *
   * Two things need it. A rollup over both ends of a hop has to net internal
   * movement out or it inflates the estate once per hop (see
   * `AccountPlan.internalInflowUsedMinor`). And anything asking "what did *this*
   * movement pay for" needs to be able to take it back out again — otherwise it
   * has no base to compare against, having already been handed the answer with
   * the money in it. Absent means nothing internal arrived, which is the case
   * for every household allocation.
   */
  sources?: InflowArrival[];
}

/** Money one authored movement actually delivered into an account. */
export interface InflowArrival {
  /** The authored inflow's id — one row, read from both ends. */
  inflowId: string;
  fromAccountId: string;
  /** What the sending account could afford, which may be less than the row
   *  asks for. */
  amountMinor: number;
  /**
   * How much of `amountMinor` has been confirmed as actually moved, clamped to
   * it. Filled in by `computeEstatePlan` from the account's
   * `confirmedArrivals`; absent means nobody has said this one moved.
   */
  confirmedMinor?: number;
}

/**
 * Somebody has said this movement happened.
 *
 * Input to the pass, where `InflowArrival` is its output: a confirmation is
 * about an authored row, so it can be read before anything is known about what
 * the row managed to deliver. It names no person — the engine is never told who
 * moved the money, only that it moved.
 */
export interface ConfirmedArrival {
  /** The authored inflow's id. */
  inflowId: string;
  /** What was confirmed moved. Clamped by the pass to what actually arrived: a
   *  confirmation outlives the plan that derived it, and a stale one must not
   *  credit money this month's plan never sent. */
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
  /** What has been allocated into this account — by a household, by another
   *  account you own, or both. Absent for a standalone account funded entirely
   *  by its own income. */
  inflow?: AllocatedInflow | null;
  /** Every inflow authored on this account, external and account-sourced alike.
   *  The engine reads only the external ones (through `incomes`); the arriving
   *  face of an account-sourced row is `computeEstatePlan`'s business — see
   *  `InflowInput`. */
  inflows?: InflowInput[];
  /** Account-sourced inflows **leaving** this account. Funded after every
   *  payment above, in their own priority order (decision 6). */
  outboundInflows?: OutboundInflowInput[];
  /**
   * Movements arriving here that have been confirmed as actually moved this
   * month, by authored inflow.
   *
   * Read alongside the inflows rather than merged into `inflow.confirmedMinor`
   * by the caller, because what a movement delivered is not known until the
   * pass has planned the sender — so the clamp that keeps a stale confirmation
   * honest can only be applied there. Absent for an account nothing moves into.
   */
  confirmedArrivals?: ConfirmedArrival[];
  /**
   * The accounts in the funding loop this account belongs to, if any, in the
   * order money would travel round it.
   *
   * Worked out by `computeEstatePlan` and carried through the engine untouched,
   * so that a caller holding nothing but one account's plan still learns its
   * funding is circular and can name the accounts involved. The engine neither
   * computes nor acts on it.
   */
  fundingCycleAccountIds?: string[];
  /**
   * The one movement on that loop the pass ignored to break it.
   *
   * Carried for the same reason the account list is, and it is the half that
   * makes the loop *actionable*: the accounts say a loop exists, this says which
   * edge is not moving money — the edge a diagram would otherwise draw as a
   * ribbon funding nothing, and the one the user has to delete or re-point.
   * Set exactly when `fundingCycleAccountIds` is.
   */
  fundingCycleBrokenInflowId?: string;
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

/** How one outbound movement fared against the money left after the bills. */
export interface OutboundInflowPlan {
  /** The authored inflow's id — the same row the receiving account sees. */
  inflowId: string;
  toAccountId: string;
  /** The movement's monthly amount, normalised the way income is. */
  requiredMonthlyMinor: number;
  /** What this account can actually afford to send, after every payment on it
   *  is funded. Less than required when the money ran out. */
  fundedMonthlyMinor: number;
  /** Of `fundedMonthlyMinor`, the part paid for by this account's own income. */
  fundedFromOwnMinor: number;
  /** Of `fundedMonthlyMinor`, the part passed on out of arriving inflow. */
  fundedFromInflowMinor: number;
  onTrack: boolean;
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
  /**
   * What is actually left in the account once the month's flows have happened:
   *
   *     income + arriving − spending − leaving
   *
   * The figure the flow diagram draws as "stays put" and the household page
   * prints in the account's "left over" column — one number, on every surface
   * (ONE-ENGINE.md). `leftoverMinor` above is deliberately a *different* figure,
   * and keeps its meaning (decision 13): the account's own income after its own
   * obligations, which is the right answer for a rollup and the wrong one for a
   * picture, because summing residuals across an estate counts a transferred
   * pound at both ends.
   *
   * **Signed.** Negative means a member is committed to moving more out of this
   * account than reaches it, which happens exactly when they hold income in a
   * personal account other than the one their transfers leave (decision 11) and
   * have to consolidate first. Flooring it would hide the thing to do.
   *
   * Absent from a plan the superseded `computeAccountPlan` built: it has no term
   * for money leaving on a transfer nobody authored, which is the defect this
   * field exists to close.
   */
  residualMinor?: number;
  /** Gap the month's money — own income plus allocated inflow — cannot cover
   *  (>= 0). Inflow that covers the gap takes this to 0. */
  shortfallMinor: number;
  /**
   * Of the inflow this account's payments consumed, how much came from another
   * account in the same estate (see `AllocatedInflow.internalMinor`).
   *
   * This is the term `computeOverview` nets out. Allocation that arrived and was
   * never spent is deliberately excluded: it is still sitting in this account,
   * and the account that sent it still reports it as its own leftover, so it is
   * counted exactly once already. What was *spent* is the money counted twice.
   *
   * Household-earmarked money is treated as spent before internal money, on the
   * grounds that it was earmarked for these very bills; internal movement is the
   * top-up on the end.
   */
  internalInflowUsedMinor: number;
  /** Of `allocatedInflowMinor`, what each movement from another of your accounts
   *  delivered. Empty unless the ordered pass filled it in. */
  inflowArrivals: InflowArrival[];
  /**
   * Total this account actually sends to other accounts — the sum of
   * `outboundInflows`' funded amounts.
   *
   * **Not** subtracted from `leftoverMinor`, which keeps its meaning: the
   * account's own income after the account's own obligations. Part of that
   * leftover is committed to these movements, so the two are not additive —
   * see the rollup in `computeOverview` for how the estate resolves it.
   */
  outboundInflowMinor: number;
  /** Every movement out of this account, funded from what the payments left.
   *  Empty for an account that sends nothing anywhere. */
  outboundInflows: OutboundInflowPlan[];
  /** Carried straight through from the input: the accounts in the funding loop
   *  this account is part of. Absent when its funding is acyclic, which is
   *  almost always. See `AccountInput.fundingCycleAccountIds`. */
  fundingCycleAccountIds?: string[];
  /** Also straight through: the movement on that loop the pass ignored, which
   *  is the one funding nothing. See `AccountInput.fundingCycleBrokenInflowId`. */
  fundingCycleBrokenInflowId?: string;
  lines: PaymentPlanLine[];
}
