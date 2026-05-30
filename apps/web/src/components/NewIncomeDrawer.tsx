import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { api, ApiError } from "../lib/api.js";
import { toMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto, Frequency } from "../lib/types.js";
import { Drawer } from "./Drawer.js";

const NO_ACCOUNTS = Object.freeze([]) as readonly AccountDto[];

export function NewIncomeDrawer() {
  const { state, close, notifyCreated } = useQuickAdd();
  const open = state.kind === "income";

  // Only fetch when the drawer is open so we always see fresh accounts.
  const accounts = useAsync<AccountDto[]>(
    () => (open ? api.listAccounts() : Promise.resolve(NO_ACCOUNTS as AccountDto[])),
    [open],
  );

  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("monthly");
  const [anchorDate, setAnchorDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset form whenever the drawer opens.
  useEffect(() => {
    if (!open) return;
    setAccountId(state.accountId ?? "");
    setName("");
    setAmount("");
    setFrequency("monthly");
    setAnchorDate(new Date().toISOString().slice(0, 10));
    setBusy(false);
    setErr(null);
  }, [open, state.accountId]);

  const editable = useMemo(
    () => (accounts.data ?? []).filter((a) => a.owner || a.permission === "edit"),
    [accounts.data],
  );

  // Default to the first editable account once they load.
  useEffect(() => {
    if (!open || accountId) return;
    if (editable[0]) setAccountId(editable[0].id);
  }, [open, accountId, editable]);

  if (!open) return null;

  async function submit(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    if (!accountId) return;
    setBusy(true);
    setErr(null);
    try {
      await api.createIncome(accountId, {
        name: name.trim(),
        amountMinor: toMinor(amount),
        frequency,
        anchorDate,
      });
      notifyCreated("income", accountId);
      close();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not create income.");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !!accountId && !!name.trim() && !!amount && !busy;

  return (
    <Drawer
      open
      onClose={close}
      title="new income"
      footer={
        <>
          <button type="button" className="ghost" onClick={close} disabled={busy}>
            cancel
          </button>
          <button type="button" onClick={() => submit()} disabled={!canSubmit}>
            {busy ? "adding…" : "add income"}
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
          name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. salary"
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

        <label>
          frequency
          <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
            <option value="monthly">monthly</option>
            <option value="yearly">yearly</option>
            <option value="one_off">one-off</option>
          </select>
        </label>

        <label>
          anchor date
          <input
            type="date"
            value={anchorDate}
            onChange={(e) => setAnchorDate(e.target.value)}
            required
          />
          <span className="field-hint">first / next occurrence date.</span>
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
