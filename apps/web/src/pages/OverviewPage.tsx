import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { api } from "../lib/api.js";
import { formatMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto, OverviewDto } from "../lib/types.js";

export function OverviewPage() {
  const { lastCreated } = useQuickAdd();
  const overview = useAsync<OverviewDto>(() => api.overview(), []);
  const accounts = useAsync<AccountDto[]>(() => api.listAccounts(), []);

  // Any quick-add creation can affect what the Overview shows.
  useEffect(() => {
    if (!lastCreated) return;
    overview.refetch();
    accounts.refetch();
  }, [lastCreated]);

  if (overview.loading || accounts.loading) return <p className="muted">loading…</p>;
  if (overview.error) return <p className="error">failed to load overview.</p>;

  const byId = new Map((accounts.data ?? []).map((a) => [a.id, a]));
  const totalAccounts = accounts.data?.length ?? 0;
  const buckets = overview.data?.perCurrency ?? [];

  return (
    <section>
      <h1>
        overview <span className="scope">/ all-accounts</span>
      </h1>
      <div className="subhead">
        <b>{totalAccounts}</b> accounts · <b>{buckets.length}</b>{" "}
        {buckets.length === 1 ? "currency" : "currencies"}
      </div>

      {buckets.length === 0 ? (
        <div className="empty-state">
          <h3>no accounts yet</h3>
          <p>
            Add your first account to start planning. Each account holds incomes and payments and
            generates its own savings plan.
          </p>
          <Link to="/accounts">
            <button type="button">+ create account</button>
          </Link>
        </div>
      ) : (
        buckets.map((c) => {
          const atRisk = c.accounts.reduce((n, a) => n + a.atRiskCount, 0);
          return (
            <div key={c.currency} className="scope-block">
              <div className="scope-block-head">currency · {c.currency}</div>

              <div className="kpis">
                <div className="kpi">
                  <div className="kpi-label">monthly income</div>
                  <div className="kpi-value">{formatMinor(c.monthlyIncomeMinor, c.currency)}</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label">buffer</div>
                  <div className="kpi-value">{formatMinor(c.bufferMinor, c.currency)}</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label">required / mo</div>
                  <div className="kpi-value">{formatMinor(c.totalRequiredMinor, c.currency)}</div>
                </div>
                <div className="kpi ok">
                  <div className="kpi-label">left over</div>
                  <div className="kpi-value">{formatMinor(c.leftoverMinor, c.currency)}</div>
                </div>
                <div className={c.shortfallMinor > 0 ? "kpi warn" : "kpi"}>
                  <div className="kpi-label">shortfall</div>
                  <div className="kpi-value">{formatMinor(c.shortfallMinor, c.currency)}</div>
                  {atRisk > 0 && (
                    <div className="kpi-delta warn">
                      {atRisk} {atRisk === 1 ? "goal" : "goals"} at risk
                    </div>
                  )}
                </div>
              </div>

              <div className="section-head">
                <h2>accounts</h2>
                <span className="meta">[{c.accounts.length} rows]</span>
                <span className="spacer" />
                <Link to="/accounts" className="action">
                  manage →
                </Link>
              </div>

              <table>
                <thead>
                  <tr>
                    <th>name</th>
                    <th>status</th>
                    <th className="num">left over</th>
                    <th className="num">shortfall</th>
                    <th className="num">at risk</th>
                  </tr>
                </thead>
                <tbody>
                  {c.accounts.map((sa) => {
                    const acct = byId.get(sa.accountId);
                    const status =
                      sa.shortfallMinor > 0 ? "shortfall" : sa.atRiskCount > 0 ? "at_risk" : "ok";
                    return (
                      <tr key={sa.accountId}>
                        <td>
                          <Link to={`/accounts/${sa.accountId}`} className="name">
                            {acct?.name ?? "account"}
                          </Link>
                          {acct && !acct.owner ? <span className="shared">shared</span> : null}
                        </td>
                        <td>
                          {status === "ok" ? (
                            <span className="tag-status ok">on_track</span>
                          ) : status === "shortfall" ? (
                            <span className="tag-status warn">shortfall</span>
                          ) : (
                            <span className="tag-status warn">at_risk</span>
                          )}
                        </td>
                        <td className="num ok">{formatMinor(sa.leftoverMinor, c.currency)}</td>
                        <td className={`num${sa.shortfallMinor > 0 ? " warn" : " dim"}`}>
                          {sa.shortfallMinor > 0 ? formatMinor(sa.shortfallMinor, c.currency) : "—"}
                        </td>
                        <td className={`num${sa.atRiskCount > 0 ? " warn" : " dim"}`}>
                          {sa.atRiskCount > 0 ? sa.atRiskCount : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })
      )}
    </section>
  );
}
