import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto, HouseholdDetailDto } from "../lib/types.js";

export function HouseholdDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const household = useAsync<HouseholdDetailDto>(() => api.getHousehold(id), [id]);
  const accounts = useAsync<AccountDto[]>(() => api.listAccounts(), []);

  if (household.error) return <p className="error">household not found.</p>;
  if (household.loading || !household.data) return <p className="muted">loading…</p>;

  const data = household.data;
  const isOwner = data.yourRole === "owner";
  const isAdmin = isOwner || data.yourRole === "admin";
  const sharedIds = new Set(data.shares.map((s) => s.accountId));
  const shareableAccounts = (accounts.data ?? []).filter((a) => a.owner && !sharedIds.has(a.id));

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            household <span className="scope">/ {data.name}</span>
          </h1>
          <div className="subhead">
            <Link to="/households" className="action" style={{ marginRight: "0.75rem" }}>
              ← back
            </Link>
            your role: <b style={{ color: "var(--ink-2)" }}>{data.yourRole}</b>
          </div>
        </div>
      </div>

      <div className="section-head">
        <h2>members</h2>
        <span className="meta">[{data.members.length} active]</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>name</th>
            <th>email</th>
            <th>role</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.members.map((m) => (
            <tr key={m.membershipId}>
              <td>
                <span className="name">
                  {m.displayName}
                  {m.isSelf && <span className="shared">you</span>}
                </span>
              </td>
              <td className="muted">{m.email}</td>
              <td>
                <RoleCell
                  member={m}
                  canEditRole={isOwner}
                  householdId={id}
                  onChanged={() => household.refetch()}
                />
              </td>
              <td className="row-actions-cell">
                <RemoveMemberButton
                  householdId={id}
                  userId={m.userId}
                  displayName={m.displayName}
                  isSelf={m.isSelf}
                  isOwner={m.role === "owner"}
                  canAdmin={isAdmin}
                  onRemoved={() => household.refetch()}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {isAdmin && <InviteMemberForm householdId={id} onAdded={() => household.refetch()} />}

      <div className="section-head">
        <h2>shared accounts</h2>
        <span className="meta">[{data.shares.length} shared]</span>
      </div>
      {data.shares.length === 0 ? (
        <p className="muted" style={{ fontSize: "12px" }}>
          no accounts shared with this household yet.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>account</th>
              <th>currency</th>
              <th>permission</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.shares.map((s) => (
              <tr key={s.shareId}>
                <td>
                  <Link to={`/accounts/${s.accountId}`} className="name">
                    {s.accountName}
                  </Link>
                </td>
                <td className="muted">{s.currency}</td>
                <td>
                  <span className="tag-status idle">{s.permission}</span>
                </td>
                <td className="row-actions-cell">
                  <UnshareButton
                    accountId={s.accountId}
                    shareId={s.shareId}
                    accountName={s.accountName}
                    onUnshared={() => household.refetch()}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {accounts.loading ? null : shareableAccounts.length > 0 ? (
        <ShareAccountForm
          householdId={id}
          accounts={shareableAccounts}
          onShared={() => household.refetch()}
        />
      ) : (
        <p className="muted" style={{ fontSize: "12px", marginTop: "1rem" }}>
          no accounts left to share — you've shared all your owned accounts with this household.
        </p>
      )}

      {isOwner && (
        <DeleteHouseholdZone
          householdId={id}
          householdName={data.name}
          onDeleted={() => navigate("/households")}
        />
      )}
    </section>
  );
}

function RoleCell({
  member,
  canEditRole,
  householdId,
  onChanged,
}: {
  member: import("../lib/types.js").HouseholdMemberDto;
  canEditRole: boolean;
  householdId: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // The owner's role is immutable here; only admin <-> member can flip.
  if (!canEditRole || member.role === "owner") {
    return <span className="tag-status idle">{member.role}</span>;
  }

  async function onChange(e: React.ChangeEvent<HTMLSelectElement>): Promise<void> {
    const next = e.target.value as "admin" | "member";
    if (next === member.role) return;
    setBusy(true);
    try {
      await api.updateMemberRole(householdId, member.userId, next);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <select
      value={member.role}
      onChange={onChange}
      disabled={busy}
      aria-label={`change ${member.displayName}'s role`}
      style={{ width: "8rem" }}
    >
      <option value="member">member</option>
      <option value="admin">admin</option>
    </select>
  );
}

function DeleteHouseholdZone({
  householdId,
  householdName,
  onDeleted,
}: {
  householdId: string;
  householdName: string;
  onDeleted: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function destroy(): Promise<void> {
    if (confirm !== householdName) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteHousehold(householdId);
      onDeleted();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not delete household.");
      setBusy(false);
    }
  }

  return (
    <section className="danger-zone" style={{ marginTop: "3rem" }}>
      <h3>danger zone</h3>
      <p className="hint">
        deleting removes the household, every membership, and every shared-account grant attached to
        it. owned accounts themselves are not touched. there is no undo. type <b>{householdName}</b>{" "}
        to confirm.
      </p>
      <input
        placeholder={householdName}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        disabled={busy}
        aria-label="type household name to confirm deletion"
      />
      <button
        type="button"
        className="danger"
        onClick={destroy}
        disabled={confirm !== householdName || busy}
      >
        {busy ? "deleting…" : "delete household"}
      </button>
      {err && (
        <p className="error" role="alert" style={{ marginTop: "0.5rem" }}>
          {err}
        </p>
      )}
    </section>
  );
}

function InviteMemberForm({ householdId, onAdded }: { householdId: string; onAdded: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.inviteMember(householdId, email.trim(), role);
      setEmail("");
      onAdded();
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 404
          ? "no user with that email — they need to register first."
          : e instanceof ApiError && e.status === 409
            ? "that user is already a member."
            : "could not add member.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit} style={{ marginTop: "1rem" }}>
      <input
        type="email"
        placeholder="invite by email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        style={{ minWidth: "16rem" }}
      />
      <select value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
        <option value="member">member</option>
        <option value="admin">admin</option>
      </select>
      <button type="submit" disabled={busy}>
        {busy ? "inviting…" : "+ invite"}
      </button>
      {err && <span className="error">{err}</span>}
    </form>
  );
}

function ShareAccountForm({
  householdId,
  accounts,
  onShared,
}: {
  householdId: string;
  accounts: AccountDto[];
  onShared: () => void;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!accountId) return;
    setBusy(true);
    setErr(null);
    try {
      await api.shareAccount(accountId, householdId, permission);
      onShared();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not share account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit} style={{ marginTop: "1rem" }}>
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {a.currency}
          </option>
        ))}
      </select>
      <select value={permission} onChange={(e) => setPermission(e.target.value as "view" | "edit")}>
        <option value="view">view</option>
        <option value="edit">edit</option>
      </select>
      <button type="submit" disabled={busy}>
        {busy ? "sharing…" : "+ share account"}
      </button>
      {err && <span className="error">{err}</span>}
    </form>
  );
}

function RemoveMemberButton({
  householdId,
  userId,
  displayName,
  isSelf,
  isOwner,
  canAdmin,
  onRemoved,
}: {
  householdId: string;
  userId: string;
  displayName: string;
  isSelf: boolean;
  isOwner: boolean;
  canAdmin: boolean;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);

  if (isOwner) return <span className="muted">—</span>;
  // Anyone can leave; admins can remove others.
  if (!isSelf && !canAdmin) return <span className="muted">—</span>;

  async function remove(): Promise<void> {
    const verb = isSelf ? "leave this household" : `remove ${displayName}`;
    if (!confirm(`are you sure you want to ${verb}?`)) return;
    setBusy(true);
    try {
      await api.removeMember(householdId, userId);
      onRemoved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="row-edit" onClick={remove} disabled={busy}>
      {busy ? "…" : isSelf ? "leave" : "remove"}
    </button>
  );
}

function UnshareButton({
  accountId,
  shareId,
  accountName,
  onUnshared,
}: {
  accountId: string;
  shareId: string;
  accountName: string;
  onUnshared: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function unshare(): Promise<void> {
    if (!confirm(`stop sharing ${accountName} with this household?`)) return;
    setBusy(true);
    try {
      await api.unshareAccount(accountId, shareId);
      onUnshared();
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="row-edit" onClick={unshare} disabled={busy}>
      {busy ? "…" : "unshare"}
    </button>
  );
}
