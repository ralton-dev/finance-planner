import { useState } from "react";
import { ApiError } from "../lib/api.js";
import { formatMonth } from "../lib/months.js";
import { formatMinor } from "../lib/money.js";
import type { MonthCloseDto } from "../lib/types.js";

/**
 * Share of the month's income that was actually set aside. Income of zero (or
 * missing) has no meaningful rate, so it reads as "—" rather than 0% or NaN.
 */
export function savingsRate(contributedMinor: number, incomeMinor: number): string {
  if (incomeMinor <= 0) return "—";
  return `${((contributedMinor / incomeMinor) * 100).toFixed(1)}%`;
}

interface Props {
  /** Newest first, as the API returns them. */
  closes: MonthCloseDto[];
  currency: string;
  /** The month the "close" button acts on, "YYYY-MM". */
  month: string;
  /** Gate close/reopen: account editors, or household owners/admins. */
  canClose?: boolean;
  onClose: (month: string) => Promise<unknown>;
  onReopen: (closeId: string) => Promise<unknown>;
}

/**
 * The month scorecard: freeze what the plan asked for against what actually
 * happened, one row per closed month. Closing is idempotent server-side —
 * a second attempt comes back 409 and is shown inline.
 */
export function MonthScorecard({
  closes,
  currency,
  month,
  canClose = false,
  onClose,
  onReopen,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-head">
        <h2>months</h2>
        <span className="meta">[{closes.length} closed · plan vs. what actually happened]</span>
        <span className="spacer" />
        {canClose && (
          <button
            type="button"
            className="ghost tiny"
            disabled={busy}
            onClick={() => void run(() => onClose(month))}
          >
            close {formatMonth(month)}
          </button>
        )}
      </div>

      {err && (
        <p className="error" role="alert" style={{ fontSize: "12px", marginBottom: "0.5rem" }}>
          {err}
        </p>
      )}

      {closes.length === 0 ? (
        <p className="muted" style={{ fontSize: "12px" }}>
          no months closed yet — close one to lock in its scorecard.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>month</th>
              <th className="num">income</th>
              <th className="num">planned</th>
              <th className="num">saved</th>
              <th className="num">savings rate</th>
              {canClose && <th />}
            </tr>
          </thead>
          <tbody>
            {closes.map((mc) => (
              <tr key={mc.id}>
                <td className="name">{formatMonth(mc.month)}</td>
                <td className="num">{formatMinor(mc.incomeMinor, currency)}</td>
                <td className="num">{formatMinor(mc.plannedMinor, currency)}</td>
                <td className="num">{formatMinor(mc.contributedMinor, currency)}</td>
                <td className={`num${mc.incomeMinor > 0 ? "" : " dim"}`}>
                  {savingsRate(mc.contributedMinor, mc.incomeMinor)}
                </td>
                {canClose && (
                  <td>
                    <span className="row-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run(() => onReopen(mc.id))}
                      >
                        reopen
                      </button>
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
