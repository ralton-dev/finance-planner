import { lazy, Suspense, useRef } from "react";
import { formatMinor } from "../lib/money.js";
import type { HouseholdPlanDto } from "../lib/types.js";
import { ChartFrame } from "./ChartFrame.js";
import { DownloadButton } from "./DownloadButton.js";

// Lazy so the charting library (recharts) stays in its own chunk — the Overview
// is eagerly loaded, and solo users with no household never need the Sankey.
const HouseholdSankey = lazy(() =>
  import("./HouseholdSankey.js").then((m) => ({ default: m.HouseholdSankey })),
);

const pct = (bp: number): string => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`;

/**
 * The reconciled household picture: KPIs, the money-flow Sankey, a per-account
 * table (transfers + true balances) and a per-person table (share + funding).
 * Shared by the full household plan page and the Overview's household blocks.
 */
export function HouseholdPlanView({ plan }: { plan: HouseholdPlanDto }) {
  const c = plan.currency;
  const memberName = new Map(plan.members.map((m) => [m.userId, m.displayName ?? "member"]));
  const sankeyRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">monthly income</div>
          <div className="kpi-value">{formatMinor(plan.monthlyIncomeMinor, c)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">required / mo</div>
          <div className="kpi-value">{formatMinor(plan.totalRequiredMinor, c)}</div>
        </div>
        <div className="kpi ok">
          <div className="kpi-label">left over</div>
          <div className="kpi-value">{formatMinor(plan.leftoverMinor, c)}</div>
        </div>
        <div className={plan.shortfallMinor > 0 ? "kpi warn" : "kpi"}>
          <div className="kpi-label">shortfall</div>
          <div className="kpi-value">
            {plan.shortfallMinor > 0 ? formatMinor(plan.shortfallMinor, c) : "—"}
          </div>
        </div>
      </div>

      <div className="section-head">
        <h2>money flow</h2>
        <span className="meta">[income → accounts → transfers → spending]</span>
        <span className="spacer" />
        <DownloadButton targetRef={sankeyRef} name="money-flow" />
      </div>
      <ChartFrame ref={sankeyRef}>
        <Suspense
          fallback={
            <p className="muted" style={{ fontSize: "12px" }}>
              loading chart…
            </p>
          }
        >
          <HouseholdSankey plan={plan} />
        </Suspense>
      </ChartFrame>

      <div className="section-head">
        <h2>per account</h2>
        <span className="meta">[transfers + reconciled balances]</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>account</th>
            <th>role</th>
            <th className="num">income</th>
            <th className="num">transfer in</th>
            <th className="num">transfer out</th>
            <th className="num">left over</th>
            <th className="num">shortfall</th>
          </tr>
        </thead>
        <tbody>
          {plan.accounts.map((a) => (
            <tr key={a.accountId} className={a.shortfallMinor > 0 ? "at-risk" : ""}>
              <td className="name">{a.name ?? "account"}</td>
              <td>
                {a.role === "shared" ? (
                  <span className="tag-status idle">shared</span>
                ) : (
                  <span className="shared">
                    {memberName.get(a.memberUserId ?? "") ?? "personal"}
                  </span>
                )}
              </td>
              <td className="num">
                {a.monthlyIncomeMinor > 0 ? formatMinor(a.monthlyIncomeMinor, c) : "—"}
              </td>
              <td className="num">
                {a.transferInMinor > 0 ? formatMinor(a.transferInMinor, c) : "—"}
              </td>
              <td className="num">
                {a.transferOutMinor > 0 ? formatMinor(a.transferOutMinor, c) : "—"}
              </td>
              <td className="num ok">{formatMinor(a.leftoverMinor, c)}</td>
              <td className={`num${a.shortfallMinor > 0 ? " warn" : " dim"}`}>
                {a.shortfallMinor > 0 ? formatMinor(a.shortfallMinor, c) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section-head">
        <h2>per person</h2>
        <span className="meta">[contribution + funding]</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>member</th>
            <th className="num">share</th>
            <th className="num">income</th>
            <th className="num">their costs</th>
            <th className="num">left over</th>
            <th className="num">shortfall</th>
          </tr>
        </thead>
        <tbody>
          {plan.members.map((m) => (
            <tr key={m.userId} className={m.shortfallMinor > 0 ? "at-risk" : ""}>
              <td className="name">{m.displayName ?? "member"}</td>
              <td className="num">{pct(m.shareBp)}</td>
              <td className="num">{formatMinor(m.monthlyIncomeMinor, c)}</td>
              <td className="num">{formatMinor(m.obligationMinor, c)}</td>
              <td className="num ok">{formatMinor(m.leftoverMinor, c)}</td>
              <td className={`num${m.shortfallMinor > 0 ? " warn" : " dim"}`}>
                {m.shortfallMinor > 0 ? formatMinor(m.shortfallMinor, c) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
