import { lazy, Suspense, useRef } from "react";
import { formatMinor } from "../lib/money.js";
import type { HouseholdPlanDto } from "../lib/types.js";
import { Amount } from "./Amount.js";
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
      {/* Seven columns is more than a phone holds, so on one the two that
          describe the account rather than move its money — whose it is, and
          whether income lands in it — fold into a sub-line under the name. What
          is left is the section's own promise: what comes in, what goes out,
          and whether it covers the bills. The wrapper scrolls the remainder. */}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="sticky-col">account</th>
              <th className="wide-only">role</th>
              <th className="num wide-only">income</th>
              <th className="num">transfer in</th>
              <th className="num">transfer out</th>
              <th className="num">left over</th>
              <th className="num">shortfall</th>
            </tr>
          </thead>
          <tbody>
            {plan.accounts.map((a) => (
              <tr key={a.accountId} className={a.shortfallMinor > 0 ? "at-risk" : ""}>
                <td className="name sticky-col">
                  <span>{a.name ?? "account"}</span>
                  {/* What the two dropped columns say, once they are gone.
                      Written flat rather than as copies of their cells: the
                      sub-line is already quiet, and a chip inside it would
                      shout. The income goes through <Amount> so privacy mode
                      still reaches it. */}
                  <span className="row-sub">
                    {a.role === "shared"
                      ? "shared pot"
                      : (memberName.get(a.memberUserId ?? "") ?? "personal")}
                    {a.monthlyIncomeMinor > 0 && (
                      <>
                        {" · income "}
                        <Amount minor={a.monthlyIncomeMinor} currency={c} />
                      </>
                    )}
                  </span>
                </td>
                <td className="wide-only">
                  {a.role === "shared" ? (
                    <span className="tag-status idle">shared</span>
                  ) : (
                    <span className="shared">
                      {memberName.get(a.memberUserId ?? "") ?? "personal"}
                    </span>
                  )}
                </td>
                <td className="num wide-only">
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
      </div>

      <div className="section-head">
        <h2>per person</h2>
        <span className="meta">[contribution + funding]</span>
      </div>
      {/* Six columns, and one of them — the share — is a standing fact about
          the person rather than anything this month did. It folds into the
          sub-line on a phone, which leaves the same five as the table above:
          who, what comes in, what it owes, and how that lands. */}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="sticky-col">member</th>
              <th className="num wide-only">share</th>
              <th className="num">income</th>
              <th className="num">their costs</th>
              <th className="num">left over</th>
              <th className="num">shortfall</th>
            </tr>
          </thead>
          <tbody>
            {plan.members.map((m) => (
              <tr key={m.userId} className={m.shortfallMinor > 0 ? "at-risk" : ""}>
                <td className="name sticky-col">
                  <span>{m.displayName ?? "member"}</span>
                  <span className="row-sub">{pct(m.shareBp)} share</span>
                </td>
                <td className="num wide-only">{pct(m.shareBp)}</td>
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
      </div>
    </>
  );
}
