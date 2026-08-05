import { lazy, Suspense, useRef, useState } from "react";
import { formatMonth, formatMonthShort } from "../lib/months.js";
import { formatCompactMinor, formatMinor } from "../lib/money.js";
import {
  buildGridRows,
  buildProjectionPoints,
  hasBalanceSeries,
  hasShortfallSeries,
  hasTransfers,
  monthLeftOverMinor,
  type ProjectionMonthLike,
} from "../lib/projection.js";
import { useAsync } from "../lib/useAsync.js";
import { ChartFrame } from "./ChartFrame.js";
import { DownloadButton } from "./DownloadButton.js";

// Keeps recharts out of the page chunks, as the Sankey and net-worth chart do.
const ProjectionChart = lazy(() =>
  import("./ProjectionChart.js").then((m) => ({ default: m.ProjectionChart })),
);

/** Windows the selector offers. The server clamps to 1..24 regardless. */
const WINDOWS = [6, 12, 24];
const DEFAULT_WINDOW = 12;

/** The slice of either projection response these views need. */
export interface ProjectionData {
  currency: string;
  months: ProjectionMonthLike[];
}

interface Props {
  /** Fetches one window of months. Re-run whenever the selector changes. */
  load: (months: number) => Promise<ProjectionData>;
  /** The account or household the projection belongs to; a change reloads. */
  scopeKey?: string;
  /** Household variant: account names, to tell same-named payments apart. */
  accountNames?: Record<string, string>;
  /** One-line caveat above the chart, e.g. the missing balance check-in. */
  hint?: string;
}

/**
 * The forecast: a line chart of where the money ends up, over a dense
 * months × payments grid of what each payment asks for along the way.
 *
 * Shared by the account and household pages — the household variant adds
 * account names to colliding payment names and reports the money that has to
 * move each month in the chart tooltip (it is a per-month fact, not a
 * trajectory, so it gets no line of its own).
 */
export function ProjectionView({ load, scopeKey, accountNames, hint }: Props) {
  const [windowMonths, setWindowMonths] = useState(DEFAULT_WINDOW);
  const projection = useAsync<ProjectionData>(() => load(windowMonths), [windowMonths, scopeKey]);
  const chartRef = useRef<HTMLDivElement>(null);

  const data = projection.data;
  const months = data?.months ?? [];
  const currency = data?.currency ?? "";
  const rows = buildGridRows(months, accountNames);

  return (
    <>
      <div className="section-head">
        <h2>projection</h2>
        <span className="meta">
          [{months.length || windowMonths} months · what each payment asks for
          {hasTransfers(months) ? " · transfers in the tooltip" : ""}]
        </span>
        <span className="spacer" />
        <span className="months-select" role="group" aria-label="projection window">
          {WINDOWS.map((n) => (
            <button
              key={n}
              type="button"
              className={`ghost tiny${n === windowMonths ? " active" : ""}`}
              aria-pressed={n === windowMonths}
              onClick={() => setWindowMonths(n)}
            >
              {n}m
            </button>
          ))}
        </span>
        <DownloadButton targetRef={chartRef} name="projection" />
      </div>

      {hint && <p className="projection-hint">{hint}</p>}

      {projection.error ? (
        <p className="error" style={{ fontSize: "12px" }}>
          could not load the projection.
        </p>
      ) : projection.loading && months.length === 0 ? (
        <p className="muted" style={{ fontSize: "12px" }}>
          projecting…
        </p>
      ) : months.length === 0 || rows.length === 0 ? (
        <p className="muted" style={{ fontSize: "12px" }}>
          nothing to project yet — add a payment to see where the money lands.
        </p>
      ) : (
        <>
          <ChartFrame ref={chartRef}>
            <Suspense
              fallback={
                <p className="muted" style={{ fontSize: "12px" }}>
                  loading chart…
                </p>
              }
            >
              <ProjectionChart
                points={buildProjectionPoints(months)}
                currency={currency}
                showBalance={hasBalanceSeries(months)}
                showShortfall={hasShortfallSeries(months)}
              />
            </Suspense>
          </ChartFrame>
          <MonthsGrid months={months} rows={rows} currency={currency} />
        </>
      )}
    </>
  );
}

/** Payments down, months across. Scrolls inside itself so the page never does. */
function MonthsGrid({
  months,
  rows,
  currency,
}: {
  months: ProjectionMonthLike[];
  rows: ReturnType<typeof buildGridRows>;
  currency: string;
}) {
  return (
    <>
      <div className="grid-scroll">
        <table className="months-grid">
          <thead>
            <tr>
              <th className="sticky-col">payment</th>
              {months.map((m) => (
                <th key={m.month} className="num" title={formatMonth(m.month)}>
                  {formatMonthShort(m.month)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.paymentId}>
                <th scope="row" className="sticky-col name">
                  {row.label}
                </th>
                {row.cells.map((cell, i) =>
                  cell ? (
                    <td
                      key={months[i]!.month}
                      className={`num${cell.dueThisMonth ? " due" : ""}`}
                      title={
                        cell.dueThisMonth
                          ? `due: ${formatMinor(cell.dueAmountMinor, currency)}`
                          : formatMinor(cell.requiredMonthlyMinor, currency)
                      }
                    >
                      {formatCompactMinor(cell.requiredMonthlyMinor, currency)}
                      {cell.dueThisMonth && (
                        <span className="due-dot" aria-hidden="true">
                          •
                        </span>
                      )}
                    </td>
                  ) : (
                    <td key={months[i]!.month} className="num dim" />
                  ),
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="sticky-col">
                required
              </th>
              {months.map((m) => (
                <td
                  key={m.month}
                  className="num"
                  title={formatMinor(m.totalRequiredMinor, currency)}
                >
                  {formatCompactMinor(m.totalRequiredMinor, currency)}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row" className="sticky-col">
                left over
              </th>
              {months.map((m) => {
                const short = m.shortfallMinor > 0;
                // The same derivation the KPI above prints for month 1 — the
                // account's residual, or the household's members' sum — never
                // `leftoverMinor`, which is what made this row contradict the
                // figure directly above it.
                const left = monthLeftOverMinor(m);
                return (
                  <td
                    key={m.month}
                    className={`num${short ? " warn" : left < 0 ? " warn" : " ok"}`}
                    title={
                      short
                        ? `shortfall: ${formatMinor(m.shortfallMinor, currency)}`
                        : formatMinor(left, currency)
                    }
                  >
                    {short
                      ? `-${formatCompactMinor(m.shortfallMinor, currency)}`
                      : formatCompactMinor(left, currency)}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      <GridKey />
    </>
  );
}

/**
 * What the grid's marks mean. Three of them: the dot and the tint both say
 * "this payment actually falls due that month" (the tint carries across the
 * whole cell, the dot survives a screenshot at low contrast), and the tilde is
 * the plan-table's mark for a date it worked out rather than one you set.
 */
function GridKey() {
  return (
    <p className="grid-key">
      <span className="due-dot" aria-hidden="true">
        •
      </span>{" "}
      falls due that month{" · "}
      <i className="key-swatch" aria-hidden="true" /> tinted cell = due month{" · "}
      <span className="derived">~</span> derived date
    </p>
  );
}
