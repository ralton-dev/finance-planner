import { useState } from "react";
import { api } from "../lib/api.js";
import { money, type Phrase } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type { AccountDto, AccountPlanDto, InflowDto } from "../lib/types.js";
import { Amount, Sentence } from "./Amount.js";
import { MovementDrawer, type MovementTarget } from "./MovementDrawer.js";

const NO_ACCOUNTS = Object.freeze([]) as readonly AccountDto[];

/**
 * What an account whose name is withheld is called.
 *
 * An account the caller cannot see and an account that does not exist answer
 * identically at the API, on purpose, and this must not be the screen that
 * tells them apart. "another account" is the same absence `PlanTable` prints,
 * and deliberately not "another of *your* accounts" — a caller who cannot see
 * the far end has not been told whose it is.
 */
const UNNAMED = "another account";

/** How a movement's cadence reads on one line. */
function cadence(inflow: InflowDto): string {
  if (inflow.frequency !== "custom") return inflow.frequency.replace(/_/g, "-");
  const r = inflow.recurrence;
  return r ? `every ${r.interval} ${r.unit}${r.interval === 1 ? "" : "s"}` : "custom";
}

/**
 * Money moving between two accounts you own, from whichever end you are
 * standing on.
 *
 * Both lists are the same authored rows read from opposite sides — arriving on
 * `accountId`, leaving `sourceAccountId` — so the two ends can never drift.
 * `listOutboundInflows` had no consumer at all until now: an account that sends
 * money had nothing anywhere saying what its surplus was already committed to,
 * which is the one question only the sending end can ask.
 *
 * External inflows are not here. They arrive through the income door above and
 * have no far end, no priority and nothing to confirm.
 *
 * ## The two access rules, as the buttons
 *
 * Authoring a movement takes `edit` on **both** accounts, because the row is a
 * standing claim on the sender's surplus. Removing one takes `edit` on
 * **either**, because releasing a claim can harm neither end — and the
 * symmetric rule would trap an owner whose account was shared, drained, and
 * then un-shared. So a row whose far end you cannot edit still offers *remove*
 * and does not offer *edit*: changing the amount would commit more of an
 * account you have no say over, which is the act that needs both.
 */
export function AccountMovements({
  account,
  plan,
  canEdit,
  onChanged,
}: {
  account: AccountDto;
  /** For the funding-loop note. Absent while the plan is still loading. */
  plan?: AccountPlanDto;
  /** Whether the caller may edit *this* account. */
  canEdit: boolean;
  /** Something was authored, changed or removed — re-read the plan. */
  onChanged: () => void;
}) {
  const inbound = useAsync<InflowDto[]>(() => api.listInflows(account.id), [account.id]);
  const outbound = useAsync<InflowDto[]>(() => api.listOutboundInflows(account.id), [account.id]);
  // The far ends' names, and which of them this caller may edit. One read; the
  // list is exactly the accounts they can see, which is the same gate the API
  // applies to a sending account's name.
  const accounts = useAsync<AccountDto[]>(() => api.listAccounts(), []);
  const [target, setTarget] = useState<MovementTarget | null>(null);

  const known = new Map((accounts.data ?? NO_ACCOUNTS).map((a) => [a.id, a]));
  const arriving = (inbound.data ?? []).filter((i) => i.source === "account");
  const leaving = (outbound.data ?? []).slice().sort((a, b) => a.priority - b.priority);

  const refresh = (): void => {
    inbound.refetch();
    outbound.refetch();
    onChanged();
  };

  const remove = async (inflow: InflowDto): Promise<void> => {
    await api.deleteInflow(inflow.id);
    refresh();
  };

  /** The far end of a row, from this account's side. */
  const otherIdOf = (inflow: InflowDto): string | null =>
    inflow.accountId === account.id ? inflow.sourceAccountId : inflow.accountId;

  const nameOf = (inflow: InflowDto): string => {
    const id = otherIdOf(inflow);
    return (id && known.get(id)?.name) || UNNAMED;
  };

  /** Changing a movement commits the far account's money, so it takes edit
   *  there too — the same rule as authoring one. */
  const canChange = (inflow: InflowDto): boolean => {
    const id = otherIdOf(inflow);
    const other = id ? known.get(id) : undefined;
    return canEdit && !!other && (other.owner || other.permission === "edit");
  };

  const loop = loopNote(plan, known, account);
  const nothing = arriving.length === 0 && leaving.length === 0;
  if (nothing && !canEdit) return null;

  return (
    <>
      <div className="section-head">
        <h2>movements</h2>
        <span className="meta">[between accounts you own · funded after every bill]</span>
      </div>

      {loop && <p className="movement-loop">{loop}</p>}

      <div className="two-col">
        <MovementList
          heading="arriving here"
          empty="nothing moves into this account."
          addLabel="+ money in"
          rows={arriving}
          account={account}
          canEdit={canEdit}
          canChange={canChange}
          nameOf={nameOf}
          arrow={(name) => `${name} →`}
          onAdd={() => setTarget({ direction: "in" })}
          onEdit={(editing) => setTarget({ direction: "in", editing })}
          onRemove={remove}
        />
        <MovementList
          heading="leaving here"
          empty="this account sends nothing on."
          addLabel="+ money out"
          rows={leaving}
          account={account}
          canEdit={canEdit}
          canChange={canChange}
          nameOf={nameOf}
          arrow={(name) => `→ ${name}`}
          onAdd={() => setTarget({ direction: "out" })}
          onEdit={(editing) => setTarget({ direction: "out", editing })}
          onRemove={remove}
          note={outboundNote(plan, account)}
        />
      </div>

      <MovementDrawer
        account={account}
        accounts={accounts.data ?? NO_ACCOUNTS}
        target={target}
        onClose={() => setTarget(null)}
        onSaved={refresh}
      />
    </>
  );
}

function MovementList({
  heading,
  empty,
  addLabel,
  rows,
  account,
  canEdit,
  canChange,
  nameOf,
  arrow,
  onAdd,
  onEdit,
  onRemove,
  note,
}: {
  heading: string;
  empty: string;
  addLabel: string;
  rows: readonly InflowDto[];
  account: AccountDto;
  canEdit: boolean;
  canChange: (inflow: InflowDto) => boolean;
  nameOf: (inflow: InflowDto) => string;
  arrow: (name: string) => string;
  onAdd: () => void;
  onEdit: (inflow: InflowDto) => void;
  onRemove: (inflow: InflowDto) => Promise<void>;
  /** A sentence under the heading, when there is one worth saying. */
  note?: Phrase | null;
}) {
  return (
    <div>
      <div className="section-head">
        <h2>{heading}</h2>
        <span className="meta">[{rows.length}]</span>
        <span className="spacer" />
        {canEdit && (
          <button type="button" className="action" onClick={onAdd}>
            {addLabel}
          </button>
        )}
      </div>
      {note && (
        <p className="plan-notes">
          <Sentence phrase={note} />
        </p>
      )}
      {rows.length > 0 ? (
        <ul className="entity-list">
          {rows.map((inflow) => (
            <li key={inflow.id}>
              <span>
                <span className="name">{inflow.name}</span>
                <em>
                  — <Amount minor={inflow.amountMinor} currency={account.currency} /> /{" "}
                  {cadence(inflow)}
                </em>
                <span className="shared movement-end" title={nameOf(inflow)}>
                  {arrow(nameOf(inflow))}
                </span>
                {!inflow.active && <span className="tag-status idle">paused</span>}
              </span>
              {canEdit && (
                <span className="row-actions">
                  {/* Disabled rather than absent, and it says why: the two
                      rules differ here and a missing button would look like an
                      oversight rather than the point. */}
                  <button
                    type="button"
                    className="ghost tiny"
                    disabled={!canChange(inflow)}
                    title={
                      canChange(inflow)
                        ? "edit"
                        : "changing a movement needs edit access to both accounts"
                    }
                    onClick={() => onEdit(inflow)}
                  >
                    edit
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    title="remove — takes edit access on either account, not both"
                    onClick={() => void onRemove(inflow)}
                  >
                    ✕
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted" style={{ fontSize: "12px" }}>
          {empty}
          {canEdit && (
            <>
              {" "}
              <button type="button" className="action" onClick={onAdd}>
                {addLabel} →
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * What LEFT OVER above does not know.
 *
 * `outboundInflowMinor` is deliberately *not* subtracted from `leftoverMinor` —
 * an account genuinely does have that surplus before it moves any of it on, and
 * the estate rollup nets the pound once, centrally, rather than at both ends.
 * Both figures are right; read side by side without a word between them they
 * look like a contradiction. This is the word.
 */
export function outboundNote(plan: AccountPlanDto | undefined, account: AccountDto): Phrase | null {
  const leaving = plan?.outboundInflowMinor ?? 0;
  if (leaving <= 0) return null;
  return [
    money(leaving, account.currency),
    " a month is already committed to leave. left over above is what this account has before any of it moves on, not after.",
  ];
}

/**
 * A funding loop, named account by account.
 *
 * A cycle is never refused at authoring — it is a property of the estate rather
 * than of the edge that closes it, and rows arrive by import and restore where
 * no authoring check could ever have run. So the plan detects it, breaks it at
 * one edge and reports it, and the screen is the only thing that can explain
 * what happened to somebody who has just saved the closing edge.
 *
 * `PlanSummary` already says a loop exists and how many accounts are in it.
 * This says *which*, in the order money would travel, next to the movements
 * that make it — which is the difference between a warning and an explanation.
 * Naming them is the whole of the honest minimum: which edge to remove is the
 * user's call, and the plan's choice of where to break it is arbitrary by
 * design.
 */
export function loopNote(
  plan: AccountPlanDto | undefined,
  known: Map<string, AccountDto>,
  account: AccountDto,
): string | null {
  const cycle = plan?.fundingCycleAccountIds ?? [];
  if (cycle.length === 0) return null;
  const names = cycle.map((id) =>
    id === account.id ? account.name : (known.get(id)?.name ?? UNNAMED),
  );
  // Closed back to the start, because that is the hop the plan ignores.
  const round = [...names, names[0]].join(" → ");
  return `funding loop · ${round}. the plan ignores the last hop so the rest can still be computed — remove one of these movements to break the loop where you mean to.`;
}
