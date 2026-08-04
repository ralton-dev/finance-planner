import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useQuickAdd } from "../contexts/QuickAddContext.js";
import { api, ApiError } from "../lib/api.js";
import { toMajor, toMinor } from "../lib/money.js";
import { summarizePreview, type PreviewImpact } from "../lib/planPreview.js";
import { useAsync } from "../lib/useAsync.js";
import type {
  AccountDto,
  PaymentCategory,
  PaymentDto,
  PaymentScope,
  ProjectDto,
} from "../lib/types.js";
import { Drawer } from "./Drawer.js";
import { PreviewStrip } from "./PreviewStrip.js";

const NO_ACCOUNTS = Object.freeze([]) as readonly AccountDto[];
const NO_PROJECTS = Object.freeze([]) as readonly ProjectDto[];
const NO_PAYMENTS = Object.freeze([]) as readonly PaymentDto[];
type Unit = "day" | "week" | "month" | "year";
/** How a one-off goal is expressed: by the date it must be met, or by the pace
 *  the user is willing to save at. The server accepts either. */
type GoalMode = "date" | "monthly";

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
  const [goalMode, setGoalMode] = useState<GoalMode>("date");
  const [monthlyAmount, setMonthlyAmount] = useState("");
  const [showTargetDate, setShowTargetDate] = useState(false);
  const [tag, setTag] = useState("");
  const [intervalN, setIntervalN] = useState("3");
  const [unit, setUnit] = useState<Unit>("month");
  const [alreadySaved, setAlreadySaved] = useState("0");
  const [priority, setPriority] = useState("100");
  const [scope, setScope] = useState<PaymentScope>("shared");
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewImpact | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  // Existing payments on the chosen account, purely for the tag suggestions —
  // tags are free text, and the useful ones are the ones already in use.
  const payments = useAsync<PaymentDto[]>(
    () =>
      open && accountId
        ? api.listPayments(accountId)
        : Promise.resolve(NO_PAYMENTS as PaymentDto[]),
    [open, accountId],
  );

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setAccountId(editing.accountId);
      setProjectId(editing.projectId ?? "");
      setName(editing.name);
      setCategory(editing.category);
      setAmount(toMajor(editing.amountMinor).toFixed(2));
      setDueDate(editing.dueDate ?? new Date().toISOString().slice(0, 10));
      // A goal with a monthly cap opens the way it was written.
      setGoalMode(editing.fixedMonthlyMinor ? "monthly" : "date");
      setMonthlyAmount(
        editing.fixedMonthlyMinor ? toMajor(editing.fixedMonthlyMinor).toFixed(2) : "",
      );
      setShowTargetDate(!!editing.fixedMonthlyMinor && !!editing.dueDate);
      setTag(editing.tag ?? "");
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
      setGoalMode("date");
      setMonthlyAmount("");
      setShowTargetDate(false);
      setTag("");
      setIntervalN("3");
      setUnit("month");
      setAlreadySaved("0");
      setPriority("100");
      setScope("shared");
      setActive(true);
    }
    setBusy(false);
    setErr(null);
    setPreview(null);
    setPreviewErr(null);
  }, [open, state.accountId, editing]);

  const editable = useMemo(
    () => (accounts.data ?? []).filter((a) => a.owner || a.permission === "edit"),
    [accounts.data],
  );

  const tagSuggestions = useMemo(() => {
    const seen = new Set<string>();
    for (const p of payments.data ?? []) {
      const t = (p.tag ?? "").trim();
      if (t) seen.add(t);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [payments.data]);

  useEffect(() => {
    if (!open || accountId || isEdit) return;
    if (editable[0]) setAccountId(editable[0].id);
  }, [open, accountId, editable, isEdit]);

  // A preview describes one exact draft. The moment any of it changes the strip
  // is stale, so it goes rather than quietly lying.
  useEffect(() => {
    setPreview(null);
    setPreviewErr(null);
  }, [
    accountId,
    name,
    category,
    amount,
    dueDate,
    goalMode,
    monthlyAmount,
    showTargetDate,
    tag,
    intervalN,
    unit,
    alreadySaved,
    priority,
    scope,
    projectId,
  ]);

  if (!open) return null;

  const isGoal = category === "fixed_point";
  const isCustom = category === "custom_recurring";
  const monthlyMinor = toMinor(monthlyAmount);
  // A dated goal (or any recurring payment bar a monthly bill) needs its date;
  // a paced goal only carries one when the user asks for it.
  const dateRequired = isGoal ? goalMode === "date" : category !== "monthly_recurring";
  const paceDateOptional = isGoal && goalMode === "monthly" && showTargetDate;
  const dateVisible = dateRequired || paceDateOptional;
  // Mirrors the server: a fixed_point payment needs a due date OR a monthly cap.
  const goalReady = !isGoal || (goalMode === "date" ? !!dueDate : monthlyMinor > 0);
  const canSubmit = !!accountId && !!name.trim() && !!amount && goalReady && !busy;

  function buildBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      name: name.trim(),
      category,
      amountMinor: toMinor(amount),
      alreadySavedMinor: toMinor(alreadySaved),
      priority: Number(priority),
    };
    if (dateVisible) body.dueDate = dueDate;
    // A paced goal with the date disclosure closed must actively clear any date
    // the payment used to carry, or an edit would silently keep the old one.
    else if (isGoal) body.dueDate = null;
    // Always send recurrence: a non-null value for custom; null otherwise so
    // edits between categories clear stale recurrence rows.
    body.recurrence = isCustom ? { interval: Number(intervalN), unit, anchor: dueDate } : null;
    // Same reasoning: the cap only means anything on a paced goal, and moving
    // off that mode has to unset it.
    body.fixedMonthlyMinor = isGoal && goalMode === "monthly" ? monthlyMinor : null;
    body.tag = tag.trim() || null;
    body.projectId = projectId || null;
    body.scope = scope;
    return body;
  }

  async function submit(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    if (!accountId) return;
    setBusy(true);
    setErr(null);
    try {
      const body = buildBody();
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

  /** Manual only — never on keystroke. One click, one round trip, one answer. */
  async function runPreview(): Promise<void> {
    if (!accountId) return;
    setPreviewBusy(true);
    setPreviewErr(null);
    try {
      const res = await api.previewPlan(accountId, { addPayments: [buildBody()] });
      setPreview(summarizePreview(res.base, res.preview));
    } catch (e) {
      setPreviewErr(e instanceof ApiError ? e.message : "could not preview the plan.");
    } finally {
      setPreviewBusy(false);
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

        {isGoal && (
          <div className="field">
            <span className="field-label">how you'll get there</span>
            <div className="mode-switch" role="group" aria-label="goal type">
              <button
                type="button"
                className={`ghost tiny${goalMode === "date" ? " active" : ""}`}
                aria-pressed={goalMode === "date"}
                onClick={() => setGoalMode("date")}
              >
                by date
              </button>
              <button
                type="button"
                className={`ghost tiny${goalMode === "monthly" ? " active" : ""}`}
                aria-pressed={goalMode === "monthly"}
                onClick={() => setGoalMode("monthly")}
              >
                fixed monthly
              </button>
            </div>
            <span className="field-hint">
              {goalMode === "date"
                ? "save whatever it takes to hit the date."
                : "set aside the same amount each month — the finish date follows the pace."}
            </span>
          </div>
        )}

        {isGoal && goalMode === "monthly" && (
          <label>
            amount / month
            <input
              value={monthlyAmount}
              onChange={(e) => setMonthlyAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              required
            />
            <span className="field-hint">what you'll put aside toward this every month.</span>
          </label>
        )}

        {dateVisible && (
          <label>
            {paceDateOptional ? "target date (optional)" : "due / target date"}
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              required={dateRequired}
            />
            {paceDateOptional && (
              <span className="field-hint">
                a date to aim at as well —{" "}
                <button type="button" className="action" onClick={() => setShowTargetDate(false)}>
                  drop it
                </button>
              </span>
            )}
          </label>
        )}

        {isGoal && goalMode === "monthly" && !showTargetDate && (
          <p className="field-hint" style={{ marginBottom: "0.65rem" }}>
            <button type="button" className="action" onClick={() => setShowTargetDate(true)}>
              + also set a target date
            </button>
          </p>
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
          tag (optional)
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            list="payment-tag-suggestions"
            placeholder="e.g. housing"
            maxLength={40}
          />
          <datalist id="payment-tag-suggestions">
            {tagSuggestions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <span className="field-hint">groups payments in the charts. free text; reuse yours.</span>
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

        {/* What-if, on demand. Editing is left out on purpose: the overlay adds
            a payment on top of the account as it stands, so previewing an edit
            would count the existing one twice. */}
        {!isEdit && (
          <div className="preview-block">
            <button
              type="button"
              className="ghost tiny"
              disabled={!canSubmit || previewBusy}
              onClick={() => void runPreview()}
            >
              {previewBusy ? "checking…" : "preview impact"}
            </button>
            <span className="field-hint">
              what this does to the plan — nothing is saved until you add it.
            </span>
            {previewErr && (
              <p className="error" role="alert">
                {previewErr}
              </p>
            )}
            {preview && <PreviewStrip impact={preview} />}
          </div>
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
