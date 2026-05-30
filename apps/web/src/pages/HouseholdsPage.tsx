import { useState, type FormEvent } from "react";
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
      setErr("Could not create household.");
    } finally {
      setBusy(false);
    }
  }

  const households: HouseholdDto[] = me.data?.households ?? [];

  return (
    <section>
      <h1>
        households <span className="scope">/ {households.length}</span>
      </h1>
      <div className="subhead">groups of users who can share accounts</div>

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

      {me.loading ? (
        <p className="muted">loading…</p>
      ) : households.length === 0 ? (
        <div className="empty-state">
          <h3>no households yet</h3>
          <p>
            Create a household to share accounts with a partner or family. Once created, you'll be
            able to invite members by email and share specific accounts at <code>view</code> or{" "}
            <code>edit</code> permission.
          </p>
          <p className="muted">
            Member invites and per-household account sharing UI ship in the next slice.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>id</th>
              <th className="num">created</th>
            </tr>
          </thead>
          <tbody>
            {households.map((h) => (
              <tr key={h.id}>
                <td>
                  <span className="name">{h.name}</span>
                </td>
                <td className="muted">
                  <code style={{ fontSize: "11px" }}>{h.id.slice(0, 8)}…</code>
                </td>
                <td className="num muted">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="empty-state" style={{ marginTop: "1.5rem" }}>
        <h3>coming next</h3>
        <p>
          Invite members by email, manage roles (owner / admin / member), and pick which accounts
          each household sees. The backend endpoints already exist; just the UI is pending.
        </p>
      </div>
    </section>
  );
}
