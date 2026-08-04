import {
  splitByShares,
  type AccountRole,
  type PaymentCategory,
  type PaymentScope,
} from "@finance-planner/contracts";
import { parseISODate } from "./dates.js";
import { contributionCapMinor, monthlyIncomeMinor, requiredMonthlyForPayment } from "./engine.js";
import {
  buildFundingEdges,
  orderAccounts,
  type EstateCycle,
  type EstateMovementStatus,
  type FundingEdge,
} from "./estate.js";
import type { MemberAllocation, Transfer } from "./household.js";
import type {
  ConfirmedArrival,
  IncomeInput,
  InflowArrival,
  InflowInput,
  OutboundInflowInput,
  PaymentInput,
} from "./types.js";

/**
 * **One funding pass over a scope. Everything else is a view of it.**
 *
 * A scope is a set of accounts and the members whose money they are. A household
 * is a scope with sharing rules; a solo user is a household of one at a 100%
 * share, planned by the same pass with degenerate attribution. There is one
 * funding loop, one derivation of leftover, and one concept of money crossing an
 * account boundary — which is the point. Two engines that each planned part of
 * the same estate could only ever agree by coincidence, and did not: the same
 * account read £2,793 left over on the household page and £2,093 on the flow
 * diagram, one authored movement apart (see `ONE-ENGINE.md`).
 *
 * ## The phases
 *
 * 1. **Attribution.** Every active payment on every in-scope account becomes
 *    obligations attributed to members — `splitByShares` for shared scope, the
 *    bearer (or the owning member) for personal. A personal account's buffer
 *    reduces its member's budget; a shared pot's buffer is an obligation at
 *    `RESERVE_PRIORITY`.
 * 2. **Expense funding.** Obligations fund from pooled member budgets in **one
 *    global priority order**: household-shared and personal intertwined, so a
 *    household bill at priority 5 beats a personal bill at 10 and vice versa
 *    (decision 8). No account funds in a private order of its own.
 * 3. **Derived transfers.** Funded obligations that cross an account boundary
 *    become the transfers each member must make, out of their source account
 *    (decision 11). This is how an expense-bearing account with no income gets
 *    fed — household or not, authored by nobody (decision 9).
 * 4. **Savings.** Authored movements fund **last**, per sending account, out of
 *    what the expenses and the derived transfers left, in their own priority
 *    order, through the estate machinery unchanged: dependency-ordered,
 *    iterative, loops detected and broken with the edge named (`estate.ts`).
 *
 * ## Why derived transfers cannot cycle, and authored movements can
 *
 * A derived transfer is never *funded from* another derived transfer. Every one
 * of them is paid for out of a member budget, and a member's budget is their own
 * external income (phase 1) less their own buffer — money that is settled before
 * a single transfer is derived. Each member's transfers therefore form a star of
 * depth one radiating from `memberSource`, and money never chains: there is
 * nothing to order, so there is no order to be circular. Two members' stars can
 * overlap into a two-cycle in the drawn graph (A's source funds B's pot while B's
 * source funds A's) and it still costs nothing, because neither edge waits on the
 * other.
 *
 * An authored movement is the opposite: it spends what the *sending account* has
 * left, so A → B → C → A really is a loop with nothing to start it. Phase 4 keeps
 * `estate.ts`'s answer verbatim — one iterative DFS, deterministic root and
 * out-edge order, each loop broken at exactly one edge, that edge reported as
 * `broken_cycle` and funding nothing.
 *
 * ## Per currency, first (decision 10)
 *
 * The accounts are partitioned by currency and the four phases run per
 * partition. Nothing derived crosses a currency: a member's income, budget and
 * source account are all read within the partition, so an obligation with no
 * same-currency source in scope simply goes unfunded and is reported as an
 * honest shortfall rather than being covered by money that cannot reach it.
 */

const DEFAULT_PRIORITY = 100;
/** Buffer reservations fund after every dated payment. */
const RESERVE_PRIORITY = Number.MAX_SAFE_INTEGER;
const FAR_FUTURE = "9999-12-31";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A member of the scope, with a proportional contribution to shared costs. */
export interface ScopeMemberInput {
  userId: string;
  displayName?: string;
  /** Relative contribution weight (basis points). Normalised by the pass
   *  against the scope total, so the absolute scale is free. */
  shareBp: number;
}

/** A payment carrying its cost-sharing classification. */
export interface ScopePaymentInput extends PaymentInput {
  scope: PaymentScope;
  /** When scope === "personal": the member who bears it. Falls back to a
   *  personal account's owning member. */
  bearerUserId?: string | null;
}

/** An account in the scope, with its role and everything on it. */
export interface ScopeAccountInput {
  accountId: string;
  name?: string;
  role: AccountRole;
  /** Set when role === "personal": the member who owns this account. For a solo
   *  user that is the owner, on every account they have. */
  memberUserId?: string | null;
  currency: string;
  monthlyBufferMinor?: number;
  /** The account's **external** inflows — money entering the estate. */
  incomes: IncomeInput[];
  payments: ScopePaymentInput[];
  /** Every inflow authored on this account, read only to notice a movement
   *  whose sender is outside the scope (`unknown_source`). */
  inflows?: InflowInput[];
  /** Authored savings movements **leaving** this account (decision 9). */
  outboundInflows?: OutboundInflowInput[];
  /** Authored movements arriving here that somebody has said actually moved. */
  confirmedArrivals?: ConfirmedArrival[];
}

/**
 * Somebody has said a **derived** transfer happened.
 *
 * Scoped by who moved it and between which two accounts, because a derived
 * transfer has no authored row to name — that is exactly what makes it derived.
 * Clamped by the pass to what the transfer actually came to, for the same reason
 * `ConfirmedArrival` is: a confirmation outlives the plan that derived it.
 */
export interface ConfirmedTransfer {
  fromAccountId: string;
  toAccountId: string;
  memberUserId: string;
  confirmedMinor: number;
}

/**
 * One scope, as the pass is handed it.
 *
 * `members` defaults to nothing meaningful: a caller with no household applying
 * passes the owner alone at a 100% share, and the pass then plans them exactly as
 * it plans a household of two. A scope with no members at all attributes nothing
 * and reports every obligation as a shortfall, which is the honest answer to
 * "whose money is this?" when nobody has said.
 */
export interface ScopeInput {
  /** The household's id, or the owner's — whatever identifies this scope. */
  scopeId: string;
  /** Set when the scope *is* a household, so a view can say so. */
  householdId?: string | null;
  members: ScopeMemberInput[];
  accounts: ScopeAccountInput[];
  confirmedTransfers?: ConfirmedTransfer[];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * One payment, as the pass funded it.
 *
 * Carries everything a view needs so that no view has to run
 * `requiredMonthlyForPayment` again and risk answering a slightly different
 * question: the amount, the dates, the split across members, and the own/inflow
 * split of what it was funded with.
 */
export interface ScopePlanLine {
  paymentId: string;
  accountId: string;
  currency: string;
  name: string;
  category: PaymentCategory;
  scope: PaymentScope;
  amountMinor: number;
  dueDate: string;
  targetDate: string;
  /** True when the pace chose the date rather than the user — see
   *  `PaymentPlanLine.dueDateIsDerived`. */
  dueDateIsDerived: boolean;
  monthsUntilDue: number;
  priority: number;
  requiredMonthlyMinor: number;
  fundedMonthlyMinor: number;
  /** Of `fundedMonthlyMinor`, the part the account's own income paid for. */
  fundedFromOwnMinor: number;
  /** Of `fundedMonthlyMinor`, the part paid for by money arriving — a derived
   *  transfer, or an authored movement. Sums with the above exactly. */
  fundedFromInflowMinor: number;
  alreadySavedMinor: number;
  occurrencesThisMonth: number;
  onTrack: boolean;
  /** Passthrough of the payment's grouping label. */
  tag?: string | null;
  allocations: MemberAllocation[];
}

/** A derived transfer, with what has been confirmed of it. */
export interface DerivedTransfer extends Transfer {
  currency: string;
  /** How much of `amountMinor` somebody has said actually moved (<= it). */
  confirmedMinor: number;
}

/** One authored savings movement, as the pass resolved it. */
export interface ScopeMovement {
  /** The authored inflow's id — one row, read from both ends. */
  inflowId: string;
  fromAccountId: string;
  toAccountId: string;
  currency: string;
  priority: number;
  /** The movement's monthly amount as authored. */
  requestedMinor: number;
  /** What the sender could afford once its expenses and its owners' derived
   *  transfers were paid for. */
  fundedMinor: number;
  /** Of `fundedMinor`, the part the sending account's own income paid for. */
  fundedFromOwnMinor: number;
  /** Of `fundedMinor`, the part passed on out of money that arrived. */
  fundedFromInflowMinor: number;
  status: EstateMovementStatus;
}

export interface ScopeMemberPlan {
  userId: string;
  displayName?: string;
  currency: string;
  /** Share normalised to sum 10000 across members, for display. */
  shareBp: number;
  monthlyIncomeMinor: number;
  /** Total monthly cost attributed to this member in this currency. */
  obligationMinor: number;
  fundedMinor: number;
  /** Discretionary surplus after the buffer + obligations (>= 0). Keeps its
   *  meaning exactly (decision 13): it is **not** reduced by `committedMinor`. */
  leftoverMinor: number;
  /** Of that leftover, what funded savings movements out of this member's own
   *  accounts have spoken for (decision 13). Added alongside, never netted. */
  committedMinor: number;
  /** Obligation the member's income in this currency can't cover (>= 0). */
  shortfallMinor: number;
  /** The account this member's derived transfers leave, in this currency
   *  (decision 11): their personal account with the most external income. Null
   *  when they have no personal account in this currency — every obligation of
   *  theirs here is then a shortfall, honestly. */
  sourceAccountId: string | null;
}

export interface ScopeAccountPlan {
  accountId: string;
  name?: string;
  role: AccountRole;
  memberUserId: string | null;
  currency: string;
  /** The account's **own** external income only. */
  monthlyIncomeMinor: number;
  bufferMinor: number;
  /** Bills falling due out of this account each month, and what they got. */
  requiredOutflowMinor: number;
  fundedOutflowMinor: number;
  /** Derived transfers in and out — expense transport, authored by nobody. */
  transferInMinor: number;
  transferOutMinor: number;
  /** What authored savings movements delivered into this account. */
  movementInMinor: number;
  /** What funded savings movements take out of it (decision 13). */
  committedMinor: number;
  /** Everything arriving: derived transfers plus authored movements. */
  allocatedInflowMinor: number;
  /** How much of that somebody has said actually moved. */
  confirmedInflowMinor: number;
  /**
   * The account's **own** income after its own obligations and after the
   * derived transfers its owner has to make — `AccountPlan.leftoverMinor`'s
   * figure, which keeps its meaning (decision 13) and is deliberately not
   * reduced by `committedMinor`.
   *
   * Money that merely arrived is excluded, so summing this across an estate
   * does not double-count a pound at every hop.
   */
  ownLeftoverMinor: number;
  /**
   * What is left in the account once the month's flows have happened:
   *
   *     income + arriving − spending − leaving
   *
   * The figure a diagram needs, where a node whose ribbons do not meet is a
   * drawing that lies. **Signed**: negative means a member is committed to
   * moving more out of this account than reaches it, which happens exactly when
   * they hold income in a personal account other than their source one
   * (decision 11) and have to consolidate first. Flooring it would hide that.
   */
  leftoverMinor: number;
  shortfallMinor: number;
  /** What each authored movement delivered here. Empty when none did. */
  inflowArrivals: InflowArrival[];
  /** The accounts in the authored-movement loop this account is on, if any. */
  fundingCycleAccountIds?: string[];
  /** The one movement on that loop the pass ignored to break it. */
  fundingCycleBrokenInflowId?: string;
}

/** The pass's answer for one currency. Nothing here crosses into another. */
export interface ScopeCurrencyPlan {
  currency: string;
  /** Every account's own external income, summed. */
  monthlyIncomeMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  /** Members' discretionary surplus plus income sitting in accounts no member
   *  owns (a shared pot's own income, chiefly). */
  leftoverMinor: number;
  /** Of that, what funded savings movements have spoken for. */
  committedMinor: number;
  shortfallMinor: number;
  members: ScopeMemberPlan[];
  accounts: ScopeAccountPlan[];
  /** In funding order: the order the pass spent the month's money in. */
  lines: ScopePlanLine[];
  transfers: DerivedTransfer[];
  movements: ScopeMovement[];
  /** Empty in the overwhelmingly normal case. */
  cycles: EstateCycle[];
}

export interface ScopePlan {
  scopeId: string;
  householdId: string | null;
  asOfDate: string;
  /** One per currency present in the scope, in alphabetical order. */
  partitions: ScopeCurrencyPlan[];
  /** Every partition's accounts, in partition order. */
  accounts: ScopeAccountPlan[];
  /** Every partition's lines, in partition order. */
  lines: ScopePlanLine[];
  transfers: DerivedTransfer[];
  movements: ScopeMovement[];
  cycles: EstateCycle[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** One unit of money a member must get into an account by a deadline. */
interface Obligation {
  accountId: string;
  memberIdx: number;
  requiredMinor: number;
  fundedMinor: number;
  priority: number;
  sortDate: string;
  /** Set for payment-derived obligations; absent for buffer reservations. */
  lineIdx?: number;
}

/**
 * The date a payment is ranked by when two priorities tie.
 *
 * The account engine's key, deliberately — `targetDate ?? dueDate ?? never`, the
 * date the *user* wrote — so that generalising the funding loop cannot reorder a
 * solo user's month. It differs from the payment's computed next occurrence for
 * an undated monthly bill and for a yearly bill whose anchor is in the past;
 * where the two disagree, the authored date wins, here and in `engine.ts`, and
 * now in one place rather than two.
 */
function sortDateOf(p: PaymentInput): string {
  return p.targetDate ?? p.dueDate ?? FAR_FUTURE;
}

/** A member's income, buffer and source account, within one currency. */
interface MemberMoney {
  incomeMinor: number;
  bufferMinor: number;
  sourceAccountId: string | null;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Plan a whole scope as of `asOfDate` — the one funding pass.
 *
 * `input` is not mutated, and neither are its accounts. Account order is the
 * caller's throughout, which is what fixes every tie-break: a scope is a list
 * somebody made, and it must not start reordering itself by the shape of the
 * funding graph.
 */
export function computeScopePlan(input: ScopeInput, asOfDate: string): ScopePlan {
  const now = parseISODate(asOfDate);
  const currencies = [...new Set(input.accounts.map((a) => a.currency))].sort();
  const partitions = currencies.map((currency) => planCurrency(input, currency, now));

  return {
    scopeId: input.scopeId,
    householdId: input.householdId ?? null,
    asOfDate,
    partitions,
    accounts: partitions.flatMap((p) => p.accounts),
    lines: partitions.flatMap((p) => p.lines),
    transfers: partitions.flatMap((p) => p.transfers),
    movements: partitions.flatMap((p) => p.movements),
    cycles: partitions.flatMap((p) => p.cycles),
  };
}

function planCurrency(input: ScopeInput, currency: string, now: Date): ScopeCurrencyPlan {
  const members = input.members;
  const memberIdx = new Map(members.map((m, i) => [m.userId, i] as const));
  const shareWeights = members.map((m) => Math.max(0, m.shareBp));
  const totalShareBp = shareWeights.reduce((s, w) => s + w, 0);
  const accounts = input.accounts.filter((a) => a.currency === currency);
  const inPartition = new Set(accounts.map((a) => a.accountId));

  // ---- phase 1: attribution -----------------------------------------------

  const accountIncome = new Map<string, number>();
  for (const acc of accounts) {
    accountIncome.set(
      acc.accountId,
      acc.incomes.reduce((sum, i) => sum + monthlyIncomeMinor(i, now), 0),
    );
  }

  // Per member, within this currency: what they earn, what their own buffers
  // reserve, and the account their transfers leave (decision 11 — the personal
  // account with the most external income, lowest id breaking a tie).
  const money: MemberMoney[] = members.map(() => ({
    incomeMinor: 0,
    bufferMinor: 0,
    sourceAccountId: null,
  }));
  for (let i = 0; i < members.length; i++) {
    const personal = accounts
      .filter((a) => a.role === "personal" && a.memberUserId === members[i]!.userId)
      .sort((a, b) => (a.accountId < b.accountId ? -1 : 1));
    let bestIncome = -1;
    for (const a of personal) {
      const income = accountIncome.get(a.accountId)!;
      money[i]!.incomeMinor += income;
      money[i]!.bufferMinor += Math.max(0, a.monthlyBufferMinor ?? 0);
      if (income > bestIncome) {
        bestIncome = income;
        money[i]!.sourceAccountId = a.accountId;
      }
    }
  }

  const lines: ScopePlanLine[] = [];
  /** Each line's tie-break date, parallel to `lines` — the authored key phase 2
   *  ranks by, which is not the same as the computed `targetDate`. */
  const lineSortDate: string[] = [];
  const obligations: Obligation[] = [];

  for (const acc of accounts) {
    for (const p of acc.payments) {
      if (p.active === false) continue;
      const req = requiredMonthlyForPayment(p, now);
      const priority = p.priority ?? DEFAULT_PRIORITY;

      // Attribute the required amount to members.
      const allocReq = members.map(() => 0);
      if (p.scope === "personal") {
        const bearer = p.bearerUserId ?? (acc.role === "personal" ? acc.memberUserId : null);
        const bi = bearer != null ? memberIdx.get(bearer) : undefined;
        if (bi !== undefined) {
          allocReq[bi] = req.requiredMinor;
        } else {
          // Unresolvable bearer → fall back to a shared split so it's still
          // someone's responsibility rather than silently unfunded.
          splitByShares(req.requiredMinor, shareWeights).forEach((v, i) => (allocReq[i] = v));
        }
      } else {
        splitByShares(req.requiredMinor, shareWeights).forEach((v, i) => (allocReq[i] = v));
      }

      const lineIdx = lines.length;
      lines.push({
        paymentId: p.id,
        accountId: acc.accountId,
        currency,
        name: p.name,
        category: p.category,
        scope: p.scope,
        amountMinor: p.amountMinor,
        dueDate: p.dueDate ?? req.effectiveDate,
        targetDate: req.effectiveDate,
        dueDateIsDerived: contributionCapMinor(p) !== null && !p.targetDate && !p.dueDate,
        monthsUntilDue: req.monthsUntilDue,
        priority,
        requiredMonthlyMinor: req.requiredMinor,
        fundedMonthlyMinor: 0,
        fundedFromOwnMinor: 0,
        fundedFromInflowMinor: 0,
        alreadySavedMinor: p.alreadySavedMinor ?? 0,
        occurrencesThisMonth: req.occurrencesThisMonth,
        onTrack: false,
        tag: p.tag ?? null,
        allocations: members.map((m) => ({ userId: m.userId, requiredMinor: 0, fundedMinor: 0 })),
      });
      lineSortDate.push(sortDateOf(p));
      for (let i = 0; i < members.length; i++) {
        lines[lineIdx]!.allocations[i]!.requiredMinor = allocReq[i]!;
        if (allocReq[i]! > 0) {
          obligations.push({
            accountId: acc.accountId,
            memberIdx: i,
            requiredMinor: allocReq[i]!,
            fundedMinor: 0,
            priority,
            sortDate: sortDateOf(p),
            lineIdx,
          });
        }
      }
    }

    // A shared pot's buffer is a reserve the members fund into it
    // proportionally, at the lowest priority. A personal account's buffer comes
    // off its member's budget instead, above.
    const buffer = Math.max(0, acc.monthlyBufferMinor ?? 0);
    if (acc.role !== "personal" && buffer > 0) {
      splitByShares(buffer, shareWeights).forEach((v, i) => {
        if (v > 0) {
          obligations.push({
            accountId: acc.accountId,
            memberIdx: i,
            requiredMinor: v,
            fundedMinor: 0,
            priority: RESERVE_PRIORITY,
            sortDate: FAR_FUTURE,
          });
        }
      });
    }
  }

  // ---- phase 2: expense funding, one global priority order ----------------
  //
  // Decision 8. Every obligation in the scope queues together — the household's
  // rent and your own gym membership, on whichever account each is paid from —
  // and each member spends their own budget down that one queue. An account
  // never funds in a private order, which is the whole reason two accounts of
  // one estate can no longer disagree about the same pound.
  const budget = members.map((_, i) => Math.max(0, money[i]!.incomeMinor - money[i]!.bufferMinor));
  const remaining = budget.slice();
  const orderedObligations = obligations
    .map((o, idx) => ({ o, idx }))
    .sort(
      (a, b) =>
        a.o.priority - b.o.priority ||
        (a.o.sortDate < b.o.sortDate ? -1 : a.o.sortDate > b.o.sortDate ? 1 : 0) ||
        a.idx - b.idx,
    );
  for (const { o } of orderedObligations) {
    const funded = Math.max(0, Math.min(o.requiredMinor, remaining[o.memberIdx]!));
    o.fundedMinor = funded;
    remaining[o.memberIdx]! -= funded;
    if (o.lineIdx !== undefined) {
      lines[o.lineIdx]!.allocations[o.memberIdx]!.fundedMinor = funded;
    }
  }

  // The lines in the order the money was spent — the same key the obligations
  // queued by, so an account's slice of this list is that account's funding
  // order and a view can read the own/inflow split straight off it.
  const orderedLines = lines
    .map((line, idx) => ({ line, idx }))
    .sort(
      (a, b) =>
        a.line.priority - b.line.priority ||
        (lineSortDate[a.idx]! < lineSortDate[b.idx]!
          ? -1
          : lineSortDate[a.idx]! > lineSortDate[b.idx]!
            ? 1
            : 0) ||
        a.idx - b.idx,
    )
    .map(({ line }) => line);

  for (const line of lines) {
    line.fundedMonthlyMinor = line.allocations.reduce((s, a) => s + a.fundedMinor, 0);
    line.onTrack = line.fundedMonthlyMinor >= line.requiredMonthlyMinor;
  }

  // ---- phase 3: derived transfers -----------------------------------------
  //
  // Funded obligations that cross an account boundary, radiating from each
  // member's source account. Nothing waits on anything: see the module comment
  // for why this cannot cycle however the stars overlap.
  const confirmedTransfers = new Map<string, number>();
  for (const c of input.confirmedTransfers ?? []) {
    const key = transferKey(c.fromAccountId, c.toAccountId, c.memberUserId);
    confirmedTransfers.set(key, (confirmedTransfers.get(key) ?? 0) + Math.max(0, c.confirmedMinor));
  }

  const transferMap = new Map<string, DerivedTransfer>();
  for (const o of obligations) {
    if (o.fundedMinor <= 0) continue;
    const from = money[o.memberIdx]!.sourceAccountId;
    if (!from || from === o.accountId) continue; // no source, or internal
    const key = `${from}→${o.accountId}→${o.memberIdx}`;
    const existing = transferMap.get(key);
    if (existing) {
      existing.amountMinor += o.fundedMinor;
    } else {
      transferMap.set(key, {
        fromAccountId: from,
        toAccountId: o.accountId,
        memberUserId: members[o.memberIdx]!.userId,
        currency,
        amountMinor: o.fundedMinor,
        confirmedMinor: 0,
      });
    }
  }
  const transfers = [...transferMap.values()].sort(
    (a, b) =>
      (a.fromAccountId < b.fromAccountId ? -1 : a.fromAccountId > b.fromAccountId ? 1 : 0) ||
      (a.toAccountId < b.toAccountId ? -1 : a.toAccountId > b.toAccountId ? 1 : 0) ||
      (a.memberUserId < b.memberUserId ? -1 : a.memberUserId > b.memberUserId ? 1 : 0),
  );
  for (const t of transfers) {
    // Clamped to what the transfer actually came to. A confirmation outlives the
    // plan that derived it, so one taken in a month a member owed £300 must not
    // still credit £300 in a month they owe £120.
    t.confirmedMinor = Math.min(
      t.amountMinor,
      confirmedTransfers.get(transferKey(t.fromAccountId, t.toAccountId, t.memberUserId)) ?? 0,
    );
  }

  const transferIn = tally(accounts);
  const transferOut = tally(accounts);
  const confirmedIn = tally(accounts);
  for (const t of transfers) {
    transferIn.set(t.toAccountId, transferIn.get(t.toAccountId)! + t.amountMinor);
    transferOut.set(t.fromAccountId, transferOut.get(t.fromAccountId)! + t.amountMinor);
    confirmedIn.set(t.toAccountId, confirmedIn.get(t.toAccountId)! + t.confirmedMinor);
  }

  // ---- the own/inflow split, per account, in funding order ----------------
  //
  // Own income is spent first, exactly as the account engine spends it, so the
  // split falls straight out of the order phase 2 already fixed. What is left of
  // each pool afterwards is what phase 4 has to work with.
  const ownPool = new Map<string, number>();
  const inflowPool = new Map<string, number>();
  for (const acc of accounts) {
    const income = accountIncome.get(acc.accountId)!;
    ownPool.set(acc.accountId, Math.max(0, income - Math.max(0, acc.monthlyBufferMinor ?? 0)));
    inflowPool.set(acc.accountId, transferIn.get(acc.accountId)!);
  }
  const fundedOutflow = tally(accounts);
  const requiredOutflow = tally(accounts);
  for (const line of orderedLines) {
    const paid = Math.min(line.fundedMonthlyMinor, line.requiredMonthlyMinor);
    const fromOwn = Math.min(paid, ownPool.get(line.accountId)!);
    ownPool.set(line.accountId, ownPool.get(line.accountId)! - fromOwn);
    const fromInflow = paid - fromOwn;
    inflowPool.set(line.accountId, inflowPool.get(line.accountId)! - fromInflow);
    line.fundedFromOwnMinor = fromOwn;
    line.fundedFromInflowMinor = fromInflow;
    // The *bills*, taken off the lines rather than off the member obligations
    // that pay for them: buffer reserves never leave the account, and neither do
    // the pennies members round their shares up by. A bill costs what it costs.
    fundedOutflow.set(line.accountId, fundedOutflow.get(line.accountId)! + paid);
    requiredOutflow.set(
      line.accountId,
      requiredOutflow.get(line.accountId)! + line.requiredMonthlyMinor,
    );
  }

  // A reserve is money savings may not touch. The account engine takes the
  // buffer off the account's *own* income and deliberately not off what arrives,
  // because a shared pot's buffer arrives earmarked — it is funded as an
  // obligation at `RESERVE_PRIORITY` and would otherwise be reserved twice. What
  // that leaves is a pot whose own income is smaller than its buffer holding the
  // reserve in the arriving money, where a savings sweep could take it. So the
  // part of the buffer the own income could not cover is withheld here instead:
  // reserved exactly once, and never spendable.
  const heldBack = new Map<string, number>();
  for (const acc of accounts) {
    const buffer = Math.max(0, acc.monthlyBufferMinor ?? 0);
    heldBack.set(acc.accountId, Math.max(0, buffer - accountIncome.get(acc.accountId)!));
  }

  // Derived transfers leave the same two pools, own money first. A pool can be
  // short here without anything being wrong: a member whose income sits in a
  // personal account other than their source one is expected to consolidate
  // first, which `ScopeAccountPlan.leftoverMinor` reports as a negative residual
  // rather than hiding.
  for (const acc of accounts) {
    let out = transferOut.get(acc.accountId)!;
    if (out <= 0) continue;
    const own = Math.max(0, ownPool.get(acc.accountId)!);
    const fromOwn = Math.min(own, out);
    ownPool.set(acc.accountId, own - fromOwn);
    out -= fromOwn;
    const inflow = Math.max(0, inflowPool.get(acc.accountId)!);
    inflowPool.set(acc.accountId, inflow - Math.min(inflow, out));
  }
  // What the account's own income has left after its own bills and its owner's
  // transfers — `AccountPlan.leftoverMinor`'s figure, before any savings.
  const ownLeftover = new Map<string, number>();
  for (const acc of accounts) {
    ownLeftover.set(acc.accountId, Math.max(0, ownPool.get(acc.accountId)!));
    const inflow = Math.max(0, inflowPool.get(acc.accountId)!);
    inflowPool.set(acc.accountId, Math.max(0, inflow - heldBack.get(acc.accountId)!));
  }

  // ---- phase 4: savings, through the estate machinery ---------------------
  const savings = planSavings({
    accounts,
    inPartition,
    currency,
    now,
    ownPool,
    inflowPool,
  });

  // ---- summaries ----------------------------------------------------------

  const committedByAccount = tally(accounts);
  const movementIn = tally(accounts);
  for (const m of savings.movements) {
    if (m.fundedMinor <= 0) continue;
    committedByAccount.set(
      m.fromAccountId,
      committedByAccount.get(m.fromAccountId)! + m.fundedMinor,
    );
    if (inPartition.has(m.toAccountId)) {
      movementIn.set(m.toAccountId, movementIn.get(m.toAccountId)! + m.fundedMinor);
    }
  }

  const memberPlans: ScopeMemberPlan[] = members.map((m, i) => {
    const ob = obligations.filter((o) => o.memberIdx === i);
    const obligation = ob.reduce((s, o) => s + o.requiredMinor, 0);
    const funded = ob.reduce((s, o) => s + o.fundedMinor, 0);
    // A member's committed savings are the funded movements leaving the
    // accounts they own. Movements out of a shared pot belong to no one member
    // and are counted on the account alone.
    const committed = accounts
      .filter((a) => a.role === "personal" && a.memberUserId === m.userId)
      .reduce((s, a) => s + committedByAccount.get(a.accountId)!, 0);
    return {
      userId: m.userId,
      displayName: m.displayName,
      currency,
      shareBp:
        totalShareBp > 0
          ? Math.round((shareWeights[i]! / totalShareBp) * 10_000)
          : Math.round(10_000 / members.length),
      monthlyIncomeMinor: money[i]!.incomeMinor,
      obligationMinor: obligation,
      fundedMinor: funded,
      leftoverMinor: remaining[i]!,
      committedMinor: committed,
      shortfallMinor: Math.max(0, obligation - funded),
      sourceAccountId: money[i]!.sourceAccountId,
    };
  });

  const accountPlans: ScopeAccountPlan[] = accounts.map((acc) => {
    const income = accountIncome.get(acc.accountId)!;
    const tin = transferIn.get(acc.accountId)!;
    const tout = transferOut.get(acc.accountId)!;
    const min = movementIn.get(acc.accountId)!;
    const fout = fundedOutflow.get(acc.accountId)!;
    const rout = requiredOutflow.get(acc.accountId)!;
    const committed = committedByAccount.get(acc.accountId)!;
    const arrivals = savings.arrivalsFor.get(acc.accountId) ?? [];
    return {
      accountId: acc.accountId,
      name: acc.name,
      role: acc.role,
      memberUserId: acc.memberUserId ?? null,
      currency,
      monthlyIncomeMinor: income,
      bufferMinor: Math.max(0, acc.monthlyBufferMinor ?? 0),
      requiredOutflowMinor: rout,
      fundedOutflowMinor: fout,
      transferInMinor: tin,
      transferOutMinor: tout,
      movementInMinor: min,
      committedMinor: committed,
      allocatedInflowMinor: tin + min,
      confirmedInflowMinor:
        confirmedIn.get(acc.accountId)! + arrivals.reduce((s, a) => s + (a.confirmedMinor ?? 0), 0),
      ownLeftoverMinor: ownLeftover.get(acc.accountId)!,
      leftoverMinor: income + tin + min - fout - tout - committed,
      shortfallMinor: Math.max(0, rout - fout),
      inflowArrivals: arrivals,
      fundingCycleAccountIds: savings.cycleFor.get(acc.accountId),
      fundingCycleBrokenInflowId: savings.brokenFor.get(acc.accountId),
    };
  });

  const monthlyIncome = [...accountIncome.values()].reduce((s, v) => s + v, 0);
  const attributedIncome = money.reduce((s, m) => s + m.incomeMinor, 0);
  // What the scope needs, and what it got. Attributed cost is counted as the
  // members were *asked* for it — each share rounded up, so a bill is never a
  // penny short. Anything a line needed that reached no member at all is counted
  // too: a scope with nobody in it still owes the rent, and a total that
  // silently dropped it would report no shortfall while every account on it was
  // short. That is the shape of defect this pass exists to make impossible.
  const unattributed = lines.reduce(
    (s, l) =>
      s +
      Math.max(0, l.requiredMonthlyMinor - l.allocations.reduce((t, a) => t + a.requiredMinor, 0)),
    0,
  );
  const totalRequired = obligations.reduce((s, o) => s + o.requiredMinor, 0) + unattributed;
  const totalFunded = obligations.reduce((s, o) => s + o.fundedMinor, 0);

  return {
    currency,
    monthlyIncomeMinor: monthlyIncome,
    totalRequiredMinor: totalRequired,
    totalFundedMinor: totalFunded,
    // Members' surplus, plus income sitting in accounts no member's budget
    // counted — a shared pot's own income, chiefly.
    leftoverMinor:
      memberPlans.reduce((s, m) => s + m.leftoverMinor, 0) + (monthlyIncome - attributedIncome),
    committedMinor: [...committedByAccount.values()].reduce((s, v) => s + v, 0),
    shortfallMinor: Math.max(0, totalRequired - totalFunded),
    members: memberPlans,
    accounts: accountPlans,
    lines: orderedLines,
    transfers,
    movements: savings.movements,
    cycles: savings.cycles,
  };
}

function transferKey(from: string, to: string, memberUserId: string): string {
  return `${from}→${to}→${memberUserId}`;
}

/** A per-account running total, with an entry for every account in the
 *  partition from the start — so nothing downstream has to guess what a missing
 *  one was supposed to mean. */
function tally(accounts: readonly ScopeAccountInput[]): Map<string, number> {
  return new Map(accounts.map((a) => [a.accountId, 0]));
}

interface SavingsPass {
  accounts: readonly ScopeAccountInput[];
  inPartition: ReadonlySet<string>;
  currency: string;
  now: Date;
  /** Mutated: what each account's own income has left. */
  ownPool: Map<string, number>;
  /** Mutated: what arrived at each account and nothing has spent. */
  inflowPool: Map<string, number>;
}

interface SavingsResult {
  movements: ScopeMovement[];
  cycles: EstateCycle[];
  arrivalsFor: Map<string, InflowArrival[]>;
  cycleFor: Map<string, string[]>;
  brokenFor: Map<string, string>;
}

/**
 * Phase 4: authored savings movements, funded last, out of the residuals.
 *
 * `estate.ts`'s machinery, unchanged in every respect that matters — the same
 * iterative DFS over the same graph, the same deterministic root and out-edge
 * order, the same one broken edge per loop reported as `broken_cycle` and
 * funding nothing, the same clamp on a confirmation that outlived its plan.
 * What differs is only what it is handed: residuals a single funding pass
 * produced, rather than a second engine's idea of the same accounts' money.
 */
function planSavings(pass: SavingsPass): SavingsResult {
  const { accounts, inPartition, currency, now, ownPool, inflowPool } = pass;
  const byId = new Map(accounts.map((a) => [a.accountId, a]));
  const edges = buildFundingEdges(accounts);
  const { order, cycles, broken } = orderAccounts([...byId.keys()], edges);

  const cycleFor = new Map<string, string[]>();
  const brokenFor = new Map<string, string>();
  for (const cycle of cycles) {
    for (const accountId of cycle.accountIds) {
      if (!cycleFor.has(accountId)) cycleFor.set(accountId, cycle.accountIds);
      if (!brokenFor.has(accountId)) brokenFor.set(accountId, cycle.brokenInflowId);
    }
  }

  const outByAccount = new Map<string, FundingEdge[]>();
  for (const edge of edges) {
    const list = outByAccount.get(edge.from) ?? [];
    list.push(edge);
    outByAccount.set(edge.from, list);
  }

  const arrivalsFor = new Map<string, InflowArrival[]>();
  const movements: ScopeMovement[] = [];

  for (const accountId of order) {
    const account = byId.get(accountId)!;
    const confirmedByInflow = new Map(
      (account.confirmedArrivals ?? []).map((c) => [c.inflowId, Math.max(0, c.confirmedMinor)]),
    );
    // Sorted rather than left in the order the senders happened to be planned:
    // which of two independent senders a depth-first walk reaches first is an
    // accident of the graph, and a plan that reorders its own arrivals for no
    // visible reason is a plan nobody can diff.
    const arrivals = (arrivalsFor.get(accountId) ?? [])
      .map((a) => ({
        ...a,
        confirmedMinor: Math.min(a.amountMinor, confirmedByInflow.get(a.inflowId) ?? 0),
      }))
      .sort(
        (a, b) =>
          (a.fromAccountId < b.fromAccountId ? -1 : a.fromAccountId > b.fromAccountId ? 1 : 0) ||
          (a.inflowId < b.inflowId ? -1 : a.inflowId > b.inflowId ? 1 : 0),
      );
    if (arrivals.length > 0) arrivalsFor.set(accountId, arrivals);

    // Money that arrived from another account can pay for further movements out;
    // it can never pay for an expense, because every expense was funded in phase
    // 2 from member budgets. Savings money stays savings money (decision 8).
    let own = Math.max(0, ownPool.get(accountId)!);
    let inflow =
      Math.max(0, inflowPool.get(accountId)!) + arrivals.reduce((sum, a) => sum + a.amountMinor, 0);

    // A movement the pass has decided to ignore must not eat the sender's money
    // on its way past: it is not happening, so it costs nothing. Everything else
    // stays, including movements out of the partition — that money really does
    // leave, and it has to keep its place in the queue or the movements behind it
    // would be funded with money already spoken for.
    for (const edge of outByAccount.get(accountId) ?? []) {
      const requested = Math.max(0, monthlyIncomeMinor(edge.row, now));
      if (broken.has(edge.inflowId)) {
        movements.push({
          inflowId: edge.inflowId,
          fromAccountId: edge.from,
          toAccountId: edge.to,
          currency,
          priority: edge.priority,
          requestedMinor: requested,
          fundedMinor: 0,
          fundedFromOwnMinor: 0,
          fundedFromInflowMinor: 0,
          status: "broken_cycle",
        });
        continue;
      }
      const fromOwn = Math.min(requested, own);
      own -= fromOwn;
      const fromInflow = Math.min(requested - fromOwn, inflow);
      inflow -= fromInflow;
      const funded = fromOwn + fromInflow;
      if (funded > 0 && inPartition.has(edge.to)) {
        const list = arrivalsFor.get(edge.to) ?? [];
        list.push({ inflowId: edge.inflowId, fromAccountId: edge.from, amountMinor: funded });
        arrivalsFor.set(edge.to, list);
      }
      movements.push({
        inflowId: edge.inflowId,
        fromAccountId: edge.from,
        toAccountId: edge.to,
        currency,
        priority: edge.priority,
        requestedMinor: requested,
        fundedMinor: funded,
        fundedFromOwnMinor: fromOwn,
        fundedFromInflowMinor: fromInflow,
        status: funded >= requested ? "funded" : funded > 0 ? "short" : "unfunded",
      });
    }
    ownPool.set(accountId, own);
    inflowPool.set(accountId, inflow);
  }

  // Movements this pass can see arriving but not leaving: their sending account
  // is outside it — a different currency, or an account the scope never loaded.
  // Reported so the gap is visible rather than looking like an inflow of zero
  // that nobody authored.
  const known = new Set(movements.map((m) => m.inflowId));
  for (const account of accounts) {
    for (const row of account.inflows ?? []) {
      if (row.source !== "account" || row.active === false || !row.sourceAccountId) continue;
      if (known.has(row.id)) continue;
      movements.push({
        inflowId: row.id,
        fromAccountId: row.sourceAccountId,
        toAccountId: account.accountId,
        currency,
        priority: row.priority ?? DEFAULT_PRIORITY,
        requestedMinor: Math.max(0, monthlyIncomeMinor(row, now)),
        fundedMinor: 0,
        fundedFromOwnMinor: 0,
        fundedFromInflowMinor: 0,
        status: "unknown_source",
      });
    }
  }

  return {
    movements: movements.sort(
      (a, b) =>
        (a.fromAccountId < b.fromAccountId ? -1 : a.fromAccountId > b.fromAccountId ? 1 : 0) ||
        (a.toAccountId < b.toAccountId ? -1 : a.toAccountId > b.toAccountId ? 1 : 0) ||
        (a.inflowId < b.inflowId ? -1 : a.inflowId > b.inflowId ? 1 : 0),
    ),
    cycles,
    arrivalsFor,
    cycleFor,
    brokenFor,
  };
}
