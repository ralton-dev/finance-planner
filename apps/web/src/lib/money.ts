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
