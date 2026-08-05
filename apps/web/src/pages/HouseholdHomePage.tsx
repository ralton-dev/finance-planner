import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api.js";
import { useAsync } from "../lib/useAsync.js";
import type { HouseholdDto, UserDto } from "../lib/types.js";

/**
 * The households tab, which is now a household tab.
 *
 * A user belongs to exactly one household (WP-W), so there is nothing to
 * choose between and a chooser would be a list of one with an empty row
 * underneath it. `/households` therefore resolves to *your* household and
 * redirects into it, keeping `/households/:id` as the one address a household
 * has — the plan page nests under it, the overview cards link to it, and the
 * command palette jumps to it.
 *
 * When you are in none, this is the page: the two honest ways in. You can
 * found one, or somebody can add you to theirs by email. There is nothing to
 * accept and nothing to poll — an invitation *is* a membership, so the moment
 * they add you this page stops being reachable and lands you inside.
 *
 * Replaces `HouseholdsPage`, which listed every household you were in.
 */
export function HouseholdHomePage() {
  const me = useAsync<UserDto>(() => api.me(), []);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createHousehold(e: FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const created = await api.createHousehold(name);
      // Straight in, rather than back through a refetch: the household exists
      // and this page's only job was getting you one.
      navigate(`/households/${created.id}`, { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not create household.");
      setBusy(false);
    }
  }

  if (me.loading) return <p className="muted">loading…</p>;
  if (me.error) return <p className="error">could not read your household.</p>;

  const households: HouseholdDto[] = me.data?.households ?? [];
  // At most one, and the first is it. Still written as a list because the API
  // still answers with one: the rule is enforced from migration 0011 forward,
  // never retroactively, so an account older than it could hold a second.
  const mine = households[0];
  if (mine) return <Navigate to={`/households/${mine.id}`} replace />;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            household <span className="scope">/ none yet</span>
          </h1>
          <div className="subhead">
            a household is the people you split money with — one household each
          </div>
        </div>
      </div>

      <div className="section-head">
        <h2>start one</h2>
        <span className="meta">[name only — invite members once it exists]</span>
      </div>
      <form className="inline-form" onSubmit={createHousehold}>
        <input
          placeholder="household name (e.g. Home)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          aria-label="household name"
          style={{ minWidth: "16rem" }}
        />
        <button type="submit" disabled={busy}>
          {busy ? "creating…" : "+ create"}
        </button>
        {err && (
          <span className="error" role="alert">
            {err}
          </span>
        )}
      </form>

      <div className="section-head">
        <h2>or join one</h2>
        <span className="meta">[by email, from their side]</span>
      </div>
      <div className="empty-state">
        <h3>waiting to be added</h3>
        <p>
          there is nothing to accept here. an admin of the household invites you by the email you
          signed up with, and the moment they do this page becomes your household — refresh and you
          are in it.
        </p>
        <p className="muted">
          you can be in <b>one</b> household at a time. if you are ever in one and want to join
          another, leave the first from its members table; the accounts you shared with it, and the
          money it was moving between you and its members, stop when you do.
        </p>
      </div>
    </section>
  );
}
