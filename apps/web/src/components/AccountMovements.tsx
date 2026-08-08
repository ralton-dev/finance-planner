import { useState } from "react";
import { api } from "../lib/api.js";
import { currentMonth } from "../lib/months.js";
import { money, type Phrase } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import type {
  AccountDto,
  AccountPlanDto,
  HouseholdRole,
  InflowDto,
  PlanInflowSourceDto,
  TransferConfirmationDto,
  UserDto,
} from "../lib/types.js";
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

/** And what a *person* whose name is withheld is called — the same words
 *  `PlanTable`'s `senderName` prints, for the same reason, restated here rather
 *  than imported because the two files each own their own copy of this absence
 *  (`lib/needsYou.ts` keeps a third for the same reason). */
const UNNAMED_MEMBER = "a household member";

/** One end of a movement the plan derived: authored by nobody, so it has no id
 *  to edit, no priority to reorder and no row to remove. */
export interface DerivedRow {
  key: string;
  /** The far end — the member the plan asks on the arriving side, the account
   *  the money goes to on the leaving one — or the honest absence when it may
   *  not be named. */
  name: string;
  amountMinor: number;
  /** Whether somebody has said this month's transfer actually moved. */
  settled: boolean;
  /** The member being asked, and the account they send from — what "I moved it"
   *  is scoped by, since nobody authored a row to point at. Absent on the
   *  leaving side, which reflects the tick and does not offer it: the
   *  confirmation endpoints are nested under the *receiving* account and take
   *  `edit` there, and this page holds no answer for the far end. */
  fromAccountId?: string;
  memberUserId?: string;
}

/** How a movement's cadence reads on one line. */
function cadence(inflow: InflowDto): string {
  if (inflow.frequency !== "custom") return inflow.frequency.replace(/_/g, "-");
  const r = inflow.recurrence;
  return r ? `every ${r.interval} ${r.unit}${r.interval === 1 ? "" : "s"}` : "custom";
}

/**
 * Money moving between two accounts, from whichever end you are standing on.
 *
 * Not "two accounts you own": authoring one takes `edit` at both ends and never
 * ownership (see `MovementDrawer`), so a co-member's account shared into your
 * household with edit is a legitimate end — and this section renders on such an
 * account as readily as on your own. The sentences below say only what they can
 * know from `account.owner`.
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
  // "I moved it", for the transfers the plan derives into this account. Who is
  // asking, because whose transfer a row is decides which of the two confirm
  // routes it takes — and, for somebody else's, which households the reader
  // could possibly be an admin of. And what has already been recorded this
  // month, because un-ticking needs the row's id and a derived confirmation has
  // no authored inflow to find it by.
  const me = useAsync<UserDto>(() => api.me(), []);
  const month = currentMonth();
  const confirmations = useAsync<TransferConfirmationDto[]>(
    () => api.listAccountConfirmations(account.id, month),
    [account.id, month],
  );
  const [target, setTarget] = useState<MovementTarget | null>(null);
  const [settling, setSettling] = useState<string | null>(null);

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
  // Every movement touching this account, whichever plan derives it: the rows
  // somebody authored, and the transfers the pass works out for the bills.
  const arrivingDerived = derivedArrivals(plan, me.data?.id);
  // Somebody else's derived transfer on this page, and whether this reader may
  // tick it. Read only when there is one: an account fed by nobody but the
  // reader needs no roster and asks for none, and the read is per page rather
  // than per row either way.
  const otherMemberIds = arrivingDerived
    .filter((r) => r.memberUserId && me.data?.id && r.memberUserId !== me.data.id)
    .map((r) => r.memberUserId)
    .sort()
    .join(",");
  const myHouseholdIds = (me.data?.households ?? []).map((h) => h.id).join(",");
  const wantsRoster = canEdit && otherMemberIds !== "" && myHouseholdIds !== "";
  const household = useAsync<HouseholdSettling | null>(
    () =>
      wantsRoster
        ? householdSettling(myHouseholdIds.split(","), otherMemberIds.split(","), month)
        : Promise.resolve(null),
    [wantsRoster, myHouseholdIds, otherMemberIds, month],
  );
  const actionFor = (row: DerivedRow): DerivedAction | null => {
    const fromAccountId = row.fromAccountId;
    const memberUserId = row.memberUserId;
    // Who is asking has not arrived yet, so the row cannot be told whose it is.
    // It offers nothing and explains nothing: both would be guesses.
    if (!canEdit || !fromAccountId || !memberUserId || !me.data) return null;

    const settle = (fn: () => Promise<unknown>) => async (): Promise<void> => {
      setSettling(row.key);
      try {
        await fn();
        confirmations.refetch();
        household.refetch();
        onChanged();
      } finally {
        setSettling(null);
      }
    };

    // Yours: the standalone route, scoped by the two accounts, the month and
    // you, with no household anywhere in it. It refuses anybody else's on
    // purpose — there is no roster in that scope to make a reader an admin of
    // somebody's own money moving — and that rule is unchanged here.
    if (memberUserId === me.data.id) {
      const mine = derivedConfirmationId(confirmations.data ?? [], row, account.id);
      return {
        kind: "control",
        label: mine ? "undo" : "moved",
        busy: settling === row.key,
        run: settle(() =>
          mine
            ? api.unconfirmDerivedTransfer(account.id, mine)
            : api.confirmDerivedTransfer(
                account.id,
                { fromAccountId, toAccountId: account.id, memberUserId },
                month,
              ),
        ),
      };
    }

    // Somebody else's, which is not the same question. A *household* transfer is
    // ticked through the household, and those routes keep decision 28's other
    // half: the member themselves, **or an owner or admin of that household**.
    // The account page simply never reached for them, so an owner got a dead row
    // here while the household's own checklist offered the very same action.
    if (household.loading) return null;
    const hh = household.data;
    if (!hh || !mayActForOthers(hh.role)) {
      return { kind: "note", text: `${row.name}'s to record — or a household owner or admin's` };
    }
    const ticked = householdConfirmationId(hh.confirmations, row, account.id, hh.id);
    if (!ticked && derivedConfirmationId(confirmations.data ?? [], row, account.id)) {
      // Already recorded on their own account page, which files it with no
      // household on it — and that route un-ticks only for the member who made
      // it. Offering "moved" here would write a *second* confirmation and book
      // the month's contributions twice, so this row says what happened instead.
      return { kind: "note", text: `${row.name} recorded this themselves — only they can undo it` };
    }
    return {
      kind: "control",
      label: ticked ? "undo" : "moved",
      busy: settling === row.key,
      run: settle(() =>
        ticked
          ? api.unconfirmTransfer(hh.id, ticked)
          : api.confirmTransfer(hh.id, {
              fromAccountId,
              toAccountId: account.id,
              memberUserId,
              month,
            }),
      ),
    };
  };
  // The other half of "every movement touching this account, in and out": the
  // transfers the plan asks this account's owner to make out of it — a member's
  // current account sends its share of every household bill and every
  // standalone pot's rent, all of it derived and none of it authored. LEFT OVER
  // already has it taken out, so without a word here the page reports a surplus
  // hundreds of pounds smaller than the income above it, with nothing saying
  // why. Read off the plan since WP-Y; it used to be recovered by rearranging
  // `residualMinor`'s identity.
  const leavingDerived = derivedDepartures(plan);
  const nothing =
    arriving.length === 0 &&
    leaving.length === 0 &&
    arrivingDerived.length === 0 &&
    leavingDerived.length === 0;
  if (nothing && !canEdit) return null;

  return (
    <>
      <div className="section-head">
        <h2>movements</h2>
        <span className="meta">[everything in and out · authored or derived]</span>
      </div>

      {loop && <p className="movement-loop">{loop}</p>}

      <div className="two-col">
        <MovementList
          heading="arriving here"
          empty="nothing moves into this account."
          addLabel="+ money in"
          rows={arriving}
          derived={arrivingDerived}
          derivedAction={actionFor}
          derivedArrow={(name) => `${name} →`}
          derivedNote="the plan derives this for the bills here — nobody authored it"
          account={account}
          canEdit={canEdit}
          canChange={canChange}
          nameOf={nameOf}
          arrow={(name) => `${name} →`}
          onAdd={() => setTarget({ direction: "in" })}
          onEdit={(editing) => setTarget({ direction: "in", editing })}
          onRemove={remove}
          note={duplicateFeedNote(plan, account)}
        />
        <MovementList
          heading="leaving here"
          empty="this account sends nothing on."
          addLabel="+ money out"
          rows={leaving}
          derived={leavingDerived}
          derivedArrow={(name) => `→ ${name}`}
          derivedNote="already taken out of left over above"
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

/**
 * What a derived row offers this reader: the one control it can have — "I moved
 * it", and its undo — or the reason there is none.
 *
 * The second half is the defect this shape exists for. An owner looking at their
 * partner's transfer got a bare line with no button and no account of why, which
 * reads as a page that forgot to finish rather than as a rule. A row that
 * explains itself is the floor here; a row that works is the ceiling, and which
 * of the two it gets is decided per reader.
 */
type DerivedAction =
  | { kind: "control"; label: string; busy: boolean; run: () => Promise<void> }
  | { kind: "note"; text: string };

/** The household an account is planned in, as much of it as this page needs:
 *  which one, what the reader may do in it, and what has already been ticked
 *  there this month. */
interface HouseholdSettling {
  id: string;
  role: HouseholdRole;
  /** This month's household confirmations — the only place a household row's id
   *  can be read, and so the only way to offer an undo for one. Empty for a
   *  reader who may not act for anybody else, who never asks for them. */
  confirmations: readonly TransferConfirmationDto[];
}

/** Whether a role may act for another member — the household routes' own rule,
 *  restated here so the button appears exactly where the API would allow it. */
const mayActForOthers = (role: HouseholdRole): boolean => role === "owner" || role === "admin";

/**
 * Which of the reader's households derives this account's member transfers, and
 * what the reader may do in it.
 *
 * **Nothing on the account plan says which household an account is planned in.**
 * `AccountPlanDto` carries no household id and neither does `AccountDto` — the
 * server knows (`scope.householdOf`) and simply does not publish it. What the
 * wire *does* carry is the answer sideways: `planInflowSources` publishes
 * another member's `memberUserId` only to a reader who is a member of the
 * household that account is planned in, so a `member` source naming somebody
 * else is the server's own proof that such a household exists and that the
 * reader belongs to it. The roster that holds that member is therefore the
 * household, and `yourRole` comes back on the same read.
 *
 * One request in practice, since a user belongs to exactly one household
 * (WP-W) — and one per *page*, never one per row. The loop is for data written
 * before that rule, and takes the first hit in the same order the API's own
 * `accountPlacements` does, so the two cannot disagree about which household an
 * account of a legacy two-household user is planned in.
 */
async function householdSettling(
  candidateIds: readonly string[],
  memberUserIds: readonly string[],
  month: string,
): Promise<HouseholdSettling | null> {
  const wanted = new Set(memberUserIds);
  for (const id of candidateIds) {
    const detail = await api.getHousehold(id);
    if (!detail.members.some((m) => wanted.has(m.userId))) continue;
    return {
      id,
      role: detail.yourRole,
      // A reader who may not act for anybody else is not charged for a list they
      // could do nothing with.
      confirmations: mayActForOthers(detail.yourRole)
        ? await api.listTransferConfirmations(id, month)
        : [],
    };
  }
  return null;
}

function MovementList({
  heading,
  empty,
  addLabel,
  rows,
  derived,
  derivedAction,
  derivedArrow,
  derivedNote,
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
  /** Movements the plan derived, which have no row to edit or remove. */
  derived: readonly DerivedRow[];
  /** What a derived row may be ticked with, when this caller may tick it — or
   *  the reason it may not be, when they may not. */
  derivedAction?: (row: DerivedRow) => DerivedAction | null;
  derivedArrow: (name: string) => string;
  derivedNote: string;
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
        <span className="meta">[{rows.length + derived.length}]</span>
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
      {derived.length > 0 && (
        <ul className="entity-list">
          {derived.map((row) => {
            const action = derivedAction?.(row) ?? null;
            return (
              <li key={`derived:${row.key}`}>
                <span>
                  {/* No name of its own: nobody wrote it down, so what it is
                      called is what it is — the plan's own feed. */}
                  <span className="name">derived transfer</span>
                  <em>
                    — <Amount minor={row.amountMinor} currency={account.currency} /> / monthly
                  </em>
                  <span className="shared movement-end" title={row.name}>
                    {derivedArrow(row.name)}
                  </span>
                  <span className={`tag-status ${row.settled ? "ok" : "idle"}`}>
                    {row.settled ? "moved" : "derived"}
                  </span>
                </span>
                {/* The only thing there is to do about a transfer nobody
                    authored: say that you made it, or take it back. There is no
                    row to edit and none to remove — and where there is nothing
                    to offer, the reason, because a row with neither a control
                    nor a word about it reads as an oversight. */}
                {action && (
                  <span className="row-actions">
                    {action.kind === "control" ? (
                      <button
                        type="button"
                        className="ghost tiny"
                        disabled={action.busy}
                        onClick={() => void action.run()}
                      >
                        {action.busy ? "…" : action.label}
                      </button>
                    ) : (
                      <span>{action.text}</span>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {derived.length > 0 && (
        <p className="muted" style={{ fontSize: "11.5px" }}>
          {derivedNote}
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
          {/* "nothing moves into this account" is only true when nothing does.
              A derived feed is money moving, so the empty state stands down to
              the narrower thing that is still true. */}
          {derived.length > 0 ? "nothing you authored." : empty}
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
 * an account genuinely does have that surplus before it moves any of it on
 * (decision 13), and the field keeps that meaning everywhere. Both figures are
 * right; read side by side without a word between them they look like a
 * contradiction. This is the word.
 *
 * The word used to spell out `leftover − outbound`, which is the right answer
 * only for an account nothing arrives at. Money arriving is not in LEFT OVER at
 * all, so on a pot that is fed and then sweeps on, that subtraction was simply a
 * wrong number — and LEFT OVER now prints `residualMinor`, which has the sweep
 * in it already (see `PlanTable.leftOverMinor`). So the note says which side of
 * the movement that figure is on, and quotes nothing it would only restate.
 *
 * ## Whose income it asks to be consolidated
 *
 * The negative branch is an instruction, and this page renders on an account a
 * co-member shared to you as readily as on your own. Told to consolidate **your**
 * income into somebody else's account, a reader is being asked to do a thing
 * about money that is not theirs and in a place they may not even be able to
 * edit. Ownership, never access (decision 20): the account's owner is who has
 * to move it, and `owner` absent reads as "cannot say" and so as not yours. The
 * diagnosis is unchanged either way — only who is being asked.
 */
export function outboundNote(plan: AccountPlanDto | undefined, account: AccountDto): Phrase | null {
  const leaving = plan?.outboundInflowMinor ?? 0;
  if (leaving <= 0) return null;
  const c = account.currency;
  const residual = plan?.residualMinor;
  const consolidate = account.owner
    ? " more than reaches this account — consolidate your income here first, or the month cannot happen."
    : " more than reaches this account — its owner has to consolidate their income here first, or the month cannot happen.";
  const tail: Phrase =
    residual === undefined
      ? [" left over above is what this account has before any of it moves on, not after."]
      : residual < 0
        ? [" that is ", money(-residual, c), consolidate]
        : [" left over above is what stays once it has."];
  return [money(leaving, c), " a month is already committed to leave.", ...tail];
}

/**
 * Decision 12, as the screen says it.
 *
 * A pot with a £400 bill and a £400 authored movement into it is **not** short
 * and **not** double-funded: the pass derives a £400 transfer to cover the bill
 * and then lands the movement on top as savings, so £800 arrives and £400 stays.
 * That is the engine working — netting the two would put savings money inside
 * expense arithmetic, which was rejected — and it is also almost certainly not
 * what whoever wrote the movement meant. So the flag's job is to offer deletion
 * of the redundant row, never to warn of a shortfall there is not.
 *
 * The signature is `transferInMinor > 0 && movementInMinor > 0` on one account.
 * Neither is on the wire by name, and both are exact: what authored movements
 * delivered is the sum of `inflowArrivals`, and what the derived feed delivered
 * is the rest of `allocatedInflowMinor`. Nothing is gated — the arrivals ride on
 * this very plan — so the **figure** reads the same for every caller who can see
 * the account. Verified rather than assumed: `scope.ts` pushes an arrival and
 * tallies `movementInMinor` under the same `inPartition` guard, so the sum of
 * the arrivals is exactly `movementInMinor` and `derived` is exactly
 * `transferInMinor`, for every caller.
 *
 * ## The two things the sentence used to claim, and could not
 *
 * It said "a movement **you** authored". Nothing here knows who authored one:
 * an inflow belongs to a pair of accounts and carries no author, authoring takes
 * `edit` on both ends, and this page renders on a pot a co-member shared to you
 * — so the movement landing on it may be theirs, out of an account of theirs
 * this reader cannot even see. The claim was unprovable rather than merely
 * unlikely, so it goes; the movement is named by what it is, which is authored
 * rather than derived.
 *
 * And it told the reader to delete it. `MovementList` draws the ✕ only when the
 * caller may edit **this** account, so on a view-only share the instruction
 * pointed at a control that is not on the page. It is now conditional on the
 * same access that decides whether the button exists.
 */
export function duplicateFeedNote(
  plan: AccountPlanDto | undefined,
  account: AccountDto,
): Phrase | null {
  if (!plan) return null;
  const authored = (plan.inflowArrivals ?? []).reduce((sum, a) => sum + a.amountMinor, 0);
  const derived = (plan.allocatedInflowMinor ?? 0) - authored;
  if (authored <= 0 || derived <= 0) return null;
  const canRemove = account.owner || account.permission === "edit";
  return [
    money(derived, account.currency),
    " a month already arrives here as a transfer the plan derives for these bills. an authored movement lands on top of it as savings, not instead of it" +
      (canRemove ? " — if it was meant to cover the bills, delete it." : "."),
  ];
}

/**
 * The feed nobody wrote down, from this account's side.
 *
 * `listInflows` only ever knew about authored rows, so an account fed entirely
 * by the pass showed "nothing moves into this account" while £303.20 a month
 * arrived. These are the same transfers the household plan lists and the flow
 * diagram draws, read off the account's own plan — one derivation, three
 * surfaces.
 */
export function derivedArrivals(
  plan: AccountPlanDto | undefined,
  viewerUserId?: string,
): DerivedRow[] {
  return (plan?.inflowSources ?? [])
    .filter((s) => s.kind === "member" && s.amountMinor > 0)
    .map((s) => {
      const source = s as Extract<PlanInflowSourceDto, { kind: "member" }>;
      return {
        key: source.memberUserId,
        // Access-gated on the wire; an absence is rendered as an absence —
        // except when the absence is about the reader. Decision 42 stopped the
        // server naming somebody no household in the scope rosters, which is
        // most often the person looking at this page: their account funds a pot
        // they can see, so they are in its scope and on nobody's roster. The
        // client holds their name already, so "you" is said here rather than
        // fetched there. Anyone else with a withheld name stays anonymous.
        name: source.displayName ?? (source.memberUserId === viewerUserId ? "you" : UNNAMED_MEMBER),
        amountMinor: source.amountMinor,
        settled: source.confirmedMinor >= source.amountMinor,
        fromAccountId: source.fromAccountId,
        memberUserId: source.memberUserId,
      };
    });
}

/**
 * The same feed from the other end: what the plan asks this account to send on,
 * one row per account it goes to.
 *
 * This was **one synthetic row** summing every derived transfer out — spotted on
 * the deployed build reading "£2,585.84 → your bills", which was in fact three
 * transfers to a bills pot and two shared pots. The far end was a set of
 * accounts, so it could not be named, and the label was a guess at what the set
 * had in common. `transferOutMinor` is still the right total and still on the
 * wire; it simply never said where the money went, and now the plan does.
 *
 * The second defect went with it. That row's `settled` was a hardcoded `false`,
 * because a scalar has no confirmation of its own — so a transfer ticked where
 * it lands could never read as moved from the account it leaves. Each of these
 * carries its own `confirmedMinor`, from either surface's tick.
 *
 * Reflected, never offered: no `fromAccountId`, so `MovementList` draws no
 * button. Confirming is `POST /accounts/:id/transfers/confirm` on the
 * **receiving** account and takes `edit` there — an access this page has no
 * answer for, since `canEdit` is about the account being shown. A tick here
 * would be a control whose authorisation the page cannot evaluate, and for a
 * household pot it would be a roster-blind second route to a fact the household
 * checklist already governs. The arriving side offers it because there the
 * receiving account *is* this account.
 */
export function derivedDepartures(plan: AccountPlanDto | undefined): DerivedRow[] {
  return (plan?.transferDepartures ?? [])
    .filter((d) => d.amountMinor > 0)
    .map((d) => ({
      // Both, because one destination can take a transfer from each member.
      key: `${d.toAccountId}:${d.memberUserId}`,
      // Access-gated on the wire; an absence is rendered as an absence, the
      // same way a sender that cannot be named is.
      name: d.toAccountName ?? UNNAMED,
      amountMinor: d.amountMinor,
      settled: d.confirmedMinor >= d.amountMinor,
    }));
}

/**
 * This month's confirmation of one derived transfer, if somebody has recorded it.
 *
 * A derived transfer carries neither a household nor an inflow — that is exactly
 * what makes it derived — so it is found the way it is scoped: by its two
 * accounts, its month and the member who moves it. The household rows are
 * deliberately excluded: those are un-confirmed through the household route,
 * which keeps its own rule about whose transfers a plain member may undo.
 */
export function derivedConfirmationId(
  confirmations: readonly TransferConfirmationDto[],
  row: DerivedRow,
  accountId: string,
): string | null {
  const hit = confirmations.find(
    (c) =>
      c.householdId === null &&
      !c.inflowId &&
      c.toAccountId === accountId &&
      c.fromAccountId === row.fromAccountId &&
      c.memberUserId === row.memberUserId,
  );
  return hit?.id ?? null;
}

/**
 * The same question of a *household's* own list: has this month's transfer been
 * ticked there?
 *
 * A second function rather than a relaxed filter on the one above, because the
 * exclusion up there is not a filter to loosen — it is the shape of the
 * endpoint. `GET /accounts/:id/transfers/confirmations` cannot return a
 * household's rows at all: the two store queries behind it ask for
 * `inflow_id NOT NULL` and for `household_id IS NULL AND inflow_id IS NULL`, so
 * a household row matches neither. And the id it yields is spent on
 * `DELETE /accounts/:id/transfers/confirmations/:confId`, which 404s on anything
 * carrying a household. Widening it would have produced a button that could only
 * fail. So the household's rows are asked for where they live, un-ticked through
 * the route that owns them, and the two lookups stay apart.
 */
export function householdConfirmationId(
  confirmations: readonly TransferConfirmationDto[],
  row: DerivedRow,
  accountId: string,
  householdId: string,
): string | null {
  const hit = confirmations.find(
    (c) =>
      c.householdId === householdId &&
      !c.inflowId &&
      c.toAccountId === accountId &&
      c.fromAccountId === row.fromAccountId &&
      c.memberUserId === row.memberUserId,
  );
  return hit?.id ?? null;
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
