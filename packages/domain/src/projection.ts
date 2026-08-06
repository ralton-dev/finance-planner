import type { PaymentCategory, Recurrence } from "@finance-planner/contracts";
import { addUnit, occurrencesInMonth, parseISODate, toISODate } from "./dates.js";
import { accountPlanFromScope, contributionCapMinor } from "./engine.js";
import type { EstateCycle } from "./estate.js";
import {
  computeScopePlan,
  type DerivedTransfer,
  type ScopeInput,
  type ScopeMovement,
} from "./scope.js";
import type { AccountPlan, InflowInput, OutboundInflowInput, PaymentInput } from "./types.js";

const DEFAULT_MONTHS = 12;
const MIN_MONTHS = 1;
const MAX_MONTHS = 24;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ProjectionOptions {
  /** Months to simulate, including the as-of month. Clamped to 1..24 (default 12). */
  months?: number;
}

/** Options for the scope walk: how far, and from what opening balances. */
export interface ScopeProjectionOptions {
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
  /** Spendable/free left over, excluding authored movement arrivals. */
  availableLeftoverMinor: number;
  /**
   * What is actually in the account at the end of this simulated month —
   * `AccountPlan.residualMinor` for the month's own pass, passed through, and
   * signed.
   *
   * The account page prints a residual as its LEFT OVER and printed
   * `leftoverMinor` a few hundred pixels below it in the projection strip's
   * footer, labelled the same way: £2,501 under a KPI reading £2,051 on the
   * estate. Both figures were right and they answer different questions —
   * `leftoverMinor` is the account's own income after its own bills and the
   * transfers its owner must make, which is what a rollup wants; this is what is
   * left in the place, which is what a month wants.
   *
   * Published rather than left to be reconstructed as
   * `leftoverMinor + allocatedInflowMinor − outboundInflowMinor − …`: that
   * arithmetic is right until a term changes meaning, which is the failure this
   * work keeps finding, and decision 19 forbids a surface deriving a fourth
   * left over of its own.
   */
  residualMinor: number;
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
  /**
   * Whose account it is — `ScopeAccountInput.ownerUserId` passed through, so a
   * roll-up over a walk can be taken on the ownership basis (decision 20).
   *
   * Additive, and here because a projection carried no owner at all: every
   * total over a set of these was therefore a total over *some other* boundary
   * — the household roster, in `householdProjectionFromScope`'s case — and a
   * projection strip cannot agree with the headline above it while the two are
   * summed over different sets of accounts.
   */
  ownerUserId: string;
  currency: string;
  asOfDate: string;
  months: MonthProjection[];
}

/** One currency's totals for one simulated month, straight off the pass. */
export interface ScopeCurrencyMonth {
  currency: string;
  /** External money only, in every month of the horizon — the pass never counts
   *  a transferred pound as income, so there is nothing to net back out. */
  monthlyIncomeMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  leftoverMinor: number;
  /** Of that leftover, what funded savings movements have spoken for
   *  (decision 13). Alongside, never netted. */
  committedMinor: number;
  shortfallMinor: number;
}

/** One simulated month of a whole scope, as the pass planned it. */
export interface ScopeMonthProjection {
  /** Calendar month as "YYYY-MM". */
  month: string;
  perCurrency: ScopeCurrencyMonth[];
  /** The transfers the pass derived this month — expense transport, authored by
   *  nobody, and recomputed against this month's obligations rather than held at
   *  the as-of month's figure. */
  transfers: DerivedTransfer[];
  /** Every authored savings movement this month, including the ones the senders
   *  could not afford. */
  movements: ScopeMovement[];
}

export interface ScopeProjection {
  scopeId: string;
  householdId: string | null;
  asOfDate: string;
  /** One projection per account, in the scope's own account order. */
  accounts: AccountProjection[];
  /** The scope as a whole, month by month. */
  months: ScopeMonthProjection[];
  /** Authored-movement loops as of the as-of month; empty in the normal case. A
   *  loop is broken the same way in every simulated month, so it is reported
   *  once. */
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
  /** What the household's **own accounts** had spare this month: each one's own
   *  income after its own bills and the transfers its owner has to make, added
   *  up. Unchanged, and deliberately not what a household headline prints. */
  leftoverMinor: number;
  /**
   * **A household's left over is its members', added up** (decision 19), one
   * simulated month at a time — `HouseholdPlan.membersLeftoverMinor`'s field on
   * the projection, and equal to it in month 0 because month 0 of a walk is the
   * plan for the as-of date.
   *
   * `Σ MonthProjection.residualMinor` over the accounts this household's members
   * **own**, in this household's currency. Ownership, never the roster: the
   * roster misses a member's own pot the household never assigned, and counts a
   * co-member's money twice when they move it into a pot the roster does hold.
   * `leftoverMinor` beside it is a sum over accounts and answers a different
   * question — the two are not a whole and a part.
   */
  membersLeftoverMinor: number;
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
 * (so the first month matches the plan for that very date, exactly);
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

function withMovementState<T extends InflowInput | OutboundInflowInput>(
  movement: T,
  refDate: Date,
  firstMonth: boolean,
): T {
  if (firstMonth || movement.active === false || movement.frequency !== "one_off") return movement;
  const anchor = parseISODate(movement.anchorDate);
  return anchor.getTime() <= refDate.getTime() ? { ...movement, active: false } : movement;
}

function totalReserved(states: Iterable<PaymentState>): number {
  let total = 0;
  for (const s of states) total += s.alreadySavedMinor;
  return total;
}

// ---------------------------------------------------------------------------
// One account's walk through the simulation
// ---------------------------------------------------------------------------

/** The least a walk needs of an account: what it is, and what it owes. Both
 *  `AccountInput` and the scope pass's account satisfy it. */
interface ProjectedAccount {
  accountId: string;
  currency: string;
  payments: PaymentInput[];
}

/** Everything that evolves as one account is walked forward. */
interface AccountSim {
  accountId: string;
  currency: string;
  byId: Map<string, PaymentInput>;
  states: Map<string, PaymentState>;
  balance: number | null;
  months: MonthProjection[];
}

function newSim(account: ProjectedAccount, startingBalanceMinor: number | null): AccountSim {
  return {
    accountId: account.accountId,
    currency: account.currency,
    byId: new Map(account.payments.map((p) => [p.id, p] as const)),
    states: new Map(account.payments.map((p) => [p.id, initialState(p)] as const)),
    balance: startingBalanceMinor,
    months: [],
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
    availableLeftoverMinor: plan.availableLeftoverMinor,
    residualMinor: plan.residualMinor,
    outboundInflowMinor: plan.outboundInflowMinor,
    shortfallMinor: plan.shortfallMinor,
    reservedEndMinor: totalReserved(sim.states.values()),
    projectedBalanceMinor: sim.balance,
    lines,
  });
}

// ---------------------------------------------------------------------------
// Scope projection — every month is a pass, every account is a view of it
// ---------------------------------------------------------------------------

/**
 * The scope as it should be planned for one simulated month: each account's
 * savings state overlaid, and — after the first month — nothing confirmed.
 * Inputs are never mutated; this is always a copy.
 */
function workingScope(
  input: ScopeInput,
  sims: ReadonlyMap<string, AccountSim>,
  firstMonth: boolean,
  refDate: Date,
): ScopeInput {
  return {
    ...input,
    confirmedTransfers: firstMonth ? input.confirmedTransfers : [],
    accounts: input.accounts.map((account) => {
      const states = sims.get(account.accountId)!.states;
      return {
        ...account,
        payments: account.payments.map((p) => withState(p, states.get(p.id)!)),
        inflows: account.inflows?.map((i) => withMovementState(i, refDate, firstMonth)),
        outboundInflows: account.outboundInflows?.map((i) =>
          withMovementState(i, refDate, firstMonth),
        ),
        confirmedArrivals: firstMonth ? account.confirmedArrivals : [],
      };
    }),
  };
}

/**
 * Simulate a whole scope month by month: one `computeScopePlan` per simulated
 * month, over every account at once, and each account's month read off it as a
 * view.
 *
 * This replaces the single-account walk, and the reason is the one this whole
 * package exists for. Walking one account forward on a total somebody else
 * worked out could only ever hold that total flat: what arrives in month 7 is
 * month 7's obligation, funded out of month 7's income, and one account's input
 * does not contain the member whose money it is. So the old walk documented
 * three approximations it could not avoid — an expired transfer that kept
 * arriving, a sender whose goal completed and never passed the money on, a
 * sender whose income fell away and kept sending. None of them survives here,
 * because a **sending account's projection is the same pass as the receiving
 * account's** and cannot diverge from it:
 *
 *  - a derived feed is re-derived each month against that month's obligations,
 *    so a pot whose bill is nearly saved for is fed less, not the same;
 *  - a goal that completes upstream stops consuming, and the money flows on;
 *  - an authored movement with a `one_off` cadence stops when its anchor passes;
 *  - a loop is broken at the same edge every month, deterministically, so
 *    `cycles` is reported once.
 *
 * Confirmations are the one thing not carried forward: a confirmation is a
 * statement about the month it was made in, and holding it flat would assert
 * that you have already made twelve transfers you have not made.
 *
 * ## Balance premise
 *
 * Unchanged, and per account. Only money that is *set aside* moves the balance:
 * it grows by what was funded into non-monthly goals and falls by the full
 * amount of any non-monthly bill that fell due, so an under-reserved bill drives
 * the balance negative and makes the crunch visible. Monthly bills, the buffer,
 * the leftover, derived transfers and authored movements are all assumed paid or
 * moved out of the same month's money and are balance-neutral. A dateless
 * contribution-capped goal never falls due, so completing it takes nothing back
 * out.
 *
 * Inputs are never mutated: the evolving payment state is held separately and
 * overlaid onto copies.
 */
export function computeScopeProjection(
  input: ScopeInput,
  asOfDate: string,
  opts: ScopeProjectionOptions = {},
): ScopeProjection {
  const refs = monthReferences(asOfDate, clampMonths(opts.months));
  const sims = new Map<string, AccountSim>(
    input.accounts.map((a) => [
      a.accountId,
      newSim(a, opts.startingBalancesMinor?.[a.accountId] ?? null),
    ]),
  );

  const months: ScopeMonthProjection[] = [];
  let cycles: EstateCycle[] = [];

  for (const [index, ref] of refs.entries()) {
    const refDate = parseISODate(ref);
    const monthKey = ref.slice(0, 7);
    const working = workingScope(input, sims, index === 0, refDate);
    const plan = computeScopePlan(working, ref);
    if (index === 0) cycles = plan.cycles;

    for (const account of input.accounts) {
      advance(
        sims.get(account.accountId)!,
        accountPlanFromScope(working, plan, account.accountId),
        refDate,
        monthKey,
      );
    }

    months.push({
      month: monthKey,
      // Read straight off the partitions rather than summed here: the pass has
      // already decided what the month cost and what it left, and a second
      // arithmetic over the same accounts is exactly the thing that used to need
      // netting to agree with itself.
      perCurrency: plan.partitions.map((p) => ({
        currency: p.currency,
        monthlyIncomeMinor: p.monthlyIncomeMinor,
        totalRequiredMinor: p.totalRequiredMinor,
        totalFundedMinor: p.totalFundedMinor,
        leftoverMinor: p.leftoverMinor,
        committedMinor: p.committedMinor,
        shortfallMinor: p.shortfallMinor,
      })),
      transfers: plan.transfers,
      movements: plan.movements,
    });
  }

  return {
    scopeId: input.scopeId,
    householdId: input.householdId ?? null,
    asOfDate,
    accounts: input.accounts.map((account) => {
      const sim = sims.get(account.accountId)!;
      return {
        accountId: sim.accountId,
        ownerUserId: account.ownerUserId,
        currency: sim.currency,
        asOfDate,
        months: sim.months,
      };
    }),
    months,
    cycles,
  };
}

// ---------------------------------------------------------------------------
// Household projection — the scope walk, restricted to one household's accounts
// ---------------------------------------------------------------------------

/**
 * A household's simulated months, read off a scope walk.
 *
 * `computeHouseholdProjection` used to re-run the household engine per month and
 * could no more see money leaving one of its accounts than the plan it projected
 * could (ONE-ENGINE.md). One walk answers both surfaces now, and this restricts
 * its answer to the accounts the household actually holds — the scope reaches
 * upstream to whatever funds them, and a sender nobody assigned is not the
 * household's business.
 *
 * There is no balance trajectory here, unchanged: household money sits across
 * several accounts, so the meaningful monthly figure is what has to move between
 * them. `transfersTotalMinor` counts the transfers the pass derived that **land**
 * in one of them, in this household's currency — the same set, to the penny, that
 * `householdPlanFromScope` publishes as `transfers`, because month 0 of a walk is
 * the plan for the as-of date and two surfaces reporting one figure differently
 * is the defect ONE-ENGINE.md exists to end.
 *
 * Which is why `memberUserIds` is here. Every other figure below is a sum over
 * the **roster**, correctly — they are all about the household's own accounts
 * and its own obligations. `membersLeftoverMinor` is not about accounts at all;
 * it is about people (decision 19), so it is summed over the accounts those
 * people **own**, wherever the scope found them. The roster cannot answer it:
 * it misses a member's own pot the household never assigned, and it counts a
 * co-member's money twice when they move it into a pot the roster does hold.
 * A projection strip that answered it off the roster would contradict the
 * headline printed directly above it, one month at a time.
 */
export function householdProjectionFromScope(
  projection: ScopeProjection,
  householdId: string,
  accountIds: readonly string[],
  currency: string,
  memberUserIds: readonly string[],
): HouseholdProjection {
  const inHousehold = new Set(accountIds);
  const accounts = projection.accounts.filter((a) => inHousehold.has(a.accountId));
  const memberIds = new Set(memberUserIds);
  // Ownership, never the roster and never access (decision 20) — and narrowed
  // to this household's currency for the same reason `personalLeftoverMinor`
  // is: a second currency is a second answer, never a term in the first.
  const memberOwned = projection.accounts.filter(
    (a) => a.currency === currency && memberIds.has(a.ownerUserId),
  );

  return {
    householdId,
    currency,
    asOfDate: projection.asOfDate,
    months: projection.months.map((month, index) => {
      const slices = accounts.map((a) => ({ accountId: a.accountId, month: a.months[index]! }));
      const sum = (pick: (m: MonthProjection) => number): number =>
        slices.reduce((n, s) => n + pick(s.month), 0);
      return {
        month: month.month,
        monthlyIncomeMinor: sum((m) => m.monthlyIncomeMinor),
        totalRequiredMinor: sum((m) => m.totalRequiredMinor),
        totalFundedMinor: sum((m) => m.totalFundedMinor),
        // The accounts' own surplus after their own obligations and after the
        // transfers their owners have to make — the same money the plan's
        // `leftoverMinor` describes, summed over accounts rather than members
        // because a walk records months per account. Its meaning is unchanged
        // (decision 13's surviving half); the ownership figure is added beside
        // it, never in place of it.
        leftoverMinor: sum((m) => m.leftoverMinor),
        membersLeftoverMinor: memberOwned.reduce(
          (n, a) => n + a.months[index]!.availableLeftoverMinor,
          0,
        ),
        shortfallMinor: sum((m) => m.shortfallMinor),
        // Arriving only, and only in this household's currency — the narrowing
        // `householdPlanFromScope` applies, for its reasons: the destination is
        // what decides, because that is the set with lines on this plan for a
        // confirmation to book against. `||` counted money *leaving* a member's
        // account for their own pot outside the household as well, so a
        // household that sends anything out read one figure on its plan and a
        // larger one on its projection for the very same month.
        transfersTotalMinor: month.transfers
          .filter((t) => t.currency === currency && inHousehold.has(t.toAccountId))
          .reduce((n, t) => n + t.amountMinor, 0),
        reservedEndMinor: sum((m) => m.reservedEndMinor),
        lines: slices.flatMap((s) => s.month.lines.map((l) => ({ ...l, accountId: s.accountId }))),
      };
    }),
  };
}
