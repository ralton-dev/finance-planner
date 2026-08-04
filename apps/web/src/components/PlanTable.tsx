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

interface PlanTableProps {
  plan: AccountPlanDto;
  /** When true, non-monthly rows get a "record" action for setting money aside. */
  canRecord?: boolean;
  /** Called with the amount the user typed, in minor units. Rejections surface inline. */
  onRecord?: (paymentId: string, amountMinor: number) => Promise<unknown>;
}

/**
 * The savings plan, with reality alongside it: what is already saved per
 * payment, what was recorded this month, and an inline way to record more.
 * Monthly recurring bills are excluded from recording — they are paid, not
 * saved for.
 */
export function PlanTable({ plan, canRecord = false, onRecord }: PlanTableProps) {
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
          return (
            <tr key={line.paymentId} className={line.onTrack ? "" : "at-risk"}>
              <td className="name">{line.name}</td>
              <td className="muted">{CATEGORY_LABEL[line.category]}</td>
              <td className="muted">{line.targetDate}</td>
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
