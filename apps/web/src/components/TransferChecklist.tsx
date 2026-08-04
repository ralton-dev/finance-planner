import { useState } from "react";
import { ApiError } from "../lib/api.js";
import { formatDayMonth, formatMonth } from "../lib/months.js";
import { formatMinor } from "../lib/money.js";
import type {
  HouseholdPlanDto,
  MemberPaydayScheduleDto,
  TransferConfirmationDto,
  TransferDto,
} from "../lib/types.js";

interface Props {
  plan: HouseholdPlanDto;
  /** This month's confirmations, from GET /transfers/confirmations. */
  confirmations: TransferConfirmationDto[];
  onConfirm: (transfer: TransferDto) => Promise<unknown>;
  onUndo: (confirmationId: string) => Promise<unknown>;
  /** The month being checked off, "YYYY-MM". Display only. */
  month?: string;
}

/** A transfer is identified by who moves money from where to where. */
const keyOf = (t: { fromAccountId: string; toAccountId: string; memberUserId: string }): string =>
  `${t.fromAccountId}|${t.toAccountId}|${t.memberUserId}`;

/**
 * A member with no payday at all gets one synthetic event on the 1st, which is
 * indistinguishable from a real first-of-the-month payday client-side — so any
 * first-of-month event reads as "start of month" rather than a pay date.
 */
export function paydayLabel(date: string): string {
  return date.endsWith("-01") ? "start of month" : `pay day ${formatDayMonth(date)}`;
}

/**
 * The month's move-money checklist. Each planned transfer is either waiting or
 * done; confirming books the member's funded slice against the destination
 * account's payments, so the plan tracks money that actually moved.
 *
 * Confirmations survive plan changes, so any confirmation with no matching
 * planned transfer is listed too — otherwise it would be impossible to undo.
 */
export function TransferChecklist({ plan, confirmations, onConfirm, onUndo, month }: Props) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const c = plan.currency;
  const accountName = new Map(plan.accounts.map((a) => [a.accountId, a.name ?? "account"]));
  const memberName = new Map(plan.members.map((m) => [m.userId, m.displayName ?? "member"]));
  const confirmedBy = new Map(confirmations.map((x) => [keyOf(x), x]));
  const plannedKeys = new Set(plan.transfers.map(keyOf));
  const orphans = confirmations.filter((x) => !plannedKeys.has(keyOf(x)));

  async function run(key: string, fn: () => Promise<unknown>): Promise<void> {
    setBusyKey(key);
    setErrors((e) => ({ ...e, [key]: "" }));
    try {
      await fn();
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        [key]: e instanceof ApiError ? e.code : "something went wrong",
      }));
    } finally {
      setBusyKey(null);
    }
  }

  if (plan.transfers.length === 0 && orphans.length === 0) {
    return (
      <>
        <ChecklistHead done={0} total={0} month={month} />
        <p className="muted" style={{ fontSize: "12px" }}>
          no transfers needed — income already lands where it's spent.
        </p>
      </>
    );
  }

  const doneCount = plan.transfers.filter((t) => confirmedBy.has(keyOf(t))).length;

  return (
    <>
      <ChecklistHead done={doneCount} total={plan.transfers.length} month={month} />
      <table>
        <thead>
          <tr>
            <th>who</th>
            <th>from</th>
            <th>to</th>
            <th className="num">amount / mo</th>
            <th>status</th>
          </tr>
        </thead>
        <tbody>
          {plan.transfers.map((t) => {
            const key = keyOf(t);
            const done = confirmedBy.get(key);
            const error = errors[key];
            return (
              <tr key={key}>
                <td className="name">{memberName.get(t.memberUserId) ?? "member"}</td>
                <td className="muted">{accountName.get(t.fromAccountId) ?? "account"}</td>
                <td>{accountName.get(t.toAccountId) ?? "account"}</td>
                <td className="num">{formatMinor(t.amountMinor, c)}</td>
                <td>
                  {done ? (
                    <span className="checklist-cell">
                      <span className="tag-status ok">
                        done · {formatMinor(done.amountMinor, c)}
                      </span>
                      <button
                        type="button"
                        className="action muted"
                        disabled={busyKey === key}
                        onClick={() => void run(key, () => onUndo(done.id))}
                      >
                        undo
                      </button>
                    </span>
                  ) : (
                    <span className="checklist-cell">
                      <button
                        type="button"
                        className="ghost tiny"
                        disabled={busyKey === key}
                        onClick={() => void run(key, () => onConfirm(t))}
                      >
                        {busyKey === key ? "…" : "mark done"}
                      </button>
                    </span>
                  )}
                  {error && (
                    <span className="error checklist-error" role="alert">
                      {error}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}

          {orphans.map((x) => {
            const key = keyOf(x);
            const error = errors[key];
            return (
              <tr key={key} className="dim">
                <td className="muted">{memberName.get(x.memberUserId) ?? "member"}</td>
                <td className="muted">{accountName.get(x.fromAccountId) ?? "account"}</td>
                <td className="muted">{accountName.get(x.toAccountId) ?? "account"}</td>
                <td className="num dim">{formatMinor(x.amountMinor, c)}</td>
                <td>
                  <span className="checklist-cell">
                    <span className="tag-status idle">no longer planned</span>
                    <button
                      type="button"
                      className="action muted"
                      disabled={busyKey === key}
                      onClick={() => void run(key, () => onUndo(x.id))}
                    >
                      undo
                    </button>
                  </span>
                  {error && (
                    <span className="error checklist-error" role="alert">
                      {error}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <PaydayPlan
        schedule={plan.paydaySchedule ?? []}
        currency={c}
        memberName={memberName}
        accountName={accountName}
      />
    </>
  );
}

/**
 * When to move the money. The checklist above stays monthly — a confirmation
 * covers a whole transfer, not one payday's slice — so this is a breakdown of
 * the same plan, not a second set of things to tick off.
 */
function PaydayPlan({
  schedule,
  currency,
  memberName,
  accountName,
}: {
  schedule: MemberPaydayScheduleDto[];
  currency: string;
  memberName: Map<string, string>;
  accountName: Map<string, string>;
}) {
  const withEvents = schedule.filter((m) => m.events.length > 0);
  if (withEvents.length === 0) return null;
  const eventCount = withEvents.reduce((n, m) => n + m.events.length, 0);

  return (
    <>
      <div className="section-head">
        <h2>payday plan</h2>
        <span className="meta">
          [{eventCount} {eventCount === 1 ? "payday" : "paydays"} · when to move it]
        </span>
      </div>
      <div className="payday-list">
        {withEvents.map((member) =>
          member.events.map((event) => (
            <div key={`${member.memberUserId}|${event.date}`} className="payday-event">
              <div className="payday-head">
                <span className="name">{memberName.get(member.memberUserId) ?? "member"}</span>
                <span className="dim"> · {paydayLabel(event.date)}</span>
                <span className="spacer" />
                <b>{formatMinor(event.totalMinor, currency)}</b>
              </div>
              {event.transfers.length === 0 ? (
                <div className="payday-slice muted">nothing to move on this one</div>
              ) : (
                event.transfers.map((t, i) => (
                  <div key={`${t.fromAccountId}|${t.toAccountId}|${i}`} className="payday-slice">
                    <span className="payday-route">
                      {accountName.get(t.fromAccountId) ?? "account"} →{" "}
                      {accountName.get(t.toAccountId) ?? "account"}
                    </span>
                    <span className="num">{formatMinor(t.amountMinor, currency)}</span>
                  </div>
                ))
              )}
            </div>
          )),
        )}
      </div>
    </>
  );
}

function ChecklistHead({ done, total, month }: { done: number; total: number; month?: string }) {
  return (
    <div className="section-head">
      <h2>transfers</h2>
      <span className="meta">
        [{month ? `${formatMonth(month)} · ` : ""}
        {done}/{total} done]
      </span>
    </div>
  );
}
