import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChartFrame } from "../components/ChartFrame.js";
import { DownloadButton } from "../components/DownloadButton.js";
import { HouseholdPlanView } from "../components/HouseholdPlanView.js";
import { UpcomingDigest } from "../components/UpcomingDigest.js";
import { api, ApiError } from "../lib/api.js";
import { formatMinor } from "../lib/money.js";
import { buildNetWorthSeries, type AccountBalanceHistory } from "../lib/networth.js";
import { useAsync } from "../lib/useAsync.js";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import type {
  AccountDto,
  BalanceSnapshotDto,
  CurrencyOverviewDto,
  HouseholdDto,
  HouseholdPlanDto,
  OverviewDto,
  UpcomingDto,
  UserDto,
} from "../lib/types.js";

/** Look-ahead for the "coming up" digest — a fortnight is one pay cycle. */
const UPCOMING_DAYS = 14;

// Keeps recharts out of the eagerly-loaded Overview chunk, as the Sankey does.
const NetWorthChart = lazy(() =>
  import("../components/NetWorthChart.js").then((m) => ({ default: m.NetWorthChart })),
);

/** Balances + reserved for one account. Reserved only exists on the *account*
 *  plan (household plans don't expose it), so it is fetched alongside. */
interface AccountReality extends AccountBalanceHistory {
  account: AccountDto;
  reservedMinor: number;
}

export function OverviewPage() {
  const { lastCreated } = useQuickAdd();
  const me = useAsync<UserDto>(() => api.me(), []);
  const overview = useAsync<OverviewDto>(() => api.overview(), []);
  const accounts = useAsync<AccountDto[]>(() => api.listAccounts(), []);
  const upcoming = useAsync<UpcomingDto>(() => api.upcoming(UPCOMING_DAYS), []);

  const households = me.data?.households ?? [];
  const householdKey = households.map((h) => h.id).join(",");
  const plans = useAsync<{ h: HouseholdDto; p: HouseholdPlanDto }[]>(
    () => Promise.all(households.map((h) => api.householdPlan(h.id).then((p) => ({ h, p })))),
    [householdKey],
  );

  // One parallel batch across every accessible account: balance history for the
  // chart, plan for `reservedMinor`. A single failing account degrades to
  // "no data" instead of blanking the whole section.
  const accountList = accounts.data ?? [];
  const accountKey = accountList.map((a) => a.id).join(",");
  const reality = useAsync<AccountReality[]>(
    () =>
      Promise.all(
        accountList.map(async (account) => {
          const [snapshots, plan] = await Promise.all([
            api.listBalances(account.id).catch((): BalanceSnapshotDto[] => []),
            api.getPlan(account.id).catch(() => null),
          ]);
          return { account, snapshots, reservedMinor: plan?.reservedMinor ?? 0 };
        }),
      ),
    [accountKey],
  );

  /** Everything on the page, re-read: for anything that can create data behind
   *  the Overview's back (a quick-add drawer, the demo seed). */
  function refetchAll(): void {
    overview.refetch();
    accounts.refetch();
    plans.refetch();
    reality.refetch();
    upcoming.refetch();
  }

  // Any quick-add creation can affect what the Overview shows.
  useEffect(() => {
    if (!lastCreated) return;
    refetchAll();
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

      {totalAccounts > 0 && (
        <UpcomingDigest
          items={upcoming.data?.items ?? []}
          days={upcoming.data?.days ?? UPCOMING_DAYS}
          loading={upcoming.loading}
        />
      )}

      {totalAccounts === 0 ? (
        <NoAccounts onSeeded={refetchAll} />
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

      {totalAccounts > 0 && <NetWorth reality={reality.data ?? []} loading={reality.loading} />}
    </section>
  );
}

/**
 * First run: nothing to plan with yet. Offers the worked example alongside the
 * real thing, on the deployments that have it switched on.
 */
function NoAccounts({ onSeeded }: { onSeeded: () => void }) {
  const demoSeedEnabled = useDemoSeedEnabled();
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadDemo(): Promise<void> {
    setSeeding(true);
    setError(null);
    try {
      await api.seedDemo();
    } catch (err) {
      // demo_not_empty: there is data after all (another tab, another device).
      // Showing it is exactly the right response, so it isn't an error here.
      if (!(err instanceof ApiError && err.code === "demo_not_empty")) {
        setError("could not load the demo data.");
        setSeeding(false);
        return;
      }
    }
    onSeeded();
    setSeeding(false);
  }

  return (
    <div className="empty-state">
      <h3>no accounts yet</h3>
      <p>
        Add your first account to start planning. Each account holds incomes and payments and
        generates its own savings plan.
      </p>
      <div className="empty-state-actions">
        <Link to="/accounts">
          <button type="button">+ create account</button>
        </Link>
        {demoSeedEnabled && (
          <button
            type="button"
            className="ghost"
            onClick={() => void loadDemo()}
            disabled={seeding}
          >
            {seeding ? "loading…" : "load demo data"}
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Asks the API once whether this deployment offers demo data. A failed probe
 *  reads as "off": the button stays hidden rather than dead-ending the user,
 *  the same way the login screen probes for SSO. */
function useDemoSeedEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api
      .meta()
      .then((meta) => {
        if (!cancelled) setEnabled(meta.demoSeedEnabled);
      })
      .catch(() => {
        /* no meta — leave the button hidden */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return enabled;
}

/** Net worth over time, from manual balance check-ins. */
function NetWorth({ reality, loading }: { reality: AccountReality[]; loading: boolean }) {
  const points = buildNetWorthSeries(reality);
  const chartRef = useRef<HTMLDivElement>(null);

  // Latest balance per account, summed per currency — never across currencies.
  const totals = new Map<string, { cash: number; reserved: number }>();
  for (const r of reality) {
    const entry = totals.get(r.account.currency) ?? { cash: 0, reserved: 0 };
    const latest = [...r.snapshots].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate)).at(-1);
    entry.cash += latest?.balanceMinor ?? 0;
    entry.reserved += r.reservedMinor;
    totals.set(r.account.currency, entry);
  }
  const multi = totals.size > 1;

  return (
    <div className="scope-block">
      <div className="section-head">
        <h2>net worth</h2>
        <span className="meta">[from balance check-ins · carried forward]</span>
        <span className="spacer" />
        <DownloadButton targetRef={chartRef} name="net-worth" />
      </div>

      {loading ? (
        <p className="muted" style={{ fontSize: "12px" }}>
          loading balances…
        </p>
      ) : points.length === 0 ? (
        <p className="muted" style={{ fontSize: "12px" }}>
          record balances on your accounts to see net worth over time
        </p>
      ) : (
        <>
          <div className="networth-summary">
            {[...totals.entries()].map(([currency, t]) => (
              <span key={currency}>
                {multi && <span className="dim">{currency} </span>}
                cash <b className="amount">{formatMinor(t.cash, currency)}</b>
                <span className="dim"> · </span>
                reserved <b className="amount">{formatMinor(t.reserved, currency)}</b>
              </span>
            ))}
          </div>
          <ChartFrame ref={chartRef}>
            <Suspense
              fallback={
                <p className="muted" style={{ fontSize: "12px" }}>
                  loading chart…
                </p>
              }
            >
              <NetWorthChart points={points} />
            </Suspense>
          </ChartFrame>
        </>
      )}
    </div>
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
