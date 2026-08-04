import type { PaymentCategory, Recurrence } from "@finance-planner/contracts";
import { addUnit, nextOccurrence, parseISODate, toISODate } from "./dates.js";
import type { PaymentInput } from "./types.js";

const DEFAULT_DAYS = 14;
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const MS_PER_DAY = 86_400_000;
/** Safety net for the stepping loops: a daily cadence over the widest window. */
const MAX_HITS = 200;
/** A 90-day window spans at most four month boundaries; five is slack. */
const MAX_MONTH_HITS = 5;

/** One dated hit of a payment inside the look-ahead window. */
export interface UpcomingPayment {
  paymentId: string;
  name: string;
  category: PaymentCategory;
  amountMinor: number;
  /** ISO date the money is needed. */
  dueDate: string;
  /** Whole days from the as-of date; 0 means "today". */
  daysUntil: number;
}

/** Window length in days, clamped to 1..90 (default 14 for absent/garbage). */
export function clampUpcomingDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.trunc(days)));
}

/** Mirrors engine.ts: a dateless yearly bill has no cadence to step. */
function resolveRecurrence(p: PaymentInput): Recurrence | null {
  if (p.recurrence) return p.recurrence;
  if (p.category === "yearly_recurring" && p.dueDate) {
    return { interval: 1, unit: "year", anchor: p.dueDate };
  }
  return null;
}

function within(date: Date, start: Date, end: Date): boolean {
  return date.getTime() >= start.getTime() && date.getTime() <= end.getTime();
}

/** Every hit of a fixed day-of-month (clamped to short months) in the window. */
function monthlyHits(day: number, start: Date, end: Date): Date[] {
  const hits: Date[] = [];
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  for (let i = 0; i < MAX_MONTH_HITS; i++) {
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const hit = new Date(Date.UTC(year, month, Math.min(day, daysInMonth)));
    if (hit.getTime() > end.getTime()) break;
    if (hit.getTime() >= start.getTime()) hits.push(hit);
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return hits;
}

/**
 * When a payment needs money inside [start, end], per category:
 *   fixed_point       → its target (or due) date, if it lands in the window. An
 *                       already-overdue goal is excluded: the plan already flags
 *                       it off-track, and a feed of past dates is noise. A
 *                       contribution-first goal with no date at all has nothing
 *                       to pin to a day and is skipped — it is a monthly habit,
 *                       not an upcoming bill.
 *   monthly_recurring → its due date's day-of-month, recurring every month and
 *                       clamped to short ones (31st → 30th in April). With no due
 *                       date there is no calendar day to pin it to, so it is
 *                       skipped — it still shows in the plan as a monthly cost.
 *   yearly / custom   → its cadence stepped from the first occurrence on/after
 *                       the window start; a sub-monthly cadence can hit several
 *                       times and every hit is emitted. With no resolvable
 *                       cadence, a due date counts as a single dated hit and a
 *                       payment without one is skipped.
 */
function dueDatesFor(p: PaymentInput, start: Date, end: Date): Date[] {
  if (p.category === "fixed_point") {
    const target = p.targetDate ?? p.dueDate;
    if (!target) return [];
    const date = parseISODate(target);
    return within(date, start, end) ? [date] : [];
  }

  if (p.category === "monthly_recurring") {
    if (!p.dueDate) return [];
    return monthlyHits(parseISODate(p.dueDate).getUTCDate(), start, end);
  }

  const rec = resolveRecurrence(p);
  if (!rec) {
    if (!p.dueDate) return [];
    const date = parseISODate(p.dueDate);
    return within(date, start, end) ? [date] : [];
  }

  const anchor = p.dueDate ? parseISODate(p.dueDate) : start;
  const hits: Date[] = [];
  let occ = nextOccurrence(anchor, rec, start);
  let guard = 0;
  while (occ.getTime() <= end.getTime() && guard < MAX_HITS) {
    hits.push(occ);
    occ = addUnit(occ, rec.interval, rec.unit);
    guard += 1;
  }
  return hits;
}

/**
 * The payments falling due in the next `days` days, one row per dated hit.
 *
 * The window is inclusive at both ends: something due on the as-of date appears
 * with `daysUntil: 0`, and something due exactly `days` out is included. Only
 * active payments are considered. Rows are sorted by due date, then name, so a
 * day's bills read in a stable order.
 */
export function upcomingPayments(
  payments: PaymentInput[],
  asOfDate: string,
  days: number,
): UpcomingPayment[] {
  const start = parseISODate(asOfDate);
  const end = new Date(start.getTime() + clampUpcomingDays(days) * MS_PER_DAY);

  const rows: UpcomingPayment[] = [];
  for (const p of payments) {
    if (p.active === false) continue;
    for (const date of dueDatesFor(p, start, end)) {
      rows.push({
        paymentId: p.id,
        name: p.name,
        category: p.category,
        amountMinor: p.amountMinor,
        dueDate: toISODate(date),
        daysUntil: Math.round((date.getTime() - start.getTime()) / MS_PER_DAY),
      });
    }
  }

  return rows.sort(
    (a, b) =>
      (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) || a.name.localeCompare(b.name),
  );
}
