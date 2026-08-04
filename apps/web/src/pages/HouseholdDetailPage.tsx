import { splitByShares } from "@finance-planner/contracts/money";
import { type CSSProperties, type FormEvent, Fragment, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Amount } from "../components/Amount.js";
import { api, ApiError } from "../lib/api.js";
import { useAsync } from "../lib/useAsync.js";
import { BalanceCell, ownershipPhrase } from "./AccountsPage.js";
import type {
  AccountDto,
  AccountRole,
  HouseholdAccountAssignmentDto,
  HouseholdDetailDto,
  HouseholdMemberDto,
  HouseholdPlanDto,
  HouseholdShareDto,
  OverviewAccountDto,
  OverviewDto,
} from "../lib/types.js";

/**
 * The household's settings page: who is in it, how they split the bills, which
 * accounts the plan moves money through, and the way out.
 *
 * It used to print two account tables — "shared accounts" (a view/edit grant)
 * and "plan accounts" (a role in the money flow) — each with its own chip
 * vocabulary, so the same account appeared twice saying two different things.
 * There is one table now: an account is a row, and the grant and the role are
 * two of its columns. The operations behind them are unchanged; they moved into
 * the row rather than into a second table.
 *
 * Balances come from GET /api/overview — the same read the accounts index uses,
 * so the figure here and the figure there are one number.
 */

/** Sub-line under a cell's headline. */
const SUB: CSSProperties = { fontSize: "11px", marginTop: "0.15rem" };

/** Body copy that explains rather than states — notes, hints, consequences. */
const NOTE: CSSProperties = { fontSize: "11.5px", lineHeight: 1.55 };

// --- the merged account table ------------------------------------------------

/** One account, with everything this household knows about it. */
export interface HouseholdAccountRow {
  accountId: string;
  name: string;
  currency: string;
  /** Its role in the money-flow plan, or null when it is not in the plan. */
  assignment: HouseholdAccountAssignmentDto | null;
  /** The grant that lets this household's members see it, when there is one. */
  share: HouseholdShareDto | null;
  /** Your own copy of the account — absent when it is in the plan but nobody
   *  has shared it with you. */
  account: AccountDto | null;
  /** The overview's state for it: balance, check-in date. */
  state?: OverviewAccountDto;
}

/**
 * The union of the two old tables, plan accounts first (the roster is the
 * household's own ordering) and share-only accounts after. An account that is
 * both is one row.
 */
export function mergeAccountRows(
  roster: HouseholdAccountAssignmentDto[],
  shares: HouseholdShareDto[],
  accounts: AccountDto[],
  state: Map<string, OverviewAccountDto>,
): HouseholdAccountRow[] {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const rows = new Map<string, HouseholdAccountRow>();

  function row(accountId: string, name: string, currency: string): HouseholdAccountRow {
    const existing = rows.get(accountId);
    if (existing) return existing;
    const fresh: HouseholdAccountRow = {
      accountId,
      name,
      currency,
      assignment: null,
      share: null,
      account: accountById.get(accountId) ?? null,
      state: state.get(accountId),
    };
    rows.set(accountId, fresh);
    return fresh;
  }

  for (const r of roster) row(r.accountId, r.accountName, r.currency).assignment = r;
  for (const s of shares) row(s.accountId, s.accountName, s.currency).share = s;
  return [...rows.values()];
}

// --- the share split ---------------------------------------------------------

/** Weights as percentages of their own total, in basis points — what the plan
 *  normalises them to before it splits anything. */
export function normaliseShares(weights: number[]): number[] {
  const safe = weights.map((w) => Math.max(0, w));
  const total = safe.reduce((s, w) => s + w, 0);
  if (total === 0) return safe.map(() => Math.round(10_000 / (safe.length || 1)));
  return safe.map((w) => Math.round((w / total) * 10_000));
}

/** Basis points as a percentage with one decimal: 6000 → "60.0". */
function percent(bp: number): string {
  return (bp / 100).toFixed(1);
}

/** A percent field's contents as basis points. Blank and nonsense read as 0. */
function toBp(input: string): number {
  const n = Number(input.trim());
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
}

// --- the page ----------------------------------------------------------------

export function HouseholdDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const household = useAsync<HouseholdDetailDto>(() => api.getHousehold(id), [id]);
  const accounts = useAsync<AccountDto[]>(() => api.listAccounts(), []);
  const roster = useAsync<HouseholdAccountAssignmentDto[]>(
    () => api.listHouseholdAccounts(id),
    [id],
  );
  // The consequence line under the shares is computed from the household's own
  // plan totals, so this page asks for the plan it never used to fetch.
  const plan = useAsync<HouseholdPlanDto>(() => api.householdPlan(id), [id]);
  const overview = useAsync<OverviewDto>(() => api.overview(), []);
  // Refetching the household blanks it (useAsync drops data while loading), so
  // the shares confirmation lives up here where the reload cannot erase it.
  const [sharesSaved, setSharesSaved] = useState(false);

  if (household.error) return <p className="error">household not found.</p>;
  if (household.loading || !household.data) return <p className="muted">loading…</p>;

  const data = household.data;
  const isOwner = data.yourRole === "owner";
  const isAdmin = isOwner || data.yourRole === "admin";
  const sharedIds = new Set(data.shares.map((s) => s.accountId));
  const shareableAccounts = (accounts.data ?? []).filter((a) => a.owner && !sharedIds.has(a.id));

  const state = new Map(
    (overview.data?.perCurrency ?? []).flatMap((c) => c.accounts).map((a) => [a.accountId, a]),
  );
  const rows = mergeAccountRows(roster.data ?? [], data.shares, accounts.data ?? [], state);

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
            your role: <b>{data.yourRole}</b>
            <Link
              to={`/households/${id}/plan`}
              className="action"
              style={{ marginLeft: "0.75rem" }}
            >
              money flow →
            </Link>
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

      <SharesBlock
        householdId={id}
        members={data.members}
        plan={plan.data}
        planFailed={plan.error !== undefined}
        canEdit={isAdmin}
        saved={sharesSaved}
        onDirty={() => setSharesSaved(false)}
        onSaved={() => {
          setSharesSaved(true);
          household.refetch();
          plan.refetch();
        }}
      />

      <AccountsSection
        householdId={id}
        members={data.members}
        rows={rows}
        loading={roster.loading || accounts.loading}
        canEdit={isAdmin}
        asOfDate={overview.data?.asOfDate}
        onChanged={() => {
          roster.refetch();
          household.refetch();
          plan.refetch();
        }}
      />

      {isAdmin && !roster.loading && (
        <AddToPlanForm
          householdId={id}
          accounts={(accounts.data ?? []).filter(
            (a) => !(roster.data ?? []).some((r) => r.accountId === a.id),
          )}
          members={data.members}
          onDone={() => {
            roster.refetch();
            plan.refetch();
          }}
        />
      )}

      {!accounts.loading && shareableAccounts.length > 0 && (
        <ShareAccountForm
          householdId={id}
          accounts={shareableAccounts}
          onShared={() => household.refetch()}
        />
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

// --- shares ------------------------------------------------------------------

/**
 * The contribution split, and what it does.
 *
 * The percentages used to be editable inline in the members table, saving on
 * blur, with nothing on screen to say what a number meant. Here they are one
 * block: the inputs, the sentence they produce against the plan's real shared
 * costs, and an explicit save — because changing them moves every transfer in
 * the money flow.
 */
function SharesBlock({
  householdId,
  members,
  plan,
  planFailed,
  canEdit,
  saved,
  onDirty,
  onSaved,
}: {
  householdId: string;
  members: HouseholdMemberDto[];
  plan?: HouseholdPlanDto;
  planFailed: boolean;
  canEdit: boolean;
  saved: boolean;
  onDirty: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(members.map((m) => [m.userId, percent(m.shareBp)])),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const weights = members.map((m) => toBp(draft[m.userId] ?? ""));
  const totalBp = weights.reduce((s, w) => s + w, 0);
  const dirty = members.some((m, i) => weights[i] !== m.shareBp);

  function edit(userId: string, value: string): void {
    setDraft((d) => ({ ...d, [userId]: value }));
    onDirty();
  }

  async function save(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      // One PATCH per member that actually moved; the endpoint takes basis
      // points, which is what the inputs already are.
      for (let i = 0; i < members.length; i++) {
        const m = members[i]!;
        if (weights[i] === m.shareBp) continue;
        await api.setMemberShare(householdId, m.userId, weights[i]!);
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not save the shares.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-head">
        <h2>shares</h2>
        <span className="meta">[shared costs split {members.length} ways]</span>
      </div>
      <div className="settings-panel">
        {members.map((m, i) => (
          <div className="settings-row" key={m.userId}>
            <span className="k">{m.displayName}</span>
            <span className="v">
              {canEdit ? (
                <>
                  <input
                    value={draft[m.userId] ?? ""}
                    onChange={(e) => edit(m.userId, e.target.value)}
                    inputMode="decimal"
                    disabled={busy}
                    aria-label={`${m.displayName}'s share of shared costs, percent`}
                    style={{ width: "5rem", textAlign: "right" }}
                  />{" "}
                  <span className="muted">%</span>
                </>
              ) : (
                <>{percent(weights[i] ?? 0)}%</>
              )}
            </span>
          </div>
        ))}

        <ConsequenceLine members={members} weights={weights} plan={plan} planFailed={planFailed} />

        <p className="muted" style={{ ...NOTE, margin: "0.35rem 0 0" }}>
          shares must total 100% — anything else is normalised to it before the split, so 60/40 and
          30/20 mean the same thing. these total <b>{percent(totalBp)}%</b>.
        </p>

        {canEdit && (
          <div className="settings-actions">
            <button type="button" onClick={save} disabled={busy || !dirty}>
              {busy ? "saving…" : "save shares"}
            </button>
            {saved && !dirty && (
              <span className="tag-status ok" role="status">
                ✓ saved — plan, transfers and the money flow recalculated
              </span>
            )}
            {err && (
              <span className="error" role="alert">
                {err}
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * What the numbers above actually do, in one sentence.
 *
 * The amounts split are the plan's own figures — the share-split bills the
 * household's shared pots must pay each month — never totals re-derived on this
 * page, so the sentence moves whenever the plan does. The split is the engine's
 * own `splitByShares`, applied the way the engine applies it: once per bill,
 * each member's slice rounded up. Splitting the total in one go would name
 * smaller figures than the plan will actually ask for.
 */
function ConsequenceLine({
  members,
  weights,
  plan,
  planFailed,
}: {
  members: HouseholdMemberDto[];
  weights: number[];
  plan?: HouseholdPlanDto;
  planFailed: boolean;
}) {
  if (!plan) {
    return (
      <p className="muted" style={{ ...NOTE, margin: "0.75rem 0 0" }}>
        {planFailed
          ? "the money-flow plan could not be read, so there is nothing to show the split against."
          : "reading the plan the split applies to…"}
      </p>
    );
  }

  const pots = plan.accounts.filter((a) => a.role === "shared");
  const potIds = new Set(pots.map((a) => a.accountId));
  // What the shares actually govern: the shared-scope bills sitting in the
  // pots. A personal bill parked in a pot belongs to one member — the engine
  // never splits it, so neither does this sentence.
  const potLines = plan.lines.filter((l) => potIds.has(l.accountId) && l.scope === "shared");
  const sharedCostsMinor = potLines.reduce((s, l) => s + l.requiredMonthlyMinor, 0);
  const potName = pots.length === 1 ? (pots[0]?.name ?? "the shared pot") : "the shared pots";
  const normalised = normaliseShares(weights);
  const split = members.map(() => 0);
  for (const line of potLines) {
    splitByShares(line.requiredMonthlyMinor, weights).forEach((v, i) => (split[i]! += v));
  }
  // Rounding each share up leaves the pot a few pence heavier than the bills.
  const overshootMinor = split.reduce((s, v) => s + v, 0) - sharedCostsMinor;
  const ratio = normalised.map(percent).join("/");

  if (sharedCostsMinor === 0) {
    return (
      <p style={{ ...NOTE, margin: "0.75rem 0 0" }}>
        splits shared costs <b>{ratio}</b> — there is nothing in the shared pots to split yet.
      </p>
    );
  }

  return (
    <p style={{ ...NOTE, margin: "0.75rem 0 0" }}>
      splits shared costs <b>{ratio}</b> —{" "}
      <Amount minor={sharedCostsMinor} currency={plan.currency} /> a month lands as{" "}
      {members.map((m, i) => (
        <Fragment key={m.userId}>
          {i > 0 && (i === members.length - 1 ? " and " : ", ")}
          {m.displayName} <Amount minor={split[i] ?? 0} currency={plan.currency} />
        </Fragment>
      ))}{" "}
      into {potName}.
      {overshootMinor > 0 && (
        <>
          {" "}
          every share is rounded up, so the pot ends the month{" "}
          <Amount minor={overshootMinor} currency={plan.currency} /> over rather than a penny short.
        </>
      )}
    </p>
  );
}

// --- accounts ----------------------------------------------------------------

function AccountsSection({
  householdId,
  members,
  rows,
  loading,
  canEdit,
  asOfDate,
  onChanged,
}: {
  householdId: string;
  members: HouseholdMemberDto[];
  rows: HouseholdAccountRow[];
  loading: boolean;
  canEdit: boolean;
  asOfDate?: string;
  onChanged: () => void;
}) {
  const [managing, setManaging] = useState<string | null>(null);
  const memberName = new Map(members.map((m) => [m.userId, m.displayName]));
  const inPlan = rows.filter((r) => r.assignment).length;
  const shared = rows.filter((r) => r.share).length;

  return (
    <>
      <div className="section-head">
        <h2>accounts</h2>
        <span className="meta">
          [{inPlan} in plan · {shared} shared with the household]
        </span>
      </div>
      <p className="muted" style={NOTE}>
        an account's <b>role</b> is what the money flow does with it — a shared pot is split by the
        contribution shares, a personal account belongs to one member. Its <b>access</b> is who can
        read and edit it. They are set independently, on the same row.
      </p>

      {loading ? (
        <p className="muted">loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted" style={NOTE}>
          no accounts here yet — add one to the plan, or share one of yours with the household.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>account</th>
              <th>role in plan</th>
              <th>your access</th>
              <th className="num">balance</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const open = managing === row.accountId;
              // Sharing is the owner's call; the plan role is the household's.
              const manageable = canEdit || row.account?.owner === true;
              return (
                <Fragment key={row.accountId}>
                  <tr>
                    <td>
                      {row.account ? (
                        <Link to={`/accounts/${row.accountId}`} className="name">
                          {row.name}
                        </Link>
                      ) : (
                        <span className="name">{row.name}</span>
                      )}
                      <div className="muted" style={SUB}>
                        {row.currency}
                        {(row.state?.monthlyIncomeMinor ?? 0) > 0 && " · salary lands here"}
                      </div>
                    </td>
                    <td>
                      {row.assignment ? (
                        <span className="tag-status idle">
                          {row.assignment.role === "shared"
                            ? "shared pot"
                            : `personal · ${memberName.get(row.assignment.memberUserId ?? "") ?? "unassigned"}`}
                        </span>
                      ) : (
                        <span className="muted">not in the plan</span>
                      )}
                    </td>
                    <td>
                      {row.account ? (
                        ownershipPhrase(row.account)
                      ) : (
                        <span className="muted">not shared with you</span>
                      )}
                      {row.share && (
                        <div className="muted" style={SUB}>
                          the household can {row.share.permission} it
                        </div>
                      )}
                    </td>
                    <td className="num">
                      <BalanceCell state={row.state} currency={row.currency} asOfDate={asOfDate} />
                    </td>
                    <td className="row-actions-cell">
                      {manageable && (
                        <button
                          type="button"
                          className="row-edit"
                          aria-expanded={open}
                          aria-label={`manage ${row.name}`}
                          onClick={() => setManaging(open ? null : row.accountId)}
                        >
                          {open ? "close" : "manage"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={5}>
                        {canEdit && (
                          <RoleForm
                            householdId={householdId}
                            row={row}
                            members={members}
                            onChanged={onChanged}
                          />
                        )}
                        <AccessForm householdId={householdId} row={row} onChanged={onChanged} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

/** The row's plan role — the same PUT the old "plan accounts" table used. */
function RoleForm({
  householdId,
  row,
  members,
  onChanged,
}: {
  householdId: string;
  row: HouseholdAccountRow;
  members: HouseholdMemberDto[];
  onChanged: () => void;
}) {
  const [role, setRole] = useState<AccountRole>(row.assignment?.role ?? "shared");
  const [memberUserId, setMemberUserId] = useState(
    row.assignment?.memberUserId ?? members[0]?.userId ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.assignHouseholdAccount(householdId, row.accountId, {
        role,
        memberUserId: role === "personal" ? memberUserId : null,
      });
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not change the role.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit} style={{ marginBottom: "0.35rem" }}>
      <span className="field-label">role in plan</span>
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as AccountRole)}
        aria-label={`role in plan for ${row.name}`}
      >
        <option value="shared">shared pot</option>
        <option value="personal">personal</option>
      </select>
      {role === "personal" && (
        <select
          value={memberUserId}
          onChange={(e) => setMemberUserId(e.target.value)}
          aria-label={`who ${row.name} belongs to`}
        >
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.displayName}
            </option>
          ))}
        </select>
      )}
      <button type="submit" disabled={busy}>
        {busy ? "saving…" : row.assignment ? "save role" : "add to plan"}
      </button>
      {row.assignment && (
        <UnassignAccountButton
          householdId={householdId}
          accountId={row.accountId}
          accountName={row.name}
          onDone={onChanged}
        />
      )}
      {err && <span className="error">{err}</span>}
    </form>
  );
}

/** The row's access grant — the same share endpoints the old "shared accounts"
 *  table used, now behind the row's own menu. */
function AccessForm({
  householdId,
  row,
  onChanged,
}: {
  householdId: string;
  row: HouseholdAccountRow;
  onChanged: () => void;
}) {
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (row.share) {
    return (
      <p className="muted" style={NOTE}>
        the household can {row.share.permission} it.{" "}
        <UnshareButton
          accountId={row.accountId}
          shareId={row.share.shareId}
          accountName={row.name}
          onUnshared={onChanged}
        />
      </p>
    );
  }

  if (!row.account?.owner) {
    return (
      <p className="muted" style={NOTE}>
        only the account's owner can change who reads it.
      </p>
    );
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.shareAccount(row.accountId, householdId, permission);
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not share the account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit} style={{ margin: 0 }}>
      <span className="field-label">household access</span>
      <select
        value={permission}
        onChange={(e) => setPermission(e.target.value as "view" | "edit")}
        aria-label={`household access for ${row.name}`}
      >
        <option value="view">view</option>
        <option value="edit">edit</option>
      </select>
      <button type="submit" disabled={busy}>
        {busy ? "sharing…" : "share with household"}
      </button>
      {err && <span className="error">{err}</span>}
    </form>
  );
}

// --- members -----------------------------------------------------------------

function RoleCell({
  member,
  canEditRole,
  householdId,
  onChanged,
}: {
  member: HouseholdMemberDto;
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

// --- adding accounts ---------------------------------------------------------

function AddToPlanForm({
  householdId,
  accounts,
  members,
  onDone,
}: {
  householdId: string;
  accounts: AccountDto[];
  members: HouseholdMemberDto[];
  onDone: () => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [role, setRole] = useState<AccountRole>("shared");
  const [memberUserId, setMemberUserId] = useState(members[0]?.userId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The list shrinks as accounts join the plan; keep the selection valid.
  const selected = accounts.some((a) => a.id === accountId) ? accountId : (accounts[0]?.id ?? "");
  if (accounts.length === 0) return null;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setErr(null);
    try {
      await api.assignHouseholdAccount(householdId, selected, {
        role,
        memberUserId: role === "personal" ? memberUserId : null,
      });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not add account to the plan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit} style={{ marginTop: "1rem" }}>
      <select
        value={selected}
        onChange={(e) => setAccountId(e.target.value)}
        aria-label="account to add to the plan"
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {a.currency}
          </option>
        ))}
      </select>
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as AccountRole)}
        aria-label="role"
      >
        <option value="shared">shared pot</option>
        <option value="personal">personal</option>
      </select>
      {role === "personal" && (
        <select
          value={memberUserId}
          onChange={(e) => setMemberUserId(e.target.value)}
          aria-label="account owner"
        >
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.displayName}
            </option>
          ))}
        </select>
      )}
      <button type="submit" disabled={busy || !selected}>
        {busy ? "adding…" : "+ add to plan"}
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
  const [accountId, setAccountId] = useState("");
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = accounts.some((a) => a.id === accountId) ? accountId : (accounts[0]?.id ?? "");

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setErr(null);
    try {
      await api.shareAccount(selected, householdId, permission);
      onShared();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not share account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <select
        value={selected}
        onChange={(e) => setAccountId(e.target.value)}
        aria-label="account to share with the household"
      >
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
    <button type="button" className="action" onClick={unshare} disabled={busy}>
      {busy ? "…" : "stop sharing"}
    </button>
  );
}

function UnassignAccountButton({
  householdId,
  accountId,
  accountName,
  onDone,
}: {
  householdId: string;
  accountId: string;
  accountName: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function remove(): Promise<void> {
    if (!confirm(`remove ${accountName} from the household plan?`)) return;
    setBusy(true);
    try {
      await api.unassignHouseholdAccount(householdId, accountId);
      onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="action" onClick={remove} disabled={busy}>
      {busy ? "…" : "remove from plan"}
    </button>
  );
}

// --- the way out -------------------------------------------------------------

/**
 * Deleting a household is a once-ever action, so it sits collapsed at the very
 * bottom rather than shouting from the middle of the page. Opening it is the
 * first of two deliberate acts; typing the household's name is the second.
 */
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
    <details className="danger-zone settings-panel settings-danger">
      <summary>
        <h3>danger zone</h3>
      </summary>
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
    </details>
  );
}
