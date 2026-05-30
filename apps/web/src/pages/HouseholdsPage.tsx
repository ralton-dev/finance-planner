import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { useAsync } from "../lib/useAsync.js";
import type { HouseholdDto, UserDto } from "../lib/types.js";

export function HouseholdsPage() {
  const me = useAsync<UserDto>(() => api.me(), []);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createHousehold(e: FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api.createHousehold(name);
      setName("");
      me.refetch();
    } catch {
      setErr("could not create household.");
    } finally {
      setBusy(false);
    }
  }

  const households: HouseholdDto[] = me.data?.households ?? [];

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            households <span className="scope">/ {households.length}</span>
          </h1>
          <div className="subhead">
            groups of users who can share accounts at view or edit level
          </div>
        </div>
      </div>

      <div className="section-head">
        <h2>new household</h2>
        <span className="meta">[name only — invite members from the detail page]</span>
      </div>
      <form className="inline-form" onSubmit={createHousehold}>
        <input
          placeholder="household name (e.g. Home)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          style={{ minWidth: "16rem" }}
        />
        <button type="submit" disabled={busy}>
          {busy ? "creating…" : "+ create"}
        </button>
        {err && <span className="error">{err}</span>}
      </form>

      <div className="section-head">
        <h2>your households</h2>
        <span className="meta">[{households.length} rows]</span>
      </div>

      {me.loading ? (
        <p className="muted">loading…</p>
      ) : households.length === 0 ? (
        <div className="empty-state">
          <h3>no households yet</h3>
          <p>
            create one to share accounts with a partner or family. once a household exists you can
            invite members by email and share accounts with them at <code>view</code> or{" "}
            <code>edit</code> permission.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>id</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {households.map((h) => (
              <tr key={h.id}>
                <td>
                  <Link to={`/households/${h.id}`} className="name">
                    {h.name}
                  </Link>
                </td>
                <td className="muted">
                  <code style={{ fontSize: "11px" }}>{h.id.slice(0, 8)}…</code>
                </td>
                <td className="row-actions-cell">
                  <Link
                    to={`/households/${h.id}`}
                    className="row-edit"
                    aria-label={`open ${h.name}`}
                  >
                    open →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
