import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Amount } from "../components/Amount.js";
import { Fold } from "../components/Fold.js";
import { LeftOverCell } from "../components/PlanTable.js";
import { MonthScorecard } from "../components/MonthScorecard.js";
import { UpcomingDigest } from "../components/UpcomingDigest.js";
import { api, ApiError } from "../lib/api.js";
import { currentMonth } from "../lib/months.js";
import {
  deriveNeedsYou,
  headlineCurrency,
  type NeedsYouAccountInput,
  type NeedsYouInput,
} from "../lib/needsYou.js";
import { useAsync } from "../lib/useAsync.js";
import { useMeta } from "../lib/useMeta.js";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { AccountCell, AttentionCell, BalanceCell } from "./AccountsPage.js";
import type {
  AccountDto,
  CurrencyOverviewDto,
  HouseholdDto,
  HouseholdPlanDto,
  LatestBalanceDto,
  MonthCloseDto,
  OverviewAccountDto,
  OverviewDto,
  OverviewYouDto,
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
 * The *account* plans are not read at all. GET /overview computes every one of
 * them to aggregate it, so it sends down the handful of line facts the
 * checklist acts on (`planSummary`) and the arrivals it must name to confirm a
 * movement (`inflowArrivals`), and the page costs a fixed number of requests
 * however many accounts you have. There is no per-account read left at all:
 * the last one was the balance history behind the net-worth trend, and net
 * worth is gone (decision 21).
 *
 * **Every figure on this page is the caller's own money.** The headline reads
 * the bucket's `you`, which the pass sums over the accounts the caller *owns*;
 * the account rows read each account's residual through the accounts index's
 * own cell. Net worth could not be made to say that — it summed balances over
 * every account the caller could **see**, including a co-member's shared into
 * the household, and a balance is a fact about a place rather than about a
 * person, so there was no ownership filter that would have made the total mean
 * anything. It was deleted rather than fixed. `reservedMinor` stays on the wire
 * and the account page's reality strip still prints it, and balance check-ins
 * are untouched: only the roll-up over them was ever the problem.
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

/** No accounts in the headline's currency: three noughts rather than a figure
 *  borrowed from a bucket the sentence is not about. */
const NOTHING_OF_YOURS: OverviewYouDto = {
  leftoverMinor: 0,
  shortfallMinor: 0,
  paymentCount: 0,
};

/** A household, its plan and this month's confirmations: everything the fold
 *  derives from, and everything its link card says. */
export interface HouseholdEntry {
  household: HouseholdDto;
  plan: HouseholdPlanDto;
  confirmations: TransferConfirmationDto[];
}

/**
 * An account's last check-in in the shape the checklist reads it, or null. The
 * two halves arrive together or not at all; anything less than both is "never
 * checked in", which is what the check-in row is for.
 */
function latestBalanceOf(s: OverviewAccountDto): LatestBalanceDto | null {
  const { latestBalanceDate: asOfDate, latestBalanceMinor: balanceMinor } = s;
  if (!asOfDate || balanceMinor === null || balanceMinor === undefined) return null;
  return { asOfDate, balanceMinor };
}

export function OverviewPage() {
  const { lastCreated } = useQuickAdd();
  const me = useAsync<UserDto>(() => api.me(), []);
  const overview = useAsync<OverviewDto>(() => api.overview(), []);
  const accounts = useAsync<AccountDto[]>(() => api.listAccounts(), []);
  const upcoming = useAsync<UpcomingDto>(() => api.upcoming(UPCOMING_DAYS), []);
  // The scorecard's one producer. A close is the caller's own, so this asks for
  // nothing and scopes to nothing — which is why it lives here, on the only
  // screen that is about the person rather than about a place.
  const closes = useAsync<MonthCloseDto[]>(() => api.listMyCloses(), []);

  // The household plans are read for one reason: the fold derives the
  // shortfall and transfer rows from them, and the link cards print the totals
  // that same read already carries. Nothing on this page renders their lines.
  const households = me.data?.households ?? [];
  const householdKey = households.map((h) => h.id).join(",");
  //
  // Neither read is caught. Both used to be — the plan fell back to dropping
  // the household, the confirmations to an empty list — and a 404 from
  // `/api/households/:id/plan` therefore produced no error strip anywhere on
  // this page: the household section simply was not there, and a reader had no
  // way to tell "nothing to show" from "could not read it". A swallowed
  // confirmations read is quieter still, because the card renders and only its
  // "transfers to make" chip is missing, which reads as *nothing to do*.
  //
  // Letting them reject costs one thing: a household whose plan cannot be read
  // takes the others down with it. A user is in at most one household (WP-W),
  // so in practice there are no others — and where there are, one strip saying
  // so beats one card silently absent.
  const plans = useAsync<HouseholdEntry[]>(
    () =>
      Promise.all(
        households.map(async (household): Promise<HouseholdEntry> => {
          const plan = await api.householdPlan(household.id);
          // Server-side default is the current month, which is the month the
          // checklist filters to anyway.
          const confirmations = await api.listTransferConfirmations(household.id);
          return { household, plan, confirmations };
        }),
      ),
    [householdKey],
  );

  /** Everything on the page, re-read: for anything that can create data behind
   *  the Overview's back (a quick-add drawer, the demo seed, the fold). */
  function refetchAll(): void {
    overview.refetch();
    accounts.refetch();
    plans.refetch();
    upcoming.refetch();
  }

  // Any quick-add creation can affect what the Overview shows.
  useEffect(() => {
    if (!lastCreated) return;
    refetchAll();
  }, [lastCreated]);

  if (me.loading || overview.loading || accounts.loading) return <p className="muted">loading…</p>;
  if (overview.error || !overview.data) return <p className="error">failed to load overview.</p>;
  // The account list is not optional to this page — the guard above already
  // waits for it — but only its *success* used to be assumed. `accounts.data?.
  // length ?? 0` turned a failed read into a count of zero, and zero is the
  // first run: "no accounts yet", under a subhead counting none, offering to
  // seed a worked example over a profile whose real contents we had not
  // managed to read. The same empty map silently emptied every currency table
  // below, which filters its rows through it.
  //
  // "We could not find out" and "there is nothing there" are different
  // sentences. A strip would have left both of those still speaking, so this
  // refuses the page instead — the house answer for a read a page is built on
  // (`AccountPage.tsx`, `HouseholdPlanPage.tsx`, `SettingsPage.tsx`). Note the
  // narrowing: an empty array is data, so a genuine first run walks straight
  // past and gets its welcome.
  if (accounts.error || !accounts.data)
    return <p className="error">could not read your accounts.</p>;

  const { asOfDate, perCurrency: buckets } = overview.data;
  const byId = new Map(accounts.data.map((a) => [a.id, a]));
  const householdPlans = plans.data ?? [];
  const totalAccounts = accounts.data.length;

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
  //
  // Every account fact here is off the overview's own read — the shortfall and
  // left-over it aggregates anyway, the balance the index prints, the line
  // summary the API derives from the plan it computed, and now the movements
  // itemised out of the inflow total. No plan is fetched at all.
  //
  // The headline's three figures ride down as `you`, computed by the pass over
  // the accounts the caller **owns**. The browser assembles none of them: it
  // used to add up whatever it held, which on a household of two was the
  // co-member's money as much as the reader's.
  const derivedFrom = {
    households: householdPlans.map(({ plan, confirmations }) => ({ plan, confirmations })),
    accounts: buckets.flatMap((bucket) =>
      bucket.accounts.map((s): NeedsYouAccountInput => {
        return {
          name: s.name,
          plan: {
            accountId: s.accountId,
            currency: bucket.currency,
            leftoverMinor: s.leftoverMinor,
            shortfallMinor: s.shortfallMinor,
            ...(s.ownerUserId ? { ownerUserId: s.ownerUserId } : {}),
            latestBalance: latestBalanceOf(s),
            ...(s.allocatedInflowMinor === undefined
              ? {}
              : { allocatedInflowMinor: s.allocatedInflowMinor }),
            ...(s.inflowArrivals ? { inflowArrivals: s.inflowArrivals } : {}),
            // Straight from the API, which applies the one gate: names are
            // withheld, ids are not. This page used to name the senders itself
            // out of the account list it holds — the same answer for an authored
            // movement, and no answer at all for a transfer the plan derived,
            // because there is no arrival to name when nobody authored one.
            ...(s.inflowSources ? { inflowSources: s.inflowSources } : {}),
          },
          ...(s.householdId ? { householdId: s.householdId } : {}),
          ...(s.planSummary ? { lineSummary: s.planSummary } : {}),
        };
      }),
    ),
    upcoming: upcoming.data?.items ?? [],
  };

  // The headline is counted in one currency, so it reads that bucket's `you`
  // and no other — money in a second currency is left to its own bucket rather
  // than added to a total that would mean nothing. `headlineCurrency` picks the
  // same one the sentence is worded in, off the same input, so the figure and
  // the words can never be about different money.
  const currency = headlineCurrency(derivedFrom);
  const needsYou: NeedsYouInput = {
    asOfDate,
    userId: me.data?.id,
    ...derivedFrom,
    you: buckets.find((b) => b.currency === currency)?.you ?? NOTHING_OF_YOURS,
  };

  return (
    <section>
      <h1>
        overview <span className="scope">/ all-accounts</span>
      </h1>
      {/* The household is named rather than counted: there is at most one
          (WP-W), and "1 household" was a count of a thing that has a name. */}
      <div className="subhead">
        <b>{totalAccounts}</b> accounts ·{" "}
        {households[0] ? (
          <b>{households[0].name}</b>
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
          {/* Said before the checklist, because the checklist is what the
              missing read would have filled: a household plan that will not
              load takes its shortfall and transfer rows down with it, and a
              fold with rows missing looks exactly like a fold with nothing to
              do. */}
          {plans.error && (
            <p className="error" role="alert">
              could not read your household plan — anything it was owed is missing below.
            </p>
          )}

          {/* The headline and the checklist must not appear before the data
              they are derived from, or the page greets you with a confident
              "nothing planned yet" it is about to take back. */}
          {plans.loading ? (
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
              userId={me.data?.id}
            />
          ))}

          {/* Last, because it is the only backward-looking thing here: every
              section above is what to do now, and this is what already
              happened. Not in `refetchAll` — a close is frozen, so nothing a
              quick-add or a seed can do moves a row that already exists. */}
          <MonthScorecard
            closes={closes.data ?? []}
            month={currentMonth()}
            onClose={async (m) => {
              await api.closeMyMonth(m);
              closes.refetch();
            }}
            onReopen={async (closeId) => {
              await api.reopenMyMonth(closeId);
              closes.refetch();
            }}
          />
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
        loading your household plan…
      </p>
    );
  }
  if (entries.length === 0) return null;

  // Still a list, still mapped: a user has one household (WP-W), and the row
  // that renders one renders it the same way. The heading stops claiming
  // otherwise.
  return (
    <>
      <div className="section-head">
        <h2>household</h2>
        <span className="meta">[the plan you share]</span>
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
 *
 * **The heading says "your" only when they are all yours.** This list is every
 * account the caller can *see* with no household plan speaking for it, and an
 * account a co-member shared into the household without anyone giving it a
 * plan role lands here — theirs, correctly listed, and correctly labelled
 * "shared with you" on its own row while the heading above called it the
 * reader's (decision 20's boundary, decision 25's wording). The row stays: it
 * is a real account the caller can act on. Only the claim goes.
 */
function StandaloneAccounts({
  bucket,
  byId,
  asOfDate,
  named,
  userId,
}: {
  bucket: CurrencyOverviewDto;
  byId: Map<string, AccountDto>;
  asOfDate: string;
  named: boolean;
  /** Who is looking. Absent while `GET /api/users/me` is in flight, which reads
   *  as "cannot say these are yours" rather than as "they all are". */
  userId: string | undefined;
}) {
  const rows = bucket.accounts.filter((s) => byId.has(s.accountId));
  if (rows.length === 0) return null;
  const allMine = userId !== undefined && rows.every((s) => s.ownerUserId === userId);

  return (
    <>
      <div className="section-head">
        <h2>{named ? (allMine ? "your other accounts" : "other accounts") : "accounts"}</h2>
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
                {/* The accounts index's cell, imported rather than copied —
                    this table is the same four columns and used to print a
                    different field in this one. */}
                <td className="num">
                  <LeftOverCell state={s} currency={bucket.currency} />
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

// --- first run ---------------------------------------------------------------

/**
 * First run: nothing to plan with yet. Offers the worked example alongside the
 * real thing, on the deployments that have it switched on.
 */
function NoAccounts({ onSeeded }: { onSeeded: () => void }) {
  const { demoSeedEnabled } = useMeta();
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
