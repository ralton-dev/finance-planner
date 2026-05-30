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

  async function create(e: FormEvent) {
    e.preventDefault();
    await api.createAccount({ name, currency, monthlyBufferMinor: toMinor(buffer) });
    setName("");
    setBuffer("0");
    accounts.refetch();
  }

  return (
    <section>
      <h1>Accounts</h1>

      <form className="inline-form" onSubmit={create}>
        <input
          placeholder="Account name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          placeholder="Currency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          maxLength={3}
          required
        />
        <input
          placeholder="Monthly buffer"
          value={buffer}
          onChange={(e) => setBuffer(e.target.value)}
        />
        <button type="submit">Add account</button>
      </form>

      {accounts.loading ? (
        <p>Loading…</p>
      ) : (accounts.data?.length ?? 0) === 0 ? (
        <p className="muted">No accounts yet.</p>
      ) : (
        <ul className="account-list">
          {accounts.data?.map((a) => (
            <li key={a.id}>
              <Link to={`/accounts/${a.id}`}>{a.name}</Link>
              <span className="muted">
                {a.currency} · buffer {formatMinor(a.monthlyBufferMinor, a.currency)}
                {a.owner ? "" : " · shared"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
