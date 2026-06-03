import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { api, ApiError } from "../lib/api.js";
import { toMajor, toMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto, PaymentCategory, PaymentScope, ProjectDto } from "../lib/types.js";
import { Drawer } from "./Drawer.js";

const NO_ACCOUNTS = Object.freeze([]) as readonly AccountDto[];
const NO_PROJECTS = Object.freeze([]) as readonly ProjectDto[];
type Unit = "day" | "week" | "month" | "year";

/**
 * Drawer for both creating a new payment and editing an existing one. Mode is
 * decided by `state.editingPayment` from the QuickAdd context — when set, the
 * form pre-fills, the account + category are locked, and submit PATCHes
 * instead of POSTs.
 *
 * Category is locked in edit mode because changing it would invalidate the
 * recurrence semantics; delete + recreate if you really need to change type.
 */
export function NewPaymentDrawer() {
  const { state, close, notifyCreated, notifyUpdated } = useQuickAdd();
  const open = state.kind === "payment";
  const editing = state.editingPayment;
  const isEdit = !!editing;

  const accounts = useAsync<AccountDto[]>(
    () => (open ? api.listAccounts() : Promise.resolve(NO_ACCOUNTS as AccountDto[])),
    [open],
  );
  const projects = useAsync<ProjectDto[]>(
    () => (open ? api.listProjects() : Promise.resolve(NO_PROJECTS as ProjectDto[])),
    [open],
  );

  const [accountId, setAccountId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<PaymentCategory>("fixed_point");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [intervalN, setIntervalN] = useState("3");
  const [unit, setUnit] = useState<Unit>("month");
  const [alreadySaved, setAlreadySaved] = useState("0");
  const [priority, setPriority] = useState("100");
  const [scope, setScope] = useState<PaymentScope>("shared");
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setAccountId(editing.accountId);
      setProjectId(editing.projectId ?? "");
      setName(editing.name);
      setCategory(editing.category);
      setAmount(toMajor(editing.amountMinor).toFixed(2));
      setDueDate(editing.dueDate ?? new Date().toISOString().slice(0, 10));
      setIntervalN(String(editing.recurrence?.interval ?? 3));
      setUnit((editing.recurrence?.unit as Unit) ?? "month");
      setAlreadySaved(toMajor(editing.alreadySavedMinor).toFixed(2));
      setPriority(String(editing.priority));
      setScope(editing.scope ?? "shared");
      setActive(editing.active);
    } else {
      setAccountId(state.accountId ?? "");
      setProjectId("");
      setName("");
      setCategory("fixed_point");
      setAmount("");
      setDueDate(new Date().toISOString().slice(0, 10));
      setIntervalN("3");
      setUnit("month");
      setAlreadySaved("0");
      setPriority("100");
      setScope("shared");
      setActive(true);
    }
    setBusy(false);
    setErr(null);
  }, [open, state.accountId, editing]);

  const editable = useMemo(
    () => (accounts.data ?? []).filter((a) => a.owner || a.permission === "edit"),
    [accounts.data],
  );

  useEffect(() => {
    if (!open || accountId || isEdit) return;
    if (editable[0]) setAccountId(editable[0].id);
  }, [open, accountId, editable, isEdit]);

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
      // Always send recurrence: a non-null value for custom; null otherwise so
      // edits between categories clear stale recurrence rows.
      body.recurrence = isCustom ? { interval: Number(intervalN), unit, anchor: dueDate } : null;
      body.projectId = projectId || null;
      body.scope = scope;
      if (editing) {
        body.active = active;
        body.accountId = accountId; // may move the payment to a different account
        await api.updatePayment(editing.id, body);
        // Refresh the page the edit came from (the source account) so a moved
        // payment drops off it; destination + overview reload on next view.
        notifyUpdated("payment", editing.accountId);
      } else {
        await api.createPayment(accountId, body);
        notifyCreated("payment", accountId);
      }
      close();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "could not save payment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={close}
      title={isEdit ? `edit payment · ${editing!.name}` : "new payment"}
      footer={
        <>
          <button type="button" className="ghost" onClick={close} disabled={busy}>
            cancel
          </button>
          <button type="button" onClick={() => submit()} disabled={!canSubmit}>
            {busy ? "saving…" : isEdit ? "save" : "add payment"}
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
          {!accounts.loading && editable.length === 0 && !isEdit && (
            <span className="field-hint">
              no editable accounts. create one first via <code>new account</code>.
            </span>
          )}
          {isEdit && (
            <span className="field-hint">
              changing this moves the payment to another account — and into that account's household
              plan. you need edit access to both.
            </span>
          )}
        </label>

        <label>
          category
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as PaymentCategory)}
            disabled={isEdit}
          >
            <option value="fixed_point">one-off goal (fixed date)</option>
            <option value="monthly_recurring">monthly bill</option>
            <option value="yearly_recurring">yearly</option>
            <option value="custom_recurring">custom recurring</option>
          </select>
          {isEdit && (
            <span className="field-hint">
              category is locked once created (changing would invalidate recurrence).
            </span>
          )}
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
          project (optional)
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={projects.loading}
          >
            <option value="">— none —</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="field-hint">group this payment with others toward a shared goal.</span>
        </label>

        <label>
          cost split
          <select value={scope} onChange={(e) => setScope(e.target.value as PaymentScope)}>
            <option value="shared">shared — split by household share</option>
            <option value="personal">personal — borne by one person</option>
          </select>
          <span className="field-hint">
            in the household plan, shared costs are split by contribution share; personal costs fall
            entirely to one member.
          </span>
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
