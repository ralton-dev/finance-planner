import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api.js";
import { toMajor, toMinor } from "../lib/money.js";
import type { AccountDto, Frequency, InflowDto, Recurrence } from "../lib/types.js";
import { Drawer } from "./Drawer.js";

type Unit = Recurrence["unit"];

/** What an account-sourced inflow ranks as when nobody says. Mirrors the API's
 *  `DEFAULT_INFLOW_PRIORITY`, and `core.payments.priority` before it. */
const DEFAULT_PRIORITY = 100;

/**
 * WP-J's deliberate refusals, said in the app's own words.
 *
 * Each of these is a real case a person can reach, and each is loud on purpose
 * rather than silently corrected — so none of them may be swallowed here. The
 * form is built so the first three cannot ordinarily be sent at all (the picker
 * never offers this account, the ends are locked while editing, and a movement
 * always has a priority because it is always account-sourced); this is what is
 * said when one arrives anyway, from a stale tab or a second window.
 *
 * The 404 is the important one. An account you cannot see and an account that
 * does not exist answer *identically* at the API, deliberately, so that this
 * endpoint cannot be used to probe for other people's accounts. One status in,
 * one sentence out — this must not become the place that tells them apart.
 */
const REFUSALS: readonly (readonly [RegExp, string])[] = [
  [
    /sourced from the account it arrives in/i,
    "an account cannot send money to itself. pick a different account.",
  ],
  [
    /cannot be changed/i,
    "which two accounts a movement runs between cannot be changed — remove this movement and author a new one.",
  ],
  [
    // The API's rule is `inflow.source !== "account"` (`server.ts:1282`) — a
    // fact about where the money comes *from*, not about who owns the two ends.
    // This used to say "between your own accounts", which was wrong about
    // behaviour and not merely about words: a movement out of a co-member's
    // account you hold `edit` on is account-sourced like any other, its priority
    // ranks it among everything else leaving that account, and the hint below
    // the field says so correctly. Telling somebody the number is inert there
    // would have them leave a real ordering to chance.
    /priority is meaningful only/i,
    "priority only means something for money sourced from an account — an inflow from outside has no sending account to rank it against.",
  ],
];

/** A failed save, as a sentence to put in front of somebody. */
export function movementError(err: unknown): string {
  if (!(err instanceof ApiError)) return "could not save the movement.";
  if (err.status === 404) {
    return "that account is not available — it may have been deleted, or it may not be shared with you. pick another and try again.";
  }
  if (err.status === 403) {
    return "moving money between two accounts needs edit access to both of them.";
  }
  if (err.status === 422) {
    for (const [pattern, sentence] of REFUSALS) {
      if (pattern.test(err.message)) return sentence;
    }
    // A schema rejection arrives as a serialised ZodError, which is not a
    // sentence. Anything that reads like one is the API's own words and is
    // better than ours.
    if (/^[[{]/.test(err.message)) return "that movement was refused as invalid.";
  }
  return err.message || "could not save the movement.";
}

/** Which way the money runs, relative to the account whose page this is. */
export type MovementDirection = "in" | "out";

/** What the drawer is being opened for: a new movement in one direction, or an
 *  authored one to change. */
export interface MovementTarget {
  direction: MovementDirection;
  /** The row being changed. Absent when authoring a new one. */
  editing?: InflowDto;
}

interface MovementDrawerProps {
  /** The account whose page this is — one end of every movement here. */
  account: AccountDto;
  /** Every account the caller can see, for the picker and the names. */
  accounts: readonly AccountDto[];
  /** Null keeps the drawer shut. */
  target: MovementTarget | null;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Author, change or describe a movement between two accounts you can edit.
 *
 * Not "two accounts you own": the picker below offers anything you hold `edit`
 * on, so a co-member's account shared into your household with edit is a
 * legitimate end of a movement, and the cross-owner fixture is built on exactly
 * that. Ownership is not the gate here and never was — access is.
 *
 * The one screen for the capability WP-F through WP-J built and nothing could
 * reach: "move £400 a month from my current account into bills". It is one
 * authored row read from both ends, so the same drawer serves the receiving
 * account ("money arriving here, out of…") and the sending one ("money leaving
 * here, into…"); only which end the POST is addressed to differs.
 *
 * **The picker offers only accounts the caller can edit**, because authoring a
 * movement commits the *sending* account's surplus from that moment on — every
 * month, whether or not its owner ever looks. A view grant says you may see my
 * money; it must not quietly also say you may spend it. Deleting is looser and
 * lives on the list, not here: releasing a claim can harm neither end.
 *
 * The two ends are locked while editing. Re-pointing one is not a change to
 * this movement, it is authoring a different one against an account the request
 * never names — the API refuses it outright, and the form says so rather than
 * letting somebody try.
 */
export function MovementDrawer({
  account,
  accounts,
  target,
  onClose,
  onSaved,
}: MovementDrawerProps) {
  const editing = target?.editing;
  const isEdit = !!editing;
  // While editing, the direction is a fact about the row, not a choice.
  const direction: MovementDirection = editing
    ? editing.accountId === account.id
      ? "in"
      : "out"
    : (target?.direction ?? "in");

  const [otherId, setOtherId] = useState("");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("monthly");
  const [intervalN, setIntervalN] = useState("3");
  const [unit, setUnit] = useState<Unit>("month");
  const [anchorDate, setAnchorDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [priority, setPriority] = useState(String(DEFAULT_PRIORITY));
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /**
   * The accounts a movement may be authored against: ones the caller can edit,
   * never this account itself, and only ones holding the same currency.
   *
   * The engine moves minor units and converts nothing, and the overview nets
   * intra-estate movement inside one currency bucket — so a movement across two
   * currencies would leave one bucket short and the other long by the same
   * figure with no rate anywhere to explain it. The API does not refuse it; this
   * is the UI declining to offer a thing the arithmetic cannot honour.
   */
  const editable = useMemo(
    () =>
      accounts.filter(
        (a) =>
          a.id !== account.id &&
          a.currency === account.currency &&
          (a.owner || a.permission === "edit"),
      ),
    [accounts, account.id, account.currency],
  );

  // Reset / pre-fill whenever the drawer opens or its target changes.
  useEffect(() => {
    if (!target) return;
    if (editing) {
      setOtherId(
        (editing.accountId === account.id ? editing.sourceAccountId : editing.accountId) ?? "",
      );
      setName(editing.name);
      setAmount(toMajor(editing.amountMinor).toFixed(2));
      setFrequency(editing.frequency);
      setIntervalN(String(editing.recurrence?.interval ?? 3));
      setUnit(editing.recurrence?.unit ?? "month");
      setAnchorDate(editing.anchorDate);
      setPriority(String(editing.priority));
      setActive(editing.active);
    } else {
      setOtherId(editable[0]?.id ?? "");
      setName("");
      setAmount("");
      setFrequency("monthly");
      setIntervalN("3");
      setUnit("month");
      setAnchorDate(new Date().toISOString().slice(0, 10));
      setPriority(String(DEFAULT_PRIORITY));
      setActive(true);
    }
    setBusy(false);
    setErr(null);
    // Deliberately not keyed on `editable`: it is derived from the account list
    // and re-runs on every refetch of it, which would wipe what somebody had
    // typed. The picker's default is filled in by the effect below instead,
    // which only ever fills a blank.
  }, [target, editing, account.id]);

  // The account list may not have arrived when the drawer opened. Same rule as
  // the income drawer's: default to the first account a movement may run to.
  useEffect(() => {
    if (!target || otherId || isEdit) return;
    if (editable[0]) setOtherId(editable[0].id);
  }, [target, otherId, isEdit, editable]);

  if (!target) return null;

  const other = accounts.find((a) => a.id === otherId) ?? null;
  const fromName = direction === "in" ? (other?.name ?? "another account") : account.name;
  const toName = direction === "in" ? account.name : (other?.name ?? "another account");
  const isCustom = frequency === "custom";

  async function submit(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    if (!otherId) return;
    setBusy(true);
    setErr(null);
    try {
      const body = {
        name: name.trim(),
        amountMinor: toMinor(amount),
        frequency,
        // Always sent: a non-null value for a custom cadence, null otherwise, so
        // an edit away from custom clears the stale row rather than keeping it.
        recurrence: isCustom ? { interval: Number(intervalN), unit, anchor: anchorDate } : null,
        anchorDate,
        // Always safe to send: this drawer only ever authors `source: "account"`,
        // which is the only kind of inflow a priority means anything on.
        priority: Number(priority),
        active,
      };
      if (editing) {
        // Deliberately without `accountId` / `source` / `sourceAccountId`: the
        // ends are not editable, and sending them is a 422 rather than a no-op.
        await api.updateInflow(editing.id, body);
      } else if (direction === "in") {
        await api.createInflow(account.id, {
          ...body,
          source: "account",
          sourceAccountId: otherId,
        });
      } else {
        // Authored on the account the money arrives in, whichever end asked.
        await api.createInflow(otherId, {
          ...body,
          source: "account",
          sourceAccountId: account.id,
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr(movementError(e));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !!otherId && !!name.trim() && !!amount && !busy;

  return (
    <Drawer
      open
      onClose={onClose}
      title={
        isEdit
          ? `edit movement · ${editing!.name}`
          : direction === "in"
            ? `money into ${account.name}`
            : `money out of ${account.name}`
      }
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            cancel
          </button>
          <button type="button" onClick={() => submit()} disabled={!canSubmit}>
            {busy ? "saving…" : isEdit ? "save" : "add movement"}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        {/* One row, two faces. Saying which way it runs in words costs a line
            and saves reading the two selects against each other. */}
        <p className="movement-flow">
          <span className="name">{fromName}</span> → <span className="name">{toName}</span>
        </p>

        <label>
          {direction === "in" ? "money comes from" : "money goes to"}
          <select
            value={otherId}
            onChange={(e) => setOtherId(e.target.value)}
            required
            disabled={isEdit}
          >
            <option value="" disabled>
              {isEdit ? "another account" : "select an account…"}
            </option>
            {isEdit && other && !editable.some((a) => a.id === other.id) && (
              <option value={other.id}>
                {other.name} · {other.currency}
              </option>
            )}
            {isEdit && !other && otherId !== "" && <option value={otherId}>another account</option>}
            {editable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.currency}
              </option>
            ))}
          </select>
          {isEdit ? (
            <span className="field-hint">
              which two accounts a movement runs between cannot be changed — remove it and author a
              new one.
            </span>
          ) : editable.length === 0 ? (
            <span className="field-hint">
              no other {account.currency} account you can edit. a movement commits the sending
              account's money every month, so it takes edit access at both ends.
            </span>
          ) : (
            <span className="field-hint">
              only {account.currency} accounts you can edit are listed: a movement commits the
              sending account's surplus every month from now on, so authoring one takes edit access
              at both ends. removing one takes edit at either end.
            </span>
          )}
        </label>

        <label>
          name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. monthly sweep to bills"
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
            <option value="custom">custom</option>
            <option value="one_off">one-off</option>
          </select>
        </label>

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
          anchor date
          <input
            type="date"
            value={anchorDate}
            onChange={(e) => setAnchorDate(e.target.value)}
            required
          />
          <span className="field-hint">first / next occurrence date.</span>
        </label>

        <label>
          priority
          <input
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            inputMode="numeric"
            required
          />
          <span className="field-hint">
            rank among everything else leaving {fromName}, lower first. every bill on that account
            is funded before any of this, whatever the number says.
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
