import { useState } from "react";
import { ApiError, api } from "../lib/api.js";
import { money, toMajor, toMinor, type Phrase, type PhrasePart } from "../lib/money.js";
import { formatMonth, monthOf } from "../lib/months.js";
import type { ContributionDto, PaymentDto } from "../lib/types.js";
import { Amount, Sentence } from "./Amount.js";

/**
 * What has actually been set aside, row by row — the ledger behind the plan's
 * already-saved.
 *
 * Recording one moved the plan and then vanished: the amount went in through
 * the plan table's record box, was summed into `contributionsMTD`, and no
 * screen ever showed the row again. A mistyped figure could be seen in its
 * consequences and nowhere in its cause, so the only way to correct it was an
 * API call. That is the standing assumption in its plainest form — a write and
 * the event it records treated as the same fact, so nothing ever read it back.
 *
 * Rows a **transfer confirmation** wrote are shown and not offered a control.
 * They are one line of somebody's statement that they moved money rather than
 * facts of their own, and the API refuses to change or drop them on their own
 * (409 `confirmation_generated`); un-confirming the transfer unwinds both
 * halves together. A button that only ever returns 409 is worse than no button.
 */
export function ContributionLedger({
  contributions,
  failed = false,
  payments,
  currency,
  month,
  canEdit,
  onChanged,
}: {
  /** Undefined while the read is in flight — not an empty ledger. */
  contributions: readonly ContributionDto[] | undefined;
  failed?: boolean;
  /** Names for the rows' `paymentId`s. */
  payments: readonly PaymentDto[];
  currency: string;
  /** "YYYY-MM" the server calls current — the plan's own month, so the
   *  future-month refusal is measured against its clock and not the browser's. */
  month: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [rowMonth, setRowMonth] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const names = new Map(payments.map((p) => [p.id, p.name]));
  const rows = [...(contributions ?? [])].sort(
    (a, b) => b.month.localeCompare(a.month) || b.createdAt.localeCompare(a.createdAt),
  );

  function beginEdit(c: ContributionDto): void {
    setEditingId(c.id);
    setAmount(toMajor(c.amountMinor).toFixed(2));
    setRowMonth(monthOf(c.month));
    setNote(c.note ?? "");
    setError("");
  }

  async function save(c: ContributionDto): Promise<void> {
    const amountMinor = toMinor(amount);
    if (amountMinor <= 0) {
      setError("amount must be greater than zero");
      return;
    }
    // Refused here rather than after the round trip, because the answer is
    // already known: money cannot have been set aside in a month that has not
    // started. The server refuses it too (422 `future_month`) and that refusal
    // is still handled below — this only saves the person the wait.
    if (rowMonth > month) {
      setError(`${formatMonth(rowMonth)} has not started`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.patchContribution(c.id, {
        amountMinor,
        month: rowMonth,
        note: note.trim() === "" ? null : note.trim(),
      });
      setEditingId(null);
      onChanged();
    } catch (e) {
      setError(refusal(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: ContributionDto): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await api.deleteContribution(c.id);
      setEditingId(null);
      onChanged();
    } catch (e) {
      setError(refusal(e));
    } finally {
      setBusy(false);
    }
  }

  const summary = ledgerNote(contributions, currency, month);

  return (
    <div className="ledger-section">
      <div className="section-head">
        <h2>recorded</h2>
        <span className="meta">
          [{contributions === undefined ? "…" : rows.length} set aside · money that moved]
        </span>
      </div>

      {summary && (
        <p className="muted" style={{ fontSize: "12px", margin: "0 0 0.5rem" }}>
          <Sentence phrase={summary} />
        </p>
      )}

      {failed ? (
        <p className="error">could not read what has been recorded.</p>
      ) : contributions === undefined ? (
        <p className="muted">loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted" style={{ fontSize: "12px" }}>
          nothing recorded yet — the savings plan above is where money set aside goes in.
        </p>
      ) : (
        <ul className="entity-list">
          {rows.map((c) => {
            const fromConfirmation = c.transferConfirmationId !== null;
            const name = names.get(c.paymentId) ?? "a payment no longer listed";
            if (editingId === c.id) {
              return (
                <li key={c.id}>
                  <span style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", flex: 1 }}>
                    <span className="name" style={{ alignSelf: "center" }}>
                      {name}
                    </span>
                    <input
                      aria-label={`amount recorded for ${name}`}
                      value={amount}
                      inputMode="decimal"
                      style={{ width: "5.5rem", textAlign: "right" }}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                    <input
                      aria-label={`month recorded for ${name}`}
                      type="month"
                      value={rowMonth}
                      // The calendar cannot offer a month that has not started,
                      // which is the same refusal the server makes (422
                      // `future_month`) said before the round trip instead of
                      // after it.
                      max={month}
                      style={{ width: "10.5rem" }}
                      onChange={(e) => setRowMonth(e.target.value)}
                    />
                    <input
                      aria-label={`note for ${name}`}
                      value={note}
                      placeholder="note"
                      style={{ flex: "1 1 8rem", minWidth: "6rem" }}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <button
                      type="button"
                      className="action"
                      disabled={busy}
                      onClick={() => void save(c)}
                    >
                      save
                    </button>
                    <button
                      type="button"
                      className="ghost tiny"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(null);
                        setError("");
                      }}
                    >
                      cancel
                    </button>
                    {error && (
                      <span className="error record-error" role="alert">
                        {error}
                      </span>
                    )}
                  </span>
                </li>
              );
            }
            return (
              <li key={c.id}>
                <span>
                  <span className="name">{name}</span>
                  <em>
                    — <Amount minor={c.amountMinor} currency={currency} /> · {formatMonth(c.month)}
                  </em>
                  {c.note && <span className="shared">{c.note}</span>}
                  {fromConfirmation && (
                    <span
                      className="shared"
                      title="a confirmed transfer wrote this row; un-confirm the transfer to change it"
                    >
                      from a confirmed transfer
                    </span>
                  )}
                </span>
                {canEdit && !fromConfirmation && (
                  <span className="row-actions">
                    <button
                      type="button"
                      className="ghost tiny"
                      title="edit"
                      disabled={busy}
                      onClick={() => beginEdit(c)}
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      className="ghost tiny"
                      disabled={busy}
                      onClick={() => void remove(c)}
                    >
                      remove
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && editingId === null && (
        <p className="error" role="alert" style={{ fontSize: "11px" }}>
          {error}
        </p>
      )}
    </div>
  );
}

/** The API's refusal in the words of this screen. */
function refusal(e: unknown): string {
  if (!(e instanceof ApiError)) return "could not save";
  if (e.code === "confirmation_generated") {
    return "a confirmed transfer wrote this — un-confirm the transfer instead";
  }
  if (e.code === "future_month") return "that month has not started";
  return e.message || e.code;
}

/**
 * What the ledger adds up to this month, as words with the figure kept apart
 * from them.
 *
 * A `Phrase` rather than a string because a formatted amount inside a template
 * literal is a number privacy mode cannot reach — it has no element of its own
 * to blur (`components/Amount.tsx`).
 */
export function ledgerNote(
  contributions: readonly ContributionDto[] | undefined,
  currency: string,
  month: string,
): Phrase | null {
  if (contributions === undefined || contributions.length === 0) return null;
  const mine = contributions.filter((c) => monthOf(c.month) === month);
  const total = mine.reduce((sum, c) => sum + c.amountMinor, 0);
  const parts: PhrasePart[] =
    mine.length === 0
      ? [`nothing recorded in ${formatMonth(month)}`]
      : [
          money(total, currency),
          ` set aside in ${formatMonth(month)}, across ${mine.length} record${mine.length === 1 ? "" : "s"}`,
        ];
  const earlier = contributions.length - mine.length;
  if (earlier > 0) parts.push(` · ${earlier} earlier`);
  return parts;
}
