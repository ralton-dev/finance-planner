import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.js";
import { api, ApiError } from "../lib/api.js";
import { formatMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type { ProjectDetailDto } from "../lib/types.js";

const CATEGORY_LABEL: Record<string, string> = {
  monthly_recurring: "monthly",
  yearly_recurring: "yearly",
  custom_recurring: "recurring",
  fixed_point: "goal",
};

export function ProjectDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const project = useAsync<ProjectDetailDto>(() => api.getProject(id), [id]);

  if (project.error) return <p className="error">project not found.</p>;
  if (project.loading || !project.data) return <p className="muted">loading…</p>;

  const data = project.data;
  // Aggregate per currency since payments may span multi-currency accounts.
  const totalsByCurrency = new Map<string, { target: number; saved: number; count: number }>();
  for (const p of data.payments) {
    const bucket = totalsByCurrency.get(p.currency) ?? { target: 0, saved: 0, count: 0 };
    bucket.target += p.amountMinor;
    bucket.saved += p.alreadySavedMinor;
    bucket.count += 1;
    totalsByCurrency.set(p.currency, bucket);
  }
  const totals = [...totalsByCurrency.entries()].map(([currency, t]) => ({ currency, ...t }));
  const earliestDue = data.payments
    .map((p) => p.dueDate)
    .filter((d): d is string => !!d)
    .sort()[0];

  const uniqueAccounts = new Set(data.payments.map((p) => p.accountId)).size;
  const isMine = data.ownerUserId === user?.id;
  const owner = isMine ? "you" : (data.ownerName ?? "a co-member");
  const isShared = data.visibility === "shared";

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            project <span className="scope">/ {data.name}</span>
          </h1>
          {data.description && <p className="account-description">{data.description}</p>}
          <div className="subhead">
            <Link to="/projects" className="action" style={{ marginRight: "0.75rem" }}>
              ← back
            </Link>
            {/* Whose it is and who else can read it, said in that order: the
                second only means anything once you know the first. */}
            <span className={`tag-status ${isShared ? "neutral" : "idle"}`}>
              {isShared ? "shared" : "personal"}
            </span>{" "}
            <span className="muted">{isMine ? "yours" : `owned by ${owner}`}</span> ·{" "}
            {data.payments.length} payment{data.payments.length === 1 ? "" : "s"} · {uniqueAccounts}{" "}
            account{uniqueAccounts === 1 ? "" : "s"}
            {data.targetDate && ` · target ${data.targetDate}`}
            {earliestDue && ` · earliest due ${earliestDue}`}
          </div>
          <div className="hint">
            {isShared
              ? "everyone in your household can read this project and file their own payments into it. it may only hold payments on accounts shared into the household."
              : "only you can read this project. it may hold payments on any account you own."}
          </div>
        </div>
      </div>

      {totals.length > 0 && (
        <div className="kpis">
          {totals.flatMap((t) => [
            <div key={`${t.currency}-target`} className="kpi">
              <div className="kpi-label">target ({t.currency})</div>
              <div className="kpi-value">{formatMinor(t.target, t.currency)}</div>
            </div>,
            <div key={`${t.currency}-saved`} className="kpi ok">
              <div className="kpi-label">saved ({t.currency})</div>
              <div className="kpi-value">{formatMinor(t.saved, t.currency)}</div>
              <div className="kpi-delta">
                {t.target > 0 ? Math.round((t.saved / t.target) * 100) : 0}% of target
              </div>
            </div>,
            <div key={`${t.currency}-remaining`} className="kpi">
              <div className="kpi-label">remaining ({t.currency})</div>
              <div className="kpi-value">
                {formatMinor(Math.max(0, t.target - t.saved), t.currency)}
              </div>
            </div>,
          ])}
        </div>
      )}

      <div className="section-head">
        <h2>member payments</h2>
        <span className="meta">[{data.payments.length} payments]</span>
      </div>

      {data.payments.length === 0 ? (
        <div className="empty-state">
          <h3>no payments yet</h3>
          <p>
            assign payments to this project from the <code>new payment</code> drawer — pick the
            project from the dropdown when creating one.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>account</th>
              <th>type</th>
              <th>due</th>
              <th className="num">amount</th>
              <th className="num">saved</th>
            </tr>
          </thead>
          <tbody>
            {data.payments.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/accounts/${p.accountId}`} className="name">
                    {p.name}
                  </Link>
                </td>
                {/* The name is absent when this caller may not be told it — a
                    payment outlives access to the account under it. Say so
                    honestly rather than rendering an empty cell. */}
                <td className="muted">{p.accountName ?? "another account"}</td>
                <td className="muted">{CATEGORY_LABEL[p.category] ?? p.category}</td>
                <td className="muted">{p.dueDate ?? "—"}</td>
                <td className="num">{formatMinor(p.amountMinor, p.currency)}</td>
                <td className="num">{formatMinor(p.alreadySavedMinor, p.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Deleting a shared project is its owner's alone. Offering the control
          to a co-member would only ever produce a 403. */}
      {isMine && (
        <DeleteProjectZone
          projectId={data.id}
          projectName={data.name}
          onDeleted={() => navigate("/projects")}
        />
      )}
    </section>
  );
}

function DeleteProjectZone({
  projectId,
  projectName,
  onDeleted,
}: {
  projectId: string;
  projectName: string;
  onDeleted: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function destroy(): Promise<void> {
    if (confirm !== projectName) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteProject(projectId);
      onDeleted();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not delete project.");
      setBusy(false);
    }
  }

  return (
    <section className="danger-zone" style={{ marginTop: "3rem" }}>
      <h3>danger zone</h3>
      <p className="hint">
        deleting removes the project. member payments are kept on their accounts but lose their
        project link. type <b>{projectName}</b> to confirm.
      </p>
      <input
        placeholder={projectName}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        disabled={busy}
        aria-label="type project name to confirm deletion"
      />
      <button
        type="button"
        className="danger"
        onClick={destroy}
        disabled={confirm !== projectName || busy}
      >
        {busy ? "deleting…" : "delete project"}
      </button>
      {err && (
        <p className="error" role="alert" style={{ marginTop: "0.5rem" }}>
          {err}
        </p>
      )}
    </section>
  );
}
