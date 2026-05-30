import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { formatMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto, OverviewDto } from "../lib/types.js";

export function OverviewPage() {
  const overview = useAsync<OverviewDto>(() => api.overview(), []);
  const accounts = useAsync<AccountDto[]>(() => api.listAccounts(), []);

  if (overview.loading || accounts.loading) return <p>Loading…</p>;
  if (overview.error) return <p className="error">Failed to load overview.</p>;

  const byId = new Map((accounts.data ?? []).map((a) => [a.id, a]));

  return (
    <section>
      <h1>Overview</h1>
      {(overview.data?.perCurrency.length ?? 0) === 0 && (
        <p className="muted">
          No accounts yet. <Link to="/accounts">Create your first account</Link>.
        </p>
      )}

      {overview.data?.perCurrency.map((c) => (
        <div key={c.currency} className="currency-block">
          <h2>{c.currency}</h2>
          <div className="kpis">
            <Kpi label="Monthly income" value={formatMinor(c.monthlyIncomeMinor, c.currency)} />
            <Kpi label="Required / month" value={formatMinor(c.totalRequiredMinor, c.currency)} />
            <Kpi label="Left over" value={formatMinor(c.leftoverMinor, c.currency)} tone="ok" />
            <Kpi
              label="Shortfall"
              value={formatMinor(c.shortfallMinor, c.currency)}
              tone={c.shortfallMinor > 0 ? "warn" : undefined}
            />
          </div>
          <div className="card-grid">
            {c.accounts.map((sa) => {
              const acct = byId.get(sa.accountId);
              return (
                <Link key={sa.accountId} to={`/accounts/${sa.accountId}`} className="account-card">
                  <strong>{acct?.name ?? "Account"}</strong>
                  <div className="muted">
                    {sa.atRiskCount > 0
                      ? `${sa.atRiskCount} goal(s) at risk`
                      : "All goals on track"}
                  </div>
                  <div>
                    {sa.shortfallMinor > 0
                      ? `Shortfall ${formatMinor(sa.shortfallMinor, c.currency)}`
                      : `Left over ${formatMinor(sa.leftoverMinor, c.currency)}`}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div className={`kpi ${tone ?? ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
    </div>
  );
}
