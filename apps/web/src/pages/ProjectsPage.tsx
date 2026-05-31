import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api.js";
import { useAsync } from "../lib/useAsync.js";
import type { ProjectDto } from "../lib/types.js";

export function ProjectsPage() {
  const projects = useAsync<ProjectDto[]>(() => api.listProjects(), []);
  const [name, setName] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createProject({
        name: name.trim(),
        targetDate: targetDate || null,
      });
      setName("");
      setTargetDate("");
      projects.refetch();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not create project.");
    } finally {
      setBusy(false);
    }
  }

  const total = projects.data?.length ?? 0;

  return (
    <section>
      <h1>
        projects <span className="scope">/ {total}</span>
      </h1>
      <div className="subhead">cross-account groupings of payments toward a shared goal</div>

      <div className="section-head">
        <h2>new project</h2>
        <span className="meta">[name + optional target date]</span>
      </div>
      <form className="inline-form" onSubmit={create}>
        <input
          placeholder="project name (e.g. House move 2026)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          style={{ minWidth: "18rem" }}
        />
        <input
          type="date"
          value={targetDate}
          onChange={(e) => setTargetDate(e.target.value)}
          aria-label="target date"
        />
        <button type="submit" disabled={busy}>
          {busy ? "creating…" : "+ create"}
        </button>
        {err && <span className="error">{err}</span>}
      </form>

      <div className="section-head">
        <h2>your projects</h2>
        <span className="meta">[{total} rows]</span>
      </div>

      {projects.loading ? (
        <p className="muted">loading…</p>
      ) : total === 0 ? (
        <div className="empty-state">
          <h3>no projects yet</h3>
          <p>
            create one to bundle payments across accounts (e.g. all the parts of a house move). you
            can then assign new payments to the project when you create them.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>target date</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {projects.data?.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/projects/${p.id}`} className="name">
                    {p.name}
                  </Link>
                </td>
                <td className="muted">{p.targetDate ?? "—"}</td>
                <td className="row-actions-cell">
                  <Link to={`/projects/${p.id}`} className="row-edit" aria-label={`open ${p.name}`}>
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
