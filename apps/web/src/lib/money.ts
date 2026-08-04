/** Format an integer minor-unit amount as a localized currency string. */
export function formatMinor(minor: number, currency: string, locale = "en-GB"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
}

/**
 * ICU changed the casing of the compact suffix between versions — the same
 * amount renders "£1.4K" on one Node build and "£1.4k" on another. Uppercase a
 * trailing ASCII letter so every environment ships the form the UI always had.
 */
const COMPACT_SUFFIX = /([a-z])$/;

/**
 * Short form for dense surfaces — axis ticks, grid cells: "£82.5", "£1.2K".
 * Never use it where the exact figure matters; pair it with a title/tooltip
 * carrying the full `formatMinor` value.
 */
export function formatCompactMinor(minor: number, currency: string, locale = "en-GB"): string {
  const formatted = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    // Without the minimum, compact notation pads whole amounts: "£200.0".
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(minor / 100);
  return formatted.replace(COMPACT_SUFFIX, (s) => s.toUpperCase());
}

/** Parse a user-entered major-unit amount (e.g. "12.50") into minor units. */
export function toMinor(input: string | number): number {
  const n = Number(String(input).replace(/[^0-9.-]/g, ""));
  return Math.round((Number.isFinite(n) ? n : 0) * 100);
}

/** Minor units → major-unit number for input fields. */
export function toMajor(minor: number): number {
  return minor / 100;
}

/**
 * A sentence with its money kept apart from its words.
 *
 * Privacy mode blurs *elements* — `.amount`, `td.num`, `.kpi-value`. A figure
 * baked into a string has no element of its own, so "£540.00 is short this
 * month" stayed in the clear on a screen whose entire purpose is that the
 * person behind you cannot read the numbers. Anything that words a figure into
 * prose returns these parts instead, and the UI renders each money part as an
 * `<Amount>` (see `components/Amount.tsx`).
 */
export type PhrasePart = string | { minor: number; currency: string };
export type Phrase = readonly PhrasePart[];

/** A money part, for building a phrase inline. */
export function money(minor: number, currency: string): PhrasePart {
  return { minor, currency };
}

/** The same sentence as plain text — for a `title`, a label, or a test. */
export function phraseText(phrase: Phrase): string {
  return phrase.map((p) => (typeof p === "string" ? p : formatMinor(p.minor, p.currency))).join("");
}
