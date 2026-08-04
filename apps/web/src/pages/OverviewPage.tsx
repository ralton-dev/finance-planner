import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Amount, Sentence } from "../components/Amount.js";
import { ChartFrame } from "../components/ChartFrame.js";
import { DownloadButton } from "../components/DownloadButton.js";
import { Fold } from "../components/Fold.js";
import { UpcomingDigest } from "../components/UpcomingDigest.js";
import { api, ApiError } from "../lib/api.js";
import { money, type Phrase } from "../lib/money.js";
import { deriveNeedsYou, type NeedsYouAccountInput, type NeedsYouInput } from "../lib/needsYou.js";
import { buildNetWorthSeries, type AccountBalanceHistory } from "../lib/networth.js";
import { useAsync } from "../lib/useAsync.js";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { AccountCell, AttentionCell, BalanceCell } from "./AccountsPage.js";
import type {
  AccountDto,
  AccountPlanDto,
  BalanceSnapshotDto,
  CurrencyOverviewDto,
  HouseholdDto,
  HouseholdPlanDto,
  OverviewAccountDto,
  OverviewDto,
  TransferConfirmationDto,
  UpcomingDto,
  UserDto,
} from "../lib/types.js";

/**
 * The Overview: what needs you across everything, and a door to each place the
 * detail lives.
 *
 * It used to print the household plan in full — the money-flow Sankey, the
 * member table, the per-account reconciliation — which is the plan page's job,
 * done here a second time in a smaller box. What a landing page owes you is the
 * one number, the list of things waiting on a human, and a way through to the
 * screen that can do something about each of them.
 *
 * The household plans are still read, because the fold's shortfall and transfer
 * rows are derived from them and the link cards print totals that same read
 * already carries. Nothing here renders their lines.
 *
 * `UpcomingDigest` stays a section of its own, directly beneath the fold,
 * rather than folding into the checklist. A bill that falls due next Tuesday is
 * not waiting on a human — it will be paid whether or not anyone ticks
 * anything — and the fold's contract is that every row on it is something to
 * do. Keeping them apart keeps "what needs you" honest; the check-in rows
 * already carry the due payment that dates them as their own meta.
 */

/** Look-ahead for the "coming up" digest — a fortnight is one pay cycle. */
const UPCOMING_DAYS = 14;

// Keeps recharts out of the eagerly-loaded Overview chunk, as the Sankey does.
const NetWorthChart = lazy(() =>
  import("../components/NetWorthChart.js").then((m) => ({ default: m.NetWorthChart })),
);

/** Balances for the net-worth chart, plus the account plan the checklist's
 *  `record` and `check-in` rules are derived from. */
interface AccountReality extends AccountBalanceHistory {
  account: AccountDto;
  /** null when this account's plan failed to load — it drops out of the
   *  checklist rather than blanking it. */
  plan: AccountPlanDto | null;
}

/** A household, its plan and this month's confirmations: everything the fold
 *  derives from, and everything its link card says. */
export interface HouseholdEntry {
  household: HouseholdDto;
  plan: HouseholdPlanDto;
  confirmations: TransferConfirmationDto[];
}

export function OverviewPage() {
  const { lastCreated } = useQuickAdd();
  const me = useAsync<UserDto>(() => api.me(), []);
  const overview = useAsync<OverviewDto>(() => api.overview(), []);
  const accounts = useAsync<AccountDto[]>(() => api.listAccounts(), []);
  const upcoming = useAsync<UpcomingDto>(() => api.upcoming(UPCOMING_DAYS), []);

  // The household plans are read for one reason: the fold derives the
  // shortfall and transfer rows from them, and the link cards print the totals
  // that same read already carries. Nothing on this page renders their lines.
  const households = me.data?.households ?? [];
  const householdKey = households.map((h) => h.id).join(",");
  const plans = useAsync<HouseholdEntry[]>(
    () =>
      Promise.all(
        households.map(async (household): Promise<HouseholdEntry | null> => {
          const plan = await api.householdPlan(household.id).catch(() => null);
          if (!plan) return null;
          // Server-side default is the current month, which is the month the
          // checklist filters to anyway.
          const confirmations = await api
            .listTransferConfirmations(household.id)
            .catch((): TransferConfirmationDto[] => []);
          return { household, plan, confirmations };
        }),
      ).then((entries) => entries.filter((e): e is HouseholdEntry => e !== null)),
    [householdKey],
  );

  // One parallel batch across every accessible account: balance history for the
  // chart, the account plan for the checklist. A single failing account degrades
  // to "no data" instead of blanking the section.
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
          return { account, snapshots, plan };
        }),
      ),
    [accountKey],
  );

  /** Everything on the page, re-read: for anything that can create data behind
   *  the Overview's back (a quick-add drawer, the demo seed, the fold). */
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
  if (overview.error || !overview.data) return <p className="error">failed to load overview.</p>;

  const { asOfDate, perCurrency: buckets } = overview.data;
  const byId = new Map((accounts.data ?? []).map((a) => [a.id, a]));
  const stateById = new Map(buckets.flatMap((c) => c.accounts).map((a) => [a.accountId, a]));
  const householdPlans = plans.data ?? [];
  const totalAccounts = accounts.data?.length ?? 0;

  // Accounts planned inside a household are that household's story; the table
  // below lists only the ones planned alone. The overview DTO says which is
  // which, so this no longer depends on having read any household plan.
  const unpooled = buckets
    .map((c) => ({ ...c, accounts: c.accounts.filter((a) => !a.householdId) }))
    .filter((c) => c.accounts.length > 0);

  // Everything the checklist is derived from, dated by the overview's as-of.
  // `householdId` is the de-duplication hook: an account inside a household in
  // this input contributes its record and check-in rows, but its shortfall is
  // left to that household's member rows, which say whose money is missing.
  const needsYou: NeedsYouInput = {
    asOfDate,
    households: householdPlans.map(({ plan, confirmations }) => ({ plan, confirmations })),
    accounts: (reality.data ?? []).flatMap(({ account, plan }): NeedsYouAccountInput[] => {
      if (!plan) return [];
      const householdId = stateById.get(account.id)?.householdId;
      return [{ plan, name: account.name, ...(householdId ? { householdId } : {}) }];
    }),
    upcoming: upcoming.data?.items ?? [],
  };

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
        {asOfDate && <> · as of {asOfDate}</>}
      </div>

      {totalAccounts === 0 ? (
        <NoAccounts onSeeded={refetchAll} />
      ) : (
        <>
          {/* The headline and the checklist must not appear before the data
              they are derived from, or the page greets you with a confident
              "nothing planned yet" it is about to take back. */}
          {plans.loading || reality.loading ? (
            <p className="muted">reading your plans…</p>
          ) : (
            <Fold input={needsYou} loading={upcoming.loading} onActioned={refetchAll} />
          )}

          <UpcomingDigest
            items={upcoming.data?.items ?? []}
            days={upcoming.data?.days ?? UPCOMING_DAYS}
            loading={upcoming.loading}
          />

          <HouseholdCards entries={householdPlans} loading={plans.loading} asOfDate={asOfDate} />

          {unpooled.map((c) => (
            <StandaloneAccounts
              key={c.currency}
              bucket={c}
              byId={byId}
              asOfDate={asOfDate}
              named={households.length > 0}
            />
          ))}

          <NetWorth buckets={buckets} reality={reality.data ?? []} loading={reality.loading} />
        </>
      )}
    </section>
  );
}

// --- household doorways ------------------------------------------------------

/** A card's state chips, in the accounts index's vocabulary. */
export interface HouseholdChip {
  tone: "alert" | "needs-you" | "funded" | "neutral";
  label: string;
  amountMinor?: number;
}

/**
 * What a household card says about itself, worst first: money the plan cannot
 * cover, then money nobody has moved yet, then — only when neither applies —
 * that it is on track.
 *
 * The transfer count comes from the same derivation the fold's rows do, so a
 * card and the checklist above it can never disagree about what is outstanding.
 */
export function householdChips(entry: HouseholdEntry, asOfDate: string): HouseholdChip[] {
  const chips: HouseholdChip[] = [];

  // A household with nothing in it is not "on track", it is unstarted — and
  // the card sends you to the setup screen rather than to an empty plan.
  if (entry.plan.accounts.length === 0) return [{ tone: "neutral", label: "no accounts yet" }];

  if (entry.plan.shortfallMinor > 0) {
    chips.push({ tone: "alert", label: "unfunded", amountMinor: entry.plan.shortfallMinor });
  }

  const waiting = deriveNeedsYou({
    asOfDate,
    households: [{ plan: entry.plan, confirmations: entry.confirmations }],
  }).filter((i) => i.kind === "transfer").length;
  if (waiting > 0) {
    chips.push({
      tone: "needs-you",
      label: waiting === 1 ? "1 transfer to make" : `${waiting} transfers to make`,
    });
  }

  return chips.length > 0 ? chips : [{ tone: "funded", label: "on track" }];
}

function HouseholdCards({
  entries,
  loading,
  asOfDate,
}: {
  entries: HouseholdEntry[];
  loading: boolean;
  asOfDate: string;
}) {
  if (loading && entries.length === 0) {
    return (
      <p className="muted" style={{ fontSize: "12px" }}>
        loading household plans…
      </p>
    );
  }
  if (entries.length === 0) return null;

  return (
    <>
      <div className="section-head">
        <h2>households</h2>
        <span className="meta">
          [{entries.length} {entries.length === 1 ? "plan" : "plans"}]
        </span>
      </div>
      <div className="household-cards">
        {entries.map((entry) => (
          <HouseholdCard key={entry.household.id} entry={entry} asOfDate={asOfDate} />
        ))}
      </div>
    </>
  );
}

/** The doorway: what the household is, what it costs, and what it wants. */
function HouseholdCard({ entry, asOfDate }: { entry: HouseholdEntry; asOfDate: string }) {
  const { household, plan } = entry;
  const c = plan.currency;
  const members = plan.members.length;
  const accounts = plan.accounts.length;
  // Nothing assigned yet: the plan page would be blank, so the door goes to the
  // screen that can fix that.
  const started = accounts > 0;

  return (
    <Link
      to={started ? `/households/${household.id}/plan` : `/households/${household.id}`}
      className="household-card"
    >
      <div className="household-card-head">
        <span className="name">{household.name}</span>
        <span className="spacer" />
        <span className="action">{started ? "full plan →" : "set it up →"}</span>
      </div>
      <div className="household-card-meta">
        {members} {members === 1 ? "member" : "members"} · {accounts}{" "}
        {accounts === 1 ? "account" : "accounts"}
      </div>
      <div className="household-card-figures">
        <Amount minor={plan.monthlyIncomeMinor} currency={c} /> in
        <span className="dim"> · </span>
        <Amount minor={plan.totalRequiredMinor} currency={c} /> required
      </div>
      <div className="household-card-chips">
        {householdChips(entry, asOfDate).map((chip) => (
          <span key={chip.tone} className={`tag-status ${chip.tone}`}>
            {chip.label}
            {chip.amountMinor !== undefined && (
              <>
                {" · "}
                <Amount minor={chip.amountMinor} currency={c} />
              </>
            )}
          </span>
        ))}
      </div>
    </Link>
  );
}

// --- accounts planned outside a household ------------------------------------

/**
 * The accounts nobody's household plan speaks for, in the accounts index's own
 * columns — same cells, same chips, same staleness threshold, so the two
 * screens cannot describe one account two ways.
 */
function StandaloneAccounts({
  bucket,
  byId,
  asOfDate,
  named,
}: {
  bucket: CurrencyOverviewDto;
  byId: Map<string, AccountDto>;
  asOfDate: string;
  named: boolean;
}) {
  const rows = bucket.accounts.filter((s) => byId.has(s.accountId));
  if (rows.length === 0) return null;

  return (
    <>
      <div className="section-head">
        <h2>{named ? "your other accounts" : "accounts"}</h2>
        <span className="meta">
          [{rows.length} {rows.length === 1 ? "row" : "rows"} · {bucket.currency}
          {named ? " · not in a household" : ""}]
        </span>
        <span className="spacer" />
        <Link to="/accounts" className="action">
          manage →
        </Link>
      </div>
      <table>
        <thead>
          <tr>
            <th>account</th>
            <th className="num">balance</th>
            <th className="num">left over / mo</th>
            <th>attention</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const account = byId.get(s.accountId)!;
            return (
              <tr key={s.accountId}>
                <td>
                  <AccountCell account={account} state={s} />
                </td>
                <td className="num">
                  <BalanceCell state={s} currency={bucket.currency} asOfDate={asOfDate} />
                </td>
                <td className="num">
                  <Amount minor={s.leftoverMinor} currency={bucket.currency} />
                </td>
                <td>
                  <AttentionCell state={s} currency={bucket.currency} asOfDate={asOfDate} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// --- net worth ---------------------------------------------------------------

/** What the accounts hold, and how much of it the plan has already claimed. */
export interface NetWorthTotals {
  cashMinor: number;
  reservedMinor: number;
  /** Cash the plan has no claim on. Negative when the plan is over-committed. */
  freeMinor: number;
  /** How many accounts have ever been checked in — nothing above is real
   *  without at least one. */
  checkedIn: number;
}

/**
 * Net worth from the same read the accounts index uses: the latest balance
 * check-in per account, and what that account's plan has set aside. Summed
 * inside one currency only — the caller passes one overview bucket.
 */
export function netWorthTotals(accounts: readonly OverviewAccountDto[]): NetWorthTotals {
  let cashMinor = 0;
  let reservedMinor = 0;
  let checkedIn = 0;

  for (const account of accounts) {
    if (account.latestBalanceMinor !== null && account.latestBalanceMinor !== undefined) {
      cashMinor += account.latestBalanceMinor;
      checkedIn += 1;
    }
    reservedMinor += account.reservedMinor ?? 0;
  }

  return { cashMinor, reservedMinor, freeMinor: cashMinor - reservedMinor, checkedIn };
}

/**
 * The sentence under the figure. A balance is not spendable money: the plan has
 * already promised most of it to something, and the difference is the only
 * number worth acting on.
 */
export function netWorthSentence(totals: NetWorthTotals, currency: string): Phrase {
  if (totals.checkedIn === 0) {
    return ["No balances checked in yet — record one and this becomes real."];
  }
  const reserved = money(totals.reservedMinor, currency);
  if (totals.freeMinor < 0) {
    return [
      "The plan has ",
      reserved,
      " set aside — ",
      money(-totals.freeMinor, currency),
      " more than these accounts hold.",
    ];
  }
  return [
    reserved,
    " of it is already set aside by the plan, leaving ",
    money(totals.freeMinor, currency),
    " genuinely free.",
  ];
}

/** What you hold, said in a sentence; the trend is a disclosure behind it. */
function NetWorth({
  buckets,
  reality,
  loading,
}: {
  buckets: CurrencyOverviewDto[];
  reality: AccountReality[];
  loading: boolean;
}) {
  const points = buildNetWorthSeries(reality);
  const chartRef = useRef<HTMLDivElement>(null);
  const multi = buckets.length > 1;

  return (
    <div className="scope-block">
      <div className="section-head">
        <h2>net worth</h2>
        <span className="meta">[from balance check-ins · carried forward]</span>
      </div>

      {buckets.map((bucket) => {
        const totals = netWorthTotals(bucket.accounts);
        return (
          <div key={bucket.currency} className="networth-line">
            <div className="networth-figure">
              {multi && <span className="dim">{bucket.currency} </span>}
              <Amount minor={totals.cashMinor} currency={bucket.currency} />
            </div>
            <p className="networth-sentence">
              <Sentence phrase={netWorthSentence(totals, bucket.currency)} />
            </p>
          </div>
        );
      })}

      <details className="disclosure">
        <summary>net worth over time</summary>
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
            <div className="disclosure-actions">
              <DownloadButton targetRef={chartRef} name="net-worth" />
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
      </details>
    </div>
  );
}

// --- first run ---------------------------------------------------------------

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
