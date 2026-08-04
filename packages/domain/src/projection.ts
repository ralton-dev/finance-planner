import type { PaymentCategory, Recurrence } from "@finance-planner/contracts";
import { addUnit, occurrencesInMonth, parseISODate, toISODate } from "./dates.js";
import {
  computeAccountPlan,
  computeOverview,
  contributionCapMinor,
  type CurrencyOverview,
} from "./engine.js";
import {
  computeEstatePlan,
  type EstateCycle,
  type EstateMovement,
  type EstatePlan,
} from "./estate.js";
import { computeHouseholdPlan, type HouseholdInput } from "./household.js";
import type { AccountInput, AccountPlan, AllocatedInflow, PaymentInput } from "./types.js";

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

export interface EstateProjectionOptions {
  /** Months to simulate, including the as-of month. Clamped to 1..24 (default 12). */
  months?: number;
  /** Opening balances by account id. A missing or null entry means "unknown",
   *  and that account reports a null balance in every month. */
  startingBalancesMinor?: Record<string, number | null>;
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
  /** The account's **own** income this month — never the arriving inflow, for
   *  the same reason `AccountPlan.monthlyIncomeMinor` is not. */
  monthlyIncomeMinor: number;
  /**
   * Money arriving into the account this month from outside it: a household's
   * allocation plus whatever the accounts feeding it could afford to send.
   *
   * Without it a projected month cannot explain itself — `totalFundedMinor` can
   * exceed `monthlyIncomeMinor - bufferMinor` with nothing on the wire saying
   * why, which reads as an arithmetic error rather than as a funded pot.
   */
  allocatedInflowMinor: number;
  /**
   * Of `allocatedInflowMinor`, what somebody has said actually moved. **Zero in
   * every month after the first**: a confirmation is a statement about the
   * as-of month, and nobody has moved next March's money yet.
   */
  confirmedInflowMinor: number;
  bufferMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  leftoverMinor: number;
  /**
   * Money leaving for other accounts this month, funded from what the payments
   * left. Not subtracted from `leftoverMinor`, which keeps the engine's meaning
   * — see `AccountPlan.outboundInflowMinor`. It is here so a month that sends
   * its surplus on cannot look like a month that kept it.
   */
  outboundInflowMinor: number;
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

/** One simulated month of the whole estate, across every account in the pass. */
export interface EstateMonthProjection {
  /** Calendar month as "YYYY-MM". */
  month: string;
  /**
   * The rollup over every account planned this month, grouped by currency and
   * **netted the way `computeOverview` nets it**.
   *
   * Netting is the whole reason this is not a hand-rolled sum: money moving
   * between two of your own accounts is counted at both ends, once per hop, so
   * a twelve-month aggregate would inflate the estate's future income twelve
   * times over. `monthlyIncomeMinor` here is external money and nothing else,
   * in every month of the horizon.
   */
  perCurrency: CurrencyOverview[];
  /** Every account-sourced movement this month, as the pass resolved it —
   *  including the ones the senders could not afford. */
  movements: EstateMovement[];
}

export interface EstateProjection {
  asOfDate: string;
  /** The dependency order the pass planned in, from the as-of month. */
  order: string[];
  /** One projection per account, in `order`. */
  accounts: AccountProjection[];
  /** The estate as a whole, month by month. */
  months: EstateMonthProjection[];
  /** Funding loops as of the as-of month; empty in the normal case. A loop is
   *  broken the same way in every simulated month, so it is reported once. */
  cycles: EstateCycle[];
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

/**
 * The same arriving money with nothing confirmed.
 *
 * A confirmation says "I moved it", which is a fact about the month it was
 * made in and about no other. Carrying it forward would have every future month
 * of a standing transfer read as already settled — the projection would be
 * asserting that you have already made twelve transfers you have not made.
 */
function unconfirmed(inflow: AllocatedInflow | null | undefined): AllocatedInflow | null {
  if (!inflow) return null;
  return {
    ...inflow,
    confirmedMinor: 0,
    sources: inflow.sources?.map((s) => ({ ...s, confirmedMinor: 0 })),
  };
}

// ---------------------------------------------------------------------------
// One account's walk through the simulation
// ---------------------------------------------------------------------------

/** Everything that evolves as one account is walked forward. */
interface AccountSim {
  account: AccountInput;
  byId: Map<string, PaymentInput>;
  states: Map<string, PaymentState>;
  balance: number | null;
  months: MonthProjection[];
}

function newSim(account: AccountInput, startingBalanceMinor: number | null): AccountSim {
  return {
    account,
    byId: new Map(account.payments.map((p) => [p.id, p] as const)),
    states: new Map(account.payments.map((p) => [p.id, initialState(p)] as const)),
    balance: startingBalanceMinor,
    months: [],
  };
}

/**
 * The account as it should be planned for one simulated month: the savings
 * state built up so far overlaid on it, and — after the first month — nothing
 * confirmed. Inputs are never mutated; this is always a copy.
 */
function workingInput(sim: AccountSim, firstMonth: boolean): AccountInput {
  const payments = sim.account.payments.map((p) => withState(p, sim.states.get(p.id)!));
  if (firstMonth) return { ...sim.account, payments };
  return {
    ...sim.account,
    payments,
    inflow: unconfirmed(sim.account.inflow),
    confirmedArrivals: [],
  };
}

/**
 * Advance one account past one simulated month: each payment takes its
 * contribution and pays out whatever fell due, then the month is recorded.
 *
 * Balance premise, unchanged: only money that is *set aside* moves the balance.
 * Arriving inflow is spent on the same month's obligations exactly as income is,
 * and money sent on to another account leaves like any other spending — both are
 * balance-neutral here for the same reason a monthly bill is.
 */
function advance(sim: AccountSim, plan: AccountPlan, refDate: Date, monthKey: string): void {
  let setAside = 0;
  let paidOut = 0;
  const lines: ProjectionLine[] = plan.lines.map((line) => {
    const payment = sim.byId.get(line.paymentId)!;
    const state = sim.states.get(line.paymentId)!;
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

  if (sim.balance !== null) sim.balance += setAside - paidOut;

  sim.months.push({
    month: monthKey,
    monthlyIncomeMinor: plan.monthlyIncomeMinor,
    allocatedInflowMinor: plan.allocatedInflowMinor,
    confirmedInflowMinor: plan.confirmedInflowMinor,
    bufferMinor: plan.bufferMinor,
    totalRequiredMinor: plan.totalRequiredMinor,
    totalFundedMinor: plan.totalFundedMinor,
    leftoverMinor: plan.leftoverMinor,
    outboundInflowMinor: plan.outboundInflowMinor,
    shortfallMinor: plan.shortfallMinor,
    reservedEndMinor: totalReserved(sim.states.values()),
    projectedBalanceMinor: sim.balance,
    lines,
  });
}

// ---------------------------------------------------------------------------
// Account projection
// ---------------------------------------------------------------------------

/**
 * Simulate one account's plan month by month, re-running `computeAccountPlan`
 * against the savings state built up so far.
 *
 * ## Arriving money recurs
 *
 * A movement into an account is a **standing instruction**, not a one-off: the
 * user authored "£300 a month into the bills pot", the same way they authored a
 * salary. So it is projected every month, and a pot funded from elsewhere holds
 * a stable or rising reserve instead of draining to nothing — which is the whole
 * defect this exists to fix. The alternative reading, "money arrived once", is
 * not a thing anyone authors; a genuinely one-off movement says so in its
 * frequency, and the estate walk below honours that.
 *
 * ## What this function cannot know, said out loud
 *
 * `account.inflow` is what the ordered pass settled for the **as-of month**, and
 * it is held flat across the horizon. That is right whenever the sending
 * account's month is the same shape every month — which is the normal case, a
 * salary and standing bills — and it is an approximation otherwise:
 *
 *  - a movement whose own cadence expires (a `one_off` transfer) keeps arriving;
 *  - a sender whose goal completes mid-horizon never passes on the money it
 *    frees;
 *  - a sender whose income falls away keeps sending what it could afford in
 *    month 0.
 *
 * The reason is structural, not an omission: what arrives in month 7 is month
 * 7's surplus of another account, and one account's input does not contain the
 * other account. **`computeEstateProjection` is the correct answer** and walks
 * every account forward together; this function is the single-account view, and
 * keeps its exact behaviour for an account nothing moves into.
 *
 * Confirmations are the one thing not held flat — see `unconfirmed`.
 *
 * ## Balance premise
 *
 * Only money that is *set aside* moves the balance. Each month the balance grows
 * by what was funded into non-monthly goals and falls by the full amount of any
 * non-monthly bill that fell due — the plan's premise is that the bill gets
 * paid, so an under-reserved bill can drive the balance negative and make the
 * crunch visible. Monthly bills, the buffer, the leftover and money sent on to
 * another account are assumed paid or spent out of the same month's money and
 * are balance-neutral. A dateless contribution-capped goal never falls due, so
 * completing it takes nothing back out: the balance keeps the money it
 * accumulated.
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
  const sim = newSim(account, opts.startingBalanceMinor ?? null);

  for (const [index, ref] of refs.entries()) {
    advance(
      sim,
      computeAccountPlan(workingInput(sim, index === 0), ref),
      parseISODate(ref),
      ref.slice(0, 7),
    );
  }

  return {
    accountId: account.accountId,
    currency: account.currency,
    asOfDate,
    months: sim.months,
  };
}

// ---------------------------------------------------------------------------
// Estate projection
// ---------------------------------------------------------------------------

/**
 * Simulate a whole estate month by month: one `computeEstatePlan` per simulated
 * month, over every account, in dependency order.
 *
 * This is the projection a general funding graph actually requires. Walking one
 * account forward while its funding is another account's *future* surplus is not
 * a computation one account's input can perform — the money arriving in month 7
 * is what the sender can spare in month 7, after month 7's bills, out of month
 * 7's income. Re-planning the estate each month gets all of that for free,
 * because every one of those figures is already a function of the reference
 * date and the savings state:
 *
 *  - a goal that completes upstream stops consuming, and the money it was
 *    eating flows on down the chain from the month it retires;
 *  - a sender whose income falls away sends less, and the movement is reported
 *    `short` or `unfunded` rather than silently still delivering;
 *  - a movement with a `one_off` cadence stops when its anchor passes;
 *  - a funding loop is broken at the same edge in every month, deterministically
 *    (`computeEstatePlan` orders by priority, destination and id, none of which
 *    move with the calendar), so `cycles` is reported once.
 *
 * `accounts` is the estate **as authored** — the same array `computeEstatePlan`
 * takes, not the inputs it hands back. Feeding the pass its own outputs would
 * add every household allocation to itself once per month.
 *
 * Cost: months × accounts calls to `computeAccountPlan`, against months × 1 for
 * the single-account projection. Inputs are never mutated.
 */
export function computeEstateProjection(
  accounts: AccountInput[],
  asOfDate: string,
  opts: EstateProjectionOptions = {},
): EstateProjection {
  const refs = monthReferences(asOfDate, clampMonths(opts.months));
  const sims = new Map<string, AccountSim>(
    accounts.map((a) => [
      a.accountId,
      newSim(a, opts.startingBalancesMinor?.[a.accountId] ?? null),
    ]),
  );

  const months: EstateMonthProjection[] = [];
  let first: EstatePlan | null = null;

  for (const [index, ref] of refs.entries()) {
    const refDate = parseISODate(ref);
    const monthKey = ref.slice(0, 7);
    const working = accounts.map((a) => workingInput(sims.get(a.accountId)!, index === 0));
    const estate = computeEstatePlan(working, ref);
    first ??= estate;

    for (const plan of estate.plans) advance(sims.get(plan.accountId)!, plan, refDate, monthKey);

    months.push({
      month: monthKey,
      // Through `computeOverview` rather than summed here, so the intra-estate
      // netting is the engine's one implementation and a twelve-month horizon
      // cannot drift from the one-month rollup it has to agree with.
      perCurrency: computeOverview(estate.plans, ref).perCurrency,
      movements: estate.movements,
    });
  }

  // Always set: `refs` has at least one entry, so the loop always runs.
  const order = first!.order;
  return {
    asOfDate,
    order,
    accounts: order.map((accountId) => {
      const sim = sims.get(accountId)!;
      return {
        accountId,
        currency: sim.account.currency,
        asOfDate,
        months: sim.months,
      };
    }),
    months,
    cycles: first!.cycles,
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
