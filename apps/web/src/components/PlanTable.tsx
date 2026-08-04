import { useState } from "react";
import { ApiError } from "../lib/api.js";
import { formatMinor, toMajor, toMinor } from "../lib/money.js";
import type { AccountPlanDto, PlanLineDto } from "../lib/types.js";

const CATEGORY_LABEL: Record<PlanLineDto["category"], string> = {
  monthly_recurring: "monthly",
  yearly_recurring: "yearly",
  custom_recurring: "recurring",
  fixed_point: "goal",
};

const MS_PER_DAY = 86_400_000;

/**
 * Is this goal paced rather than dated — "£200 a month until it's done" instead
 * of "£2,400 by March"?
 *
 * Only a `fixed_point` goal can carry a monthly contribution cap; the engine
 * ignores one anywhere else. The cap is what makes the goal paced, and that is
 * all this answers: a paced goal may still carry a deadline the user typed.
 * Whether the DUE date was *derived* is a separate question, and one the row
 * cannot work out for itself — see `dueDateIsDerived` on the line.
 */
export function isPacedGoal(line: PlanLineDto): boolean {
  return line.category === "fixed_point" && (line.fixedMonthlyMinor ?? 0) > 0;
}

/** "monthly" / "yearly" / "recurring", and goals by how they were set. */
function typeLabel(line: PlanLineDto): string {
  if (line.category !== "fixed_point") return CATEGORY_LABEL[line.category];
  return isPacedGoal(line) ? "goal · paced" : "goal · dated";
}

/**
 * Days from `asOfDate` to the next time a monthly bill lands, or null when
 * either date is unusable.
 *
 * A monthly recurring payment's `dueDate` is an anchor — the day of the month
 * the money leaves — so only its day matters, and the next occurrence is that
 * day this month or, once it has passed, next month. Clamped to the month's
 * length, so a bill anchored to the 31st lands on the 30th in a 30-day month.
 */
export function daysUntilNextMonthly(dueDate: string, asOfDate: string): number | null {
  const anchorDay = Number(dueDate.slice(8, 10));
  const year = Number(asOfDate.slice(0, 4));
  const month = Number(asOfDate.slice(5, 7));
  const asOf = Date.parse(`${asOfDate.slice(0, 10)}T00:00:00Z`);
  if (!anchorDay || !year || !month || !Number.isFinite(asOf)) return null;

  // This month, then next: one of the two always lands on or after the as-of date.
  for (const offset of [0, 1]) {
    const y = year + Math.floor((month - 1 + offset) / 12);
    const m = ((month - 1 + offset) % 12) + 1;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const next = Date.UTC(y, m - 1, Math.min(anchorDay, lastDay));
    if (next >= asOf) return Math.round((next - asOf) / MS_PER_DAY);
  }
  return null;
}

interface PlanTableProps {
  plan: AccountPlanDto;
  /** When true, non-monthly rows get a "record" action for setting money aside. */
  canRecord?: boolean;
  /** Called with the amount the user typed, in minor units. Rejections surface inline. */
  onRecord?: (paymentId: string, amountMinor: number) => Promise<unknown>;
  /** Today, as the caller reckons it. Monthly bills count down to their next
   *  payment from here; without it they say nothing rather than guess. */
  asOfDate?: string;
}

/**
 * The savings plan, with reality alongside it: what is already saved per
 * payment, what was recorded this month, and an inline way to record more.
 * Monthly recurring bills are excluded from recording — they are paid, not
 * saved for.
 */
export function PlanTable({ plan, canRecord = false, onRecord, asOfDate }: PlanTableProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (plan.lines.length === 0) {
    return <p className="muted">no payments yet. add one to see your savings plan.</p>;
  }

  const mtd = new Map((plan.contributionsMTD ?? []).map((c) => [c.paymentId, c.amountMinor]));

  function open(line: PlanLineDto): void {
    setOpenId(line.paymentId);
    setAmount(toMajor(line.fundedMonthlyMinor).toFixed(2));
    setErr(null);
  }

  async function submit(paymentId: string): Promise<void> {
    if (!onRecord) return;
    const amountMinor = toMinor(amount);
    if (amountMinor <= 0) {
      setErr("amount must be greater than zero");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onRecord(paymentId, amountMinor);
      setOpenId(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "could not record");
    } finally {
      setBusy(false);
    }
  }

  return (
    <table className="plan-table">
      <thead>
        <tr>
          <th>payment</th>
          <th>type</th>
          <th>due</th>
          <th className="num">amount</th>
          <th className="num">save / mo</th>
          <th className="num">saved</th>
          <th>status</th>
          <th>this month</th>
        </tr>
      </thead>
      <tbody>
        {plan.lines.map((line) => {
          const recordedMinor = mtd.get(line.paymentId);
          const recordable = canRecord && !!onRecord && line.category !== "monthly_recurring";
          const isOpen = openId === line.paymentId;
          // Straight from the API. A goal with a cap *and* a deadline is paced
          // (the TYPE column says so) but its date is still the user's, and
          // only the engine can tell the two apart.
          const derived = line.dueDateIsDerived === true;
          const dueInDays =
            asOfDate && line.category === "monthly_recurring"
              ? daysUntilNextMonthly(line.dueDate, asOfDate)
              : null;
          return (
            <tr key={line.paymentId} className={line.onTrack ? "" : "at-risk"}>
              <td className="name">{line.name}</td>
              <td className="muted">{typeLabel(line)}</td>
              <td className="muted">
                {derived ? (
                  <span className="derived" title="worked out from the pace, not a date you set">
                    ~{line.targetDate}
                  </span>
                ) : (
                  line.targetDate
                )}
              </td>
              <td className="num">{formatMinor(line.amountMinor, plan.currency)}</td>
              <td className="num">
                {formatMinor(line.requiredMonthlyMinor, plan.currency)}
                {(line.occurrencesThisMonth ?? 1) > 1 && (
                  <span
                    className="recurs"
                    title={`${line.occurrencesThisMonth} payments this month`}
                  >
                    {" "}
                    ({line.occurrencesThisMonth})
                  </span>
                )}
              </td>
              <td className={`num${line.alreadySavedMinor === 0 ? " dim" : ""}`}>
                {formatMinor(line.alreadySavedMinor, plan.currency)}
              </td>
              <td>
                {line.onTrack ? (
                  <span className="tag-status ok">on track</span>
                ) : (
                  <span
                    className="tag-status warn"
                    title={`projected ${line.projectedCompletionDate}`}
                  >
                    at risk
                  </span>
                )}
              </td>
              <td className="record-cell">
                {dueInDays !== null && (
                  <span className="due-in">
                    {dueInDays === 0 ? "due today" : `due in ${dueInDays} d`}
                  </span>
                )}
                {recordedMinor !== undefined && (
                  <span className="mtd-tick" title="recorded this month">
                    ✓ {formatMinor(recordedMinor, plan.currency)}
                  </span>
                )}
                {recordable &&
                  (isOpen ? (
                    <span className="record-form">
                      <input
                        aria-label={`amount to record for ${line.name}`}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void submit(line.paymentId);
                          if (e.key === "Escape") setOpenId(null);
                        }}
                        inputMode="decimal"
                        disabled={busy}
                        autoFocus
                      />
                      <button
                        type="button"
                        className="tiny"
                        onClick={() => void submit(line.paymentId)}
                        disabled={busy}
                      >
                        {busy ? "…" : "save"}
                      </button>
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => setOpenId(null)}
                        disabled={busy}
                      >
                        ✕
                      </button>
                      {err && (
                        <span className="error record-error" role="alert">
                          {err}
                        </span>
                      )}
                    </span>
                  ) : (
                    <button type="button" className="action" onClick={() => open(line)}>
                      record
                    </button>
                  ))}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function PlanSummary({
  plan,
  onEditBuffer,
}: {
  plan: AccountPlanDto;
  /** When provided, the Buffer KPI becomes a clickable edit affordance. */
  onEditBuffer?: () => void;
}) {
  const c = plan.currency;
  return (
    <div className="kpis">
      <Kpi label="monthly income" value={formatMinor(plan.monthlyIncomeMinor, c)} />
      <Kpi
        label="buffer"
        value={formatMinor(plan.bufferMinor, c)}
        onClick={onEditBuffer}
        ariaLabel={onEditBuffer ? "edit monthly buffer" : undefined}
      />
      <Kpi label="required / mo" value={formatMinor(plan.totalRequiredMinor, c)} />
      <Kpi
        label={plan.shortfallMinor > 0 ? "shortfall" : "left over"}
        value={formatMinor(plan.shortfallMinor > 0 ? plan.shortfallMinor : plan.leftoverMinor, c)}
        tone={plan.shortfallMinor > 0 ? "warn" : "ok"}
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
  onClick,
  ariaLabel,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const className = `kpi ${tone ?? ""} ${onClick ? "clickable" : ""}`.trim();
  const content = (
    <>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
    </>
  );
  if (onClick) {
    return (
      <div
        className={className}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
      >
        {content}
      </div>
    );
  }
  return <div className={className}>{content}</div>;
}
