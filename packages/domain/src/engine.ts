import type { Recurrence } from "@finance-planner/contracts";
import {
  addUnit,
  ceilDiv,
  intervalInMonths,
  monthsUntil,
  nextOccurrence,
  parseISODate,
  toISODate,
} from "./dates.js";
import type {
  AccountInput,
  AccountPlan,
  IncomeInput,
  PaymentInput,
  PaymentPlanLine,
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
}

/**
 * Required monthly contribution to have a payment funded by its target date.
 * See plan/03-calculation-engine.md for the per-category formulas.
 */
export function requiredMonthlyForPayment(p: PaymentInput, now: Date): RequiredResult {
  const alreadySaved = p.alreadySavedMinor ?? 0;

  // Monthly recurring: the full amount is due every month — nothing to save up.
  if (p.category === "monthly_recurring") {
    const due = p.dueDate ? parseISODate(p.dueDate) : now;
    return { requiredMinor: p.amountMinor, effectiveDate: toISODate(due), monthsUntilDue: 1 };
  }

  let nextDue: Date;
  if (p.category === "fixed_point") {
    const target = p.targetDate ?? p.dueDate ?? null;
    nextDue = target ? parseISODate(target) : now;
  } else {
    const rec = resolveRecurrence(p);
    const anchor = p.dueDate ? parseISODate(p.dueDate) : now;
    nextDue = rec ? nextOccurrence(anchor, rec, now) : anchor;
  }

  const months = monthsUntil(now, nextDue);
  const remaining = Math.max(0, p.amountMinor - alreadySaved);
  return {
    requiredMinor: ceilDiv(remaining, months),
    effectiveDate: toISODate(nextDue),
    monthsUntilDue: months,
  };
}

/**
 * Compute the full savings plan for an account as of `asOfDate`.
 *
 * Funding rule (confirmed in discovery): prioritise + show shortfall. Payments
 * are funded in priority order from available income; whatever cannot be funded
 * is surfaced as a shortfall and the affected goals are flagged off-track with a
 * projected completion date.
 */
export function computeAccountPlan(account: AccountInput, asOfDate: string): AccountPlan {
  const now = parseISODate(asOfDate);

  const monthlyIncome = account.incomes.reduce(
    (sum, income) => sum + monthlyIncomeMinor(income, now),
    0,
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
  let remainingBudget = Math.max(0, monthlyIncome - buffer);
  let totalRequired = 0;
  let totalFunded = 0;

  const lines: PaymentPlanLine[] = sorted.map((p) => {
    const req = requiredMonthlyForPayment(p, now);
    const funded = Math.max(0, Math.min(req.requiredMinor, remainingBudget));
    remainingBudget -= funded;
    totalRequired += req.requiredMinor;
    totalFunded += funded;

    const onTrack = funded >= req.requiredMinor;
    let projectedCompletionDate: string | undefined;
    if (!onTrack) {
      const remaining = Math.max(0, p.amountMinor - (p.alreadySavedMinor ?? 0));
      const monthsNeeded = ceilDiv(remaining, Math.max(funded, 1));
      projectedCompletionDate = toISODate(addUnit(now, monthsNeeded, "month"));
    }

    return {
      paymentId: p.id,
      name: p.name,
      category: p.category,
      amountMinor: p.amountMinor,
      dueDate: p.dueDate ?? req.effectiveDate,
      targetDate: req.effectiveDate,
      monthsUntilDue: req.monthsUntilDue,
      requiredMonthlyMinor: req.requiredMinor,
      fundedMonthlyMinor: funded,
      alreadySavedMinor: p.alreadySavedMinor ?? 0,
      onTrack,
      projectedCompletionDate,
    };
  });

  return {
    accountId: account.accountId,
    asOfDate,
    currency: account.currency,
    monthlyIncomeMinor: monthlyIncome,
    bufferMinor: buffer,
    totalRequiredMinor: totalRequired,
    totalFundedMinor: totalFunded,
    leftoverMinor: Math.max(0, remainingBudget),
    shortfallMinor: Math.max(0, totalRequired - totalFunded),
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
  leftoverMinor: number;
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
    bucket.shortfallMinor += plan.shortfallMinor;
    bucket.accounts.push({
      accountId: plan.accountId,
      leftoverMinor: plan.leftoverMinor,
      shortfallMinor: plan.shortfallMinor,
      atRiskCount: plan.lines.filter((l) => !l.onTrack).length,
    });
  }

  return {
    asOfDate,
    perCurrency: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}
