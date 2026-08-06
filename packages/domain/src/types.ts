import type { Frequency, PaymentCategory, Recurrence } from "@finance-planner/contracts";

/** An income stream on an account. Amounts in integer minor units. */
export interface IncomeInput {
  id: string;
  /** Optional display label. The maths keys by `id`; this is only for traces. */
  name?: string;
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
 * This is the **arriving** face, and the pass reads it for one thing only: to
 * notice a movement whose *sending* account is outside the scope, which is the
 * only way that gap can be seen at all. What actually arrives is whatever the
 * sender could afford, and that is decided from the **leaving** face —
 * `OutboundInflowInput` — in `computeScopePlan`'s savings phase.
 */
export interface InflowInput {
  id: string;
  /** Optional display label. The maths keys by `id`; this is only for traces. */
  name?: string;
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
  /** Optional display label. The maths keys by `id`; this is only for traces. */
  name?: string;
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
   * it. Filled in by `computeScopePlan` from the account's
   * `confirmedArrivals`; absent means nobody has said this one moved.
   */
  confirmedMinor?: number;
}

/**
 * One derived transfer **leaving** an account, per far end.
 *
 * `InflowArrival`'s opposite number, and it exists for the same reason: the
 * arriving side was itemised and the leaving side was one scalar, so a page
 * standing on the sending account could only ever say "£2,585.84 leaves here"
 * over three transfers to three different accounts, and had to invent a label
 * for a far end that was a *set*. Each of these is one `DerivedTransfer` — one
 * destination, one member, its own confirmation state — so the same page now
 * says which account each part of that figure goes to and which parts have
 * moved.
 *
 * The sending account is implied (it is the plan's own account) and so is the
 * currency: a derived transfer never crosses one (decision 10), and an
 * account's currency is fixed at creation.
 */
export interface TransferDeparture {
  toAccountId: string;
  /** The member whose money this is — what a confirmation is scoped by, along
   *  with the two accounts and the month. */
  memberUserId: string;
  amountMinor: number;
  /** How much of `amountMinor` somebody has said actually moved (<= it).
   *  Counts confirmations made on either surface: a household pot's transfer
   *  ticked on the household checklist reads as moved here too. */
  confirmedMinor: number;
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
  /**
   * Whose account it is — `ScopeAccountPlan.ownerUserId` passed straight
   * through, and the boundary every personal figure is counted on (decision 20:
   * ownership, never access).
   *
   * Here rather than looked up beside the plan because a rollup over these is
   * the one place the boundary is drawn — `overviewFromPlans` groups by it — and
   * a second lookup is a second answer waiting to disagree with the pass's. It
   * is no wider on the wire than what is already there: `GET /api/accounts`
   * returns the whole `Account` row, `owner_user_id` included, for every account
   * the caller may see.
   */
  ownerUserId: string;
  asOfDate: string;
  currency: string;
  /** The account's **own** income only — never the allocated inflow. Folding
   *  the two together would double-count the same money in any figure that sums
   *  income across accounts, because the paying account still reports it too. */
  monthlyIncomeMinor: number;
  /** Everything arriving into this account this month: the transfers the pass
   *  derived for its expenses, plus what authored movements delivered (>= 0). */
  allocatedInflowMinor: number;
  /** How much of `allocatedInflowMinor` has actually been moved (>= 0). */
  confirmedInflowMinor: number;
  /**
   * Of `confirmedInflowMinor`, the part confirming transfers the pass **derived**
   * (>= 0). The rest of it confirms **authored** movements, and is itemised per
   * movement on `inflowArrivals`.
   *
   * Two arrivals, two confirmations, and one total could not answer both
   * questions. A line is only ever funded from a derived transfer — every
   * expense is paid out of member budgets before a single savings movement runs
   * (decision 8), so `fundedFromInflowMinor` is expense transport by
   * construction — and while `status` was decided against the combined total,
   * confirming a £400 savings movement flipped a bill still waiting on an
   * unconfirmed £303.20 derived feed from `awaiting_transfer` to `funded`. This
   * is the figure that decides it, and it is the one the money it describes
   * actually came from.
   */
  confirmedTransferMinor: number;
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
   * This used to say why in terms of a double-count — "the account that sent it
   * has no idea it left, so its own plan still reports that money as its
   * leftover" — and that stopped being true when there stopped being two
   * engines. A derived transfer **is** subtracted at the sender (see below), so
   * counting it again at the receiver would not double it; the same comment said
   * so two paragraphs on and contradicted itself.
   *
   * The real reason is the field's meaning, which decision 13 keeps: this is the
   * account's **own** income after the account's own obligations, which is what
   * makes a rollup over these a plain sum with nothing to net. What is actually
   * *in* the account afterwards is a different question, and `residualMinor`
   * below answers it. Unspent inflow is still recoverable: `allocatedInflowMinor`
   * minus the sum of `fundedFromInflowMinor` over the lines.
   *
   * The derived transfers this account's owner has to make out of it *are*
   * subtracted, because those are the account's own money leaving.
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
   * Required. The pass always knows it, and it was optional only so that the old
   * account engine's frozen plan — which predates it — could still be typed as
   * an `AccountPlan`. That snapshot now names the fields it predates
   * (`engine.test.ts`), and `MonthProjection.residualMinor` reads this one
   * straight through rather than falling back to a figure that means something
   * else.
   */
  residualMinor: number;
  /**
   * Spendable/free leftover after authored savings movements.
   *
   * A savings movement that arrives here is reserved here, not available here.
   * This is the value account and dashboard "left over" surfaces should print.
   */
  availableLeftoverMinor: number;
  /** Gap the month's money — own income plus allocated inflow — cannot cover
   *  (>= 0). Inflow that covers the gap takes this to 0. */
  shortfallMinor: number;
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
   * `ScopeAccountPlan.committedMinor` is the same figure, and decision 13's
   * "free after committed" is `leftoverMinor - outboundInflowMinor`.
   */
  outboundInflowMinor: number;
  /**
   * The other half of what leaves: the derived transfers this account's owner
   * has to make out of it — expense transport, authored by nobody.
   *
   * `ScopeAccountPlan.transferOutMinor` passed straight through, and the term
   * `leftoverMinor` and `residualMinor` differ by. The account page needed it
   * and had to recover it by rearranging that identity — right arithmetic, and
   * fragile in exactly the way a term changing meaning makes it wrong.
   * Additive: no existing field moves (decision 4/13).
   */
  transferOutMinor: number;
  /**
   * That same money, itemised by where it goes — one entry per derived transfer
   * leaving this account, each with its own confirmation state.
   *
   * `Σ transferDepartures[].amountMinor === transferOutMinor`, always and
   * exactly: both are read off the one pass's `transfers`, and the scalar is
   * kept because other surfaces read it (decision 4/13 — added alongside, never
   * redefined). Empty exactly when the scalar is zero.
   */
  transferDepartures: TransferDeparture[];
  /** Every movement out of this account, funded from what the payments left.
   *  Empty for an account that sends nothing anywhere. */
  outboundInflows: OutboundInflowPlan[];
  /** Carried straight through from the input: the accounts in the funding loop
   *  this account is part of. Absent when its funding is acyclic, which is
   *  almost always. See `ScopeAccountPlan.fundingCycleAccountIds`. */
  fundingCycleAccountIds?: string[];
  /** Also straight through: the movement on that loop the pass ignored, which
   *  is the one funding nothing. See `ScopeAccountPlan.fundingCycleBrokenInflowId`. */
  fundingCycleBrokenInflowId?: string;
  lines: PaymentPlanLine[];
}
