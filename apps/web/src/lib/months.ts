/**
 * Month helpers. Months are handled as "YYYY-MM" strings throughout the UI —
 * ISO dates sort and compare lexicographically, so no Date maths is needed and
 * there are no timezone surprises.
 */

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** "YYYY-MM" for today (local time), matching what the server calls "current". */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** Any ISO date or month string → its "YYYY-MM" bucket. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** "2026-08-01" or "2026-08" → "aug 2026". */
export function formatMonth(isoDateOrMonth: string): string {
  const [year, month] = monthOf(isoDateOrMonth).split("-");
  const name = MONTH_NAMES[Number(month) - 1];
  return name && year ? `${name} ${year}` : isoDateOrMonth;
}

/** Advance a "YYYY-MM" by n months (n may be negative). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = (y ?? 0) * 12 + ((m ?? 1) - 1) + n;
  const year = Math.floor(total / 12);
  const idx = total - year * 12;
  return `${String(year).padStart(4, "0")}-${String(idx + 1).padStart(2, "0")}`;
}

/** Every "YYYY-MM" from `from` to `to`, inclusive. Empty when from > to. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) {
    out.push(m);
    // Cheap runaway guard: 100 years is far beyond any real plan history.
    if (out.length > 1200) break;
  }
  return out;
}
