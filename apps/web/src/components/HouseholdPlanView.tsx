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
 * Free after committed — the figure every headline and every LEFT OVER cell on
 * this page shows.
 *
 * Decision 13: `leftoverMinor` keeps its meaning to the penny wherever it
 * appears on the wire, and `committedMinor` sits alongside it rather than being
 * netted into it. What a *reader* wants is the difference, because money already
 * committed to a savings movement is not money they can spend — and because the
 * difference is the number the account page and the flow diagram print for the
 * same account. Printing `leftoverMinor` raw is how the household page came to
 * read £2,793 against the diagram's £2,093 (ONE-ENGINE.md).
 */
export function freeMinor(of: { leftoverMinor: number; committedMinor?: number }): number {
  return of.leftoverMinor - (of.committedMinor ?? 0);
}

/**
 * The headline's free-after-committed, which is **not** `freeMinor(plan)`.
 *
 * `HouseholdPlanDto.leftoverMinor` is the members' surplus scope-wide; every
 * other figure in the KPI row beside it — the income, the requirement, the
 * committed total, the shortfall — is this household's own accounts. A
 * household holding nothing but the bills pot read "income £0 · required
 * £1,410 · left over £2,000", the last of those being money the first does not
 * contain and the account table below does not hold (WP-Z).
 *
 * `householdLeftoverMinor` is the same accounts' LEFT OVER column, added up, so
 * this figure is the sum of the ones printed beneath it and cannot drift from
 * them again. A payload from an older API has no such field and falls back —
 * for a household that holds every account its members own, which is the case
 * those payloads came from, the two are equal anyway.
 */
export function householdFreeMinor(plan: HouseholdPlanDto): number {
  return (plan.householdLeftoverMinor ?? plan.leftoverMinor) - (plan.committedMinor ?? 0);
}

/**
 * The class a LEFT OVER cell takes. Green is a month that works; a negative
 * residual is not one.
 *
 * Measured in a browser: an account committed to sending out more than reaches
 * it — a member holding income somewhere other than the account their transfers
 * leave (decision 11) — printed **-£244.00 in green**, which is the one reading
 * a figure like that must never get. The pass stopped flooring it so the screen
 * could say the thing to do, and a green minus says the opposite.
 */
const leftOverClass = (minor: number): string => `num ${minor < 0 ? "warn" : "ok"}`;

/**
 * The reconciled household picture: KPIs, the money-flow Sankey, a per-account
 * table (transfers + true balances) and a per-person table (share + funding).
 * Shared by the full household plan page and the Overview's household blocks.
 *
 * A household's savings movements are shown as **one committed bucket, not
 * itemised** — per member, per account and in the KPI row. Which pot each pound
 * went to is the account page's question and the flow diagram's; the household's
 * is only how much of the month's surplus is already spoken for.
 */
export function HouseholdPlanView({ plan }: { plan: HouseholdPlanDto }) {
  const c = plan.currency;
  const memberName = new Map(plan.members.map((m) => [m.userId, m.displayName ?? "member"]));
  const sankeyRef = useRef<HTMLDivElement>(null);
  const committed = plan.committedMinor ?? 0;
  const free = householdFreeMinor(plan);
  // Every KPI here is about the household's own accounts, and for a household
  // that holds only a shared pot the income one is £0 — true, and unreadable on
  // its own, because the money the bills are paid with arrives by transfer.
  // Named here rather than left for the reader to find in the table below.
  const arriving = plan.accounts.reduce((s, a) => s + a.transferInMinor, 0);

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">monthly income</div>
          <div className="kpi-value">{formatMinor(plan.monthlyIncomeMinor, c)}</div>
          {arriving > 0 && (
            <div className="kpi-delta">+ {formatMinor(arriving, c)} arriving by transfer</div>
          )}
        </div>
        <div className="kpi">
          <div className="kpi-label">required / mo</div>
          <div className="kpi-value">{formatMinor(plan.totalRequiredMinor, c)}</div>
        </div>
        {/* Only when there is one. A household nobody has authored a movement
            in has nothing committed, and an em dash in a KPI of its own would
            be a column asking to be understood for no reason. */}
        {committed > 0 && (
          <div className="kpi">
            <div className="kpi-label">committed</div>
            <div className="kpi-value">{formatMinor(committed, c)}</div>
            <div className="kpi-delta">to savings movements out</div>
          </div>
        )}
        <div className={free < 0 ? "kpi warn" : "kpi ok"}>
          <div className="kpi-label">left over</div>
          <div className="kpi-value">{formatMinor(free, c)}</div>
          {/* Which accounts, always — this is the household's, and a member's
              own surplus is the per-person table's business two sections down.
              The two differ the moment a member holds money the household does
              not (decision 9), and the figure that says nothing about which it
              means is the one that was wrong. */}
          <div className="kpi-delta">
            {committed > 0 ? "in these accounts, after what is committed" : "in these accounts"}
          </div>
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
        <span className="meta">[income → accounts → movements → spending]</span>
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
          and whether it covers the bills. The wrapper scrolls the remainder.
          COMMITTED is an eighth, and only appears for a household that has
          authored a movement out of one of these accounts — otherwise it is a
          column of em dashes explaining a concept nothing here uses. */}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="sticky-col">account</th>
              <th className="wide-only">role</th>
              <th className="num wide-only">income</th>
              <th className="num">transfer in</th>
              <th className="num">transfer out</th>
              {committed > 0 && <th className="num">committed</th>}
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
                {committed > 0 && (
                  <td className="num">
                    {(a.committedMinor ?? 0) > 0 ? formatMinor(a.committedMinor ?? 0, c) : "—"}
                  </td>
                )}
                {/* Free after committed — the same number the account page's
                    residual and the flow diagram print for this account. */}
                <td className={leftOverClass(freeMinor(a))}>{formatMinor(freeMinor(a), c)}</td>
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
              {committed > 0 && <th className="num">committed</th>}
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
                {/* THEIR COSTS is what the pass attributes to this person
                    across the whole scope; the lines beneath this table are
                    only the household's own accounts. Decision 9 made those two
                    sets differ — a member's solo bills pot is fed by a transfer
                    the plan derives — so the figure exceeded anything the page
                    could explain, with nothing naming the difference. The
                    household view publishes it now, and this is the word.
                    Always visible: the gap is the point, not a phone fold. */}
                <td className="num">
                  {formatMinor(m.obligationMinor, c)}
                  {(m.elsewhereObligationMinor ?? 0) > 0 && (
                    <span className="cell-note">
                      incl. {formatMinor(m.elsewhereObligationMinor ?? 0, c)} elsewhere
                    </span>
                  )}
                </td>
                {committed > 0 && (
                  <td className="num">
                    {(m.committedMinor ?? 0) > 0 ? formatMinor(m.committedMinor ?? 0, c) : "—"}
                  </td>
                )}
                <td className={leftOverClass(freeMinor(m))}>{formatMinor(freeMinor(m), c)}</td>
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
