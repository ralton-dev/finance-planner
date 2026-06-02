import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { HouseholdPlanView } from "../components/HouseholdPlanView.js";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { api } from "../lib/api.js";
import { formatMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type { HouseholdDetailDto, HouseholdPlanDto } from "../lib/types.js";

export function HouseholdPlanPage() {
  const { id = "" } = useParams();
  const { lastCreated } = useQuickAdd();
  const plan = useAsync<HouseholdPlanDto>(() => api.householdPlan(id), [id]);
  const household = useAsync<HouseholdDetailDto>(() => api.getHousehold(id), [id]);

  // Any income/payment change can move the household plan.
  useEffect(() => {
    if (lastCreated) plan.refetch();
  }, [lastCreated]);

  if (plan.error) return <p className="error">could not load the household plan.</p>;
  if (plan.loading || !plan.data) return <p className="muted">loading…</p>;
  const p = plan.data;
  const c = p.currency;

  const accountName = new Map(p.accounts.map((a) => [a.accountId, a.name ?? "account"]));
  const memberName = new Map(p.members.map((m) => [m.userId, m.displayName ?? "member"]));

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            household plan <span className="scope">/ {household.data?.name ?? "money flow"}</span>
          </h1>
          <div className="subhead">
            <Link to={`/households/${id}`} className="action" style={{ marginRight: "0.75rem" }}>
              ← back
            </Link>
            pooled across {p.accounts.length} {p.accounts.length === 1 ? "account" : "accounts"} ·{" "}
            {p.members.length} {p.members.length === 1 ? "member" : "members"}
          </div>
        </div>
      </div>

      <HouseholdPlanView plan={p} />

      <div className="section-head">
        <h2>transfers</h2>
        <span className="meta">[move each month]</span>
      </div>
      {p.transfers.length === 0 ? (
        <p className="muted" style={{ fontSize: "12px" }}>
          no transfers needed — income already lands where it's spent.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>from</th>
              <th>to</th>
              <th>who</th>
              <th className="num">amount / mo</th>
            </tr>
          </thead>
          <tbody>
            {p.transfers.map((t, i) => (
              <tr key={`${t.fromAccountId}-${t.toAccountId}-${i}`}>
                <td>{accountName.get(t.fromAccountId) ?? "account"}</td>
                <td className="name">{accountName.get(t.toAccountId) ?? "account"}</td>
                <td className="muted">{memberName.get(t.memberUserId) ?? "member"}</td>
                <td className="num">{formatMinor(t.amountMinor, c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="section-head">
        <h2>cost breakdown</h2>
        <span className="meta">[{p.lines.length} payments · priority asc]</span>
      </div>
      {p.lines.length === 0 ? (
        <p className="muted" style={{ fontSize: "12px" }}>
          no payments on the household's accounts yet.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>payment</th>
              <th>account</th>
              <th>split</th>
              <th className="num">required / mo</th>
              <th>status</th>
            </tr>
          </thead>
          <tbody>
            {p.lines
              .slice()
              .sort((a, b) => a.priority - b.priority)
              .map((l) => (
                <tr key={l.paymentId} className={l.onTrack ? "" : "at-risk"}>
                  <td className="name">{l.name}</td>
                  <td className="muted">{accountName.get(l.accountId) ?? "account"}</td>
                  <td>
                    <span className={l.scope === "shared" ? "tag-status idle" : "shared"}>
                      {l.scope}
                    </span>
                  </td>
                  <td className="num">{formatMinor(l.requiredMonthlyMinor, c)}</td>
                  <td>
                    {l.onTrack ? (
                      <span className="tag-status ok">on track</span>
                    ) : (
                      <span className="tag-status warn">short</span>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
