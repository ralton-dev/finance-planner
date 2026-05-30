import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { formatMinor, toMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto } from "../lib/types.js";

export function AccountsPage() {
  const accounts = useAsync<AccountDto[]>(() => api.listAccounts(), []);
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("GBP");
  const [buffer, setBuffer] = useState("0");
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createAccount({ name, currency, monthlyBufferMinor: toMinor(buffer) });
      setName("");
      setBuffer("0");
      accounts.refetch();
    } finally {
      setBusy(false);
    }
  }

  const total = accounts.data?.length ?? 0;
  const owned = accounts.data?.filter((a) => a.owner).length ?? 0;
  const shared = total - owned;

  return (
    <section>
      <h1>
        accounts <span className="scope">/ {total}</span>
      </h1>
      <div className="subhead">
        <b>{owned}</b> owned · <b>{shared}</b> shared · single-currency per account
      </div>

      <div className="section-head">
        <h2>new account</h2>
        <span className="meta">[name, currency, optional monthly buffer]</span>
      </div>
      <form className="inline-form" onSubmit={create}>
        <input
          placeholder="account name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          style={{ minWidth: "14rem" }}
        />
        <input
          placeholder="GBP"
          value={currency}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          maxLength={3}
          required
          style={{ width: "5rem" }}
        />
        <input
          placeholder="buffer / mo"
          value={buffer}
          onChange={(e) => setBuffer(e.target.value)}
          style={{ width: "8rem" }}
        />
        <button type="submit" disabled={busy}>
          {busy ? "creating…" : "+ create"}
        </button>
      </form>

      <div className="section-head">
        <h2>your accounts</h2>
        <span className="meta">[{total} rows]</span>
      </div>

      {accounts.loading ? (
        <p className="muted">loading…</p>
      ) : total === 0 ? (
        <div className="empty-state">
          <h3>no accounts yet</h3>
          <p>Create one above to start planning.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>currency</th>
              <th>access</th>
              <th className="num">buffer / mo</th>
              <th className="num">opening balance</th>
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
                  {a.openingBalanceMinor > 0 ? formatMinor(a.openingBalanceMinor, a.currency) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
