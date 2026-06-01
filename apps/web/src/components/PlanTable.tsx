import type { AccountPlanDto, PlanLineDto } from "../lib/types.js";
import { formatMinor } from "../lib/money.js";

const CATEGORY_LABEL: Record<PlanLineDto["category"], string> = {
  monthly_recurring: "monthly",
  yearly_recurring: "yearly",
  custom_recurring: "recurring",
  fixed_point: "goal",
};

export function PlanTable({ plan }: { plan: AccountPlanDto }) {
  if (plan.lines.length === 0) {
    return <p className="muted">no payments yet. add one to see your savings plan.</p>;
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
          <th>status</th>
        </tr>
      </thead>
      <tbody>
        {plan.lines.map((line) => (
          <tr key={line.paymentId} className={line.onTrack ? "" : "at-risk"}>
            <td className="name">{line.name}</td>
            <td className="muted">{CATEGORY_LABEL[line.category]}</td>
            <td className="muted">{line.targetDate}</td>
            <td className="num">{formatMinor(line.amountMinor, plan.currency)}</td>
            <td className="num">
              {formatMinor(line.requiredMonthlyMinor, plan.currency)}
              {(line.occurrencesThisMonth ?? 1) > 1 && (
                <span className="recurs" title={`${line.occurrencesThisMonth} payments this month`}>
                  {" "}
                  ({line.occurrencesThisMonth})
                </span>
              )}
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
          </tr>
        ))}
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
