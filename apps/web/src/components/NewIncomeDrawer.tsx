import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { api, ApiError } from "../lib/api.js";
import { toMajor, toMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto, Frequency } from "../lib/types.js";
import { Drawer } from "./Drawer.js";

const NO_ACCOUNTS = Object.freeze([]) as readonly AccountDto[];

/**
 * Drawer for both creating a new income and editing an existing one. The mode
 * is decided by `state.editingIncome` from the QuickAdd context — when set,
 * the form pre-fills, the account is locked, and submit PATCHes instead of
 * POSTs.
 */
export function NewIncomeDrawer() {
  const { state, close, notifyCreated, notifyUpdated } = useQuickAdd();
  const open = state.kind === "income";
  const editing = state.editingIncome;
  const isEdit = !!editing;

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
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset / pre-fill whenever the drawer opens or target changes.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setAccountId(editing.accountId);
      setName(editing.name);
      setAmount(toMajor(editing.amountMinor).toFixed(2));
      setFrequency(editing.frequency);
      setAnchorDate(editing.anchorDate);
      setActive(editing.active);
    } else {
      setAccountId(state.accountId ?? "");
      setName("");
      setAmount("");
      setFrequency("monthly");
      setAnchorDate(new Date().toISOString().slice(0, 10));
      setActive(true);
    }
    setBusy(false);
    setErr(null);
  }, [open, state.accountId, editing]);

  const editable = useMemo(
    () => (accounts.data ?? []).filter((a) => a.owner || a.permission === "edit"),
    [accounts.data],
  );

  // Default to the first editable account on create.
  useEffect(() => {
    if (!open || accountId || isEdit) return;
    if (editable[0]) setAccountId(editable[0].id);
  }, [open, accountId, editable, isEdit]);

  if (!open) return null;

  async function submit(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    if (!accountId) return;
    setBusy(true);
    setErr(null);
    try {
      const body = {
        name: name.trim(),
        amountMinor: toMinor(amount),
        frequency,
        anchorDate,
        active,
      };
      if (editing) {
        await api.updateIncome(editing.id, body);
        notifyUpdated("income", accountId);
      } else {
        await api.createIncome(accountId, body);
        notifyCreated("income", accountId);
      }
      close();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not save income.");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !!accountId && !!name.trim() && !!amount && !busy;

  return (
    <Drawer
      open
      onClose={close}
      title={isEdit ? `edit income · ${editing!.name}` : "new income"}
      footer={
        <>
          <button type="button" className="ghost" onClick={close} disabled={busy}>
            cancel
          </button>
          <button type="button" onClick={() => submit()} disabled={!canSubmit}>
            {busy ? "saving…" : isEdit ? "save" : "add income"}
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
            disabled={accounts.loading || isEdit}
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
          {!accounts.loading && editable.length === 0 && !isEdit && (
            <span className="field-hint">
              no editable accounts. create one first via <code>new account</code>.
            </span>
          )}
          {isEdit && (
            <span className="field-hint">
              account is fixed once created; delete + recreate if you need to move this income.
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

        {isEdit && (
          <label
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: "0.55rem",
              marginTop: "0.25rem",
            }}
          >
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              style={{ width: "auto" }}
            />
            <span>active (uncheck to pause without deleting)</span>
          </label>
        )}

        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
      </form>
    </Drawer>
  );
}
