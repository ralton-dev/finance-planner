import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { Fold } from "../components/Fold.js";
import { HouseholdPlanView, memberLeftOverMinor } from "../components/HouseholdPlanView.js";
import { MemberTagBars } from "../components/MemberTagBars.js";
import { ProjectionView } from "../components/ProjectionView.js";
import { TagBreakdown } from "../components/TagBreakdown.js";
import { TransferChecklist } from "../components/TransferChecklist.js";
import { api } from "../lib/api.js";
import { currentMonth } from "../lib/months.js";
import { formatMinor } from "../lib/money.js";
import type { NeedsYouAccountInput, NeedsYouInput } from "../lib/needsYou.js";
import { useAsync } from "../lib/useAsync.js";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import type {
  HouseholdDetailDto,
  HouseholdPlanDto,
  TransferConfirmationDto,
  UpcomingDto,
  UserDto,
} from "../lib/types.js";

/** Look-ahead for the fold's "and this lands next" context — one pay cycle. */
const UPCOMING_DAYS = 14;

/**
 * The reality half of this household's accounts: the ones that answered, and
 * the names of the ones that did not.
 *
 * The second half is the whole point. A read that fails and is folded back into
 * the same shape as "this account had nothing to report" does not leave a gap on
 * the checklist — it leaves a checklist that says *nothing is waiting on you
 * here*, which is a different sentence from "we could not find out" and the more
 * dangerous one.
 */
interface Realities {
  entries: NeedsYouAccountInput[];
  /** Accounts whose plan could not be read, by name, in plan order. */
  unreadable: string[];
}

/** One account's plan read: what it contributes, or what to call it if it
 *  could not be read. */
type AccountRead = { read: true; entry: NeedsYouAccountInput } | { read: false; name: string };

/** "Bills joint" · "Bills joint and Alex current" · "A, B and C". */
function nameList(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

export function HouseholdPlanPage() {
  const { id = "" } = useParams();
  const { lastCreated } = useQuickAdd();
  const month = currentMonth();
  const plan = useAsync<HouseholdPlanDto>(() => api.householdPlan(id), [id]);
  const household = useAsync<HouseholdDetailDto>(() => api.getHousehold(id), [id]);
  // Who is looking. The fold's headline is the caller's own left over even
  // here, and there is no other way for this page to know whose row that is.
  const me = useAsync<UserDto>(() => api.me(), []);
  const confirmations = useAsync<TransferConfirmationDto[]>(
    () => api.listTransferConfirmations(id, month),
    [id, month],
  );

  // The fold's checklist needs the reality half of each account — contributions
  // this month, the last balance check-in — which only the *account* plan
  // carries. One parallel batch, and a single failing account drops out of the
  // list rather than blanking it.
  //
  // A failing account still drops out, and deliberately: this loop is over the
  // accounts *inside one household* — the demo seeds four — so letting the batch
  // reject would take every healthy account's check-in and record rows off the
  // checklist because one of them 404d. That is where this parts company with
  // the Overview's fix (WP-BA), whose loop is over households and where a user
  // has at most one (WP-W), so a rejecting batch costs nothing there.
  //
  // What is gone is the silence. `.catch(() => null)` said "no plan" in exactly
  // the words an account with nothing outstanding says, and the page had no way
  // left to tell the two apart — so a 404 here produced no error strip anywhere,
  // and a checklist missing a row looks precisely like a checklist with nothing
  // to do. The catch below records the name instead of discarding it, and the
  // page says it above the fold.
  const planAccounts = plan.data?.accounts ?? [];
  const accountKey = planAccounts.map((a) => a.accountId).join(",");
  const realities = useAsync<Realities>(
    () =>
      Promise.all(
        planAccounts.map(async (a): Promise<AccountRead> => {
          const name = a.name ?? "account";
          try {
            return {
              read: true,
              entry: { plan: await api.getPlan(a.accountId), name, householdId: id },
            };
          } catch {
            return { read: false, name };
          }
        }),
      ).then((reads) => ({
        entries: reads.flatMap((r) => (r.read ? [r.entry] : [])),
        unreadable: reads.flatMap((r) => (r.read ? [] : [r.name])),
      })),
    [accountKey, id],
  );
  const upcoming = useAsync<UpcomingDto>(() => api.upcoming(UPCOMING_DAYS), []);

  // Any income/payment change can move the household plan.
  useEffect(() => {
    if (lastCreated) plan.refetch();
  }, [lastCreated]);

  if (plan.error) return <p className="error">could not load the household plan.</p>;
  if (plan.loading || !plan.data) return <p className="muted">loading…</p>;
  const p = plan.data;
  const c = p.currency;

  const accountName = new Map(p.accounts.map((a) => [a.accountId, a.name ?? "account"]));

  // Everything the checklist is derived from, dated by the plan's own as-of.
  //
  // The fold's headline is a figure about *you* even on a screen about the
  // household (decisions 19, 20, 24), and the household's own total is the KPI
  // directly beneath it. Both come off the same publication: this reads the
  // caller's row out of `members`, the KPI adds those rows up. The shortfall is
  // that member's, and the payment count is the lines this household's plan
  // charges them a share of — a member with no row yet has nothing of their own
  // here, which is the honest answer rather than the household's figures
  // wearing a personal label.
  const mine = p.members.find((m) => m.userId === me.data?.id);
  const needsYou: NeedsYouInput = {
    asOfDate: p.asOfDate,
    userId: me.data?.id,
    you: {
      leftoverMinor: mine ? memberLeftOverMinor(mine) : 0,
      shortfallMinor: mine?.shortfallMinor ?? 0,
      paymentCount: mine
        ? p.lines.filter((l) => l.allocations.some((a) => a.userId === mine.userId)).length
        : 0,
    },
    households: [{ plan: p, confirmations: confirmations.data ?? [] }],
    accounts: realities.data?.entries ?? [],
    upcoming: upcoming.data?.items ?? [],
  };

  // What the fold could not be told, in the words of what it costs the reader.
  //
  // Both are reads that fail into an empty list, and an empty list is a claim:
  // an account with no rows has nothing outstanding, and a confirmation list
  // with nothing in it says nobody has moved this month's money — about money
  // that may well have moved. Said above the fold, because the fold is what
  // they are missing from.
  const unread: string[] = [
    ...(realities.data && realities.data.unreadable.length > 0
      ? [`the plan for ${nameList(realities.data.unreadable)}`]
      : []),
    ...(confirmations.error ? ["which transfers have already been made"] : []),
  ];

  /** Re-read everything an action in the fold can have moved. */
  function refreshReality(): void {
    plan.refetch();
    confirmations.refetch();
    realities.refetch();
    upcoming.refetch();
  }

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
            {p.members.length} {p.members.length === 1 ? "member" : "members"} ·{" "}
            {/* The same diagram, where it can be widened past this household —
                which is the point of a preset. */}
            <Link to={`/flow?household=${id}`} className="action">
              draw this alongside other accounts →
            </Link>
          </div>
        </div>
      </div>

      {unread.length > 0 && (
        <p className="error" role="alert">
          could not read {nameList(unread)} — anything{" "}
          {unread.length === 1 ? "it was" : "they were"} owed is missing from the checklist below.
        </p>
      )}

      <Fold
        input={needsYou}
        loading={confirmations.loading || realities.loading || upcoming.loading}
        onActioned={refreshReality}
      />

      <HouseholdPlanView plan={p} />

      <TransferChecklist
        plan={p}
        confirmations={confirmations.data ?? []}
        month={month}
        onConfirm={async (t) => {
          await api.confirmTransfer(id, {
            fromAccountId: t.fromAccountId,
            toAccountId: t.toAccountId,
            memberUserId: t.memberUserId,
            month,
          });
          confirmations.refetch();
          plan.refetch();
        }}
        onUndo={async (confirmationId) => {
          await api.unconfirmTransfer(id, confirmationId);
          confirmations.refetch();
          plan.refetch();
        }}
      />

      <div className="section-head">
        <h2>cost breakdown</h2>
        <span className="meta">[{p.lines.length} payments · priority asc]</span>
      </div>
      {p.lines.length === 0 ? (
        <p className="muted" style={{ fontSize: "12px" }}>
          no payments on the household's accounts yet.
        </p>
      ) : (
        // Five columns is past what a phone holds; the wrapper scrolls them
        // rather than the document, with the payment name pinned to the left.
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th className="sticky-col">payment</th>
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
                    <td className="name sticky-col">{l.name}</td>
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
        </div>
      )}

      <TagBreakdown lines={p.lines} currency={c} />

      <MemberTagBars plan={p} />

      <ProjectionView
        load={(months) => api.householdProjection(id, months)}
        scopeKey={id}
        accountNames={Object.fromEntries(accountName)}
      />
    </section>
  );
}
