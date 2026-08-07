import { type FormEvent, useState } from "react";
import { api, ApiError } from "../lib/api.js";
import { formatMinor, money, type Phrase, toMinor } from "../lib/money.js";
import { DEFAULT_STALE_AFTER_DAYS } from "../lib/needsYou.js";
import type { AccountPlanDto } from "../lib/types.js";
import { Sentence } from "./Amount.js";

interface Props {
  plan: AccountPlanDto;
  /** View-only callers see the numbers but get no check-in control. */
  canEdit?: boolean;
  /** Called after a successful check-in so the page can refetch the plan. */
  onSaved?: () => void;
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `from` to `to`, both ISO date-only strings. The same three
 *  lines as `needsYou.ts`'s private helper, which is not exported. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / MS_PER_DAY);
}

/**
 * What the banner says, or `null` when there is nothing to say.
 *
 * ## Why this is not `reserved − balance`
 *
 * It used to be, and on Ben's account that printed *"balance is £222.94 short
 * of what the plan has set aside"* beside a screen that also said £46.39 was
 * arriving, £1,534.64 was left over, and both goals were on track. Every one of
 * those figures was arithmetically correct. The sentence was still wrong, and
 * it was wrong twice over:
 *
 * 1. **It ignored money on its way.** `reservedMinor` was compared against the
 *    balance alone, so an account whose incoming transfer covers it three times
 *    over was still called short. *Decision 27: "short" means the month cannot
 *    cover it* — the test is `reserved > balance + arriving`. `arriving` is
 *    `allocatedInflowMinor`, the same field the ARRIVING tile above prints, not
 *    a second derivation of it.
 *
 * 2. **It read a record as an event.** `reservedMinor` is `Σ alreadySavedMinor`
 *    (`apps/api/src/server.ts:208`) — the running total of what somebody has
 *    *recorded* putting aside, accumulated across every month the account has
 *    existed. The balance beside it is one observation on one day. Calling the
 *    difference a shortfall asserts that money arrived and left again. Nobody
 *    moved anything; the two numbers simply are not the same kind of fact.
 *
 * ## The residue is the point, and is never clamped
 *
 * Counting the arriving money does **not** make the gap vanish, and it is not
 * supposed to. On Ben's figures `234.64 − (11.70 + 46.39)` still leaves
 * £176.55 (*decision 26*). That residue is the question this screen has never
 * asked out loud — **money was recorded as saved into this account and the
 * account does not hold it** — so the sentence names it and names the two
 * things that can be done about it. Flooring it to zero would hide the only
 * genuinely new information here.
 *
 * ## A stale balance is the third explanation, and it wins
 *
 * `latestBalance.asOfDate` can be weeks old, and a balance nobody has confirmed
 * since last month is a cheaper explanation for a gap than missing money. **The
 * decision: the banner is entitled to fire on a stale balance — suppressing it
 * would hide a real discrepancy — but it is not entitled to call it a
 * shortfall.** It leads with the age instead and asks for the one action that
 * tells the two apart. "Stale" is {@link DEFAULT_STALE_AFTER_DAYS}, reused
 * rather than reinvented, so this banner, the needs-you checklist and the
 * accounts page's "stale N d" chip all draw the line in the same place.
 *
 * Staleness is measured against `plan.asOfDate` — the server's day, already on
 * the wire — not the browser's clock, so it is the same day the rest of the
 * plan was computed for.
 */
export function realityNote(plan: AccountPlanDto): Phrase | null {
  const latest = plan.latestBalance;
  // Never checked in: there is no observation to hold the record against, so
  // there is no disagreement to report. The check-in prompt is elsewhere.
  if (!latest) return null;

  const c = plan.currency;
  const reserved = plan.reservedMinor ?? 0;
  const arriving = plan.allocatedInflowMinor ?? 0;
  const unmet = reserved - (latest.balanceMinor + arriving);
  if (unmet <= 0) return null;

  const age = daysBetween(latest.asOfDate, plan.asOfDate);
  if (Number.isFinite(age) && age > DEFAULT_STALE_AFTER_DAYS) {
    return [
      `this balance was checked in ${age} days ago`,
      arriving > 0 ? ", and " : ". ",
      ...(arriving > 0 ? [money(arriving, c), " is still on its way. "] : []),
      money(unmet, c),
      " of what is recorded as saved here is unaccounted for beyond that — but a" +
        " balance that old is not evidence the money is gone. Check in a fresh one.",
    ];
  }

  return [
    ...(arriving > 0 ? [money(arriving, c), " is still on its way. Even after it lands, "] : []),
    money(unmet, c),
    " of what is recorded as saved here is not in the account — either it never" +
      " moved in, or the saved figures below are too high.",
  ];
}

/**
 * Plan vs. reality in one line: the last real balance, what the plan has
 * spoken for, and an inline way to check in a fresh balance. When the plan has
 * recorded more saved into the account than the account can account for, that
 * is said in words — see {@link realityNote}, which is where all the judgement
 * lives.
 */
export function RealityStrip({ plan, canEdit = false, onSaved }: Props) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const c = plan.currency;
  const latest = plan.latestBalance;
  const reserved = plan.reservedMinor ?? 0;
  const note = realityNote(plan);

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
      {note && (
        <p className="reality-banner" role="status">
          <Sentence phrase={note} />
        </p>
      )}
    </>
  );
}
