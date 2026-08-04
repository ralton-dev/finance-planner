import type { Recurrence } from "@finance-planner/contracts";
import {
  addUnit,
  ceilDiv,
  intervalInMonths,
  monthsUntil,
  nextOccurrence,
  occurrencesInMonth,
  parseISODate,
  toISODate,
} from "./dates.js";
import type {
  AccountInput,
  AccountPlan,
  IncomeInput,
  OutboundInflowPlan,
  PaymentInput,
  PaymentPlanLine,
  PaymentPlanStatus,
} from "./types.js";

const DEFAULT_PRIORITY = 100;

/** Normalise a single income to its equivalent monthly amount (minor units). */
export function monthlyIncomeMinor(income: IncomeInput, now: Date): number {
  if (income.active === false) return 0;
  switch (income.frequency) {
    case "monthly":
      return income.amountMinor;
    case "yearly":
      return Math.round(income.amountMinor / 12);
    case "custom": {
      if (!income.recurrence) return income.amountMinor;
      const months = intervalInMonths(income.recurrence);
      return Math.round(income.amountMinor / Math.max(months, 1));
    }
    case "one_off": {
      const anchor = parseISODate(income.anchorDate);
      if (anchor.getTime() <= now.getTime()) return 0;
      return Math.round(income.amountMinor / monthsUntil(now, anchor));
    }
  }
}

function resolveRecurrence(p: PaymentInput): Recurrence | null {
  if (p.recurrence) return p.recurrence;
  if (p.category === "yearly_recurring" && p.dueDate) {
    return { interval: 1, unit: "year", anchor: p.dueDate };
  }
  // Note: monthly_recurring never reaches here — it returns earlier in
  // requiredMonthlyForPayment with the full amount due each month.
  return null;
}

interface RequiredResult {
  requiredMinor: number;
  /** The due/target date used for the computation (ISO date). */
  effectiveDate: string;
  monthsUntilDue: number;
  /** How many times the payment falls due in the as-of month (>= 1). */
  occurrencesThisMonth: number;
}

/**
 * The monthly contribution cap governing a payment, or null when none applies.
 *
 * Only a fixed_point goal can be contribution-first ("I'll put by £200 a month
 * until it's done"); the other categories are bills with real deadlines, so a
 * cap there would be a promise the calendar doesn't keep — it is ignored. A
 * non-positive cap is treated as absent (defensive: contracts require > 0).
 */
export function contributionCapMinor(p: PaymentInput): number | null {
  if (p.category !== "fixed_point") return null;
  const cap = p.fixedMonthlyMinor ?? null;
  return cap !== null && cap > 0 ? cap : null;
}

/**
 * Required monthly contribution to have a payment funded by its target date.
 * Per-category formulas:
 *   monthly_recurring → full amount due each month (nothing to "save up")
 *   fixed_point       → ceilDiv(amount - alreadySaved, monthsUntil(targetDate)),
 *                       or, when contribution-first (see below), the cap itself
 *   yearly_recurring  → ceilDiv(remaining, monthsUntil(nextOccurrence))
 *   custom_recurring  → if it falls due this month, (occurrences this month) ×
 *                       amount (a sub-monthly cadence like every-2-weeks can hit
 *                       2–3 times); otherwise save up toward the next occurrence
 * monthsUntil() floors at 1 to avoid divide-by-zero on past / this-month dates.
 *
 * Contribution-first goals (fixed_point + fixedMonthlyMinor):
 *   requiredMinor = min(cap, remaining) — the pace is chosen, not derived, and
 *   the final month asks only for what is left.
 *   With a dueDate:    the date no longer drives the amount (the cap does), but
 *                      it stays the effectiveDate, and monthsUntilDue still
 *                      counts to it — so the plan can still say "you'll be late".
 *   Without a dueDate: monthsUntilDue = ceilDiv(remaining, cap) (min 1) and the
 *                      effectiveDate is that many months on from the as-of date:
 *                      the goal's finish date is a consequence of the pace.
 */
export function requiredMonthlyForPayment(p: PaymentInput, now: Date): RequiredResult {
  const alreadySaved = p.alreadySavedMinor ?? 0;

  // Monthly recurring: the full amount is due every month — nothing to save up.
  if (p.category === "monthly_recurring") {
    const due = p.dueDate ? parseISODate(p.dueDate) : now;
    return {
      requiredMinor: p.amountMinor,
      effectiveDate: toISODate(due),
      monthsUntilDue: 1,
      occurrencesThisMonth: 1,
    };
  }

  const cap = contributionCapMinor(p);
  if (cap !== null) {
    const remaining = Math.max(0, p.amountMinor - alreadySaved);
    const target = p.targetDate ?? p.dueDate ?? null;
    // Dated: keep the promised date, count the months to it. Dateless: the pace
    // sets the date — as many whole months as the remaining amount needs.
    const paceMonths = Math.max(1, ceilDiv(remaining, cap));
    const dated = target ? parseISODate(target) : null;
    return {
      requiredMinor: Math.min(cap, remaining),
      effectiveDate: toISODate(dated ?? addUnit(now, paceMonths, "month")),
      monthsUntilDue: dated ? monthsUntil(now, dated) : paceMonths,
      occurrencesThisMonth: 1,
    };
  }

  let nextDue: Date;
  if (p.category === "fixed_point") {
    const target = p.targetDate ?? p.dueDate ?? null;
    nextDue = target ? parseISODate(target) : now;
  } else {
    const rec = resolveRecurrence(p);
    const anchor = p.dueDate ? parseISODate(p.dueDate) : now;
    nextDue = rec ? nextOccurrence(anchor, rec, now) : anchor;

    // A custom cadence can fall due several times in one calendar month (every
    // 2 weeks → 2–3 times). Those are paid as they land, like a monthly bill, so
    // the month's requirement is (occurrences this month) × the per-occurrence
    // amount — a figure that swings with the calendar. With none this month we
    // drop through to the save-up path, accumulating toward the next occurrence.
    if (p.category === "custom_recurring" && rec) {
      const count = occurrencesInMonth(anchor, rec, now);
      if (count >= 1) {
        return {
          requiredMinor: p.amountMinor * count,
          effectiveDate: toISODate(nextDue),
          monthsUntilDue: 1,
          occurrencesThisMonth: count,
        };
      }
    }
  }

  const months = monthsUntil(now, nextDue);
  const remaining = Math.max(0, p.amountMinor - alreadySaved);
  return {
    requiredMinor: ceilDiv(remaining, months),
    effectiveDate: toISODate(nextDue),
    monthsUntilDue: months,
    occurrencesThisMonth: 1,
  };
}

/**
 * Compute the full savings plan for an account as of `asOfDate`.
 *
 * Funding rule (confirmed in discovery): prioritise + show shortfall. Payments
 * are funded in priority order from the month's money; whatever cannot be funded
 * is surfaced as a shortfall and the affected goals are flagged off-track with a
 * projected completion date.
 *
 * The month's money is the account's own income plus any allocated inflow — what
 * a household earmarked for it, plus what another account you own sent it. Own
 * income is spent first, so the per-line own/inflow split falls straight out of
 * the priority order rather than needing a second pass.
 *
 * Requirements still never depend on income — only funding does — so nothing
 * here is circular. **Funding order across accounts is another matter**: an
 * account's allocated inflow is another account's surplus, so the accounts have
 * to be planned in dependency order. That is `computeEstatePlan`'s job; by the
 * time an account reaches this function the money arriving at it is settled.
 *
 * Outbound movements (`outboundInflows`) are funded **last**, out of whatever
 * the payments left, in their own priority order. Decision 6: every expense on
 * this account beats every movement off it, however the movement is ranked.
 */
export function computeAccountPlan(account: AccountInput, asOfDate: string): AccountPlan {
  const now = parseISODate(asOfDate);

  const monthlyIncome = account.incomes.reduce(
    (sum, income) => sum + monthlyIncomeMinor(income, now),
    0,
  );

  // Clamped defensively: a caller cannot have confirmed more than it allocated,
  // nor have more of it arrive from inside the estate than arrived at all.
  const allocatedInflow = Math.max(0, account.inflow?.allocatedMinor ?? 0);
  const confirmedInflow = Math.min(
    allocatedInflow,
    Math.max(0, account.inflow?.confirmedMinor ?? 0),
  );
  const arrivals = account.inflow?.sources ?? [];
  const internalInflow = Math.min(
    allocatedInflow,
    arrivals.reduce((sum, a) => sum + Math.max(0, a.amountMinor), 0),
  );

  const sorted = account.payments
    .filter((p) => p.active !== false)
    .sort((a, b) => {
      const pa = a.priority ?? DEFAULT_PRIORITY;
      const pb = b.priority ?? DEFAULT_PRIORITY;
      if (pa !== pb) return pa - pb;
      const da = a.targetDate ?? a.dueDate ?? "9999-12-31";
      const db = b.targetDate ?? b.dueDate ?? "9999-12-31";
      return da < db ? -1 : da > db ? 1 : 0;
    });

  const buffer = Math.max(0, account.monthlyBufferMinor ?? 0);
  // The buffer comes off the account's *own* income only. Allocated inflow
  // arrives earmarked — a shared pot's buffer is already funded as an obligation
  // in the household plan — so taking it off the inflow too would reserve the
  // same money twice. It also keeps the own/inflow split honest when own income
  // is smaller than the buffer.
  let remainingOwn = Math.max(0, monthlyIncome - buffer);
  let remainingInflow = allocatedInflow;
  // How much of the inflow earlier lines have already spent. Confirmed money is
  // spent before merely promised money, so a line leaned on an unconfirmed
  // transfer exactly when its slice of the inflow runs past the confirmed mark.
  let inflowUsed = 0;
  let totalRequired = 0;
  let totalFunded = 0;

  const lines: PaymentPlanLine[] = sorted.map((p) => {
    const req = requiredMonthlyForPayment(p, now);
    const need = Math.max(0, req.requiredMinor);
    const fromOwn = Math.min(need, remainingOwn);
    const fromInflow = Math.min(need - fromOwn, remainingInflow);
    const funded = fromOwn + fromInflow;
    remainingOwn -= fromOwn;
    remainingInflow -= fromInflow;
    const drewOnUnconfirmed = fromInflow > 0 && inflowUsed + fromInflow > confirmedInflow;
    inflowUsed += fromInflow;
    totalRequired += req.requiredMinor;
    totalFunded += funded;

    const onTrack = funded >= req.requiredMinor;
    const status: PaymentPlanStatus = !onTrack
      ? "at_risk"
      : drewOnUnconfirmed
        ? "awaiting_transfer"
        : "funded";
    const remaining = Math.max(0, p.amountMinor - (p.alreadySavedMinor ?? 0));
    let projectedCompletionDate: string | undefined;
    if (!onTrack) {
      const monthsNeeded = ceilDiv(remaining, Math.max(funded, 1));
      projectedCompletionDate = toISODate(addUnit(now, monthsNeeded, "month"));
    } else if (remaining > 0 && contributionCapMinor(p) !== null) {
      // A contribution-capped goal can be fully funded and still miss its date:
      // the cap, not the calendar, sets the pace. Surface the real finish date
      // when it lands after the date the goal carries — "on pace, but late", two
      // facts the UI can show side by side. For a dateless goal the finish date
      // *is* the effective date, so this never fires.
      const finish = toISODate(addUnit(now, ceilDiv(remaining, req.requiredMinor), "month"));
      if (finish > req.effectiveDate) projectedCompletionDate = finish;
    }

    return {
      paymentId: p.id,
      name: p.name,
      category: p.category,
      amountMinor: p.amountMinor,
      dueDate: p.dueDate ?? req.effectiveDate,
      targetDate: req.effectiveDate,
      // The pace decided the date exactly when there was a cap and no date to
      // keep — the same condition `requiredMonthlyForPayment` branches on.
      dueDateIsDerived: contributionCapMinor(p) !== null && !p.targetDate && !p.dueDate,
      monthsUntilDue: req.monthsUntilDue,
      requiredMonthlyMinor: req.requiredMinor,
      fundedMonthlyMinor: funded,
      fundedFromOwnMinor: fromOwn,
      fundedFromInflowMinor: fromInflow,
      alreadySavedMinor: p.alreadySavedMinor ?? 0,
      occurrencesThisMonth: req.occurrencesThisMonth,
      onTrack,
      status,
      projectedCompletionDate,
      fixedMonthlyMinor: p.fixedMonthlyMinor ?? null,
      tag: p.tag ?? null,
    };
  });

  // --- movements out, from whatever the bills left ---
  // Decision 6, and the reason this is a separate loop rather than another
  // entry in the priority sort: an outbound movement never competes with a
  // payment, whatever priority number it carries. It competes only with other
  // movements. Own income goes first here too, mirroring the lines above, so a
  // pot forwarding money passes on inflow rather than inventing income.
  let outboundOwn = remainingOwn;
  let outboundInflowLeft = remainingInflow;
  let outboundTotal = 0;
  const outboundInflows: OutboundInflowPlan[] = (account.outboundInflows ?? [])
    .filter((o) => o.active !== false)
    .sort((a, b) => {
      const pa = a.priority ?? DEFAULT_PRIORITY;
      const pb = b.priority ?? DEFAULT_PRIORITY;
      if (pa !== pb) return pa - pb;
      // Stable and independent of load order: the destination, then the row.
      if (a.toAccountId !== b.toAccountId) return a.toAccountId < b.toAccountId ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((o) => {
      const need = Math.max(0, monthlyIncomeMinor(o, now));
      const fromOwn = Math.min(need, outboundOwn);
      const fromInflow = Math.min(need - fromOwn, outboundInflowLeft);
      outboundOwn -= fromOwn;
      outboundInflowLeft -= fromInflow;
      const funded = fromOwn + fromInflow;
      outboundTotal += funded;
      return {
        inflowId: o.id,
        toAccountId: o.toAccountId,
        requiredMonthlyMinor: need,
        fundedMonthlyMinor: funded,
        fundedFromOwnMinor: fromOwn,
        fundedFromInflowMinor: fromInflow,
        onTrack: funded >= need,
      };
    });

  // Of the inflow the *payments* consumed, the part that came from inside the
  // estate. Household-earmarked money is spent first (it was earmarked for
  // these bills), so internal money is what is left at the bottom of the pot.
  // Inflow merely passed on to another account is not "used" — it is used
  // wherever it finally lands, and netting it here as well would net it twice.
  const internalInflowUsed = Math.min(
    internalInflow,
    Math.max(0, inflowUsed - (allocatedInflow - internalInflow)),
  );

  return {
    accountId: account.accountId,
    asOfDate,
    currency: account.currency,
    monthlyIncomeMinor: monthlyIncome,
    allocatedInflowMinor: allocatedInflow,
    confirmedInflowMinor: confirmedInflow,
    bufferMinor: buffer,
    totalRequiredMinor: totalRequired,
    totalFundedMinor: totalFunded,
    // Own income only — see the field's comment for why unspent inflow is not
    // this account's surplus to claim. Deliberately *not* reduced by what the
    // movements above send: this is the account's own surplus, and the estate
    // rollup is where money moving between two of your accounts is netted.
    leftoverMinor: Math.max(0, remainingOwn),
    shortfallMinor: Math.max(0, totalRequired - totalFunded),
    internalInflowUsedMinor: internalInflowUsed,
    inflowArrivals: arrivals,
    outboundInflowMinor: outboundTotal,
    outboundInflows,
    fundingCycleAccountIds: account.fundingCycleAccountIds,
    lines,
  };
}

export interface AccountSummary {
  accountId: string;
  leftoverMinor: number;
  shortfallMinor: number;
  atRiskCount: number;
}

export interface CurrencyOverview {
  currency: string;
  monthlyIncomeMinor: number;
  bufferMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  /**
   * Surplus across the estate, **net of money that moved between its own
   * accounts** — so this is not the sum of the per-account `leftoverMinor`s
   * below, and deliberately so. The difference is `intraEstateMovementMinor`.
   */
  leftoverMinor: number;
  /**
   * Money that left one account in this rollup and was spent by another
   * (`AccountPlan.internalInflowUsedMinor`, summed).
   *
   * Exposed rather than silently absorbed because it is the whole explanation
   * for why the rows do not add up to the total: the sending account still
   * reports the pound as its surplus, and the receiving account reports the same
   * pound as funded. One pound, counted twice, once per hop of the chain.
   */
  intraEstateMovementMinor: number;
  shortfallMinor: number;
  accounts: AccountSummary[];
}

export interface Overview {
  asOfDate: string;
  perCurrency: CurrencyOverview[];
}

/**
 * Aggregate per-account plans into an all-accounts overview, grouped by
 * currency (no FX conversion — see decision #1). Currencies are returned in
 * stable alphabetical order.
 *
 * **Intra-estate movement is netted out of the total leftover.** Each account's
 * figures are right on their own: the sender's leftover is its own income after
 * its own obligations, and the receiver's funded total is what its bills got.
 * Summed, a pound that moved between the two is counted at both ends — and a
 * chain (current → pot → ISA) counts it again at every hop, which is why the
 * error is invisible on a two-account fixture and grows without bound on a real
 * estate. Netting the inflow the receiving accounts actually *spent* restores
 * the identity that has to hold:
 *
 *     totalFundedMinor + leftoverMinor === monthlyIncomeMinor - bufferMinor
 *
 * for an estate that funds itself. Nothing is netted for a household allocation
 * arriving from someone else's account, because that money never was this
 * estate's income — so today's household rollups are unchanged to the penny.
 *
 * The per-account rows keep their own un-netted `leftoverMinor`: a row is a fact
 * about one account, and an account genuinely does have that surplus before it
 * moves any of it on.
 */
export function computeOverview(plans: AccountPlan[], asOfDate: string): Overview {
  const byCurrency = new Map<string, CurrencyOverview>();

  for (const plan of plans) {
    let bucket = byCurrency.get(plan.currency);
    if (!bucket) {
      bucket = {
        currency: plan.currency,
        monthlyIncomeMinor: 0,
        bufferMinor: 0,
        totalRequiredMinor: 0,
        totalFundedMinor: 0,
        leftoverMinor: 0,
        intraEstateMovementMinor: 0,
        shortfallMinor: 0,
        accounts: [],
      };
      byCurrency.set(plan.currency, bucket);
    }
    bucket.monthlyIncomeMinor += plan.monthlyIncomeMinor;
    bucket.bufferMinor += plan.bufferMinor;
    bucket.totalRequiredMinor += plan.totalRequiredMinor;
    bucket.totalFundedMinor += plan.totalFundedMinor;
    bucket.leftoverMinor += plan.leftoverMinor;
    bucket.intraEstateMovementMinor += plan.internalInflowUsedMinor;
    bucket.shortfallMinor += plan.shortfallMinor;
    bucket.accounts.push({
      accountId: plan.accountId,
      leftoverMinor: plan.leftoverMinor,
      shortfallMinor: plan.shortfallMinor,
      atRiskCount: plan.lines.filter((l) => !l.onTrack).length,
    });
  }

  for (const bucket of byCurrency.values()) {
    // Floored at zero: an estate can be handed more money than it earns (a
    // partner's account funding a pot inside it), and a negative surplus would
    // be an alarming way to say "somebody else is paying".
    bucket.leftoverMinor = Math.max(0, bucket.leftoverMinor - bucket.intraEstateMovementMinor);
  }

  return {
    asOfDate,
    perCurrency: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}
