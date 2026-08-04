import { occurrenceDatesInMonth, parseISODate, toISODate } from "./dates.js";
import { splitByShares, type Transfer } from "./household.js";
import type { IncomeInput } from "./types.js";

/**
 * One payday, with the money the member should move on it. `transfers` holds a
 * line per planned transfer that has a non-zero slice on this date; `totalMinor`
 * is their sum (0 on a payday where nothing rounds onto it).
 */
export interface PayEvent {
  /** ISO date (YYYY-MM-DD) of the payday. */
  date: string;
  transfers: { fromAccountId: string; toAccountId: string; amountMinor: number }[];
  totalMinor: number;
}

export interface MemberPaydaySchedule {
  memberUserId: string;
  events: PayEvent[];
}

/** A household member's income streams, for locating their paydays. */
export interface MemberIncomes {
  memberUserId: string;
  incomes: IncomeInput[];
}

/** Clamp a day-of-month into the calendar month of `ref` (31st → 30th/28th). */
function clampIntoMonth(ref: Date, day: number): Date {
  const daysInMonth = new Date(
    Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), Math.min(day, daysInMonth)));
}

/**
 * The dates one income pays out on, within the calendar month of `ref`.
 *
 *   monthly  → the anchor's day-of-month, clamped into this month (a recurrence,
 *              if one is set, wins — it is the more specific cadence)
 *   yearly   → the anchor's day, but only in months matching the anchor's month.
 *              The anchor's *year* is not checked: a yearly stream pays every
 *              year, and a future-dated anchor is a data-entry edge case.
 *   custom   → its recurrence stepped through the month; with no recurrence
 *              there is no cadence, so it falls back to the anchor's day-of-month
 *              (mirroring the engine, which treats it as a monthly amount)
 *   one_off  → the anchor itself, and only in the month it falls in
 *
 * Inactive incomes never pay.
 */
function payDatesForIncome(income: IncomeInput, ref: Date): Date[] {
  if (income.active === false) return [];
  const anchor = parseISODate(income.anchorDate);
  switch (income.frequency) {
    case "monthly":
    case "custom":
      return income.recurrence
        ? occurrenceDatesInMonth(anchor, income.recurrence, ref)
        : [clampIntoMonth(ref, anchor.getUTCDate())];
    case "yearly":
      return anchor.getUTCMonth() === ref.getUTCMonth()
        ? [clampIntoMonth(ref, anchor.getUTCDate())]
        : [];
    case "one_off":
      return anchor.getUTCFullYear() === ref.getUTCFullYear() &&
        anchor.getUTCMonth() === ref.getUTCMonth()
        ? [anchor]
        : [];
  }
}

/**
 * Every distinct payday a member has in the month of `ref`, ascending. Two
 * incomes landing on the same day merge into one event. With no paydays at all
 * the member still has to move money, so the month's first day stands in.
 */
function payDates(incomes: IncomeInput[], ref: Date): string[] {
  const dates = new Set<string>();
  for (const income of incomes) {
    for (const date of payDatesForIncome(income, ref)) dates.add(toISODate(date));
  }
  if (dates.size === 0)
    return [toISODate(new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1)))];
  return [...dates].sort();
}

/**
 * Spread each member's planned monthly transfers across the paydays they
 * actually have in the as-of month, so the plan says *when* to move the money,
 * not just how much.
 *
 * Rules:
 *   - A member's paydays are derived from their incomes (see `payDatesForIncome`),
 *     de-duplicated by date and sorted ascending. No paydays → a single synthetic
 *     event on the first of the month.
 *   - Each transfer is split into equal shares across those events using the same
 *     largest-remainder discipline as the household split, so the slices sum to
 *     the transfer exactly. With equal weights the remainder pennies land on the
 *     earliest events — better to be slightly ahead than behind.
 *   - Zero (or non-positive) slices are dropped, so a small transfer shows up on
 *     one payday rather than as a row of noise. An event left with nothing is
 *     still reported — it is a real payday with nothing to move.
 *   - Members with no transfers get an empty `events` array rather than being
 *     omitted; input member order is preserved. Transfers belonging to a member
 *     not present in `memberIncomes` are ignored.
 *
 * Pure: neither `transfers` nor `memberIncomes` is mutated.
 */
export function splitTransfersByPayday(
  transfers: Transfer[],
  memberIncomes: MemberIncomes[],
  asOfDate: string,
): MemberPaydaySchedule[] {
  const ref = parseISODate(asOfDate);

  return memberIncomes.map((member) => {
    const mine = transfers.filter((t) => t.memberUserId === member.memberUserId);
    if (mine.length === 0) return { memberUserId: member.memberUserId, events: [] };

    const events: PayEvent[] = payDates(member.incomes, ref).map((date) => ({
      date,
      transfers: [],
      totalMinor: 0,
    }));
    const equalWeights = events.map(() => 1);

    for (const transfer of mine) {
      splitByShares(transfer.amountMinor, equalWeights).forEach((amountMinor, i) => {
        if (amountMinor <= 0) return;
        const event = events[i]!;
        event.transfers.push({
          fromAccountId: transfer.fromAccountId,
          toAccountId: transfer.toAccountId,
          amountMinor,
        });
        event.totalMinor += amountMinor;
      });
    }

    return { memberUserId: member.memberUserId, events };
  });
}
