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

/** One currency's frozen months, newest first. */
export interface ScorecardCard {
  currency: string;
  closes: MonthCloseDto[];
  /** Every row in it is `{0, 0, 0}`. See the card's own note. */
  empty: boolean;
}

/** A row nobody had any money behind: closed, and correctly so, but with
 *  nothing in it. Its own currency card says why. */
const isEmpty = (c: MonthCloseDto): boolean =>
  c.incomeMinor === 0 && c.plannedMinor === 0 && c.contributedMinor === 0;

/**
 * The caller's rows, split into one card per currency, currency A–Z and months
 * newest first inside each.
 *
 * Planning partitions by currency and so does closing, so a mixed list is not
 * a table — the rows in it cannot be compared or totalled. One card per
 * currency is the only arrangement where every figure on screen is in the same
 * money.
 */
export function scorecardCards(closes: MonthCloseDto[]): ScorecardCard[] {
  const byCurrency = new Map<string, MonthCloseDto[]>();
  for (const c of closes) {
    const rows = byCurrency.get(c.currency);
    if (rows) rows.push(c);
    else byCurrency.set(c.currency, [c]);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, rows]) => ({
      currency,
      closes: rows.slice().sort((a, b) => b.month.localeCompare(a.month)),
      empty: rows.every(isEmpty),
    }));
}

interface Props {
  /** Every currency, mixed, as `GET /api/me/closes` returns them. */
  closes: MonthCloseDto[];
  /** The month the "close" button acts on, "YYYY-MM". */
  month: string;
  onClose: (month: string) => Promise<unknown>;
  onReopen: (closeId: string) => Promise<unknown>;
}

/**
 * The month scorecard: what you earned, what the plan asked for, and what you
 * actually set aside, frozen a month at a time.
 *
 * It asks that of a *person*, which is the only altitude at which "income" has
 * one meaning (`MONTH-CLOSE.md` decision 14) — so it has one producer, the
 * caller's own `/api/me/closes`, and it lives on the Overview rather than on
 * any account or household page. There is no permission to check: your month is
 * always yours to close.
 *
 * Closing takes every currency at once and a second attempt comes back 409,
 * shown inline. Re-opening is per row, so a month can be left half-open — and
 * then it cannot be closed again until its remaining rows go too, which is why
 * every card carries its own re-open.
 */
export function MonthScorecard({ closes, month, onClose, onReopen }: Props) {
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

  const cards = scorecardCards(closes);
  const months = new Set(closes.map((c) => c.month)).size;

  return (
    <>
      <div className="section-head">
        <h2>months</h2>
        <span className="meta">[{months} closed · what you earned, planned and set aside]</span>
        <span className="spacer" />
        <button
          type="button"
          className="ghost tiny"
          disabled={busy}
          onClick={() => void run(() => onClose(month))}
        >
          close {formatMonth(month)}
        </button>
      </div>

      {err && (
        <p className="error scorecard-error" role="alert">
          {err}
        </p>
      )}

      {cards.length === 0 ? (
        <p className="muted" style={{ fontSize: "12px" }}>
          no months closed yet — close one to lock in its scorecard.
        </p>
      ) : (
        <div className="scorecard-cards">
          {cards.map((card) => (
            <CurrencyCard
              key={card.currency}
              card={card}
              busy={busy}
              onReopen={onReopen}
              run={run}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** One currency's card. Four columns is what a phone holds; the table scrolls
 *  inside the card rather than the page, as every other table here does. */
function CurrencyCard({
  card,
  busy,
  onReopen,
  run,
}: {
  card: ScorecardCard;
  busy: boolean;
  onReopen: (closeId: string) => Promise<unknown>;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <div className="scorecard-card">
      <div className="scorecard-card-head">
        <span className="name">{card.currency}</span>
        <span className="meta">
          {card.closes.length} {card.closes.length === 1 ? "month" : "months"}
        </span>
      </div>

      {/* Never hidden. Closing takes every partition the pass puts you in, so a
          currency you keep no money in still gets a row — and a card missing
          from "what I closed" would contradict what "close the month" just
          did. Saying so is the honest reading of a wall of zeroes. */}
      {card.empty && (
        <p className="scorecard-note">
          none of this money is yours — the month closes here too, because closing takes every
          currency at once.
        </p>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="sticky-col">month</th>
              <th className="num">income</th>
              <th className="num">planned</th>
              <th className="num">saved</th>
              <th className="num">rate</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {card.closes.map((mc) => (
              <tr key={mc.id} className={isEmpty(mc) ? "dim-row" : ""}>
                <td className="name sticky-col">{formatMonth(mc.month)}</td>
                <td className="num">{formatMinor(mc.incomeMinor, card.currency)}</td>
                <td className="num">{formatMinor(mc.plannedMinor, card.currency)}</td>
                <td className="num">{formatMinor(mc.contributedMinor, card.currency)}</td>
                <td className={`num${mc.incomeMinor > 0 ? "" : " dim"}`}>
                  {savingsRate(mc.contributedMinor, mc.incomeMinor)}
                </td>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
