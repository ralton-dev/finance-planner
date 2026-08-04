import { type CSSProperties, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AccountSettingsDrawer } from "../components/AccountSettingsDrawer.js";
import { Amount } from "../components/Amount.js";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { api } from "../lib/api.js";
import { DEFAULT_STALE_AFTER_DAYS } from "../lib/needsYou.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto, OverviewAccountDto, OverviewDto } from "../lib/types.js";

/**
 * The accounts index, answering "which account needs me today".
 *
 * It used to print settings — currency, buffer, opening balance, an access
 * grant and a status pill that said "on track" on every row. None of that
 * changes between visits. The four columns here are the ones that do: who the
 * account belongs to, what it actually holds, what is left over each month,
 * and what is waiting on a human. Settings live on the detail page, where they
 * are edited.
 *
 * Every figure comes from GET /api/overview, which reads the same plan and the
 * same balance check-in the account page reads — so the balance printed here
 * and the balance in the detail strip are one number, not two.
 */

const MS_PER_DAY = 86_400_000;

/** Sub-line under a cell's headline figure. */
const SUB: CSSProperties = { fontSize: "11px", marginTop: "0.15rem" };

/** Chips wrap rather than stretch the column. */
const CHIP_ROW: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "0.3rem" };

/** Each tone onto the filled-chip class that paints it: amber asks, red is
 *  short, green is done, grey is only saying how old something is. */
const TONE_CLASS: Record<AttentionTone, string> = {
  record: "needs-you",
  unfunded: "alert",
  funded: "funded",
  stale: "neutral",
};

/** Whole days from an ISO date to the as-of date; null when there is no date. */
function daysSince(date: string | null | undefined, asOfDate: string): number | null {
  if (!date) return null;
  const from = Date.parse(`${date}T00:00:00Z`);
  const to = Date.parse(`${asOfDate}T00:00:00Z`);
  return Math.round((to - from) / MS_PER_DAY);
}

/** "checked in today" / "checked in 1 d ago" / "checked in 23 d ago". */
function checkedInLabel(days: number): string {
  if (days <= 0) return "checked in today";
  return `checked in ${days} d ago`;
}

// --- the state columns ------------------------------------------------------
// Exported: the Overview lists standalone accounts with these same columns.

export type AttentionTone = "record" | "unfunded" | "stale" | "funded";

export interface AttentionChip {
  tone: AttentionTone;
  /** The chip's words; the whole chip when there is no figure. */
  label: string;
  /** Rendered after the label, and blurred by privacy mode. */
  amountMinor?: number;
}

/**
 * What the row is asking for, worst first: money to record, money that is
 * missing, a balance nobody has confirmed. `funded` is the answer only when
 * there is no question — it never sits alongside another chip.
 *
 * The record rule mirrors the checklist's (`lib/needsYou.ts`), and the
 * staleness threshold is that module's, so the index and the fold cannot
 * disagree about which accounts are waiting on you.
 */
export function deriveAttention(
  state: OverviewAccountDto,
  asOfDate: string,
  staleAfterDays = DEFAULT_STALE_AFTER_DAYS,
): AttentionChip[] {
  const chips: AttentionChip[] = [];

  if (state.unrecordedCount > 0) {
    chips.push({
      tone: "record",
      label: `record ${state.unrecordedCount}`,
      amountMinor: state.unrecordedTotalMinor,
    });
  }
  if (state.shortfallMinor > 0) {
    chips.push({ tone: "unfunded", label: "unfunded", amountMinor: state.shortfallMinor });
  }

  const days = daysSince(state.latestBalanceDate, asOfDate);
  if (days === null) chips.push({ tone: "stale", label: "never checked in" });
  else if (days > staleAfterDays) chips.push({ tone: "stale", label: `stale ${days} d` });

  return chips.length > 0 ? chips : [{ tone: "funded", label: "funded" }];
}

/** The attention column: nothing but chips, and only when there is something
 *  to say. A row with no state yet (the overview is still loading) stays blank
 *  rather than claiming everything is fine. */
export function AttentionCell({
  state,
  currency,
  asOfDate,
}: {
  state?: OverviewAccountDto;
  currency: string;
  asOfDate?: string;
}) {
  if (!state || !asOfDate) return <span className="muted">—</span>;

  return (
    <div style={CHIP_ROW}>
      {deriveAttention(state, asOfDate).map((chip) => (
        <span key={chip.tone} className={`tag-status ${TONE_CLASS[chip.tone]}`}>
          {chip.label}
          {chip.amountMinor !== undefined && (
            <>
              {" · "}
              <Amount minor={chip.amountMinor} currency={currency} />
            </>
          )}
        </span>
      ))}
    </div>
  );
}

/** The balance column: what the account holds, and how long ago anyone said so. */
export function BalanceCell({
  state,
  currency,
  asOfDate,
}: {
  state?: OverviewAccountDto;
  currency: string;
  asOfDate?: string;
}) {
  if (!state || state.latestBalanceMinor === null) {
    return (
      <>
        <span className="muted">—</span>
        <div className="muted" style={SUB}>
          no check-in yet
        </div>
      </>
    );
  }

  const days = asOfDate ? daysSince(state.latestBalanceDate, asOfDate) : null;
  return (
    <>
      <Amount minor={state.latestBalanceMinor} currency={currency} />
      {days !== null && (
        <div className="muted" style={SUB}>
          {checkedInLabel(days)}
        </div>
      )}
    </>
  );
}

/**
 * Who the account belongs to, as a phrase rather than a grant. "shared with
 * you · can edit" says the same thing the old permission chip said, in the
 * order a person cares about.
 */
export function ownershipPhrase(account: AccountDto): string {
  if (account.owner) return "owner";
  return account.permission === "edit"
    ? "shared with you · can edit"
    : "shared with you · can view";
}

/** The ownership phrase plus what the account is for, when the plan knows. */
export function accountSubLine(account: AccountDto, state?: OverviewAccountDto): string {
  const parts = [ownershipPhrase(account)];
  if (state?.householdRole === "shared") parts.push("shared pot");
  else if ((state?.monthlyIncomeMinor ?? 0) > 0) parts.push("salary lands here");
  return parts.join(" · ");
}

/** The account column: member dot, name, and the sub-line under it. */
export function AccountCell({
  account,
  state,
}: {
  account: AccountDto;
  state?: OverviewAccountDto;
}) {
  const tone = state?.householdRole === "shared" ? "shared" : account.owner ? "you" : "partner";

  return (
    <>
      <span className={`member-dot ${tone}`} aria-hidden="true" />
      <Link to={`/accounts/${account.id}`} className="name">
        {account.name}
      </Link>
      <div className="muted" style={SUB}>
        {accountSubLine(account, state)}
      </div>
    </>
  );
}

// --- the page ---------------------------------------------------------------

export function AccountsPage() {
  const { openAccount, lastCreated } = useQuickAdd();
  const navigate = useNavigate();
  const accounts = useAsync<AccountDto[]>(() => api.listAccounts(), []);
  const overview = useAsync<OverviewDto>(() => api.overview(), []);
  const [editing, setEditing] = useState<AccountDto | null>(null);

  // Refetch when a new account is created via the global quick-add drawer.
  useEffect(() => {
    if (lastCreated?.kind !== "account") return;
    accounts.refetch();
    overview.refetch();
  }, [lastCreated]);

  const total = accounts.data?.length ?? 0;
  const owned = accounts.data?.filter((a) => a.owner).length ?? 0;
  const shared = total - owned;
  const asOfDate = overview.data?.asOfDate;
  const state = new Map(
    (overview.data?.perCurrency ?? []).flatMap((c) => c.accounts).map((a) => [a.accountId, a]),
  );

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            accounts <span className="scope">/ {total}</span>
          </h1>
          <div className="subhead">
            <b>{owned}</b> owned · <b>{shared}</b> shared
            {asOfDate && <> · as of {asOfDate}</>}
          </div>
        </div>
        <div className="actions">
          <button type="button" onClick={openAccount}>
            + new account
          </button>
        </div>
      </div>

      {accounts.loading ? (
        <p className="muted">loading…</p>
      ) : total === 0 ? (
        <div className="empty-state">
          <h3>no accounts yet</h3>
          <p>create one to start planning. each account holds its own incomes and payments.</p>
          <button type="button" onClick={openAccount}>
            + new account
          </button>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>account</th>
              <th className="num">balance</th>
              <th className="num">left over / mo</th>
              <th>attention</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {accounts.data?.map((a) => {
              const s = state.get(a.id);
              return (
                <tr
                  key={a.id}
                  style={{ cursor: "pointer" }}
                  // The whole row is the doorway; the "open" link is its visible
                  // affordance and its keyboard route. Clicks on the row's own
                  // controls stay with them.
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("button, a")) return;
                    navigate(`/accounts/${a.id}`);
                  }}
                >
                  <td>
                    <AccountCell account={a} state={s} />
                  </td>
                  <td className="num">
                    <BalanceCell state={s} currency={a.currency} asOfDate={asOfDate} />
                  </td>
                  <td className="num">
                    {s ? (
                      <Amount minor={s.leftoverMinor} currency={a.currency} />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <AttentionCell state={s} currency={a.currency} asOfDate={asOfDate} />
                  </td>
                  <td className="row-actions-cell">
                    <button
                      type="button"
                      className="row-edit"
                      onClick={() => setEditing(a)}
                      aria-label={`edit ${a.name}`}
                    >
                      edit
                    </button>
                    <Link
                      to={`/accounts/${a.id}`}
                      className="action"
                      style={{ marginLeft: "0.5rem" }}
                      aria-label={`open ${a.name}`}
                    >
                      open →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <AccountSettingsDrawer
        account={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          accounts.refetch();
          overview.refetch();
        }}
        onDeleted={() => {
          accounts.refetch();
          overview.refetch();
        }}
      />
    </section>
  );
}
