import type { Recurrence, RecurrenceUnit } from "@finance-planner/contracts";

const AVG_DAYS_PER_MONTH = 30.4375;

/** Parse an ISO date-only string (YYYY-MM-DD) as a UTC date. */
export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Format a Date as an ISO date-only string (YYYY-MM-DD), in UTC. */
export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whole months between two dates (can be negative). Day-of-month aware. */
export function wholeMonthsBetween(from: Date, to: Date): number {
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return months;
}

/**
 * Whole months from `from` until `to`, floored at a minimum of 1 so that a goal
 * due this month (or in the past) requires its full remaining amount now and we
 * never divide by zero.
 */
export function monthsUntil(from: Date, to: Date): number {
  return Math.max(1, wholeMonthsBetween(from, to));
}

/** Convert a recurrence cadence to an (approximate) number of months. */
export function intervalInMonths(rec: Recurrence): number {
  switch (rec.unit) {
    case "month":
      return rec.interval;
    case "year":
      return rec.interval * 12;
    case "week":
      return (rec.interval * 7) / AVG_DAYS_PER_MONTH;
    case "day":
      return rec.interval / AVG_DAYS_PER_MONTH;
  }
}

function addMonthsClamped(d: Date, months: number): void {
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, daysInMonth));
}

/** Add `interval` units to a date, clamping month-ends (e.g. Jan 31 + 1mo). */
export function addUnit(date: Date, interval: number, unit: RecurrenceUnit): Date {
  const d = new Date(date.getTime());
  switch (unit) {
    case "day":
      d.setUTCDate(d.getUTCDate() + interval);
      break;
    case "week":
      d.setUTCDate(d.getUTCDate() + interval * 7);
      break;
    case "month":
      addMonthsClamped(d, interval);
      break;
    case "year":
      addMonthsClamped(d, interval * 12);
      break;
  }
  return d;
}

/** First occurrence on/after `now`, starting from `anchor` and stepping by `rec`. */
export function nextOccurrence(anchor: Date, rec: Recurrence, now: Date): Date {
  let occ = new Date(anchor.getTime());
  let guard = 0;
  while (occ.getTime() < now.getTime() && guard < 100_000) {
    occ = addUnit(occ, rec.interval, rec.unit);
    guard += 1;
  }
  return occ;
}

/**
 * The dates on which `rec` (stepping forward from `anchor`) lands in the
 * calendar month containing `ref`, ascending. Occurrences before the anchor are
 * never produced. A sub-monthly cadence such as every-2-weeks lands 2 or 3 times
 * in a month depending on where the dates sit, so the list length is dynamic
 * month to month rather than a fixed average.
 */
export function occurrenceDatesInMonth(anchor: Date, rec: Recurrence, ref: Date): Date[] {
  if (rec.interval < 1) return [];
  const monthStart = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1));
  // First occurrence on/after the month start (never earlier than the anchor).
  let occ = nextOccurrence(anchor, rec, monthStart);
  const dates: Date[] = [];
  let guard = 0;
  while (occ.getTime() < nextMonthStart.getTime() && guard < 1000) {
    dates.push(occ);
    occ = addUnit(occ, rec.interval, rec.unit);
    guard += 1;
  }
  return dates;
}

/**
 * Count how many occurrences of `rec` (stepping forward from `anchor`) land in
 * the calendar month containing `ref` — the count sibling of
 * `occurrenceDatesInMonth`, sharing its stepping and guards.
 */
export function occurrencesInMonth(anchor: Date, rec: Recurrence, ref: Date): number {
  return occurrenceDatesInMonth(anchor, rec, ref).length;
}

/** Ceiling integer division; returns `a` if the divisor is non-positive. */
export function ceilDiv(a: number, b: number): number {
  if (b <= 0) return a;
  return Math.ceil(a / b);
}
