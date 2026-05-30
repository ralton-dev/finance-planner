import type { AccountPlanDto, PlanLineDto } from "../lib/types.js";
import { formatMinor } from "../lib/money.js";

const CATEGORY_LABEL: Record<PlanLineDto["category"], string> = {
  monthly_recurring: "Monthly bill",
  yearly_recurring: "Yearly",
  custom_recurring: "Recurring",
  fixed_point: "Goal",
};

export function PlanTable({ plan }: { plan: AccountPlanDto }) {
  if (plan.lines.length === 0) {
    return <p className="muted">No payments yet. Add one to see your savings plan.</p>;
  }
  return (
    <table className="plan-table">
      <thead>
        <tr>
          <th>Payment</th>
          <th>Type</th>
          <th>Due</th>
          <th className="num">Amount</th>
          <th className="num">Save / month</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {plan.lines.map((line) => (
          <tr key={line.paymentId} className={line.onTrack ? "" : "at-risk"}>
            <td>{line.name}</td>
            <td>{CATEGORY_LABEL[line.category]}</td>
            <td>{line.targetDate}</td>
            <td className="num">{formatMinor(line.amountMinor, plan.currency)}</td>
            <td className="num">{formatMinor(line.requiredMonthlyMinor, plan.currency)}</td>
            <td>
              {line.onTrack ? (
                <span className="badge ok">On track</span>
              ) : (
                <span className="badge warn" title={`Projected ${line.projectedCompletionDate}`}>
                  At risk
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PlanSummary({ plan }: { plan: AccountPlanDto }) {
  const c = plan.currency;
  return (
    <div className="kpis">
      <Kpi label="Monthly income" value={formatMinor(plan.monthlyIncomeMinor, c)} />
      <Kpi label="Buffer" value={formatMinor(plan.bufferMinor, c)} />
      <Kpi label="Required / month" value={formatMinor(plan.totalRequiredMinor, c)} />
      <Kpi
        label={plan.shortfallMinor > 0 ? "Shortfall" : "Left over"}
        value={formatMinor(plan.shortfallMinor > 0 ? plan.shortfallMinor : plan.leftoverMinor, c)}
        tone={plan.shortfallMinor > 0 ? "warn" : "ok"}
      />
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div className={`kpi ${tone ?? ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
    </div>
  );
}
