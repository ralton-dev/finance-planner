import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AccountSettingsDrawer } from "../components/AccountSettingsDrawer.js";
import { MonthScorecard } from "../components/MonthScorecard.js";
import { PlanSummary, PlanTable } from "../components/PlanTable.js";
import { RealityStrip } from "../components/RealityStrip.js";
import { api } from "../lib/api.js";
import { currentMonth } from "../lib/months.js";
import { formatMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import type {
  AccountDto,
  AccountPlanDto,
  IncomeDto,
  MonthCloseDto,
  PaymentDto,
  ProjectDto,
} from "../lib/types.js";

export function AccountPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { openIncome, openPayment, openEditIncome, openEditPayment, lastCreated } = useQuickAdd();

  const account = useAsync<AccountDto>(() => api.getAccount(id), [id]);
  const plan = useAsync<AccountPlanDto>(() => api.getPlan(id), [id]);
  const incomes = useAsync<IncomeDto[]>(() => api.listIncomes(id), [id]);
  const payments = useAsync<PaymentDto[]>(() => api.listPayments(id), [id]);
  // Project labels for the chips next to payment names. Cheap call; no per-account scope.
  const projects = useAsync<ProjectDto[]>(() => api.listProjects(), []);
  const closes = useAsync<MonthCloseDto[]>(() => api.listAccountCloses(id), [id]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerFocus, setDrawerFocus] = useState<"monthlyBuffer" | undefined>(undefined);

  const refresh = (): void => {
    plan.refetch();
    incomes.refetch();
    payments.refetch();
  };

  // When the quick-add drawer creates an income or payment for THIS account,
  // refetch the plan + lists so the change appears immediately.
  useEffect(() => {
    if (!lastCreated) return;
    if (lastCreated.kind === "income" || lastCreated.kind === "payment") {
      if (lastCreated.accountId === id) refresh();
    }
  }, [lastCreated, id]);

  if (account.error) return <p className="error">account not found.</p>;
  if (account.loading || !account.data) return <p className="muted">loading…</p>;
  const currency = account.data.currency;
  const canEdit = account.data.owner || account.data.permission === "edit";

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            account <span className="scope">/ {account.data.name}</span>
          </h1>
          {account.data.description && (
            <p className="account-description">{account.data.description}</p>
          )}
          <div className="subhead">
            <Link to="/accounts" className="action" style={{ marginRight: "0.75rem" }}>
              ← back
            </Link>
            {currency} ·{" "}
            {account.data.owner ? "owned" : `shared · ${account.data.permission ?? "view"}`}
          </div>
        </div>
        {canEdit && (
          <div className="actions">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setDrawerFocus(undefined);
                setDrawerOpen(true);
              }}
            >
              ⚙ settings
            </button>
          </div>
        )}
      </div>

      {plan.data && (
        <RealityStrip plan={plan.data} canEdit={canEdit} onSaved={() => plan.refetch()} />
      )}

      {plan.data && (
        <PlanSummary
          plan={plan.data}
          onEditBuffer={
            canEdit
              ? () => {
                  setDrawerFocus("monthlyBuffer");
                  setDrawerOpen(true);
                }
              : undefined
          }
        />
      )}

      <div className="section-head">
        <h2>savings plan</h2>
        <span className="meta">[per-payment funding · priority asc]</span>
      </div>
      {plan.data && (
        <PlanTable
          plan={plan.data}
          canRecord={canEdit}
          onRecord={async (paymentId, amountMinor) => {
            await api.recordContribution(paymentId, { amountMinor });
            plan.refetch();
          }}
        />
      )}

      <div className="two-col">
        <div>
          <div className="section-head">
            <h2>income</h2>
            <span className="meta">[{incomes.data?.length ?? 0} active]</span>
            <span className="spacer" />
            {canEdit && (
              <button type="button" className="action" onClick={() => openIncome(id)}>
                + add income
              </button>
            )}
          </div>
          {incomes.data && incomes.data.length > 0 ? (
            <ul className="entity-list">
              {incomes.data.map((i) => (
                <li key={i.id}>
                  <span>
                    <span className="name">{i.name}</span>
                    <em>
                      — {formatMinor(i.amountMinor, currency)} / {i.frequency}
                    </em>
                  </span>
                  {canEdit && (
                    <span className="row-actions">
                      <button
                        type="button"
                        className="ghost tiny"
                        title="edit"
                        onClick={() => openEditIncome(i)}
                      >
                        edit
                      </button>
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={async () => {
                          await api.deleteIncome(i.id);
                          refresh();
                        }}
                      >
                        remove
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ fontSize: "12px" }}>
              no income yet.
              {canEdit && (
                <>
                  {" "}
                  <button type="button" className="action" onClick={() => openIncome(id)}>
                    add the first one →
                  </button>
                </>
              )}
            </p>
          )}
        </div>

        <div>
          <div className="section-head">
            <h2>payments</h2>
            <span className="meta">[{payments.data?.length ?? 0} active]</span>
            <span className="spacer" />
            {canEdit && (
              <button type="button" className="action" onClick={() => openPayment(id)}>
                + add payment
              </button>
            )}
          </div>
          {payments.data && payments.data.length > 0 ? (
            <ul className="entity-list">
              {payments.data
                .slice()
                .sort((a, b) => a.priority - b.priority)
                .map((p, idx, arr) => (
                  <li key={p.id}>
                    <span>
                      <span className="name">{p.name}</span>
                      <em>
                        — {formatMinor(p.amountMinor, currency)} ({p.category.replace(/_/g, " ")})
                      </em>
                      {p.projectId &&
                        (() => {
                          const proj = (projects.data ?? []).find((x) => x.id === p.projectId);
                          return proj ? (
                            <Link
                              to={`/projects/${proj.id}`}
                              className="shared"
                              title={`part of project: ${proj.name}`}
                              style={{ cursor: "pointer" }}
                            >
                              ▸ {proj.name}
                            </Link>
                          ) : null;
                        })()}
                    </span>
                    {canEdit && (
                      <span className="row-actions">
                        <button
                          type="button"
                          className="ghost tiny"
                          disabled={idx === 0}
                          title="higher priority"
                          onClick={async () => {
                            const ids = arr.map((x) => x.id);
                            [ids[idx - 1], ids[idx]] = [ids[idx]!, ids[idx - 1]!];
                            await api.reorderPayments(id, ids);
                            refresh();
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="ghost tiny"
                          disabled={idx === arr.length - 1}
                          title="lower priority"
                          onClick={async () => {
                            const ids = arr.map((x) => x.id);
                            [ids[idx], ids[idx + 1]] = [ids[idx + 1]!, ids[idx]!];
                            await api.reorderPayments(id, ids);
                            refresh();
                          }}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="ghost tiny"
                          title="edit"
                          onClick={() => openEditPayment(p)}
                        >
                          edit
                        </button>
                        <button
                          type="button"
                          className="ghost tiny"
                          onClick={async () => {
                            await api.deletePayment(p.id);
                            refresh();
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    )}
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted" style={{ fontSize: "12px" }}>
              no payments yet.
              {canEdit && (
                <>
                  {" "}
                  <button type="button" className="action" onClick={() => openPayment(id)}>
                    add the first one →
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      </div>

      <MonthScorecard
        closes={closes.data ?? []}
        currency={currency}
        month={currentMonth()}
        canClose={canEdit}
        onClose={async (month) => {
          await api.closeAccountMonth(id, month);
          closes.refetch();
        }}
        onReopen={async (closeId) => {
          await api.reopenAccountMonth(id, closeId);
          closes.refetch();
        }}
      />

      <AccountSettingsDrawer
        account={drawerOpen ? account.data : null}
        focusField={drawerFocus}
        onClose={() => {
          setDrawerOpen(false);
          setDrawerFocus(undefined);
        }}
        onSaved={() => {
          account.refetch();
          plan.refetch();
        }}
        onDeleted={() => navigate("/accounts")}
      />
    </section>
  );
}
