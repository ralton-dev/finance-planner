import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api.js";
import { toMajor, toMinor } from "../lib/money.js";
import {
  deriveHeadline,
  deriveNeedsYou,
  needsYouCountLabel,
  type NeedsYouInput,
  type NeedsYouItem,
  type NeedsYouKind,
} from "../lib/needsYou.js";
import { Amount } from "./Amount.js";

/**
 * The top of a planning screen: the one number the month turns on, and the
 * list of things still waiting on a human — each with the button that deals
 * with it, so the answer to "what do I do now" is never two screens away.
 *
 * The list itself is derived by `lib/needsYou`, which owns the wording, the
 * priority order and the endpoint each row maps onto. This component only
 * renders it and calls the API: a row is ticked the moment it is actioned,
 * the page refetches behind it, and a rejection puts the row back with the
 * API's error code against it.
 */

/** What undoes an action, for the ones that can be undone. */
type Undo = () => Promise<unknown>;

/** A row already dealt with: ticked here until the refetch drops it from the
 *  derivation, and kept afterwards so its undo stays reachable. */
interface Settled {
  item: NeedsYouItem;
  undo?: Undo;
}

/** The chip that says what kind of thing a row is. */
const KIND_LABEL: Record<NeedsYouKind, string> = {
  shortfall: "shortfall",
  transfer: "transfer",
  record: "record",
  checkin: "check-in",
};

interface Props {
  /**
   * Exactly what `deriveNeedsYou` takes: one household on the plan page, every
   * household plus the standalone accounts on the Overview. The component
   * derives the headline and the list from it and holds no copy of either.
   */
  input: NeedsYouInput;
  /** Something the list derives from is still in flight. */
  loading?: boolean;
  /** Called after any action (or undo) succeeds, so the page can refetch. */
  onActioned?: () => void;
}

/**
 * The currency the headline is counted in. `deriveHeadline` sums in the first
 * currency it finds and words its sentence in it; the big figure matches.
 */
function headlineCurrency(input: NeedsYouInput): string {
  return input.households?.[0]?.plan.currency ?? input.accounts?.[0]?.plan.currency ?? "GBP";
}

export function Fold({ input, loading = false, onActioned }: Props) {
  const [settled, setSettled] = useState<Record<string, Settled>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** The row whose inline input is open, and what has been typed into it. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [amount, setAmount] = useState("");

  const items = deriveNeedsYou(input);
  // A ticked row leaves the outstanding list at once, before the refetch that
  // will drop it from the derivation — so the count, the headline's "N things
  // still waiting" and what is on screen never disagree, even for a moment.
  const outstanding = items.filter((item) => !settled[item.key]);
  const done = Object.values(settled);
  const headline = deriveHeadline(input, outstanding);

  function setError(key: string, message: string): void {
    setErrors((prev) => ({ ...prev, [key]: message }));
  }

  function forget(key: string): void {
    setSettled((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  /** Tick first, then call: a rejection puts the row back and says why. */
  async function run(item: NeedsYouItem, call: () => Promise<Undo | undefined>): Promise<void> {
    setBusyKey(item.key);
    setError(item.key, "");
    setSettled((prev) => ({ ...prev, [item.key]: { item } }));
    try {
      const undo = await call();
      setSettled((prev) => ({ ...prev, [item.key]: { item, undo } }));
      setOpenKey(null);
      setAmount("");
      onActioned?.();
    } catch (e) {
      forget(item.key);
      setError(item.key, e instanceof ApiError ? e.code : "something went wrong");
    } finally {
      setBusyKey(null);
    }
  }

  async function undoRow(key: string, call: Undo): Promise<void> {
    setBusyKey(key);
    setError(key, "");
    try {
      await call();
      forget(key);
      onActioned?.();
    } catch (e) {
      setError(key, e instanceof ApiError ? e.code : "something went wrong");
    } finally {
      setBusyKey(null);
    }
  }

  /** Each action descriptor onto the endpoint the app already has for it. */
  function act(item: NeedsYouItem): void {
    const action = item.action;
    if (!action) return;

    if (action.kind === "confirmTransfer") {
      void run(item, async () => {
        const result = await api.confirmTransfer(action.householdId, {
          fromAccountId: action.fromAccountId,
          toAccountId: action.toAccountId,
          memberUserId: action.memberUserId,
          month: action.month,
        });
        return () => api.unconfirmTransfer(action.householdId, result.confirmation.id);
      });
      return;
    }

    if (action.kind === "recordContribution") {
      const amountMinor = toMinor(amount);
      if (amountMinor <= 0) {
        setError(item.key, "amount must be greater than zero");
        return;
      }
      void run(item, async () => {
        await api.recordContribution(action.paymentId, { amountMinor, month: action.month });
        return undefined;
      });
      return;
    }

    // A balance may legitimately be zero or negative (an overdraft), so the
    // only thing worth refusing here is an empty box — the button guards that.
    void run(item, async () => {
      await api.setBalance(action.accountId, { balanceMinor: toMinor(amount) });
      return undefined;
    });
  }

  function open(item: NeedsYouItem): void {
    setOpenKey(item.key);
    setError(item.key, "");
    // A record row prefills what is still missing this month; a balance is
    // only ever the real figure, so there is nothing to guess at.
    setAmount(
      item.action?.kind === "recordContribution" ? toMajor(item.action.amountMinor).toFixed(2) : "",
    );
  }

  const hasRows = outstanding.length > 0 || done.length > 0;

  return (
    <div className="fold">
      <div className={`fold-headline ${headline.kind}`}>
        <div className="fold-label">
          {headline.kind === "shortfall" ? "shortfall" : "left over"}
        </div>
        <Amount
          minor={headline.amountMinor}
          currency={headlineCurrency(input)}
          className="fold-figure"
        />
        <p className="fold-sentence">{headline.sentence}</p>
      </div>

      <div className="section-head">
        <h2>needs you</h2>
        <span className="meta">{needsYouCountLabel(outstanding)}</span>
      </div>

      {loading && !hasRows && (
        <p className="muted" style={{ fontSize: "12px" }}>
          checking what needs you…
        </p>
      )}

      {hasRows && (
        <ul className="needs-you-list">
          {outstanding.map((item) => {
            const error = errors[item.key];
            const busy = busyKey === item.key;
            const isOpen = openKey === item.key;
            return (
              <li key={item.key} className="needs-you-row">
                <div className="needs-you-main">
                  <span className={`needs-you-kind ${item.kind}`}>{KIND_LABEL[item.kind]}</span>
                  <span className="name">{item.label}</span>
                  <span className="needs-you-figure">
                    {item.amountMinor === undefined ? (
                      <span className="dim">
                        {item.days === undefined ? "never" : `${item.days} d`}
                      </span>
                    ) : (
                      <Amount minor={item.amountMinor} currency={item.currency} />
                    )}
                  </span>
                  <span className="spacer" />
                  <span className="needs-you-do">
                    {item.action === undefined ? (
                      <Link to={item.href} className="action">
                        open →
                      </Link>
                    ) : item.action.kind === "confirmTransfer" ? (
                      <button
                        type="button"
                        className="ghost tiny"
                        disabled={busy}
                        onClick={() => act(item)}
                      >
                        {busy ? "…" : "mark done"}
                      </button>
                    ) : isOpen ? (
                      // RealityStrip's check-in control, reused verbatim: one
                      // box, one button, whatever the row is asking for.
                      <form
                        className="reality-update"
                        onSubmit={(e) => {
                          e.preventDefault();
                          act(item);
                        }}
                      >
                        <input
                          aria-label={item.label}
                          placeholder="0.00"
                          inputMode="decimal"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setOpenKey(null);
                          }}
                          disabled={busy}
                          autoFocus
                        />
                        <button
                          type="submit"
                          className="ghost tiny"
                          disabled={busy || amount.trim() === ""}
                        >
                          {busy ? "…" : "save"}
                        </button>
                        <button
                          type="button"
                          className="action muted"
                          disabled={busy}
                          onClick={() => setOpenKey(null)}
                        >
                          ✕
                        </button>
                      </form>
                    ) : (
                      <button type="button" className="action" onClick={() => open(item)}>
                        {item.action.kind === "recordContribution" ? "record" : "check in"}
                      </button>
                    )}
                  </span>
                </div>
                <div className="needs-you-meta">{item.meta}</div>
                {error && (
                  <p className="error needs-you-error" role="alert">
                    {error}
                  </p>
                )}
              </li>
            );
          })}

          {done.map(({ item, undo }) => {
            const error = errors[item.key];
            const busy = busyKey === item.key;
            return (
              <li key={item.key} className="needs-you-row done">
                <div className="needs-you-main">
                  <span className="tag-status ok">✓ done</span>
                  <span className="name">{item.label}</span>
                  <span className="spacer" />
                  {undo && (
                    <button
                      type="button"
                      className="action muted"
                      disabled={busy}
                      onClick={() => void undoRow(item.key, undo)}
                    >
                      undo
                    </button>
                  )}
                </div>
                {error && (
                  <p className="error needs-you-error" role="alert">
                    {error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
