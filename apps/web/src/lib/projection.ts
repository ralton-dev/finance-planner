/**
 * Pure shaping for the projection surfaces: the chart's series and the
 * months × payments grid. Both account and household projections feed the same
 * views, so everything here works off the fields the two shapes share — the
 * extras (`projectedBalanceMinor`, `transfersTotalMinor` /
 * `outboundInflowMinor`) are optional and each simply drives one more thing
 * when present.
 */

/** The line fields the views need, from either projection shape. */
export interface ProjectionLineLike {
  paymentId: string;
  name: string;
  requiredMonthlyMinor: number;
  dueThisMonth: boolean;
  dueAmountMinor: number;
  /** Household lines only — used to disambiguate same-named payments. */
  accountId?: string;
}

/** The month fields the views need, from either projection shape. */
export interface ProjectionMonthLike {
  month: string;
  totalRequiredMinor: number;
  /**
   * Kept for the shapes that carry nothing better, and read last.
   *
   * On an account it is own-income-after-own-bills, so a savings pot printed
   * £0.00 in the strip under a KPI reading £200.00; on a household it is that
   * summed over the **roster**, £4,705 on the estate against the members'
   * £4,025. Both are real figures and neither is the one the page leads with.
   */
  leftoverMinor: number;
  /** Account projections only: what is in the account when the month has
   *  happened. The KPI above the strip prints the same derivation for month 1. */
  residualMinor?: number;
  /** Household projections only: `Σ residual` over the accounts this
   *  household's members own — the strip's analogue of the page's headline. */
  membersLeftoverMinor?: number;
  shortfallMinor: number;
  reservedEndMinor: number;
  /** Account projections only; null when there is no balance check-in to start from. */
  projectedBalanceMinor?: number | null;
  /** Money members must move between accounts this month. Household
   *  projections only — an account's own answer is `outboundInflowMinor`. */
  transfersTotalMinor?: number;
  /**
   * Money leaving this account for other accounts this month.
   *
   * The account-scope answer to the same question the household one asks. A
   * household is no longer the only thing that makes money move: two accounts
   * one person owns move money between them with no household anywhere, and a
   * projection that could only read `transfersTotalMinor` was blind to it.
   */
  outboundInflowMinor?: number;
  lines: ProjectionLineLike[];
}

/**
 * What has to move this month, whatever the scope: the household's transfers,
 * or this account's own outbound movements. Never both — the two shapes carry
 * one field each — so the first one present is the answer, and `null` means
 * this projection does not track movement at all.
 */
function movedMinor(month: ProjectionMonthLike): number | null {
  return month.transfersTotalMinor ?? month.outboundInflowMinor ?? null;
}

/**
 * What the strip's LEFT OVER row prints, whatever the scope.
 *
 * One derivation read at two altitudes, exactly as the pages above it read it:
 * an account's residual, or a household's members' residuals added up. The two
 * shapes carry one field each — `movedMinor` directly above is the precedent —
 * so the first one present is the answer, and `leftoverMinor` is the fallback a
 * payload from an older API lands on rather than rendering nothing.
 *
 * Never a reconstruction. The reframing this file serves forbids a surface
 * deriving a fourth answer by algebra, and the strip is the surface that was
 * printing the fourth one: it read £2,501 a few hundred pixels under a KPI
 * saying £2,051, and £0.00 under one saying £200.00 (MINE-AND-OURS.md).
 */
export function monthLeftOverMinor(month: ProjectionMonthLike): number {
  return month.residualMinor ?? month.membersLeftoverMinor ?? month.leftoverMinor;
}

/** One x-position of the chart. Nulls are gaps, never zeroes. */
export interface ProjectionPoint {
  month: string;
  reserved: number;
  balance: number | null;
  shortfall: number;
  transfers: number | null;
}

export function buildProjectionPoints(months: ProjectionMonthLike[]): ProjectionPoint[] {
  return months.map((m) => ({
    month: m.month,
    reserved: m.reservedEndMinor,
    balance: m.projectedBalanceMinor ?? null,
    shortfall: m.shortfallMinor,
    transfers: movedMinor(m),
  }));
}

/** A balance line is only honest when the server projected one at all. */
export function hasBalanceSeries(months: ProjectionMonthLike[]): boolean {
  return months.some(
    (m) => m.projectedBalanceMinor !== null && m.projectedBalanceMinor !== undefined,
  );
}

/** A flat zero line teaches nothing — only draw shortfall when there is some. */
export function hasShortfallSeries(months: ProjectionMonthLike[]): boolean {
  return months.some((m) => m.shortfallMinor > 0);
}

/** Worth mentioning when money actually has to move — between members of a
 *  household, or between two accounts one person owns. */
export function hasTransfers(months: ProjectionMonthLike[]): boolean {
  return months.some((m) => (movedMinor(m) ?? 0) > 0);
}

/** A payment's slice of one month, or `null` where the payment is not in the plan. */
export interface GridCell {
  requiredMonthlyMinor: number;
  dueThisMonth: boolean;
  dueAmountMinor: number;
}

export interface GridRow {
  paymentId: string;
  /** Payment name, suffixed with its account when another payment shares the name. */
  label: string;
  /** One entry per month, positionally aligned with the months passed in. */
  cells: (GridCell | null)[];
}

/**
 * One row per payment that appears in any month, in first-appearance order —
 * which is the plan's priority order, since month 0 lists the current plan.
 * Payments that only start later fall in after the ones already running.
 */
export function buildGridRows(
  months: ProjectionMonthLike[],
  accountNames: Record<string, string> = {},
): GridRow[] {
  const rows = new Map<string, { name: string; accountId?: string; cells: (GridCell | null)[] }>();
  const blanks = (): (GridCell | null)[] => months.map(() => null);

  months.forEach((m, i) => {
    for (const line of m.lines) {
      let row = rows.get(line.paymentId);
      if (!row) {
        row = { name: line.name, accountId: line.accountId, cells: blanks() };
        rows.set(line.paymentId, row);
      }
      row.cells[i] = {
        requiredMonthlyMinor: line.requiredMonthlyMinor,
        dueThisMonth: line.dueThisMonth,
        dueAmountMinor: line.dueAmountMinor,
      };
    }
  });

  // Two payments called "insurance" are indistinguishable without their account.
  const nameCounts = new Map<string, number>();
  for (const row of rows.values()) nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);

  return [...rows.entries()].map(([paymentId, row]) => {
    const account = row.accountId ? accountNames[row.accountId] : undefined;
    const collides = (nameCounts.get(row.name) ?? 0) > 1;
    return {
      paymentId,
      label: collides && account ? `${row.name} · ${account}` : row.name,
      cells: row.cells,
    };
  });
}
