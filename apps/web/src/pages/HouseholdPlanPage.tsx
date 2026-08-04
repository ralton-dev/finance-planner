import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { HouseholdPlanView } from "../components/HouseholdPlanView.js";
import { MonthScorecard } from "../components/MonthScorecard.js";
import { TransferChecklist } from "../components/TransferChecklist.js";
import { api } from "../lib/api.js";
import { currentMonth } from "../lib/months.js";
import { formatMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import type {
  HouseholdDetailDto,
  HouseholdPlanDto,
  MonthCloseDto,
  TransferConfirmationDto,
} from "../lib/types.js";

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
