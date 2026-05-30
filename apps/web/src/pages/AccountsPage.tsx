import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AccountSettingsDrawer } from "../components/AccountSettingsDrawer.js";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { api } from "../lib/api.js";
import { formatMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto } from "../lib/types.js";

export function AccountsPage() {
  const { openAccount, lastCreated } = useQuickAdd();
  const accounts = useAsync<AccountDto[]>(() => api.listAccounts(), []);
  const [editing, setEditing] = useState<AccountDto | null>(null);

  // Refetch when a new account is created via the global quick-add drawer.
  useEffect(() => {
    if (lastCreated?.kind === "account") accounts.refetch();
  }, [lastCreated]);

  const total = accounts.data?.length ?? 0;
  const owned = accounts.data?.filter((a) => a.owner).length ?? 0;
  const shared = total - owned;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            accounts <span className="scope">/ {total}</span>
          </h1>
          <div className="subhead">
            <b>{owned}</b> owned · <b>{shared}</b> shared · single-currency per account
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
        <>
          <div className="section-head">
            <h2>your accounts</h2>
            <span className="meta">[{total} rows]</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>currency</th>
                <th>access</th>
                <th className="num">buffer / mo</th>
                <th className="num">opening balance</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.data?.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/accounts/${a.id}`} className="name">
                      {a.name}
                    </Link>
                  </td>
                  <td>{a.currency}</td>
                  <td>
                    {a.owner ? (
                      <span className="muted">owner</span>
                    ) : (
                      <>
                        <span className="tag-status idle">{a.permission ?? "view"}</span>
                        <span className="shared">shared</span>
                      </>
                    )}
                  </td>
                  <td className={`num${a.monthlyBufferMinor > 0 ? "" : " dim"}`}>
                    {a.monthlyBufferMinor > 0 ? formatMinor(a.monthlyBufferMinor, a.currency) : "—"}
                  </td>
                  <td className={`num${a.openingBalanceMinor > 0 ? "" : " dim"}`}>
                    {a.openingBalanceMinor > 0
                      ? formatMinor(a.openingBalanceMinor, a.currency)
                      : "—"}
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <AccountSettingsDrawer
        account={editing}
        onClose={() => setEditing(null)}
        onSaved={() => accounts.refetch()}
        onDeleted={() => accounts.refetch()}
      />
    </section>
  );
}
