import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { Fold } from "../components/Fold.js";
import { HouseholdPlanView } from "../components/HouseholdPlanView.js";
import { MemberTagBars } from "../components/MemberTagBars.js";
import { MonthScorecard } from "../components/MonthScorecard.js";
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
  MonthCloseDto,
  TransferConfirmationDto,
  UpcomingDto,
} from "../lib/types.js";

/** Look-ahead for the fold's "and this lands next" context — one pay cycle. */
const UPCOMING_DAYS = 14;

export function HouseholdPlanPage() {
  const { id = "" } = useParams();
  const { lastCreated } = useQuickAdd();
  const month = currentMonth();
  const plan = useAsync<HouseholdPlanDto>(() => api.householdPlan(id), [id]);
  const household = useAsync<HouseholdDetailDto>(() => api.getHousehold(id), [id]);
  const confirmations = useAsync<TransferConfirmationDto[]>(
    () => api.listTransferConfirmations(id, month),
    [id, month],
  );
  const closes = useAsync<MonthCloseDto[]>(() => api.listHouseholdCloses(id), [id]);

  // The fold's checklist needs the reality half of each account — contributions
  // this month, the last balance check-in — which only the *account* plan
  // carries. One parallel batch, and a single failing account drops out of the
  // list rather than blanking it.
  const planAccounts = plan.data?.accounts ?? [];
  const accountKey = planAccounts.map((a) => a.accountId).join(",");
  const realities = useAsync<NeedsYouAccountInput[]>(
    () =>
      Promise.all(
        planAccounts.map(async (a): Promise<NeedsYouAccountInput | null> => {
          const accountPlan = await api.getPlan(a.accountId).catch(() => null);
          return accountPlan
            ? { plan: accountPlan, name: a.name ?? "account", householdId: id }
            : null;
        }),
      ).then((entries) => entries.filter((e): e is NeedsYouAccountInput => e !== null)),
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
  const role = household.data?.yourRole;
  const canClose = role === "owner" || role === "admin";

  const accountName = new Map(p.accounts.map((a) => [a.accountId, a.name ?? "account"]));

  // Everything the checklist is derived from, dated by the plan's own as-of.
  const needsYou: NeedsYouInput = {
    asOfDate: p.asOfDate,
    households: [{ plan: p, confirmations: confirmations.data ?? [] }],
    accounts: realities.data ?? [],
    upcoming: upcoming.data?.items ?? [],
  };

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
            {p.members.length} {p.members.length === 1 ? "member" : "members"}
          </div>
        </div>
      </div>

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

      <MonthScorecard
        closes={closes.data ?? []}
        currency={c}
        month={month}
        canClose={canClose}
        onClose={async (m) => {
          await api.closeHouseholdMonth(id, m);
          closes.refetch();
        }}
        onReopen={async (closeId) => {
          await api.reopenHouseholdMonth(id, closeId);
          closes.refetch();
        }}
      />
    </section>
  );
}
