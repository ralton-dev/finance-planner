import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.js";
import { api, ApiError } from "../lib/api.js";
import { useAsync } from "../lib/useAsync.js";
import type { ProjectDto, ProjectVisibility } from "../lib/types.js";

/** The chip beside a project's name. Two quiet labels rather than one loud one:
 *  neither state is a problem, so neither gets an alerting colour. */
function VisibilityChip({ visibility }: { visibility: ProjectVisibility }) {
  return visibility === "shared" ? (
    <span className="tag-status neutral">shared</span>
  ) : (
    <span className="tag-status idle">personal</span>
  );
}

export function ProjectsPage() {
  const { user } = useAuth();
  const projects = useAsync<ProjectDto[]>(() => api.listProjects(), []);
  const [name, setName] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [visibility, setVisibility] = useState<ProjectVisibility>("personal");
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
        visibility,
      });
      setName("");
      setTargetDate("");
      setVisibility("personal");
      projects.refetch();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not create project.");
    } finally {
      setBusy(false);
    }
  }

  const rows = projects.data ?? [];
  const total = rows.length;
  // A project you do not own is one a co-member shared into your household —
  // that is the only way one can reach this list. You may open it and file your
  // payments into it; renaming, re-targeting and un-sharing stay theirs.
  const mine = rows.filter((p) => p.ownerUserId === user?.id);
  const theirs = rows.filter((p) => p.ownerUserId !== user?.id);

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
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as ProjectVisibility)}
          aria-label="visibility"
        >
          <option value="personal">personal — only you</option>
          <option value="shared">shared — everyone in your household</option>
        </select>
        <button type="submit" disabled={busy}>
          {busy ? "creating…" : "+ create"}
        </button>
        {err && (
          <span className="error" role="alert">
            {err}
          </span>
        )}
      </form>
      <p className="hint">
        a shared project may only hold payments on accounts shared into your household — everyone
        who can read it can already see those.
      </p>

      <div className="section-head">
        <h2>your projects</h2>
        <span className="meta">[{mine.length} rows]</span>
      </div>

      {projects.loading ? (
        <p className="muted">loading…</p>
      ) : mine.length === 0 ? (
        <div className="empty-state">
          <h3>no projects yet</h3>
          <p>
            create one to bundle payments across accounts (e.g. all the parts of a house move). you
            can then assign new payments to the project when you create them.
          </p>
        </div>
      ) : (
        // The visibility column is a fourth, and four does not fit at 390. The
        // house wrapper, not a narrower table: the row scrolls inside itself and
        // the page never scrolls sideways.
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>visibility</th>
                <th>target date</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {mine.map((p) => (
                <OwnedProjectRow key={p.id} project={p} onChanged={() => projects.refetch()} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {theirs.length > 0 && (
        <>
          <div className="section-head">
            <h2>shared with you</h2>
            <span className="meta">[{theirs.length} rows]</span>
          </div>
          <p className="hint">
            projects your household shared. you can open one and file your own payments into it;
            only its owner can rename or un-share it.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>name</th>
                  <th>owner</th>
                  <th>target date</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {theirs.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className="member-dot shared" aria-hidden="true" />
                      <Link to={`/projects/${p.id}`} className="name">
                        {p.name}
                      </Link>
                    </td>
                    <td className="muted">{p.ownerName ?? "a co-member"}</td>
                    <td className="muted">{p.targetDate ?? "—"}</td>
                    <td className="row-actions-cell">
                      <Link
                        to={`/projects/${p.id}`}
                        className="row-edit"
                        aria-label={`open ${p.name}`}
                      >
                        open →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * One project of yours, with the personal/shared control on it.
 *
 * The flip to shared can be refused — a project holding a payment on an account
 * the household cannot see may not be shared, and the server names every such
 * payment — so the error belongs on the row that asked for it rather than at the
 * top of the page.
 */
function OwnedProjectRow({ project, onChanged }: { project: ProjectDto; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const next: ProjectVisibility = project.visibility === "shared" ? "personal" : "shared";

  async function flip(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await api.updateProject(project.id, { visibility: next });
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not change visibility.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <span
          className={`member-dot ${project.visibility === "shared" ? "shared" : "you"}`}
          aria-hidden="true"
        />
        <Link to={`/projects/${project.id}`} className="name">
          {project.name}
        </Link>
        {err && (
          <div className="error" role="alert">
            {err}
          </div>
        )}
      </td>
      <td>
        <VisibilityChip visibility={project.visibility} />
      </td>
      <td className="muted">{project.targetDate ?? "—"}</td>
      <td className="row-actions-cell">
        <span className="row-actions">
          <button type="button" onClick={flip} disabled={busy}>
            {busy ? "saving…" : next === "shared" ? "share with household" : "make personal"}
          </button>
        </span>{" "}
        <Link
          to={`/projects/${project.id}`}
          className="row-edit"
          aria-label={`open ${project.name}`}
        >
          open →
        </Link>
      </td>
    </tr>
  );
}
