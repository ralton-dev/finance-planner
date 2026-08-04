import type { PaymentCategory, Recurrence } from "@finance-planner/contracts";
import { addUnit, occurrencesInMonth, parseISODate, toISODate } from "./dates.js";
import { computeAccountPlan, contributionCapMinor } from "./engine.js";
import { computeHouseholdPlan, type HouseholdInput } from "./household.js";
import type { AccountInput, PaymentInput } from "./types.js";

const DEFAULT_MONTHS = 12;
const MIN_MONTHS = 1;
const MAX_MONTHS = 24;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ProjectionOptions {
  /** Months to simulate, including the as-of month. Clamped to 1..24 (default 12). */
  months?: number;
  /**
   * Opening balance of the money already sitting in the account. `null` (the
   * default) means "unknown" — every month then reports a null balance rather
   * than a fabricated one.
   */
  startingBalanceMinor?: number | null;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** One payment's slice of a simulated month. */
export interface ProjectionLine {
  paymentId: string;
  name: string;
  category: PaymentCategory;
  requiredMonthlyMinor: number;
  fundedMonthlyMinor: number;
  /**
   * Amount set aside for this payment at the end of the month — after the
   * month's contribution and after any bill that fell due was paid out of it.
   * Always 0 for monthly_recurring, which is paid straight from income.
   */
  alreadySavedEndMinor: number;
  dueThisMonth: boolean;
  /** amountMinor × occurrences this month; 0 when nothing falls due. */
  dueAmountMinor: number;
}

export interface MonthProjection {
  /** Calendar month as "YYYY-MM". */
  month: string;
  monthlyIncomeMinor: number;
  bufferMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  leftoverMinor: number;
  shortfallMinor: number;
  /** Total set aside across every payment at the end of the month. */
  reservedEndMinor: number;
  /** Balance at the end of the month; null when no starting balance was given. */
  projectedBalanceMinor: number | null;
  lines: ProjectionLine[];
}

export interface AccountProjection {
  accountId: string;
  currency: string;
  asOfDate: string;
  months: MonthProjection[];
}

export interface HouseholdProjectionLine extends ProjectionLine {
  accountId: string;
}

export interface HouseholdMonthProjection {
  month: string;
  monthlyIncomeMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  leftoverMinor: number;
  shortfallMinor: number;
  /** Money members must move between accounts this month (sum of transfers). */
  transfersTotalMinor: number;
  reservedEndMinor: number;
  lines: HouseholdProjectionLine[];
}

export interface HouseholdProjection {
  householdId: string;
  currency: string;
  asOfDate: string;
  months: HouseholdMonthProjection[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Evolving state of one payment across the simulation. */
interface PaymentState {
  alreadySavedMinor: number;
  active: boolean;
}

function clampMonths(months: number | undefined): number {
  if (months === undefined || !Number.isFinite(months)) return DEFAULT_MONTHS;
  return Math.min(MAX_MONTHS, Math.max(MIN_MONTHS, Math.trunc(months)));
}

/**
 * Reference date for each simulated month. Month 0 is the as-of date itself
 * (so the first month matches `computeAccountPlan(account, asOfDate)` exactly);
 * later months start on the 1st, `k` months on from the as-of month.
 */
function monthReferences(asOfDate: string, months: number): string[] {
  const asOf = parseISODate(asOfDate);
  const firstOfMonth = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  const refs = [asOfDate];
  for (let k = 1; k < months; k++) refs.push(toISODate(addUnit(firstOfMonth, k, "month")));
  return refs;
}

/** Mirrors engine.ts: a dateless yearly bill has no cadence to step. */
function resolveRecurrence(p: PaymentInput): Recurrence | null {
  if (p.recurrence) return p.recurrence;
  if (p.category === "yearly_recurring" && p.dueDate) {
    return { interval: 1, unit: "year", anchor: p.dueDate };
  }
  return null;
}

/** A contribution-first goal with no date: it is never "due", only finished —
 *  there is no day on which the money is assumed to leave the account. */
function isDatelessCappedGoal(p: PaymentInput): boolean {
  return contributionCapMinor(p) !== null && !p.targetDate && !p.dueDate;
}

/**
 * How many times a payment actually falls due in the calendar month of `ref`.
 *   monthly_recurring → 1, every month, by definition
 *   fixed_point       → 1 in its target month; an already-overdue goal counts as
 *                       due immediately (the engine likewise demands the whole
 *                       remaining amount at once once the date has passed). A
 *                       dateless contribution-capped goal is the exception: it
 *                       has no deadline to fall due on, so it never pays out —
 *                       see `evolvePayment`.
 *   yearly / custom    → occurrencesInMonth against the resolved cadence, so a
 *                       fortnightly bill lands 2–3 times in some months
 */
function dueOccurrences(p: PaymentInput, ref: Date, monthKey: string): number {
  if (p.category === "monthly_recurring") return 1;
  if (p.category === "fixed_point") {
    if (isDatelessCappedGoal(p)) return 0;
    const target = p.targetDate ?? p.dueDate ?? null;
    return target === null || target.slice(0, 7) <= monthKey ? 1 : 0;
  }
  const rec = resolveRecurrence(p);
  // No resolvable cadence → treat it as a single hit in its due month (or every
  // month if it has no due date either, matching the engine's "anchor = now").
  if (!rec) return !p.dueDate || p.dueDate.slice(0, 7) === monthKey ? 1 : 0;
  return occurrencesInMonth(p.dueDate ? parseISODate(p.dueDate) : ref, rec, ref);
}

interface DueResult {
  dueThisMonth: boolean;
  dueAmountMinor: number;
}

/**
 * Advance one payment's state past a simulated month: this month's contribution
 * goes into its pot, then anything falling due is paid out of that pot. A
 * fixed_point goal is spent when its month arrives and takes no further part in
 * the simulation (autoRenew is a data-entry convenience, not a second goal).
 *
 * A dateless contribution-capped goal retires differently: it accumulates until
 * the target amount is reached and then drops out — completed, not spent. Its
 * reserve is left in place, so `reservedEndMinor` and the balance keep counting
 * the money (it is sitting in the account waiting to be used, and the plan has
 * no date on which to assume it leaves).
 */
function evolvePayment(
  p: PaymentInput,
  state: PaymentState,
  fundedMinor: number,
  ref: Date,
  monthKey: string,
): DueResult {
  const occurrences = dueOccurrences(p, ref, monthKey);
  const dueAmountMinor = occurrences > 0 ? p.amountMinor * occurrences : 0;
  if (p.category !== "monthly_recurring") {
    state.alreadySavedMinor = Math.max(0, state.alreadySavedMinor + fundedMinor - dueAmountMinor);
    if (p.category === "fixed_point") {
      if (occurrences > 0) state.active = false;
      else if (isDatelessCappedGoal(p) && state.alreadySavedMinor >= p.amountMinor) {
        state.active = false;
      }
    }
  }
  return { dueThisMonth: occurrences > 0, dueAmountMinor };
}

function initialState(p: PaymentInput): PaymentState {
  return { alreadySavedMinor: p.alreadySavedMinor ?? 0, active: p.active !== false };
}

/** Overlay the simulated state onto a payment without touching the original. */
function withState<T extends PaymentInput>(p: T, state: PaymentState): T {
  return { ...p, alreadySavedMinor: state.alreadySavedMinor, active: state.active };
}

function totalReserved(states: Iterable<PaymentState>): number {
  let total = 0;
  for (const s of states) total += s.alreadySavedMinor;
  return total;
}

// ---------------------------------------------------------------------------
// Account projection
// ---------------------------------------------------------------------------

/**
 * Simulate an account's plan month by month, re-running `computeAccountPlan`
 * against the savings state built up so far.
 *
 * Balance premise: only money that is *set aside* moves the balance. Each month
 * the balance grows by what was funded into non-monthly goals and falls by the
 * full amount of any non-monthly bill that fell due — the plan's premise is that
 * the bill gets paid, so an under-reserved bill can drive the balance negative
 * and make the crunch visible. Monthly bills, the buffer and the leftover are
 * assumed paid or spent out of the same month's income and are balance-neutral.
 * A dateless contribution-capped goal never falls due, so completing it takes
 * nothing back out: the balance keeps the money it accumulated.
 *
 * Inputs are never mutated: the evolving payment state is held separately and
 * overlaid onto copies.
 */
export function computeAccountProjection(
  account: AccountInput,
  asOfDate: string,
  opts: ProjectionOptions = {},
): AccountProjection {
  const refs = monthReferences(asOfDate, clampMonths(opts.months));
  const states = new Map<string, PaymentState>(
    account.payments.map((p) => [p.id, initialState(p)] as const),
  );
  const byId = new Map(account.payments.map((p) => [p.id, p] as const));

  let balance = opts.startingBalanceMinor ?? null;
  const months: MonthProjection[] = [];

  for (const ref of refs) {
    const refDate = parseISODate(ref);
    const monthKey = ref.slice(0, 7);
    const working: AccountInput = {
      ...account,
      payments: account.payments.map((p) => withState(p, states.get(p.id)!)),
    };
    const plan = computeAccountPlan(working, ref);

    let setAside = 0;
    let paidOut = 0;
    const lines: ProjectionLine[] = plan.lines.map((line) => {
      const payment = byId.get(line.paymentId)!;
      const state = states.get(line.paymentId)!;
      const due = evolvePayment(payment, state, line.fundedMonthlyMinor, refDate, monthKey);
      if (payment.category !== "monthly_recurring") {
        setAside += line.fundedMonthlyMinor;
        paidOut += due.dueAmountMinor;
      }
      return {
        paymentId: line.paymentId,
        name: line.name,
        category: line.category,
        requiredMonthlyMinor: line.requiredMonthlyMinor,
        fundedMonthlyMinor: line.fundedMonthlyMinor,
        alreadySavedEndMinor: state.alreadySavedMinor,
        dueThisMonth: due.dueThisMonth,
        dueAmountMinor: due.dueAmountMinor,
      };
    });

    if (balance !== null) balance += setAside - paidOut;

    months.push({
      month: monthKey,
      monthlyIncomeMinor: plan.monthlyIncomeMinor,
      bufferMinor: plan.bufferMinor,
      totalRequiredMinor: plan.totalRequiredMinor,
      totalFundedMinor: plan.totalFundedMinor,
      leftoverMinor: plan.leftoverMinor,
      shortfallMinor: plan.shortfallMinor,
      reservedEndMinor: totalReserved(states.values()),
      projectedBalanceMinor: balance,
      lines,
    });
  }

  return {
    accountId: account.accountId,
    currency: account.currency,
    asOfDate,
    months,
  };
}

// ---------------------------------------------------------------------------
// Household projection
// ---------------------------------------------------------------------------

/** Payments are unique per account, not household-wide. */
function lineKey(accountId: string, paymentId: string): string {
  return `${accountId} ${paymentId}`;
}

/**
 * Simulate a household's pooled plan month by month, re-running
 * `computeHouseholdPlan` against the savings state built up so far.
 *
 * Savings evolve exactly as in the account projection (contribution in, bill
 * out, fixed_point goals retire once spent), keyed per account + payment. There
 * is no balance trajectory here: household money sits across several accounts,
 * so the meaningful monthly figure is what has to move between them
 * (`transfersTotalMinor`). Inputs are never mutated.
 */
export function computeHouseholdProjection(
  input: HouseholdInput,
  asOfDate: string,
  opts: ProjectionOptions = {},
): HouseholdProjection {
  const refs = monthReferences(asOfDate, clampMonths(opts.months));
  const states = new Map<string, PaymentState>();
  const byKey = new Map<string, PaymentInput>();
  for (const account of input.accounts) {
    for (const p of account.payments) {
      states.set(lineKey(account.accountId, p.id), initialState(p));
      byKey.set(lineKey(account.accountId, p.id), p);
    }
  }

  const months: HouseholdMonthProjection[] = [];

  for (const ref of refs) {
    const refDate = parseISODate(ref);
    const monthKey = ref.slice(0, 7);
    const working: HouseholdInput = {
      ...input,
      accounts: input.accounts.map((account) => ({
        ...account,
        payments: account.payments.map((p) =>
          withState(p, states.get(lineKey(account.accountId, p.id))!),
        ),
      })),
    };
    const plan = computeHouseholdPlan(working, ref);

    const lines: HouseholdProjectionLine[] = plan.lines.map((line) => {
      const key = lineKey(line.accountId, line.paymentId);
      const payment = byKey.get(key)!;
      const state = states.get(key)!;
      const due = evolvePayment(payment, state, line.fundedMonthlyMinor, refDate, monthKey);
      return {
        paymentId: line.paymentId,
        accountId: line.accountId,
        name: line.name,
        category: line.category,
        requiredMonthlyMinor: line.requiredMonthlyMinor,
        fundedMonthlyMinor: line.fundedMonthlyMinor,
        alreadySavedEndMinor: state.alreadySavedMinor,
        dueThisMonth: due.dueThisMonth,
        dueAmountMinor: due.dueAmountMinor,
      };
    });

    months.push({
      month: monthKey,
      monthlyIncomeMinor: plan.monthlyIncomeMinor,
      totalRequiredMinor: plan.totalRequiredMinor,
      totalFundedMinor: plan.totalFundedMinor,
      leftoverMinor: plan.leftoverMinor,
      shortfallMinor: plan.shortfallMinor,
      transfersTotalMinor: plan.transfers.reduce((sum, t) => sum + t.amountMinor, 0),
      reservedEndMinor: totalReserved(states.values()),
      lines,
    });
  }

  return {
    householdId: input.householdId,
    currency: input.currency,
    asOfDate,
    months,
  };
}
