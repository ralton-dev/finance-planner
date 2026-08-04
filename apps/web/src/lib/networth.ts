import { currentMonth, monthOf, monthRange } from "./months.js";
import type { BalanceSnapshotDto } from "./types.js";

export interface AccountBalanceHistory {
  /** Only what the series needs — keeps the helper trivially testable. */
  account: { id: string; currency: string };
  snapshots: BalanceSnapshotDto[];
}

export interface NetWorthPoint {
  /** "YYYY-MM". */
  month: string;
  /** Minor units per ISO currency code. A currency is absent until at least
   *  one of its accounts has been checked in. */
  totals: Record<string, number>;
}

/**
 * Turn per-account balance check-ins into a monthly net-worth series.
 *
 * For every calendar month between the earliest snapshot and the current month,
 * each account contributes its most recent snapshot dated on or before the end
 * of that month (carry-forward: a balance stays true until it is restated).
 * Accounts with no snapshot yet contribute nothing, so an account that appears
 * halfway through history doesn't fake a zero balance before it existed.
 *
 * Amounts are never summed across currencies — each gets its own total.
 */
export function buildNetWorthSeries(
  histories: AccountBalanceHistory[],
  now: Date = new Date(),
): NetWorthPoint[] {
  const dated = histories
    .map((h) => ({
      currency: h.account.currency,
      // Ascending by date so "latest on or before month end" is a scan.
      snapshots: [...h.snapshots].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate)),
    }))
    .filter((h) => h.snapshots.length > 0);

  if (dated.length === 0) return [];

  const earliest = dated.reduce((min, h) => {
    const first = monthOf(h.snapshots[0]!.asOfDate);
    return first < min ? first : min;
  }, monthOf(dated[0]!.snapshots[0]!.asOfDate));

  const last = currentMonth(now);
  // A check-in dated in the future would otherwise fall outside the range.
  const end = dated.reduce((max, h) => {
    const latest = monthOf(h.snapshots.at(-1)!.asOfDate);
    return latest > max ? latest : max;
  }, last);

  return monthRange(earliest, end).map((month) => {
    const totals: Record<string, number> = {};
    for (const h of dated) {
      // Compare by month bucket so a snapshot on the 31st still counts for that
      // month — no end-of-month date arithmetic needed.
      let value: number | null = null;
      for (const s of h.snapshots) {
        if (monthOf(s.asOfDate) > month) break;
        value = s.balanceMinor;
      }
      if (value === null) continue;
      totals[h.currency] = (totals[h.currency] ?? 0) + value;
    }
    return { month, totals };
  });
}

/** Every currency that appears anywhere in the series, in first-seen order. */
export function seriesCurrencies(points: NetWorthPoint[]): string[] {
  const seen: string[] = [];
  for (const p of points) {
    for (const c of Object.keys(p.totals)) if (!seen.includes(c)) seen.push(c);
  }
  return seen;
}
