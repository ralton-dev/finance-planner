import { type FormEvent, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { formatMinor, toMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto, AccountPlanDto, IncomeDto, PaymentDto } from "../lib/types.js";
import { PlanSummary, PlanTable } from "../components/PlanTable.js";

export function AccountPage() {
  const { id = "" } = useParams();
  const account = useAsync<AccountDto>(() => api.getAccount(id), [id]);
  const plan = useAsync<AccountPlanDto>(() => api.getPlan(id), [id]);
  const incomes = useAsync<IncomeDto[]>(() => api.listIncomes(id), [id]);
  const payments = useAsync<PaymentDto[]>(() => api.listPayments(id), [id]);

  const refresh = () => {
    plan.refetch();
    incomes.refetch();
    payments.refetch();
  };

  if (account.error) return <p className="error">Account not found.</p>;
  if (account.loading || !account.data) return <p>Loading…</p>;
  const currency = account.data.currency;

  return (
    <section>
      <h1>{account.data.name}</h1>
      {plan.data && <PlanSummary plan={plan.data} />}

      <h2>Savings plan</h2>
      {plan.data && <PlanTable plan={plan.data} />}

      <div className="two-col">
        <div>
          <h2>Income</h2>
          <ul className="entity-list">
            {incomes.data?.map((i) => (
              <li key={i.id}>
                <span>
                  {i.name} — {formatMinor(i.amountMinor, currency)} / {i.frequency}
                </span>
                <button
                  onClick={async () => {
                    await api.deleteIncome(i.id);
                    refresh();
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <IncomeForm accountId={id} onAdded={refresh} />
        </div>

        <div>
          <h2>Payments</h2>
          <ul className="entity-list">
            {payments.data
              ?.slice()
              .sort((a, b) => a.priority - b.priority)
              .map((p, idx, arr) => (
                <li key={p.id}>
                  <span>
                    {p.name} — {formatMinor(p.amountMinor, currency)}
                    <em className="muted"> ({p.category.replace(/_/g, " ")})</em>
                  </span>
                  <span className="row-actions">
                    <button
                      disabled={idx === 0}
                      title="Higher priority"
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
                      disabled={idx === arr.length - 1}
                      title="Lower priority"
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
                      onClick={async () => {
                        await api.deletePayment(p.id);
                        refresh();
                      }}
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
          </ul>
          <PaymentForm accountId={id} onAdded={refresh} />
        </div>
      </div>
    </section>
  );
}

function IncomeForm({ accountId, onAdded }: { accountId: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [anchorDate, setAnchorDate] = useState("2026-01-01");

  async function submit(e: FormEvent) {
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
      <h3>Add income</h3>
      <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
      <input
        placeholder="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        required
      />
      <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
        <option value="one_off">One-off</option>
      </select>
      <input type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} />
      <button type="submit">Add income</button>
    </form>
  );
}

function PaymentForm({ accountId, onAdded }: { accountId: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("fixed_point");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("2026-06-01");
  const [interval, setInterval] = useState("3");
  const [unit, setUnit] = useState("month");
  const [alreadySaved, setAlreadySaved] = useState("0");

  const needsDate = category !== "monthly_recurring";
  const isCustom = category === "custom_recurring";

  async function submit(e: FormEvent) {
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
      <h3>Add payment</h3>
      <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
      <select value={category} onChange={(e) => setCategory(e.target.value)}>
        <option value="fixed_point">One-off goal (fixed date)</option>
        <option value="monthly_recurring">Monthly bill</option>
        <option value="yearly_recurring">Yearly</option>
        <option value="custom_recurring">Custom recurring</option>
      </select>
      <input
        placeholder="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        required
      />
      {needsDate && (
        <label>
          Due / target date
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
      )}
      {isCustom && (
        <div className="inline-form">
          <span>Every</span>
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
        Already saved
        <input value={alreadySaved} onChange={(e) => setAlreadySaved(e.target.value)} />
      </label>
      <button type="submit">Add payment</button>
    </form>
  );
}
