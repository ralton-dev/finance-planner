import { type FormEvent, useState } from "react";
import { api, ApiError } from "../lib/api.js";
import { formatMinor, toMinor } from "../lib/money.js";
import type { AccountPlanDto } from "../lib/types.js";

interface Props {
  plan: AccountPlanDto;
  /** View-only callers see the numbers but get no check-in control. */
  canEdit?: boolean;
  /** Called after a successful check-in so the page can refetch the plan. */
  onSaved?: () => void;
}

/**
 * Plan vs. reality in one line: the last real balance, what the plan has
 * spoken for, and an inline way to check in a fresh balance. When the account
 * holds less than the plan reserved, the gap is called out — that is the whole
 * point of the loop.
 */
export function RealityStrip({ plan, canEdit = false, onSaved }: Props) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const c = plan.currency;
  const latest = plan.latestBalance;
  const reserved = plan.reservedMinor ?? 0;
  const shortMinor = latest ? reserved - latest.balanceMinor : 0;

  async function save(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.setBalance(plan.accountId, { balanceMinor: toMinor(amount) });
      setAmount("");
      onSaved?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "could not save balance");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="reality-strip">
        <span className="reality-item">
          {latest ? (
            <>
              balance <b className="amount">{formatMinor(latest.balanceMinor, c)}</b>
              <span className="dim"> · as of {latest.asOfDate}</span>
            </>
          ) : (
            <span className="muted">no balance recorded</span>
          )}
        </span>
        <span className="reality-item">
          reserved <b className="amount">{formatMinor(reserved, c)}</b>
        </span>
        <span className="spacer" />
        {canEdit && (
          <form className="reality-update" onSubmit={save}>
            <input
              aria-label="new balance"
              placeholder="0.00"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
            />
            <button type="submit" className="ghost tiny" disabled={busy || amount.trim() === ""}>
              {busy ? "saving…" : "check in"}
            </button>
          </form>
        )}
      </div>
      {err && (
        <p className="error" role="alert" style={{ fontSize: "12px" }}>
          {err}
        </p>
      )}
      {latest && shortMinor > 0 && (
        <p className="reality-banner" role="status">
          balance is <span className="amount">{formatMinor(shortMinor, c)}</span> short of what the
          plan has set aside
        </p>
      )}
    </>
  );
}
