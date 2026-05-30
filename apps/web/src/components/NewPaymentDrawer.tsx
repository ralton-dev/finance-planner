import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { api, ApiError } from "../lib/api.js";
import { toMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto, PaymentCategory } from "../lib/types.js";
import { Drawer } from "./Drawer.js";

const NO_ACCOUNTS = Object.freeze([]) as readonly AccountDto[];
type Unit = "day" | "week" | "month" | "year";

export function NewPaymentDrawer() {
  const { state, close, notifyCreated } = useQuickAdd();
  const open = state.kind === "payment";

  const accounts = useAsync<AccountDto[]>(
    () => (open ? api.listAccounts() : Promise.resolve(NO_ACCOUNTS as AccountDto[])),
    [open],
  );

  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<PaymentCategory>("fixed_point");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [intervalN, setIntervalN] = useState("3");
  const [unit, setUnit] = useState<Unit>("month");
  const [alreadySaved, setAlreadySaved] = useState("0");
  const [priority, setPriority] = useState("100");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAccountId(state.accountId ?? "");
    setName("");
    setCategory("fixed_point");
    setAmount("");
    setDueDate(new Date().toISOString().slice(0, 10));
    setIntervalN("3");
    setUnit("month");
    setAlreadySaved("0");
    setPriority("100");
    setBusy(false);
    setErr(null);
  }, [open, state.accountId]);

  const editable = useMemo(
    () => (accounts.data ?? []).filter((a) => a.owner || a.permission === "edit"),
    [accounts.data],
  );

  useEffect(() => {
    if (!open || accountId) return;
    if (editable[0]) setAccountId(editable[0].id);
  }, [open, accountId, editable]);

  if (!open) return null;

  const needsDate = category !== "monthly_recurring";
  const isCustom = category === "custom_recurring";
  const canSubmit = !!accountId && !!name.trim() && !!amount && !busy;

  async function submit(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    if (!accountId) return;
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        category,
        amountMinor: toMinor(amount),
        alreadySavedMinor: toMinor(alreadySaved),
        priority: Number(priority),
      };
      if (needsDate) body.dueDate = dueDate;
      if (isCustom) body.recurrence = { interval: Number(intervalN), unit, anchor: dueDate };
      await api.createPayment(accountId, body);
      notifyCreated("payment", accountId);
      close();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not create payment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={close}
      title="new payment"
      footer={
        <>
          <button type="button" className="ghost" onClick={close} disabled={busy}>
            cancel
          </button>
          <button type="button" onClick={() => submit()} disabled={!canSubmit}>
            {busy ? "adding…" : "add payment"}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        <label>
          account
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            required
            disabled={accounts.loading}
          >
            <option value="" disabled>
              {accounts.loading ? "loading accounts…" : "select an account…"}
            </option>
            {editable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.currency}
              </option>
            ))}
          </select>
          {!accounts.loading && editable.length === 0 && (
            <span className="field-hint">
              no editable accounts. create one first via <code>new account</code>.
            </span>
          )}
        </label>

        <label>
          category
          <select value={category} onChange={(e) => setCategory(e.target.value as PaymentCategory)}>
            <option value="fixed_point">one-off goal (fixed date)</option>
            <option value="monthly_recurring">monthly bill</option>
            <option value="yearly_recurring">yearly</option>
            <option value="custom_recurring">custom recurring</option>
          </select>
        </label>

        <label>
          name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. holiday"
            required
          />
        </label>

        <label>
          amount
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            required
          />
        </label>

        {needsDate && (
          <label>
            due / target date
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              required
            />
          </label>
        )}

        {isCustom && (
          <label>
            recurrence
            <div className="inline-form" style={{ margin: 0 }}>
              <span className="muted">every</span>
              <input
                value={intervalN}
                onChange={(e) => setIntervalN(e.target.value)}
                inputMode="numeric"
                style={{ width: "4rem" }}
              />
              <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
                <option value="day">days</option>
                <option value="week">weeks</option>
                <option value="month">months</option>
                <option value="year">years</option>
              </select>
            </div>
          </label>
        )}

        <label>
          already saved
          <input
            value={alreadySaved}
            onChange={(e) => setAlreadySaved(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
          />
        </label>

        <label>
          priority
          <input
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            inputMode="numeric"
            style={{ width: "6rem" }}
          />
          <span className="field-hint">
            lower number = funded first when income runs short. defaults to 100.
          </span>
        </label>

        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
      </form>
    </Drawer>
  );
}
