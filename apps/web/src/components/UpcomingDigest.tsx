import { formatMinor } from "../lib/money.js";
import type { UpcomingItemDto } from "../lib/types.js";

/** A glance, not a report — the rest is one click away on each account. */
const MAX_ROWS = 10;
/** Past this many days out, a row is context rather than a call to action. */
const NEAR_DAYS = 7;

/** The human read of `daysUntil`: "today", "tomorrow", "in 5d". */
export function relativeDayLabel(daysUntil: number): string {
  if (daysUntil <= 0) return "today";
  if (daysUntil === 1) return "tomorrow";
  return `in ${daysUntil}d`;
}

interface Props {
  /** Already sorted and capped by the server. */
  items: UpcomingItemDto[];
  /** The window the server used. */
  days: number;
  loading?: boolean;
}

/**
 * What lands next, across every account the user can see. Rows inside the next
 * week read at full strength; anything further out dims to context.
 */
export function UpcomingDigest({ items, days, loading = false }: Props) {
  const shown = items.slice(0, MAX_ROWS);
  const rest = items.length - shown.length;
  // Same convention as the net-worth summary: name the currency only when more
  // than one is in play, otherwise the symbol already says it.
  const multi = new Set(items.map((i) => i.currency)).size > 1;

  return (
    <div className="upcoming-card">
      <div className="section-head">
        <h2>coming up</h2>
        <span className="meta">[next {days} days]</span>
      </div>

      {loading ? (
        <p className="muted" style={{ fontSize: "12px" }}>
          checking what's due…
        </p>
      ) : items.length === 0 ? (
        <p className="muted" style={{ fontSize: "12px" }}>
          nothing due in the next {days} days
        </p>
      ) : (
        <>
          <ul className="upcoming-list">
            {shown.map((item) => (
              <li
                key={`${item.paymentId}:${item.dueDate}`}
                className={`upcoming-row${item.daysUntil > NEAR_DAYS ? " far" : ""}`}
                title={item.dueDate}
              >
                <span className="when">{relativeDayLabel(item.daysUntil)}</span>
                <span className="sep">·</span>
                <span className="name">{item.name}</span>
                <span className="sep">·</span>
                <span className="amount">
                  {multi && <span className="dim">{item.currency} </span>}
                  {formatMinor(item.amountMinor, item.currency)}
                </span>
                <span className="sep">·</span>
                <span className="where">{item.accountName}</span>
              </li>
            ))}
          </ul>
          {rest > 0 && (
            <p className="muted upcoming-more">
              …and {rest} more within {days} days
            </p>
          )}
        </>
      )}
    </div>
  );
}
