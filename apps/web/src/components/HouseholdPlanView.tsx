import { lazy, Suspense, useRef } from "react";
import { accountLabel } from "../lib/flow.js";
import { formatMinor } from "../lib/money.js";
import type { HouseholdMemberPlanDto, HouseholdPlanDto } from "../lib/types.js";
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
 *
 * **Everything** committed comes off, which for a member is two fields. Their
 * `leftoverMinor` is scope-wide and their `committedMinor` is this household's
 * accounts only, so subtracting just the one netted two different sets of
 * accounts against each other and over-stated their free money by whatever they
 * commit out of a personal account the household does not hold. An account row
 * has no `elsewhere` — an account is one account — and reads exactly as before.
 */
export function freeMinor(of: {
  leftoverMinor: number;
  committedMinor?: number;
  elsewhereCommittedMinor?: number;
}): number {
  return of.leftoverMinor - (of.committedMinor ?? 0) - (of.elsewhereCommittedMinor ?? 0);
}

/** Everything one member has committed, wherever the account sits — the whole
 *  the COMMITTED cell prints, and what its note breaks down. */
const memberCommitted = (m: HouseholdMemberPlanDto): number =>
  (m.committedMinor ?? 0) + (m.elsewhereCommittedMinor ?? 0);

/**
 * **The household's left over** (decision 19): its members' left overs, added
 * up. That is all it is.
 *
 * `membersLeftoverMinor` is `Σ members[].personalLeftoverMinor`, so this figure
 * is the sum of the LEFT OVER column in the per-person table below it and the
 * rows add to the total on screen.
 *
 * What stood here was `householdLeftoverMinor − committedMinor`, which is
 * algebraically a residual sum already — the pass adds each account's committed
 * back and this subtracted the same total, so the two cancelled — but summed
 * over the **roster** rather than over the members. The difference is whatever
 * sits in accounts a member owns and the household does not hold: on the estate
 * fixture, £3,575 against the £4,025 the members actually have. Nothing is
 * subtracted here now, because a residual has already counted a movement at
 * both ends and taking committed off one end loses the money entirely.
 *
 * A payload from an older API has no such field and falls back to the old
 * derivation rather than rendering nothing.
 */
export function householdLeftOverMinor(plan: HouseholdPlanDto): number {
  return (
    plan.membersLeftoverMinor ??
    (plan.householdLeftoverMinor ?? plan.leftoverMinor) - (plan.committedMinor ?? 0)
  );
}

/**
 * **One member's left over** (decision 19): the residuals of the accounts they
 * own, added up. The LEFT OVER cell in the per-person table.
 *
 * Not `freeMinor(m)`. That netted their scope-wide surplus against everything
 * they had committed, which is a different question and summed to nothing on
 * the page: on the cross-owner fixture the two member rows read £1,600 and £800
 * beneath a household total of £2,800. The residual basis reads £2,100 and
 * £800, and those do add to the £2,900 above them.
 */
export function memberLeftOverMinor(m: HouseholdMemberPlanDto): number {
  return m.personalLeftoverMinor ?? freeMinor(m);
}

/**
 * Everything in one member's left over that arrived from somebody else, and
 * whose it was — the two halves of decision 25's sentence.
 *
 * Read off `arrivedFromOthers`, which the pass itemises from `inflowArrivals`.
 * Nothing is recomputed here and nothing is subtracted: the figure the cell
 * prints is exactly what it printed before.
 */
const arrivedFromOthersMinor = (m: HouseholdMemberPlanDto): number =>
  (m.arrivedFromOthers ?? []).reduce((sum, a) => sum + a.amountMinor, 0);

/**
 * "Bob", "Bob and Carol", "Bob, Carol and Dave" — a list a person reads rather
 * than one a machine writes.
 *
 * An owner the roster cannot name is described, never printed as an id: the
 * amount travels ungated and the name does not, which is the same rule every
 * other cell on this page follows.
 */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "somebody outside the household";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
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
  const left = householdLeftOverMinor(plan);
  // Every KPI here is about the household's own accounts, and for a household
  // that holds only a shared pot the income one is £0 — true, and unreadable on
  // its own, because the money the bills are paid with arrives by transfer.
  // Named here rather than left for the reader to find in the table below.
  const arriving = plan.accounts.reduce((s, a) => s + a.transferInMinor, 0);
  // The per-person table's own gate, and not `committed`. The two answer
  // different questions — that one is this household's accounts, this one is
  // these people, wherever they bank — and either can be nought while the other
  // is not. A household whose only movement leaves the shared pot had a column
  // of em dashes on a table about people; a member who commits only out of an
  // account the household does not hold had a reduced LEFT OVER with no column
  // on the page saying why, which is the reading the figure must never get.
  const committedByMembers = plan.members.reduce((s, m) => s + memberCommitted(m), 0);
  // What the LEFT OVER column of the account table actually adds to, and what
  // the KPI has that it does not: money in accounts a member owns and this
  // household does not hold (decision 25). A difference of two figures already
  // on the screen — no third derivation, and nothing here changes either.
  const heldHere = plan.accounts.reduce((s, a) => s + freeMinor(a), 0);
  const heldElsewhere = left - heldHere;
  // What the household's own accounts have *received* from authored savings
  // movements — `movementInMinor`, the field the pass publishes as the mirror
  // of `committedMinor`, added up. Decision 40's whole job, and no new
  // arithmetic: it decides one word, and never the figure beside it.
  const reservedHere = plan.accounts.reduce((s, a) => s + (a.movementInMinor ?? 0), 0);

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
        <div className={left < 0 ? "kpi warn" : "kpi ok"}>
          <div className="kpi-label">left over</div>
          <div className="kpi-value">{formatMinor(left, c)}</div>
          {/* Whose money, always. It is these people's, wherever they bank —
              which is a different set from the accounts in the table above,
              the moment a member holds money the household does not hold
              (decision 9). The figure that said nothing about which it meant is
              the one that was wrong, and this one is the per-person table's
              LEFT OVER column added up. */}
          <div className="kpi-delta">these members', added up</div>
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
                  {/* A roster account whose name was withheld (decision 41) is
                      still every figure in this row; only the label is gated.
                      "account", in a column headed ACCOUNT, read as a lookup
                      that had broken. */}
                  <span>{accountLabel(a)}</span>
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
          {/* The column does not add to the KPI above it, and until now nothing
              said why (decision 25). These are the household's accounts; the
              household's left over is its **members'**, and a member owns
              accounts this roster does not hold — an ISA of Alice's reads
              £2,800 here under a headline of £2,900. Same word the member rows
              use for the same class of gap, and the footer appears only when
              there is one, exactly as their notes do. Nothing is recomputed:
              this is the column added up beside the figure already printed.

              **Two words, because the gap has two causes** (decision 40). A
              column that *overshoots* the members' total is not money held
              elsewhere — it is here, in a pot two rows above, and calling it
              "elsewhere" pointed the reader off the screen they were looking
              at. Which cause it is, is a question the published fields already
              answer: an account row counts a savings arrival, a member's left
              over does not, so `movementInMinor` is exactly the overshoot the
              pots explain. When it covers the whole gap the money is
              **reserved**; when it does not, the remainder belongs to somebody
              this household's members do not include — a roster account owned
              by a non-member, the cause this branch was written for — and that
              keeps **elsewhere**. A payload too old to carry the field reads
              nought and keeps the word it always had. */}
          {heldElsewhere !== 0 && (
            <tfoot>
              <tr>
                <th className="sticky-col">these accounts</th>
                <td className="wide-only" />
                <td className="num wide-only" />
                <td className="num" />
                <td className="num" />
                {committed > 0 && <td className="num" />}
                <td className="num">
                  {formatMinor(heldHere, c)}
                  <span className="cell-note">
                    {heldElsewhere > 0 ? "plus " : "less "}
                    {formatMinor(Math.abs(heldElsewhere), c)}{" "}
                    {heldElsewhere < 0 && -heldElsewhere <= reservedHere ? "reserved" : "elsewhere"}
                  </span>
                </td>
                <td className="num" />
              </tr>
            </tfoot>
          )}
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
              {committedByMembers > 0 && <th className="num">committed</th>}
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
                {/* INCOME is scope-wide too, and became so in production the
                    moment a member's own accounts stopped having to be on this
                    roster to reach their budget (`f3acef8`). A salary paid into
                    an account the household does not hold is in this figure and
                    in nothing the page prints beneath it, so it gets THEIR
                    COSTS's word for the same gap. The amount, never the account:
                    it is what tells a co-member whether the share split still
                    makes sense, and nothing about *where* it lands is theirs.
                    Unconditional, like the column — a member's income is a
                    standing fact, not something a month can make absent. */}
                <td className="num">
                  {formatMinor(m.monthlyIncomeMinor, c)}
                  {(m.elsewhereIncomeMinor ?? 0) > 0 && (
                    <span className="cell-note">
                      incl. {formatMinor(m.elsewhereIncomeMinor ?? 0, c)} elsewhere
                    </span>
                  )}
                </td>
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
                {/* Everything this person has committed, and the same word
                    THEIR COSTS uses for the part these accounts do not carry.
                    Every other cell in this row is scope-wide — their income,
                    their costs, their leftover, their shortfall — and this one
                    was the household's accounts only, so LEFT OVER netted a
                    narrow figure against a wide one and paid them money they
                    had already promised a savings pot. */}
                {committedByMembers > 0 && (
                  <td className="num">
                    {memberCommitted(m) > 0 ? formatMinor(memberCommitted(m), c) : "—"}
                    {(m.elsewhereCommittedMinor ?? 0) > 0 && (
                      <span className="cell-note">
                        incl. {formatMinor(m.elsewhereCommittedMinor ?? 0, c)} elsewhere
                      </span>
                    )}
                  </td>
                )}
                {/* Their own accounts' residuals, added up — so this column
                    sums to the KPI above rather than to nothing on the page.

                    And the last cell on this table without a note for the gap
                    between it and its neighbours (decision 25). Alice's row
                    reads income £2,000, their costs £300, committed £100 and a
                    left over of £2,100; a reader doing that arithmetic gets
                    £1,600. £400 of the difference is Bob's money sitting in a
                    pot she owns — in her account, and not hers. Naming it costs
                    the figure nothing: a residual counts a movement at both
                    ends and the household's total is the same either way. */}
                <td className={leftOverClass(memberLeftOverMinor(m))}>
                  {formatMinor(memberLeftOverMinor(m), c)}
                  {arrivedFromOthersMinor(m) > 0 && (
                    <span className="cell-note">
                      incl. {formatMinor(arrivedFromOthersMinor(m), c)} that arrived from{" "}
                      {nameList(
                        (m.arrivedFromOthers ?? []).map(
                          (a) => memberName.get(a.ownerUserId) ?? "somebody outside the household",
                        ),
                      )}
                    </span>
                  )}
                </td>
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
