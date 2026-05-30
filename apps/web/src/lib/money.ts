/** Format an integer minor-unit amount as a localized currency string. */
export function formatMinor(minor: number, currency: string, locale = "en-GB"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
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
