import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AccountSettingsDrawer } from "../components/AccountSettingsDrawer.js";
import { PlanSummary, PlanTable } from "../components/PlanTable.js";
import { api } from "../lib/api.js";
import { formatMinor, toMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto, AccountPlanDto, IncomeDto, PaymentDto } from "../lib/types.js";

export function AccountPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const account = useAsync<AccountDto>(() => api.getAccount(id), [id]);
  const plan = useAsync<AccountPlanDto>(() => api.getPlan(id), [id]);
  const incomes = useAsync<IncomeDto[]>(() => api.listIncomes(id), [id]);
  const payments = useAsync<PaymentDto[]>(() => api.listPayments(id), [id]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerFocus, setDrawerFocus] = useState<"monthlyBuffer" | undefined>(undefined);

  const refresh = (): void => {
    plan.refetch();
    incomes.refetch();
    payments.refetch();
  };

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
      {plan.data && <PlanTable plan={plan.data} />}

      <div className="two-col">
        <div>
          <div className="section-head">
            <h2>income</h2>
            <span className="meta">[{incomes.data?.length ?? 0} active]</span>
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
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ fontSize: "12px" }}>
              no income yet.
            </p>
          )}
          <IncomeForm accountId={id} onAdded={refresh} />
        </div>

        <div>
          <div className="section-head">
            <h2>payments</h2>
            <span className="meta">[{payments.data?.length ?? 0} active]</span>
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
                    </span>
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
                        onClick={async () => {
                          await api.deletePayment(p.id);
                          refresh();
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted" style={{ fontSize: "12px" }}>
              no payments yet.
            </p>
          )}
          <PaymentForm accountId={id} onAdded={refresh} />
        </div>
      </div>

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

function IncomeForm({ accountId, onAdded }: { accountId: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [anchorDate, setAnchorDate] = useState(new Date().toISOString().slice(0, 10));

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    await api.createIncome(accountId, {
      name,
      amountMinor: toMinor(amount),
      frequency,
      anchorDate,
    });
    setName("");
    setAmount("");
    onAdded();
  }

  return (
    <form className="stack-form" onSubmit={submit}>
      <h3>add income</h3>
      <input
        placeholder="name (e.g. salary)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <input
        placeholder="amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        required
      />
      <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
        <option value="monthly">monthly</option>
        <option value="yearly">yearly</option>
        <option value="one_off">one-off</option>
      </select>
      <input type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} />
      <button type="submit">+ add income</button>
    </form>
  );
}

function PaymentForm({ accountId, onAdded }: { accountId: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("fixed_point");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(new Date().toISOString().slice(0, 10));
  const [interval, setInterval] = useState("3");
  const [unit, setUnit] = useState("month");
  const [alreadySaved, setAlreadySaved] = useState("0");

  const needsDate = category !== "monthly_recurring";
  const isCustom = category === "custom_recurring";

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const body: Record<string, unknown> = {
      name,
      category,
      amountMinor: toMinor(amount),
      alreadySavedMinor: toMinor(alreadySaved),
    };
    if (needsDate) body.dueDate = dueDate;
    if (isCustom) {
      body.recurrence = { interval: Number(interval), unit, anchor: dueDate };
    }
    await api.createPayment(accountId, body);
    setName("");
    setAmount("");
    onAdded();
  }

  return (
    <form className="stack-form" onSubmit={submit}>
      <h3>add payment</h3>
      <input
        placeholder="name (e.g. holiday)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <select value={category} onChange={(e) => setCategory(e.target.value)}>
        <option value="fixed_point">one-off goal (fixed date)</option>
        <option value="monthly_recurring">monthly bill</option>
        <option value="yearly_recurring">yearly</option>
        <option value="custom_recurring">custom recurring</option>
      </select>
      <input
        placeholder="amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        required
      />
      {needsDate && (
        <label>
          due / target date
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
      )}
      {isCustom && (
        <div className="inline-form">
          <span className="muted">every</span>
          <input
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            style={{ width: "4rem" }}
          />
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="day">days</option>
            <option value="week">weeks</option>
            <option value="month">months</option>
            <option value="year">years</option>
          </select>
        </div>
      )}
      <label>
        already saved
        <input value={alreadySaved} onChange={(e) => setAlreadySaved(e.target.value)} />
      </label>
      <button type="submit">+ add payment</button>
    </form>
  );
}
