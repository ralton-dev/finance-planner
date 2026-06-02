import { useEffect } from "react";
import { Link } from "react-router-dom";
import { HouseholdPlanView } from "../components/HouseholdPlanView.js";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { api } from "../lib/api.js";
import { formatMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type {
  AccountDto,
  CurrencyOverviewDto,
  HouseholdDto,
  HouseholdPlanDto,
  OverviewDto,
  UserDto,
} from "../lib/types.js";

export function OverviewPage() {
  const { lastCreated } = useQuickAdd();
  const me = useAsync<UserDto>(() => api.me(), []);
  const overview = useAsync<OverviewDto>(() => api.overview(), []);
  const accounts = useAsync<AccountDto[]>(() => api.listAccounts(), []);

  const households = me.data?.households ?? [];
  const householdKey = households.map((h) => h.id).join(",");
  const plans = useAsync<{ h: HouseholdDto; p: HouseholdPlanDto }[]>(
    () => Promise.all(households.map((h) => api.householdPlan(h.id).then((p) => ({ h, p })))),
    [householdKey],
  );

  // Any quick-add creation can affect what the Overview shows.
  useEffect(() => {
    if (!lastCreated) return;
    overview.refetch();
    accounts.refetch();
    plans.refetch();
  }, [lastCreated]);

  if (me.loading || overview.loading || accounts.loading) return <p className="muted">loading…</p>;
  if (overview.error) return <p className="error">failed to load overview.</p>;

  const byId = new Map((accounts.data ?? []).map((a) => [a.id, a]));
  const householdPlans = plans.data ?? [];
  // Accounts already reconciled inside a household plan shouldn't also appear in
  // the standalone list below.
  const pooledIds = new Set(householdPlans.flatMap(({ p }) => p.accounts.map((a) => a.accountId)));
  const buckets = overview.data?.perCurrency ?? [];
  const standalone = buckets
    .map((c) => ({ ...c, accounts: c.accounts.filter((sa) => !pooledIds.has(sa.accountId)) }))
    .filter((c) => c.accounts.length > 0);
  const totalAccounts = accounts.data?.length ?? 0;

  return (
    <section>
      <h1>
        overview <span className="scope">/ all-accounts</span>
      </h1>
      <div className="subhead">
        <b>{totalAccounts}</b> accounts ·{" "}
        {households.length > 0 ? (
          <>
            <b>{households.length}</b> {households.length === 1 ? "household" : "households"}
          </>
        ) : (
          <>
            <b>{buckets.length}</b> {buckets.length === 1 ? "currency" : "currencies"}
          </>
        )}
      </div>

      {totalAccounts === 0 ? (
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
      ) : households.length > 0 ? (
        <>
          {plans.loading ? (
            <p className="muted">loading household plans…</p>
          ) : (
            householdPlans.map(({ h, p }) => (
              <div key={h.id} className="scope-block">
                <div className="scope-block-head">
                  household · {h.name}
                  <Link
                    to={`/households/${h.id}/plan`}
                    className="action"
                    style={{ marginLeft: "0.75rem" }}
                  >
                    full plan →
                  </Link>
                </div>
                {p.accounts.length === 0 ? (
                  <p className="muted" style={{ fontSize: "12px" }}>
                    no accounts in this household's plan yet —{" "}
                    <Link to={`/households/${h.id}`} className="action">
                      set it up →
                    </Link>
                  </p>
                ) : (
                  <HouseholdPlanView plan={p} />
                )}
              </div>
            ))
          )}
          {standalone.map((c) => (
            <StandaloneAccounts key={c.currency} bucket={c} byId={byId} heading="other accounts" />
          ))}
        </>
      ) : (
        buckets.map((c) => <CurrencyBlock key={c.currency} bucket={c} byId={byId} />)
      )}
    </section>
  );
}

/** A standalone (not-in-a-plan) account table — names + per-account status. */
function StandaloneAccounts({
  bucket,
  byId,
  heading,
}: {
  bucket: CurrencyOverviewDto;
  byId: Map<string, AccountDto>;
  heading: string;
}) {
  return (
    <div className="scope-block">
      <div className="section-head">
        <h2>{heading}</h2>
        <span className="meta">
          [{bucket.accounts.length} · {bucket.currency} · not in a plan]
        </span>
        <span className="spacer" />
        <Link to="/accounts" className="action">
          manage →
        </Link>
      </div>
      <AccountsTable bucket={bucket} byId={byId} />
    </div>
  );
}

/** The original per-currency block (KPIs + accounts) — used when the user is in
 *  no household, so solo planning is unchanged. */
function CurrencyBlock({
  bucket,
  byId,
}: {
  bucket: CurrencyOverviewDto;
  byId: Map<string, AccountDto>;
}) {
  const c = bucket;
  const atRisk = c.accounts.reduce((n, a) => n + a.atRiskCount, 0);
  return (
    <div className="scope-block">
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
      <AccountsTable bucket={c} byId={byId} />
    </div>
  );
}

function AccountsTable({
  bucket,
  byId,
}: {
  bucket: CurrencyOverviewDto;
  byId: Map<string, AccountDto>;
}) {
  return (
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
        {bucket.accounts.map((sa) => {
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
              <td className="num ok">{formatMinor(sa.leftoverMinor, bucket.currency)}</td>
              <td className={`num${sa.shortfallMinor > 0 ? " warn" : " dim"}`}>
                {sa.shortfallMinor > 0 ? formatMinor(sa.shortfallMinor, bucket.currency) : "—"}
              </td>
              <td className={`num${sa.atRiskCount > 0 ? " warn" : " dim"}`}>
                {sa.atRiskCount > 0 ? sa.atRiskCount : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
