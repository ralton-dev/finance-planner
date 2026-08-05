import { useState } from "react";
import { ApiError } from "../lib/api.js";
import { formatMinor, money, type Phrase, toMajor, toMinor } from "../lib/money.js";
import {
  lineStatus,
  type AccountPlanDto,
  type PlanInflowSourceDto,
  type PlanLineDto,
  type PlanLineStatus,
} from "../lib/types.js";
import { Amount, Sentence } from "./Amount.js";

const CATEGORY_LABEL: Record<PlanLineDto["category"], string> = {
  monthly_recurring: "monthly",
  yearly_recurring: "yearly",
  custom_recurring: "recurring",
  fixed_point: "goal",
};

const MS_PER_DAY = 86_400_000;

/** What the status column says, and the chip class that colours it. Amber is
 *  "waiting on you to move money"; red is only ever "the plan cannot cover
 *  this", because red is the one that means cut something. */
const STATUS_CHIP: Record<PlanLineStatus, { label: string; className: string }> = {
  funded: { label: "on track", className: "tag-status ok" },
  awaiting_transfer: { label: "awaiting transfer", className: "tag-status needs-you" },
  at_risk: { label: "at risk", className: "tag-status warn" },
};

/** The row tint, splitting the old single `at-risk` wash the same way. */
const STATUS_ROW_CLASS: Record<PlanLineStatus, string> = {
  funded: "",
  awaiting_transfer: "awaiting",
  at_risk: "at-risk",
};

/**
 * What the record box should open with: money that is actually in the account.
 *
 * `fundedMonthlyMinor` includes inflow nobody has moved yet, so prefilling with
 * it prompts you to record money that has not arrived — the wrong way round,
 * and the same mistake the API already stopped making in `summarisePlanLines`.
 * On a line still waiting on a transfer, the honest floor is the part the
 * account's own income paid for; the field stays editable for the person who
 * really did move it.
 */
export function recordPrefillMinor(line: PlanLineDto): number {
  if (lineStatus(line) !== "awaiting_transfer") return line.fundedMonthlyMinor;
  return Math.max(0, line.fundedFromOwnMinor ?? 0);
}

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
    setAmount(toMajor(recordPrefillMinor(line)).toFixed(2));
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
    // Scrolls inside itself rather than dragging the document sideways, and on
    // a phone sheds the three columns the sub-line takes over — see
    // `.table-scroll` and the `max-width: 560px` block in styles.css.
    <div className="table-scroll">
      <table className="plan-table">
        <thead>
          <tr>
            <th className="sticky-col">payment</th>
            <th className="wide-only">type</th>
            <th className="wide-only">due</th>
            <th className="num wide-only">amount</th>
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
            const status = lineStatus(line);
            return (
              <tr key={line.paymentId} className={STATUS_ROW_CLASS[status]}>
                <td className="name sticky-col">
                  <span>{line.name}</span>
                  {/* What the three dropped columns say, once they are gone.
                      Written flat rather than as copies of their cells: the
                      sub-line is already `--ink-3`, which is all `.derived`
                      adds, and the tilde is what carries the meaning. The
                      amount goes through <Amount> so privacy mode reaches it,
                      and is left off when it is the monthly ask over again —
                      every monthly bill, where the two are the same number. */}
                  <span className="row-sub">
                    {typeLabel(line)} · due {derived ? `~${line.targetDate}` : line.targetDate}
                    {line.amountMinor !== line.requiredMonthlyMinor && (
                      <>
                        {" · "}
                        <Amount minor={line.amountMinor} currency={plan.currency} />
                      </>
                    )}
                  </span>
                </td>
                <td className="muted wide-only">{typeLabel(line)}</td>
                <td className="muted wide-only">
                  {derived ? (
                    <span className="derived" title="worked out from the pace, not a date you set">
                      ~{line.targetDate}
                    </span>
                  ) : (
                    line.targetDate
                  )}
                </td>
                <td className="num wide-only">{formatMinor(line.amountMinor, plan.currency)}</td>
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
                  <span
                    className={STATUS_CHIP[status].className}
                    // Only the red state has a projection to explain; the amber
                    // one is explained by the arriving figure above the table.
                    {...(status === "at_risk"
                      ? { title: `projected ${line.projectedCompletionDate}` }
                      : status === "awaiting_transfer"
                        ? { title: "the plan covers this — the money has not moved yet" }
                        : {})}
                  >
                    {STATUS_CHIP[status].label}
                  </span>
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
    </div>
  );
}

// --- where the money is coming from ----------------------------------------
// An account is a location money sits in, not a closed universe: a bills pot
// with no income of its own is funded, every month, by money somebody moves
// into it. The KPI row used to be unable to say so — it printed INCOME £0.00
// against SHORTFALL £303.20 while the plan was covered — which is the screen
// that prompted this whole piece of work.

/**
 * What to call whoever is sending the money.
 *
 * The names are access-gated on the wire and may simply not be there. When one
 * is withheld the honest answer is the *kind* of sender, never a made-up name
 * and never an id: "a household member" if it is a person, "another account" if
 * it is an account — and deliberately not "another of *your* accounts", since a
 * caller who cannot see the sender has not been told whose it is.
 */
export function senderName(source: PlanInflowSourceDto): string {
  if (source.kind === "member") return source.displayName ?? "a household member";
  return source.accountName ?? "another account";
}

/** "Ben", "Ben and your ISA", "Ben, your ISA and Alex" — an Oxford-comma-free
 *  list, because these are rarely more than two. */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The sentence under the KPI row: what is arriving, and from whom.
 *
 * Returned as a `Phrase` rather than a string so the figure in it goes through
 * `<Amount>` and privacy mode can reach it. Null when nothing is arriving that
 * this caller may be told about — the same thing the API's null `inflowSources`
 * means, and the same thing an account funded entirely by its own income means.
 *
 * It never says "household" unless a household member is actually sending
 * something. Money moves between two accounts one person owns with no household
 * anywhere, and saying otherwise would invent an arrangement that does not
 * exist.
 */
export function inflowNote(plan: AccountPlanDto): Phrase | null {
  const arriving = plan.allocatedInflowMinor ?? 0;
  if (arriving <= 0) return null;

  const names = (plan.inflowSources ?? []).filter((s) => s.amountMinor > 0).map(senderName);
  // No income of its own is a fact worth leading with: it is why the plan can
  // fund more than the account earns, and why LEFT OVER has nothing to report.
  const lead = plan.monthlyIncomeMinor === 0 ? "no income of its own · " : "";
  const from = names.length > 0 ? ` from ${nameList(names)}` : "";
  return [lead, money(arriving, plan.currency), ` arriving${from} this month`];
}

/**
 * The one shape an account's LEFT OVER can be read off, whichever surface is
 * asking. `AccountPlanDto` and the overview's `OverviewAccountDto` both satisfy
 * it structurally, which is the whole point: there is one rule and three
 * callers, not three rules.
 */
export interface LeftOverLike {
  residualMinor?: number;
  leftoverMinor: number;
  monthlyIncomeMinor: number;
}

/**
 * What LEFT OVER shows, and why it is not `leftoverMinor`.
 *
 * Measured in a browser at 1280px: this KPI read **£2,625.80** for an account
 * whose household page and flow diagram both read **£1,822.60** — the same
 * account, the same month, one savings movement apart. That is the defect
 * ONE-ENGINE.md exists to end, surviving in the last place it could: the page
 * that prints the plan's own field rather than what is left in the account.
 *
 * `residualMinor` is `income + arriving − spending − leaving`, signed, and it is
 * the one figure the pass publishes for all three surfaces (decision 19).
 * `leftoverMinor` keeps its meaning on the wire and is the right answer for a
 * *rollup*; it is the wrong one for a person looking at one account, which is
 * how the accounts index and the dashboard came to print £2,501.00 and £0.00
 * for accounts whose own pages read £2,051.00 and £200.00 (MINE-AND-OURS.md).
 *
 * **Every surface that prints an account's left over calls this**, so a fourth
 * one cannot be added wrong — the account page's KPI, the accounts index and
 * the dashboard's account table, the last two through {@link LeftOverCell}.
 *
 * Null when there is nothing to report: an account with no income of its own and
 * nothing left in it never had a surplus, and "£0.00 left over" claims there was
 * one and it is gone.
 */
export function leftOverMinor(plan: LeftOverLike): number | null {
  const residual = plan.residualMinor ?? plan.leftoverMinor;
  if (residual === 0 && plan.monthlyIncomeMinor === 0) return null;
  return residual;
}

/**
 * The LEFT OVER / MO cell the accounts index and the dashboard's account table
 * both render.
 *
 * One component rather than two call sites of {@link leftOverMinor}, because
 * the em dash is half the rule and a caller that remembered the field but not
 * the absence would print "£0.00" for a pot that never had a surplus. A row
 * with no overview state yet stays blank for the same reason.
 */
export function LeftOverCell({ state, currency }: { state?: LeftOverLike; currency: string }) {
  const left = state ? leftOverMinor(state) : null;
  if (left === null) return <span className="muted">—</span>;
  return <Amount minor={left} currency={currency} />;
}

/** How much of what is arriving has actually moved — the amber KPI's sub-line. */
function movedNote(plan: AccountPlanDto): Phrase | null {
  const arriving = plan.allocatedInflowMinor ?? 0;
  if (arriving <= 0) return null;
  const moved = plan.confirmedInflowMinor ?? 0;
  if (moved <= 0) return ["none of it moved yet"];
  if (moved >= arriving) return ["all of it moved"];
  return [money(moved, plan.currency), " moved so far"];
}

/**
 * A funding loop, named rather than hidden.
 *
 * A cycle is a property of the estate, not of the edge that closes it, so
 * authoring never refuses one — which makes the UI the only thing that can
 * explain why the plan broke the loop somewhere. Naming the accounts is the
 * whole of the honest minimum; resolving it is the user's call.
 */
function cycleNote(plan: AccountPlanDto): string | null {
  const cycle = plan.fundingCycleAccountIds ?? [];
  if (cycle.length === 0) return null;
  return `funding loop · ${cycle.length} accounts feed each other in a circle, so the plan breaks it at one point`;
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
  const arriving = plan.allocatedInflowMinor ?? 0;
  const moved = plan.confirmedInflowMinor ?? 0;
  // An account with no income of its own and nothing left in it had no surplus
  // to begin with. The em dash says so, and — the point of the exercise —
  // SHORTFALL does not appear at all, because the plan covers these bills.
  const left = leftOverMinor(plan);
  const nothingOfItsOwn = plan.monthlyIncomeMinor === 0 && arriving > 0;
  const note = inflowNote(plan);
  const moving = movedNote(plan);
  const loop = cycleNote(plan);

  return (
    <>
      <div className="kpis">
        <Kpi
          label="monthly income"
          value={nothingOfItsOwn ? "—" : formatMinor(plan.monthlyIncomeMinor, c)}
        />
        {arriving > 0 && (
          <Kpi
            label="arriving"
            value={formatMinor(arriving, c)}
            tone={moved >= arriving ? "ok" : "needs-you"}
            delta={moving ?? undefined}
          />
        )}
        <Kpi
          label="buffer"
          value={formatMinor(plan.bufferMinor, c)}
          onClick={onEditBuffer}
          ariaLabel={onEditBuffer ? "edit monthly buffer" : undefined}
        />
        <Kpi label="required / mo" value={formatMinor(plan.totalRequiredMinor, c)} />
        <Kpi
          label={plan.shortfallMinor > 0 ? "shortfall" : "left over"}
          value={
            plan.shortfallMinor > 0
              ? formatMinor(plan.shortfallMinor, c)
              : left === null
                ? "—"
                : formatMinor(left, c)
          }
          tone={plan.shortfallMinor > 0 || (left ?? 0) < 0 ? "warn" : "ok"}
          // A negative residual is decision 11's consolidation, and the one
          // thing a left-over figure must never be printed silently.
          delta={
            plan.shortfallMinor === 0 && (left ?? 0) < 0
              ? ["more leaves this account than reaches it — consolidate first"]
              : undefined
          }
        />
      </div>
      {(note || loop) && (
        <div className="plan-notes">
          {note && (
            <p>
              <Sentence phrase={note} />
            </p>
          )}
          {loop && <p className="needs-you">{loop}</p>}
        </div>
      )}
    </>
  );
}

function Kpi({
  label,
  value,
  tone,
  delta,
  onClick,
  ariaLabel,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "needs-you";
  /** Sub-line under the figure, e.g. how much of it has actually moved. */
  delta?: Phrase;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const className = `kpi ${tone ?? ""} ${onClick ? "clickable" : ""}`.trim();
  const content = (
    <>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {delta && (
        <div className={`kpi-delta ${tone ?? ""}`.trim()}>
          <Sentence phrase={delta} />
        </div>
      )}
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
