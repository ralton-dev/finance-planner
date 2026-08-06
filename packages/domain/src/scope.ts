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
 * 1. **Attribution.** Every account's external income counts for the member who
 *    **owns** it, whatever the account's household role (decision 15). Every
 *    active payment on every in-scope account becomes obligations attributed to
 *    members — `splitByShares` for shared scope, the bearer (or the owning
 *    member) for personal. A personal account's buffer reduces its member's
 *    budget; a shared pot's buffer is an obligation at `RESERVE_PRIORITY`.
 * 2. **Expense funding.** Obligations fund from pooled member budgets in **one
 *    global priority order**: household-shared and personal intertwined, so a
 *    household bill at priority 5 beats a personal bill at 10 and vice versa
 *    (decision 8). No account funds in a private order of its own.
 * 3. **Derived transfers.** Funded obligations that cross an account boundary
 *    become the transfers each member must make, out of their source account
 *    (decision 11) — and only for the part the destination cannot pay for out of
 *    its **own** income. This is how an expense-bearing account with no income
 *    gets fed — household or not, authored by nobody (decision 9); an account
 *    that already holds the money is not asked for a transfer that would fund
 *    nothing.
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
  /** Set when role === "personal": the member the **household** attributes this
   *  account to. For a solo user that is the owner, on every account they have.
   *  Not the same question as `ownerUserId` below — see it. */
  memberUserId?: string | null;
  /**
   * **Whose account this is** — `core.accounts.owner_user_id`, which is
   * `NOT NULL`, so every account has exactly one owner and a "joint" account is
   * one person's account shared into a household.
   *
   * Required, and deliberately not optional (decision 15). External income
   * counts for the owner whatever the account's role, so a shared pot's own
   * lodger rent joins its owner's income and budget exactly as a salary does —
   * and a field a call site could omit would silently resurrect
   * "shared-pot income belongs to nobody" at that call site alone.
   *
   * `memberUserId` answers a different question and both are needed: this one is
   * a fact about the account, that one is a fact about the household's roster.
   * A member's *transfers* still leave one of their personal-role accounts
   * (decision 11), and a personal account's buffer still comes off the budget of
   * the member the roster names — attribution moved, the roster did not.
   */
  ownerUserId: string;
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
  /** Everything this member earns in this currency: the external income of every
   *  account they **own**, whatever its household role (decision 15). Summed
   *  across the members of a partition it is the partition's whole income,
   *  provided every account in it is owned by one of them — which is what lets a
   *  month close be a per-user view of the pass rather than a second sum. */
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
  /** Whose account it is — `ScopeAccountInput.ownerUserId` passed through, so a
   *  view attributing anything by ownership reads the pass's answer rather than
   *  deriving a second one from the input. */
  ownerUserId: string;
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
  /** Members' discretionary surplus plus income sitting in accounts owned by
   *  nobody in the scope — a sender pulled in from outside it, chiefly. Since
   *  decision 15 a shared pot's own income is not that: it belongs to whoever
   *  owns the pot, and is in their surplus already. */
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
// Debug trace
// ---------------------------------------------------------------------------

export interface ScopePlanDebugReport {
  scopeId: string;
  householdId: string | null;
  asOfDate: string;
  plan: ScopePlan;
  currencies: ScopeCurrencyDebugTrace[];
  report: string;
}

export interface ScopeCurrencyDebugTrace {
  currency: string;
  shareWeights: number[];
  totalShareBp: number;
  accounts: AccountDebugTrace[];
  members: MemberDebugTrace[];
  payments: PaymentDebugTrace[];
  obligations: ObligationDebugTrace[];
  fundingSteps: FundingStepDebugTrace[];
  selfFundingSteps: SelfFundingDebugTrace[];
  transferDerivations: TransferDerivationDebugTrace[];
  transfers: DerivedTransfer[];
  expenseSplits: ExpenseSplitDebugTrace[];
  heldBack: HeldBackDebugTrace[];
  transferOutSplits: TransferOutSplitDebugTrace[];
  savings: SavingsDebugTrace;
}

export interface AccountDebugTrace {
  accountId: string;
  name?: string;
  role: AccountRole;
  memberUserId: string | null;
  ownerUserId: string;
  monthlyBufferMinor: number;
  monthlyIncomeMinor: number;
  incomes: IncomeDebugTrace[];
}

export interface IncomeDebugTrace {
  incomeId: string;
  name?: string;
  amountMinor: number;
  frequency: IncomeInput["frequency"];
  active: boolean;
  monthlyMinor: number;
  explanation: string;
}

export interface MemberDebugTrace {
  userId: string;
  displayName?: string;
  shareBp: number;
  shareWeight: number;
  incomeMinor: number;
  bufferMinor: number;
  budgetMinor: number;
  sourceAccountId: string | null;
}

export interface PaymentDebugTrace {
  lineIndex: number;
  paymentId: string;
  accountId: string;
  name: string;
  category: PaymentCategory;
  scope: PaymentScope;
  priority: number;
  sortDate: string;
  amountMinor: number;
  alreadySavedMinor: number;
  requiredMonthlyMinor: number;
  effectiveDate: string;
  monthsUntilDue: number;
  occurrencesThisMonth: number;
  explanation: string;
  allocations: { userId: string; requiredMinor: number }[];
}

type ObligationKind = "payment" | "reserve";

export interface ObligationDebugTrace {
  obligationIndex: number;
  kind: ObligationKind;
  accountId: string;
  paymentId?: string;
  paymentName?: string;
  memberUserId: string;
  priority: number;
  sortDate: string;
  requiredMinor: number;
  fundedMinor: number;
  selfFundedMinor: number;
}

export interface FundingStepDebugTrace {
  rank: number;
  obligationIndex: number;
  kind: ObligationKind;
  accountId: string;
  paymentId?: string;
  paymentName?: string;
  memberUserId: string;
  priority: number;
  sortDate: string;
  requiredMinor: number;
  budgetBeforeMinor: number;
  fundedMinor: number;
  budgetAfterMinor: number;
  shortfallMinor: number;
}

export interface SelfFundingDebugTrace {
  rank: number;
  kind: ObligationKind;
  accountId: string;
  paymentId?: string;
  paymentName?: string;
  pool: "spendable" | "reserve";
  ownerUserId: string | null;
  wantMinor: number;
  poolBeforeMinor: number;
  coveredMinor: number;
  poolAfterMinor: number;
  entries: {
    obligationIndex: number;
    memberUserId: string;
    fundedMinor: number;
    selfFundedMinor: number;
    transferNeededMinor: number;
  }[];
}

export interface TransferDerivationDebugTrace {
  obligationIndex: number;
  kind: ObligationKind;
  accountId: string;
  paymentId?: string;
  paymentName?: string;
  memberUserId: string;
  fundedMinor: number;
  selfFundedMinor: number;
  movingMinor: number;
  fromAccountId: string | null;
  toAccountId: string;
  reason: "transfer" | "unfunded" | "self_funded" | "no_source" | "same_account";
}

export interface ExpenseSplitDebugTrace {
  rank: number;
  paymentId: string;
  accountId: string;
  name: string;
  requiredMinor: number;
  fundedMinor: number;
  paidMinor: number;
  ownPoolBeforeMinor: number;
  fundedFromOwnMinor: number;
  ownPoolAfterMinor: number;
  inflowPoolBeforeMinor: number;
  fundedFromInflowMinor: number;
  inflowPoolAfterMinor: number;
}

export interface HeldBackDebugTrace {
  accountId: string;
  bufferMinor: number;
  monthlyIncomeMinor: number;
  heldBackMinor: number;
}

export interface TransferOutSplitDebugTrace {
  accountId: string;
  transferOutMinor: number;
  ownPoolBeforeMinor: number;
  fundedFromOwnMinor: number;
  ownPoolAfterMinor: number;
  inflowPoolBeforeMinor: number;
  fundedFromInflowMinor: number;
  inflowPoolAfterMinor: number;
}

export interface SavingsDebugTrace {
  edges: {
    inflowId: string;
    name?: string;
    fromAccountId: string;
    toAccountId: string;
    priority: number;
    requestedMinor: number;
  }[];
  order: string[];
  cycles: EstateCycle[];
  brokenInflowIds: string[];
  accountSteps: SavingsAccountDebugTrace[];
  unknownSources: SavingsMovementDebugTrace[];
}

export interface SavingsAccountDebugTrace {
  accountId: string;
  ownPoolStartMinor: number;
  inflowPoolStartMinor: number;
  arrivalsMinor: number;
  availableOwnMinor: number;
  availableInflowMinor: number;
  arrivals: InflowArrival[];
  movements: SavingsMovementDebugTrace[];
  ownPoolEndMinor: number;
  inflowPoolEndMinor: number;
}

export interface SavingsMovementDebugTrace {
  rank: number;
  inflowId: string;
  name?: string;
  fromAccountId: string;
  toAccountId: string;
  priority: number;
  requestedMinor: number;
  ownBeforeMinor: number;
  fundedFromOwnMinor: number;
  ownAfterMinor: number;
  inflowBeforeMinor: number;
  fundedFromInflowMinor: number;
  inflowAfterMinor: number;
  fundedMinor: number;
  status: EstateMovementStatus;
  deliveredToPartition: boolean;
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
  /** Of `fundedMinor`, the part the destination account's own income already
   *  covers, so it needs no transport (decision 9). Settled in phase 2's queue —
   *  see `selfFunding`. */
  selfFundedMinor: number;
  priority: number;
  sortDate: string;
  /** Set for payment-derived obligations; absent for buffer reservations. */
  lineIdx?: number;
}

/**
 * What an account can pay for out of its own income, and who may draw on it.
 *
 * Decision 9 derives transport for an account "with obligations and no income".
 * The netting was in the wording and not in the code, so the pass asked a member
 * to move £40 into an account whose own £50 of interest had already paid the £40
 * subscription: money that funds nothing, on the transfer checklist and in
 * `needsYou`, and a rollup identity short by exactly it.
 *
 * Two pools, because the account's own income is already split two ways
 * everywhere else in this file. `spendable` is `income − buffer`, the money
 * `ownPool` lets bills spend; `reserve` is `min(income, buffer)`, the part the
 * buffer holds back — which on a shared pot is claimed by a reserve obligation
 * at `RESERVE_PRIORITY` and would otherwise be reserved twice, once out of the
 * account's own income and again out of the members' transfers. They sum to the
 * account's income exactly, so nothing is netted twice and nothing is missed.
 *
 * `owner` is the member whose budget phase 1 already counted this income into —
 * the account's **owner** (decision 15), when they are a member of the scope.
 * Their obligations here are paid for by money that is already here; a
 * **co-member's** are not, and netting those would tell Bob he owes Alice nothing
 * for the rent that leaves her current account. Income no member's budget counted
 * — an account owned by somebody outside the scope — has no owner and is
 * available to whoever the queue reaches first.
 *
 * It tracks phase 1 and must keep tracking it. While income was attributed by
 * role, a shared pot's own income was in nobody's budget and every member could
 * lean on it; now it is in its owner's, and letting a co-member lean on it too
 * would spend the same £500 twice — the owner's budget would grow by it while
 * the co-member's transfer shrank by a share of it, and the co-member would end
 * the month holding money the owner's `leftoverMinor` claims.
 */
interface SelfFunding {
  spendable: number;
  reserve: number;
  owner: number | null;
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

interface ScopeDebugCollector {
  currencies: ScopeCurrencyDebugTrace[];
}

interface ObligationDebugSeed {
  kind: ObligationKind;
  paymentId?: string;
  paymentName?: string;
}

const emptySavingsDebug = (): SavingsDebugTrace => ({
  edges: [],
  order: [],
  cycles: [],
  brokenInflowIds: [],
  accountSteps: [],
  unknownSources: [],
});

function moneyMinor(currency: string, minor: number): string {
  return `${currency} ${minor} minor`;
}

function incomeExplanation(income: IncomeInput, monthlyMinor: number): string {
  if (income.active === false) return "inactive income contributes 0";
  switch (income.frequency) {
    case "monthly":
      return `monthly income contributes its amount: ${monthlyMinor}`;
    case "yearly":
      return `yearly income is rounded over 12 months: ${income.amountMinor} / 12 = ${monthlyMinor}`;
    case "custom":
      return income.recurrence
        ? `custom income is normalised over its recurrence: ${income.amountMinor} -> ${monthlyMinor}`
        : `custom income without a recurrence contributes its amount: ${monthlyMinor}`;
    case "one_off":
      return `one-off income is spread until its anchor when it is still in the future: ${income.amountMinor} -> ${monthlyMinor}`;
  }
}

function paymentExplanation(p: PaymentInput, req: ReturnType<typeof requiredMonthlyForPayment>): string {
  const alreadySaved = p.alreadySavedMinor ?? 0;
  const remaining = Math.max(0, p.amountMinor - alreadySaved);
  const cap = contributionCapMinor(p);
  if (p.category === "monthly_recurring") {
    return `monthly recurring: the full amount is due this month, required = ${p.amountMinor}`;
  }
  if (cap !== null) {
    return `contribution-first fixed point: remaining ${remaining}, cap ${cap}, required = min(cap, remaining) = ${req.requiredMinor}`;
  }
  if (p.category === "custom_recurring" && req.occurrencesThisMonth > 1) {
    return `custom recurring lands ${req.occurrencesThisMonth} times this month, required = ${p.amountMinor} * ${req.occurrencesThisMonth} = ${req.requiredMinor}`;
  }
  return `save-up path: remaining ${remaining}, months until effective date ${req.monthsUntilDue}, required = ceil(remaining / months) = ${req.requiredMinor}`;
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
export function computeScopePlan(
  input: ScopeInput,
  asOfDate: string,
  debug?: ScopeDebugCollector,
): ScopePlan {
  const now = parseISODate(asOfDate);
  const currencies = [...new Set(input.accounts.map((a) => a.currency))].sort();
  const partitions = currencies.map((currency) => planCurrency(input, currency, now, debug));

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

export function explainScopePlan(input: ScopeInput, asOfDate: string): ScopePlanDebugReport {
  const collector: ScopeDebugCollector = { currencies: [] };
  const plan = computeScopePlan(input, asOfDate, collector);
  return {
    scopeId: plan.scopeId,
    householdId: plan.householdId,
    asOfDate,
    plan,
    currencies: collector.currencies,
    report: renderScopeDebugReport(input, plan, collector.currencies),
  };
}

function planCurrency(
  input: ScopeInput,
  currency: string,
  now: Date,
  debug?: ScopeDebugCollector,
): ScopeCurrencyPlan {
  const members = input.members;
  const memberIdx = new Map(members.map((m, i) => [m.userId, i] as const));
  const shareWeights = members.map((m) => Math.max(0, m.shareBp));
  const totalShareBp = shareWeights.reduce((s, w) => s + w, 0);
  const accounts = input.accounts.filter((a) => a.currency === currency);
  const inPartition = new Set(accounts.map((a) => a.accountId));
  const debugTrace: ScopeCurrencyDebugTrace | null = debug
    ? {
        currency,
        shareWeights,
        totalShareBp,
        accounts: [],
        members: [],
        payments: [],
        obligations: [],
        fundingSteps: [],
        selfFundingSteps: [],
        transferDerivations: [],
        transfers: [],
        expenseSplits: [],
        heldBack: [],
        transferOutSplits: [],
        savings: emptySavingsDebug(),
      }
    : null;
  const obligationSeeds: ObligationDebugSeed[] = [];

  // ---- phase 1: attribution -----------------------------------------------

  const accountIncome = new Map<string, number>();
  for (const acc of accounts) {
    const incomes = acc.incomes.map((i) => {
      const monthlyMinor = monthlyIncomeMinor(i, now);
      return {
        incomeId: i.id,
        name: i.name,
        amountMinor: i.amountMinor,
        frequency: i.frequency,
        active: i.active !== false,
        monthlyMinor,
        explanation: incomeExplanation(i, monthlyMinor),
      };
    });
    const monthlyIncome = incomes.reduce((sum, i) => sum + i.monthlyMinor, 0);
    accountIncome.set(acc.accountId, monthlyIncome);
    debugTrace?.accounts.push({
      accountId: acc.accountId,
      name: acc.name,
      role: acc.role,
      memberUserId: acc.memberUserId ?? null,
      ownerUserId: acc.ownerUserId,
      monthlyBufferMinor: Math.max(0, acc.monthlyBufferMinor ?? 0),
      monthlyIncomeMinor: monthlyIncome,
      incomes,
    });
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
    const userId = members[i]!.userId;

    // **Income follows ownership, whatever the account's role** (decision 15).
    // A shared pot is still somebody's account — a "joint" account is one
    // person's, shared into a household — so the lodger rent paid into it is
    // that person's income exactly as a salary paid into their current account
    // is. Attributing by household *role* instead left a shared pot's own income
    // belonging to nobody: it funded nothing, it was in no member's budget, and
    // the members transported the gross of the pot's bills as though it had
    // never arrived.
    for (const a of accounts) {
      if (a.ownerUserId !== userId) continue;
      money[i]!.incomeMinor += accountIncome.get(a.accountId)!;
    }

    // Buffers and the source account stay a **personal-role** question, and for
    // two separate reasons. Decision 11 is untouched: a member's transfers leave
    // the personal account of theirs with the most external income (lowest id
    // breaking the tie), because a shared pot is not somewhere they pay bills
    // from. And a shared pot's buffer is already funded into it as a reserve
    // obligation at `RESERVE_PRIORITY` below — taking it off its owner's budget
    // here as well would reserve the same money twice.
    const personal = accounts
      .filter((a) => a.role === "personal" && a.memberUserId === userId)
      .sort((a, b) => (a.accountId < b.accountId ? -1 : 1));
    let bestIncome = -1;
    for (const a of personal) {
      const income = accountIncome.get(a.accountId)!;
      money[i]!.bufferMinor += Math.max(0, a.monthlyBufferMinor ?? 0);
      if (income > bestIncome) {
        bestIncome = income;
        money[i]!.sourceAccountId = a.accountId;
      }
    }
  }
  if (debugTrace) {
    for (let i = 0; i < members.length; i++) {
      debugTrace.members.push({
        userId: members[i]!.userId,
        displayName: members[i]!.displayName,
        shareBp: members[i]!.shareBp,
        shareWeight: shareWeights[i]!,
        incomeMinor: money[i]!.incomeMinor,
        bufferMinor: money[i]!.bufferMinor,
        budgetMinor: Math.max(0, money[i]!.incomeMinor - money[i]!.bufferMinor),
        sourceAccountId: money[i]!.sourceAccountId,
      });
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
      debugTrace?.payments.push({
        lineIndex: lineIdx,
        paymentId: p.id,
        accountId: acc.accountId,
        name: p.name,
        category: p.category,
        scope: p.scope,
        priority,
        sortDate: sortDateOf(p),
        amountMinor: p.amountMinor,
        alreadySavedMinor: p.alreadySavedMinor ?? 0,
        requiredMonthlyMinor: req.requiredMinor,
        effectiveDate: req.effectiveDate,
        monthsUntilDue: req.monthsUntilDue,
        occurrencesThisMonth: req.occurrencesThisMonth,
        explanation: paymentExplanation(p, req),
        allocations: members.map((m, i) => ({
          userId: m.userId,
          requiredMinor: allocReq[i]!,
        })),
      });
      for (let i = 0; i < members.length; i++) {
        lines[lineIdx]!.allocations[i]!.requiredMinor = allocReq[i]!;
        if (allocReq[i]! > 0) {
          obligationSeeds.push({ kind: "payment", paymentId: p.id, paymentName: p.name });
          obligations.push({
            accountId: acc.accountId,
            memberIdx: i,
            requiredMinor: allocReq[i]!,
            fundedMinor: 0,
            selfFundedMinor: 0,
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
          obligationSeeds.push({ kind: "reserve" });
          obligations.push({
            accountId: acc.accountId,
            memberIdx: i,
            requiredMinor: v,
            fundedMinor: 0,
            selfFundedMinor: 0,
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
  const obligationIndex = new Map(obligations.map((o, idx) => [o, idx] as const));
  for (const { o } of orderedObligations) {
    const before = remaining[o.memberIdx]!;
    const funded = Math.max(0, Math.min(o.requiredMinor, remaining[o.memberIdx]!));
    o.fundedMinor = funded;
    remaining[o.memberIdx]! -= funded;
    if (o.lineIdx !== undefined) {
      lines[o.lineIdx]!.allocations[o.memberIdx]!.fundedMinor = funded;
    }
    if (debugTrace) {
      const idx = obligationIndex.get(o)!;
      const seed = obligationSeeds[idx]!;
      debugTrace.fundingSteps.push({
        rank: debugTrace.fundingSteps.length + 1,
        obligationIndex: idx,
        kind: seed.kind,
        accountId: o.accountId,
        paymentId: seed.paymentId,
        paymentName: seed.paymentName,
        memberUserId: members[o.memberIdx]!.userId,
        priority: o.priority,
        sortDate: o.sortDate,
        requiredMinor: o.requiredMinor,
        budgetBeforeMinor: before,
        fundedMinor: funded,
        budgetAfterMinor: remaining[o.memberIdx]!,
        shortfallMinor: Math.max(0, o.requiredMinor - funded),
      });
    }
  }

  // ---- decision 9's netting: what each account pays for itself -------------
  //
  // Down the queue phase 2 just spent the month in, because "what this account
  // can fund itself" is not simply its income. Obligations queue globally
  // (decision 8), so which of an account's obligations its own money reaches is
  // a fact about the *global* order, not about the account — and that order is
  // the one immediately above. One queue, walked twice; no second ordering to
  // drift out of step with the first.
  //
  // A whole line at a time. One payment's obligations sit at one position in
  // that queue — same priority, same date, pushed together — so the account's
  // own money reaches all of them or none, and splitting it between them by
  // queue position would hand a shared pot's rebate to whichever member the
  // list happens to name first. Split by what each of them is for instead, and
  // a £200 rebate against £1,000 of rent shared 60/40 relieves £120 and £80.
  const selfFunding = new Map<string, SelfFunding>(
    accounts.map((a) => {
      const income = accountIncome.get(a.accountId)!;
      const buffer = Math.max(0, a.monthlyBufferMinor ?? 0);
      const owner = memberIdx.get(a.ownerUserId);
      return [
        a.accountId,
        {
          spendable: Math.max(0, income - buffer),
          reserve: Math.min(income, buffer),
          owner: owner ?? null,
        },
      ];
    }),
  );
  for (let i = 0; i < orderedObligations.length; ) {
    const head = orderedObligations[i]!.o;
    let end = i;
    while (
      end < orderedObligations.length &&
      orderedObligations[end]!.o.accountId === head.accountId &&
      orderedObligations[end]!.o.lineIdx === head.lineIdx
    ) {
      end++;
    }
    const group = orderedObligations.slice(i, end).map(({ o }) => o);
    i = end;

    const self = selfFunding.get(head.accountId)!;
    // Only the member whose budget already counted this income may lean on it —
    // see `SelfFunding`. A reserve obligation is claiming the buffer, so it
    // draws on the part of the income the buffer holds back; a bill draws on
    // the part `ownPool` lets bills spend.
    const drawing = group.filter(
      (o) => o.fundedMinor > 0 && (self.owner === null || self.owner === o.memberIdx),
    );
    const want = drawing.reduce((s, o) => s + o.fundedMinor, 0);
    if (want <= 0) continue;
    const pool = head.lineIdx === undefined ? "reserve" : "spendable";
    const poolBefore = self[pool];
    const covered = Math.min(want, self[pool]);
    self[pool] -= covered;
    // Floors, then the remainder a penny at a time in queue order: rounding up
    // the way `splitByShares` does would net more than the account has. Each
    // share stays under its own obligation because `covered <= want`, so the
    // spare penny can never over-credit one.
    let handed = 0;
    for (const o of drawing) {
      o.selfFundedMinor = Math.floor((covered * o.fundedMinor) / want);
      handed += o.selfFundedMinor;
    }
    for (const o of drawing) {
      if (handed >= covered) break;
      o.selfFundedMinor++;
      handed++;
    }
    if (debugTrace) {
      const headIdx = obligationIndex.get(head)!;
      const seed = obligationSeeds[headIdx]!;
      debugTrace.selfFundingSteps.push({
        rank: debugTrace.selfFundingSteps.length + 1,
        kind: seed.kind,
        accountId: head.accountId,
        paymentId: seed.paymentId,
        paymentName: seed.paymentName,
        pool,
        ownerUserId: self.owner === null ? null : members[self.owner]!.userId,
        wantMinor: want,
        poolBeforeMinor: poolBefore,
        coveredMinor: covered,
        poolAfterMinor: self[pool],
        entries: drawing.map((o) => ({
          obligationIndex: obligationIndex.get(o)!,
          memberUserId: members[o.memberIdx]!.userId,
          fundedMinor: o.fundedMinor,
          selfFundedMinor: o.selfFundedMinor,
          transferNeededMinor: Math.max(0, o.fundedMinor - o.selfFundedMinor),
        })),
      });
    }
  }
  if (debugTrace) {
    debugTrace.obligations = obligations.map((o, idx) => {
      const seed = obligationSeeds[idx]!;
      return {
        obligationIndex: idx,
        kind: seed.kind,
        accountId: o.accountId,
        paymentId: seed.paymentId,
        paymentName: seed.paymentName,
        memberUserId: members[o.memberIdx]!.userId,
        priority: o.priority,
        sortDate: o.sortDate,
        requiredMinor: o.requiredMinor,
        fundedMinor: o.fundedMinor,
        selfFundedMinor: o.selfFundedMinor,
      };
    });
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
  // member's source account — less whatever the destination's own income already
  // covers (phase 2's `selfFunding`). Nothing waits on anything: see the module
  // comment for why this cannot cycle however the stars overlap.
  const confirmedTransfers = new Map<string, number>();
  for (const c of input.confirmedTransfers ?? []) {
    const key = transferKey(c.fromAccountId, c.toAccountId, c.memberUserId);
    confirmedTransfers.set(key, (confirmedTransfers.get(key) ?? 0) + Math.max(0, c.confirmedMinor));
  }

  const transferMap = new Map<string, DerivedTransfer>();
  for (const o of obligations) {
    const moving = o.fundedMinor - o.selfFundedMinor;
    const from = money[o.memberIdx]!.sourceAccountId;
    if (debugTrace) {
      const idx = obligationIndex.get(o)!;
      const seed = obligationSeeds[idx]!;
      debugTrace.transferDerivations.push({
        obligationIndex: idx,
        kind: seed.kind,
        accountId: o.accountId,
        paymentId: seed.paymentId,
        paymentName: seed.paymentName,
        memberUserId: members[o.memberIdx]!.userId,
        fundedMinor: o.fundedMinor,
        selfFundedMinor: o.selfFundedMinor,
        movingMinor: Math.max(0, moving),
        fromAccountId: from,
        toAccountId: o.accountId,
        reason:
          o.fundedMinor <= 0
            ? "unfunded"
            : moving <= 0
              ? "self_funded"
              : !from
                ? "no_source"
                : from === o.accountId
                  ? "same_account"
                  : "transfer",
      });
    }
    if (moving <= 0) continue; // unfunded, or the money is already there
    if (!from || from === o.accountId) continue; // no source, or internal
    const key = `${from}→${o.accountId}→${o.memberIdx}`;
    const existing = transferMap.get(key);
    if (existing) {
      existing.amountMinor += moving;
    } else {
      transferMap.set(key, {
        fromAccountId: from,
        toAccountId: o.accountId,
        memberUserId: members[o.memberIdx]!.userId,
        currency,
        amountMinor: moving,
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
  if (debugTrace) debugTrace.transfers = transfers.map((t) => ({ ...t }));

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
    const ownBefore = ownPool.get(line.accountId)!;
    const inflowBefore = inflowPool.get(line.accountId)!;
    const fromOwn = Math.min(paid, ownBefore);
    ownPool.set(line.accountId, ownBefore - fromOwn);
    const fromInflow = paid - fromOwn;
    inflowPool.set(line.accountId, inflowBefore - fromInflow);
    line.fundedFromOwnMinor = fromOwn;
    line.fundedFromInflowMinor = fromInflow;
    debugTrace?.expenseSplits.push({
      rank: debugTrace.expenseSplits.length + 1,
      paymentId: line.paymentId,
      accountId: line.accountId,
      name: line.name,
      requiredMinor: line.requiredMonthlyMinor,
      fundedMinor: line.fundedMonthlyMinor,
      paidMinor: paid,
      ownPoolBeforeMinor: ownBefore,
      fundedFromOwnMinor: fromOwn,
      ownPoolAfterMinor: ownPool.get(line.accountId)!,
      inflowPoolBeforeMinor: inflowBefore,
      fundedFromInflowMinor: fromInflow,
      inflowPoolAfterMinor: inflowPool.get(line.accountId)!,
    });
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
    const held = Math.max(0, buffer - accountIncome.get(acc.accountId)!);
    heldBack.set(acc.accountId, held);
    debugTrace?.heldBack.push({
      accountId: acc.accountId,
      bufferMinor: buffer,
      monthlyIncomeMinor: accountIncome.get(acc.accountId)!,
      heldBackMinor: held,
    });
  }

  // Derived transfers leave the same two pools, own money first. A pool can be
  // short here without anything being wrong: a member whose income sits in a
  // personal account other than their source one is expected to consolidate
  // first, which `ScopeAccountPlan.leftoverMinor` reports as a negative residual
  // rather than hiding.
  for (const acc of accounts) {
    let out = transferOut.get(acc.accountId)!;
    if (out <= 0) continue;
    const ownBefore = ownPool.get(acc.accountId)!;
    const inflowBefore = inflowPool.get(acc.accountId)!;
    const own = Math.max(0, ownBefore);
    const fromOwn = Math.min(own, out);
    ownPool.set(acc.accountId, own - fromOwn);
    out -= fromOwn;
    const inflow = Math.max(0, inflowPool.get(acc.accountId)!);
    const fromInflow = Math.min(inflow, out);
    inflowPool.set(acc.accountId, inflow - fromInflow);
    debugTrace?.transferOutSplits.push({
      accountId: acc.accountId,
      transferOutMinor: transferOut.get(acc.accountId)!,
      ownPoolBeforeMinor: ownBefore,
      fundedFromOwnMinor: fromOwn,
      ownPoolAfterMinor: ownPool.get(acc.accountId)!,
      inflowPoolBeforeMinor: inflowBefore,
      fundedFromInflowMinor: fromInflow,
      inflowPoolAfterMinor: inflowPool.get(acc.accountId)!,
    });
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
    debug: debugTrace?.savings,
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
    // personal accounts the roster names as theirs. Movements out of a shared
    // pot belong to no one member and are counted on the account alone —
    // deliberately still a role question, and not the ownership one decision 15
    // moved income onto: a pot the household sweeps into an ISA is spending the
    // household's money, whoever's name is on it.
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
      ownerUserId: acc.ownerUserId,
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

  const result = {
    currency,
    monthlyIncomeMinor: monthlyIncome,
    totalRequiredMinor: totalRequired,
    totalFundedMinor: totalFunded,
    // Members' surplus, plus income sitting in accounts no member's budget
    // counted — one owned by somebody outside the scope. Zero for a scope whose
    // accounts are all owned by its members, which is every scope the loader
    // builds (it closes over common ownership).
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
  if (debugTrace) debug?.currencies.push(debugTrace);
  return result;
}

function renderScopeDebugReport(
  input: ScopeInput,
  plan: ScopePlan,
  traces: readonly ScopeCurrencyDebugTrace[],
): string {
  const accountName = new Map(input.accounts.map((a) => [a.accountId, a.name ?? "account"]));
  const memberName = new Map(input.members.map((m) => [m.userId, m.displayName ?? "user"]));
  const movementName = new Map<string, string>();
  for (const trace of traces) {
    for (const edge of trace.savings.edges) {
      if (edge.name) movementName.set(edge.inflowId, edge.name);
    }
    for (const account of trace.savings.accountSteps) {
      for (const movement of account.movements) {
        if (movement.name) movementName.set(movement.inflowId, movement.name);
      }
    }
    for (const movement of trace.savings.unknownSources) {
      if (movement.name) movementName.set(movement.inflowId, movement.name);
    }
  }
  const accountLabel = (id: string): string => accountName.get(id) ?? "unknown account";
  const memberLabel = (id: string): string => memberName.get(id) ?? "unknown user";
  const movementLabel = (id: string): string => movementName.get(id) ?? "authored movement";
  const out: string[] = [
    "Finance Planner engine debug report",
    `scope: ${plan.householdId ? "household account set" : "account set"}`,
    `household: ${plan.householdId ? "yes" : "none"}`,
    `as of: ${plan.asOfDate}`,
    "",
    "This report follows the one scope pass: account inputs, member budgets, global funding rank, derived transfers, authored movements, account residuals, then user rollup.",
  ];

  for (const trace of traces) {
    const partition = plan.partitions.find((p) => p.currency === trace.currency);
    out.push("", `Currency ${trace.currency}`, "====================");

    out.push("", "Phase 1 - account income and buffers");
    for (const account of trace.accounts) {
      out.push(
        `- ${accountLabel(account.accountId)} role=${account.role} owner=${memberLabel(account.ownerUserId)} rosterMember=${account.memberUserId ? memberLabel(account.memberUserId) : "none"}`,
        `  income total: ${moneyMinor(trace.currency, account.monthlyIncomeMinor)}; buffer: ${moneyMinor(trace.currency, account.monthlyBufferMinor)}`,
      );
      if (account.incomes.length === 0) {
        out.push("  incomes: none");
      } else {
        for (const income of account.incomes) {
          out.push(
            `  income ${income.name ?? "income"}: amount ${moneyMinor(trace.currency, income.amountMinor)}, frequency ${income.frequency}, active=${income.active} -> monthly ${moneyMinor(trace.currency, income.monthlyMinor)} (${income.explanation})`,
          );
        }
      }
    }

    out.push("", "Phase 1 - member attribution");
    for (const member of trace.members) {
      out.push(
        `- ${memberLabel(member.userId)} shareWeight=${member.shareWeight}/${trace.totalShareBp || 0}, normalisedShareBp=${member.shareBp}`,
        `  income ${moneyMinor(trace.currency, member.incomeMinor)} - personal buffers ${moneyMinor(trace.currency, member.bufferMinor)} = budget ${moneyMinor(trace.currency, member.budgetMinor)}`,
        `  transfer source account: ${member.sourceAccountId ? accountLabel(member.sourceAccountId) : "none"}`,
      );
    }

    out.push("", "Phase 1 - payment requirements and allocation");
    if (trace.payments.length === 0) out.push("- no active payments in this currency");
    for (const payment of trace.payments) {
      out.push(
        `- ${payment.name} on ${accountLabel(payment.accountId)} priority=${payment.priority}, sortDate=${payment.sortDate}`,
        `  category=${payment.category}, scope=${payment.scope}, amount=${moneyMinor(trace.currency, payment.amountMinor)}, alreadySaved=${moneyMinor(trace.currency, payment.alreadySavedMinor)}`,
        `  required=${moneyMinor(trace.currency, payment.requiredMonthlyMinor)}, effectiveDate=${payment.effectiveDate}, months=${payment.monthsUntilDue}, occurrencesThisMonth=${payment.occurrencesThisMonth}`,
        `  formula: ${payment.explanation}`,
      );
      for (const allocation of payment.allocations) {
        out.push(
          `  allocation -> ${memberLabel(allocation.userId)} requires ${moneyMinor(trace.currency, allocation.requiredMinor)}`,
        );
      }
    }

    out.push("", "Phase 2 - global funding queue by rank");
    if (trace.fundingSteps.length === 0) out.push("- no obligations queued");
    for (const step of trace.fundingSteps) {
      const target = step.kind === "payment" ? (step.paymentName ?? "payment") : "buffer reserve";
      out.push(
        `#${step.rank} ${target} on ${accountLabel(step.accountId)} for ${memberLabel(step.memberUserId)}`,
        `  priority=${step.priority}, sortDate=${step.sortDate}, required=${moneyMinor(trace.currency, step.requiredMinor)}`,
        `  member budget before ${moneyMinor(trace.currency, step.budgetBeforeMinor)}; funded ${moneyMinor(trace.currency, step.fundedMinor)}; after ${moneyMinor(trace.currency, step.budgetAfterMinor)}; shortfall ${moneyMinor(trace.currency, step.shortfallMinor)}`,
      );
    }

    out.push("", "Phase 2b - destination account self-funding");
    if (trace.selfFundingSteps.length === 0) out.push("- no destination account income covered its own obligations");
    for (const step of trace.selfFundingSteps) {
      const target = step.kind === "payment" ? (step.paymentName ?? "payment") : "buffer reserve";
      out.push(
        `#${step.rank} ${accountLabel(step.accountId)} ${target} draws from ${step.pool} pool`,
        `  pool owner=${step.ownerUserId ? memberLabel(step.ownerUserId) : "unowned in this scope"}, wanted=${moneyMinor(trace.currency, step.wantMinor)}, pool before=${moneyMinor(trace.currency, step.poolBeforeMinor)}, covered=${moneyMinor(trace.currency, step.coveredMinor)}, pool after=${moneyMinor(trace.currency, step.poolAfterMinor)}`,
      );
      for (const entry of step.entries) {
        out.push(
          `  ${memberLabel(entry.memberUserId)} funded ${moneyMinor(trace.currency, entry.fundedMinor)}; already in destination ${moneyMinor(trace.currency, entry.selfFundedMinor)}; transfer still needed ${moneyMinor(trace.currency, entry.transferNeededMinor)}`,
        );
      }
    }

    out.push("", "Phase 3 - derived transfer derivation");
    if (trace.transferDerivations.length === 0) out.push("- no funded obligation needed transport");
    for (const d of trace.transferDerivations) {
      const target = d.kind === "payment" ? (d.paymentName ?? "payment") : "buffer reserve";
      const from = d.fromAccountId ? accountLabel(d.fromAccountId) : "no source account";
      out.push(
        `- ${target} for ${memberLabel(d.memberUserId)} on ${accountLabel(d.toAccountId)}`,
        `  funded=${moneyMinor(trace.currency, d.fundedMinor)}, already in destination=${moneyMinor(trace.currency, d.selfFundedMinor)}, moving=${moneyMinor(trace.currency, d.movingMinor)}, from=${from}, reason=${d.reason}`,
      );
    }
    out.push("  aggregated derived transfers:");
    if (trace.transfers.length === 0) out.push("  - none");
    for (const t of trace.transfers) {
      out.push(
        `  - ${accountLabel(t.fromAccountId)} -> ${accountLabel(t.toAccountId)} for ${memberLabel(t.memberUserId)}: amount ${moneyMinor(trace.currency, t.amountMinor)}, confirmed ${moneyMinor(trace.currency, t.confirmedMinor)}`,
      );
    }

    out.push("", "Phase 3b - expense funding sources by account pool");
    if (trace.expenseSplits.length === 0) out.push("- no payment lines to split");
    for (const split of trace.expenseSplits) {
      out.push(
        `#${split.rank} ${split.name} on ${accountLabel(split.accountId)}`,
        `  paid ${moneyMinor(trace.currency, split.paidMinor)} of required ${moneyMinor(trace.currency, split.requiredMinor)}; line funded total ${moneyMinor(trace.currency, split.fundedMinor)}`,
        `  own pool ${moneyMinor(trace.currency, split.ownPoolBeforeMinor)} -> ${moneyMinor(trace.currency, split.ownPoolAfterMinor)}; funded from own ${moneyMinor(trace.currency, split.fundedFromOwnMinor)}`,
        `  inflow pool ${moneyMinor(trace.currency, split.inflowPoolBeforeMinor)} -> ${moneyMinor(trace.currency, split.inflowPoolAfterMinor)}; funded from arriving money ${moneyMinor(trace.currency, split.fundedFromInflowMinor)}`,
      );
    }

    out.push("", "Phase 3c - buffer held back from savings");
    for (const held of trace.heldBack) {
      out.push(
        `- ${accountLabel(held.accountId)} buffer ${moneyMinor(trace.currency, held.bufferMinor)} against income ${moneyMinor(trace.currency, held.monthlyIncomeMinor)} -> held back from savings ${moneyMinor(trace.currency, held.heldBackMinor)}`,
      );
    }

    out.push("", "Phase 3d - derived transfers leaving source accounts");
    if (trace.transferOutSplits.length === 0) out.push("- no derived transfer leaves a source account");
    for (const split of trace.transferOutSplits) {
      out.push(
        `- ${accountLabel(split.accountId)} sends derived transfers totalling ${moneyMinor(trace.currency, split.transferOutMinor)}`,
        `  own pool ${moneyMinor(trace.currency, split.ownPoolBeforeMinor)} -> ${moneyMinor(trace.currency, split.ownPoolAfterMinor)}; paid from own ${moneyMinor(trace.currency, split.fundedFromOwnMinor)}`,
        `  inflow pool ${moneyMinor(trace.currency, split.inflowPoolBeforeMinor)} -> ${moneyMinor(trace.currency, split.inflowPoolAfterMinor)}; paid from arriving money ${moneyMinor(trace.currency, split.fundedFromInflowMinor)}`,
      );
    }

    out.push("", "Phase 4 - authored savings movements");
    out.push(`graph order: ${trace.savings.order.length ? trace.savings.order.map(accountLabel).join(" -> ") : "none"}`);
    if (trace.savings.edges.length === 0) out.push("graph edges: none");
    for (const edge of trace.savings.edges) {
      out.push(
        `movement ${edge.name ?? movementLabel(edge.inflowId)}: ${accountLabel(edge.fromAccountId)} -> ${accountLabel(edge.toAccountId)}, priority=${edge.priority}, requested=${moneyMinor(trace.currency, edge.requestedMinor)}`,
      );
    }
    if (trace.savings.cycles.length > 0) {
      for (const cycle of trace.savings.cycles) {
        out.push(
          `cycle: accounts ${cycle.accountIds.map(accountLabel).join(" -> ")}; movements ${cycle.inflowIds.map(movementLabel).join(" -> ")}; broken=${movementLabel(cycle.brokenInflowId)}`,
        );
      }
    }
    for (const account of trace.savings.accountSteps) {
      out.push(
        `- ${accountLabel(account.accountId)} starts savings with own pool ${moneyMinor(trace.currency, account.ownPoolStartMinor)} and inflow pool ${moneyMinor(trace.currency, account.inflowPoolStartMinor)} plus arrivals ${moneyMinor(trace.currency, account.arrivalsMinor)}`,
      );
      if (account.arrivals.length > 0) {
        for (const arrival of account.arrivals) {
          out.push(
            `  arrival ${movementLabel(arrival.inflowId)} from ${accountLabel(arrival.fromAccountId)}: ${moneyMinor(trace.currency, arrival.amountMinor)} confirmed ${moneyMinor(trace.currency, arrival.confirmedMinor ?? 0)}`,
          );
        }
      }
      if (account.movements.length === 0) out.push("  no authored movements leave this account");
      for (const movement of account.movements) {
        out.push(
          `  #${movement.rank} movement ${movement.name ?? movementLabel(movement.inflowId)}: ${accountLabel(movement.fromAccountId)} -> ${accountLabel(movement.toAccountId)} priority=${movement.priority}, requested=${moneyMinor(trace.currency, movement.requestedMinor)}, status=${movement.status}`,
          `    own ${moneyMinor(trace.currency, movement.ownBeforeMinor)} -> ${moneyMinor(trace.currency, movement.ownAfterMinor)}; funded from own ${moneyMinor(trace.currency, movement.fundedFromOwnMinor)}`,
          `    inflow ${moneyMinor(trace.currency, movement.inflowBeforeMinor)} -> ${moneyMinor(trace.currency, movement.inflowAfterMinor)}; funded from arriving money ${moneyMinor(trace.currency, movement.fundedFromInflowMinor)}; delivered inside partition=${movement.deliveredToPartition}`,
        );
      }
      out.push(
        `  savings pools end: own ${moneyMinor(trace.currency, account.ownPoolEndMinor)}, inflow ${moneyMinor(trace.currency, account.inflowPoolEndMinor)}`,
      );
    }
    if (trace.savings.unknownSources.length > 0) {
      out.push("unknown-source movement rows:");
      for (const movement of trace.savings.unknownSources) {
        out.push(
          `- ${movement.name ?? movementLabel(movement.inflowId)}: sender account is outside this planned scope; requested ${moneyMinor(trace.currency, movement.requestedMinor)} funds 0`,
        );
      }
    }

    out.push("", "Per account final breakdown");
    for (const account of partition?.accounts ?? []) {
      out.push(
        `- ${accountLabel(account.accountId)}`,
        `  income ${moneyMinor(trace.currency, account.monthlyIncomeMinor)} + derived in ${moneyMinor(trace.currency, account.transferInMinor)} + movement in ${moneyMinor(trace.currency, account.movementInMinor)} - expenses funded ${moneyMinor(trace.currency, account.fundedOutflowMinor)} - derived out ${moneyMinor(trace.currency, account.transferOutMinor)} - authored out ${moneyMinor(trace.currency, account.committedMinor)} = residual ${moneyMinor(trace.currency, account.leftoverMinor)}`,
        `  own leftover before authored savings: ${moneyMinor(trace.currency, account.ownLeftoverMinor)}; shortfall ${moneyMinor(trace.currency, account.shortfallMinor)}; confirmed arriving ${moneyMinor(trace.currency, account.confirmedInflowMinor)}`,
      );
      const lines = (partition?.lines ?? []).filter((l) => l.accountId === account.accountId);
      if (lines.length === 0) out.push("  expenses: none");
      for (const line of lines) {
        out.push(
          `  expense ${line.name} priority=${line.priority}: required ${moneyMinor(trace.currency, line.requiredMonthlyMinor)}, funded ${moneyMinor(trace.currency, line.fundedMonthlyMinor)} (own ${moneyMinor(trace.currency, line.fundedFromOwnMinor)}, arriving ${moneyMinor(trace.currency, line.fundedFromInflowMinor)}), onTrack=${line.onTrack}`,
        );
        for (const allocation of line.allocations) {
          out.push(
            `    ${memberLabel(allocation.userId)} required ${moneyMinor(trace.currency, allocation.requiredMinor)}, funded ${moneyMinor(trace.currency, allocation.fundedMinor)}`,
          );
        }
      }
      const transfersIn = (partition?.transfers ?? []).filter((t) => t.toAccountId === account.accountId);
      const transfersOut = (partition?.transfers ?? []).filter((t) => t.fromAccountId === account.accountId);
      for (const transfer of transfersIn) {
        out.push(
          `  derived transfer in from ${accountLabel(transfer.fromAccountId)} for ${memberLabel(transfer.memberUserId)}: ${moneyMinor(trace.currency, transfer.amountMinor)} confirmed ${moneyMinor(trace.currency, transfer.confirmedMinor)}`,
        );
      }
      for (const transfer of transfersOut) {
        out.push(
          `  derived transfer out to ${accountLabel(transfer.toAccountId)} for ${memberLabel(transfer.memberUserId)}: ${moneyMinor(trace.currency, transfer.amountMinor)} confirmed ${moneyMinor(trace.currency, transfer.confirmedMinor)}`,
        );
      }
      for (const movement of (partition?.movements ?? []).filter(
        (m) => m.fromAccountId === account.accountId || m.toAccountId === account.accountId,
      )) {
        out.push(
          `  authored movement ${movementLabel(movement.inflowId)} ${accountLabel(movement.fromAccountId)} -> ${accountLabel(movement.toAccountId)}: requested ${moneyMinor(trace.currency, movement.requestedMinor)}, funded ${moneyMinor(trace.currency, movement.fundedMinor)} (own ${moneyMinor(trace.currency, movement.fundedFromOwnMinor)}, arriving ${moneyMinor(trace.currency, movement.fundedFromInflowMinor)}), status=${movement.status}`,
        );
      }
    }

    out.push("", "Per user final breakdown");
    for (const member of partition?.members ?? []) {
      out.push(
        `- ${memberLabel(member.userId)}`,
        `  income ${moneyMinor(trace.currency, member.monthlyIncomeMinor)}; obligations required ${moneyMinor(trace.currency, member.obligationMinor)}; funded ${moneyMinor(trace.currency, member.fundedMinor)}; shortfall ${moneyMinor(trace.currency, member.shortfallMinor)}`,
        `  leftover after funded obligations ${moneyMinor(trace.currency, member.leftoverMinor)}; authored savings committed ${moneyMinor(trace.currency, member.committedMinor)}; source account ${member.sourceAccountId ? accountLabel(member.sourceAccountId) : "none"}`,
      );
    }
  }

  return out.join("\n");
}

function transferKey(from: string, to: string, memberUserId: string): string {
  return `${from}→${to}→${memberUserId}`;
}

// ---------------------------------------------------------------------------
// The close, as a view of the pass
// ---------------------------------------------------------------------------

/**
 * One row of the ledger of money actually set aside, as a close reads it.
 *
 * The domain does not depend on the store, so this is the three columns of
 * `core.contributions` a close needs and no more.
 */
export interface CloseContribution {
  /** The account it was set aside in. A close buckets by that account's
   *  currency, because the pass partitions by currency and a scorecard has to
   *  say which partition it is scoring. */
  accountId: string;
  /**
   * Whose money / who recorded it.
   *
   * Nullable because `core.contributions.user_id` predates the writers that set
   * it; every creation site sets it today. A row without one is nobody's and is
   * counted for nobody (decision 17 — no legacy handling beyond saying so).
   */
  userId: string | null;
  amountMinor: number;
}

/** A user's month, in one currency: what they earned, planned, and set aside.
 *  The four columns `core.month_closes` holds for a user-scoped row. */
export interface UserMonthClose {
  currency: string;
  incomeMinor: number;
  plannedMinor: number;
  contributedMinor: number;
}

/**
 * **A month close is per user, per currency** (decision 14), and it is a *view*.
 *
 * A close freezes a scorecard — _you earned X, planned Y, set aside Z_ — and the
 * one thing it must never become is a second computation. So there is no
 * arithmetic here that the pass has not already done: the income is
 * `ScopeMemberPlan.monthlyIncomeMinor`, the planned figure is
 * `.obligationMinor`, both read straight off the partition, and the only sum is
 * over the contributions ledger, which is a ledger precisely so that summing it
 * is the answer.
 *
 * That both figures are the *member's* rather than a location's is what makes
 * the scorecard mean something. Asked of an account, "what did you earn?" had to
 * be redefined as "what arrived", so a household holding a fed bills pot froze
 * £0 of income against a contributed figure made entirely of transfers — a row
 * that could never say anything. Asked of a person, it needs no redefinition,
 * and the partition's own income is the sum of its members' (decision 15, and
 * `closeForUser` is where that identity is cashed).
 *
 * One row per currency partition the user appears in, in the pass's partition
 * order — alphabetical by currency — so one action can close every partition of
 * their month at once. A contribution against an account the pass never planned
 * has no currency to be bucketed by and is not counted; the caller decides which
 * ledger rows belong to the month, because a month is not something the pass
 * knows about.
 */
export function closeForUser(
  plan: ScopePlan,
  contributions: readonly CloseContribution[],
  userId: string,
): UserMonthClose[] {
  const currencyOf = new Map(plan.accounts.map((a) => [a.accountId, a.currency] as const));
  const contributed = new Map<string, number>();
  for (const c of contributions) {
    if (c.userId !== userId) continue;
    const currency = currencyOf.get(c.accountId);
    if (currency === undefined) continue;
    contributed.set(currency, (contributed.get(currency) ?? 0) + c.amountMinor);
  }

  const closes: UserMonthClose[] = [];
  for (const partition of plan.partitions) {
    const member = partition.members.find((m) => m.userId === userId);
    if (!member) continue;
    closes.push({
      currency: partition.currency,
      incomeMinor: member.monthlyIncomeMinor,
      plannedMinor: member.obligationMinor,
      contributedMinor: contributed.get(partition.currency) ?? 0,
    });
  }
  return closes;
}

// ---------------------------------------------------------------------------
// A person's money, as a view of the pass
// ---------------------------------------------------------------------------

/** What one person has left, in one currency, over the accounts they own. */
export interface UserLeftover {
  currency: string;
  /**
   * `Σ ScopeAccountPlan.leftoverMinor` over the accounts this person **owns** —
   * the residual, signed, exactly as the account altitude reports it.
   */
  leftoverMinor: number;
  /** `Σ ScopeAccountPlan.shortfallMinor` over the same accounts (>= 0). */
  shortfallMinor: number;
  /** How many of the pass's plan lines fall on those accounts. */
  paymentCount: number;
}

/**
 * **What is left over for this person** (decision 19), and it is a *view*.
 *
 * `closeForUser`'s shape, deliberately, and for the same reason: no arithmetic
 * the pass has not already done. An account's left over is its residual —
 * `income + arriving − spending − leaving`, which is
 * `ScopeAccountPlan.leftoverMinor`. A **person's** is that, summed over the
 * accounts they own. A **household's** is its members', added up
 * (`HouseholdPlan.membersLeftoverMinor`). Each altitude is a plain sum of the
 * one below it, so the rows on a screen add up to the total above them; nothing
 * is netted and nothing is reconstructed by algebra.
 *
 * **Ownership, never access** (decision 20). An account a co-member shared into
 * the household is theirs and appears in their figure, not in yours; a shared
 * pot you own is yours, which is decision 15 restated one altitude up. Every
 * roll-up in this product that counted "the accounts I can see" was answering a
 * question about somebody else's money.
 *
 * `shortfallMinor` and `paymentCount` ride along because a headline that put a
 * left over that is yours beside a shortfall that is the household's would state
 * two bases in one sentence, which is the disease this work exists to cure
 * (decision 24). They are the same sum over the same set.
 *
 * One row per currency partition the user appears in, in the pass's partition
 * order — alphabetical by currency — because a second currency is a second
 * answer and never a term in the first (decision 10). A member with nothing in a
 * partition reads zero there rather than being missing from it, exactly as
 * `closeForUser` gives them a row; a user who is in no partition at all —
 * somebody outside the scope who happens to own an account the pass had to plan
 * — gets nothing, because the pass was never told what they earn.
 *
 * **The case this cannot net, and does not try to.** A co-member's *authored*
 * movement into an account you own is not spent where it lands (authored
 * movements are funded after every expense — decision 8), so the remainder sits
 * in your residual and therefore in your figure: genuinely in your account,
 * genuinely not your money. Reporting the place is the whole of decision 19 —
 * the alternative is a fourth derivation, chasing provenance the pass cannot
 * interpret, to answer a question the household total does not ask. The total is
 * unaffected either way: the pound is added to your figure and subtracted from
 * theirs. `crossowner.fixture.ts` is that case, and `mine.test.ts` pins it.
 */
export function leftoverForUser(plan: ScopePlan, userId: string): UserLeftover[] {
  const leftovers: UserLeftover[] = [];
  for (const partition of plan.partitions) {
    if (!partition.members.some((m) => m.userId === userId)) continue;
    const owned = new Set<string>();
    let leftoverMinor = 0;
    let shortfallMinor = 0;
    for (const account of partition.accounts) {
      if (account.ownerUserId !== userId) continue;
      owned.add(account.accountId);
      leftoverMinor += account.leftoverMinor;
      shortfallMinor += account.shortfallMinor;
    }
    leftovers.push({
      currency: partition.currency,
      leftoverMinor,
      shortfallMinor,
      paymentCount: partition.lines.filter((l) => owned.has(l.accountId)).length,
    });
  }
  return leftovers;
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
  debug?: SavingsDebugTrace;
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
  const { accounts, inPartition, currency, now, ownPool, inflowPool, debug } = pass;
  const byId = new Map(accounts.map((a) => [a.accountId, a]));
  const edges = buildFundingEdges(accounts);
  const { order, cycles, broken } = orderAccounts([...byId.keys()], edges);
  if (debug) {
    debug.edges = edges.map((edge) => ({
      inflowId: edge.inflowId,
      name: edge.row.name,
      fromAccountId: edge.from,
      toAccountId: edge.to,
      priority: edge.priority,
      requestedMinor: Math.max(0, monthlyIncomeMinor(edge.row, now)),
    }));
    debug.order = order;
    debug.cycles = cycles;
    debug.brokenInflowIds = [...broken].sort();
  }

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
    const accountDebug: SavingsAccountDebugTrace | null = debug
      ? {
          accountId,
          ownPoolStartMinor: ownPool.get(accountId)!,
          inflowPoolStartMinor: inflowPool.get(accountId)!,
          arrivalsMinor: arrivals.reduce((sum, a) => sum + a.amountMinor, 0),
          availableOwnMinor: own,
          availableInflowMinor: inflow,
          arrivals,
          movements: [],
          ownPoolEndMinor: own,
          inflowPoolEndMinor: inflow,
        }
      : null;

    // A movement the pass has decided to ignore must not eat the sender's money
    // on its way past: it is not happening, so it costs nothing. Everything else
    // stays, including movements out of the partition — that money really does
    // leave, and it has to keep its place in the queue or the movements behind it
    // would be funded with money already spoken for.
    for (const edge of outByAccount.get(accountId) ?? []) {
      const requested = Math.max(0, monthlyIncomeMinor(edge.row, now));
      if (broken.has(edge.inflowId)) {
        accountDebug?.movements.push({
          rank: accountDebug.movements.length + 1,
          inflowId: edge.inflowId,
          name: edge.row.name,
          fromAccountId: edge.from,
          toAccountId: edge.to,
          priority: edge.priority,
          requestedMinor: requested,
          ownBeforeMinor: own,
          fundedFromOwnMinor: 0,
          ownAfterMinor: own,
          inflowBeforeMinor: inflow,
          fundedFromInflowMinor: 0,
          inflowAfterMinor: inflow,
          fundedMinor: 0,
          status: "broken_cycle",
          deliveredToPartition: false,
        });
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
      const ownBefore = own;
      const inflowBefore = inflow;
      const fromOwn = Math.min(requested, own);
      own -= fromOwn;
      const fromInflow = Math.min(requested - fromOwn, inflow);
      inflow -= fromInflow;
      const funded = fromOwn + fromInflow;
      const deliveredToPartition = funded > 0 && inPartition.has(edge.to);
      if (funded > 0 && inPartition.has(edge.to)) {
        const list = arrivalsFor.get(edge.to) ?? [];
        list.push({ inflowId: edge.inflowId, fromAccountId: edge.from, amountMinor: funded });
        arrivalsFor.set(edge.to, list);
      }
      const status: EstateMovementStatus =
        funded >= requested ? "funded" : funded > 0 ? "short" : "unfunded";
      accountDebug?.movements.push({
        rank: accountDebug.movements.length + 1,
        inflowId: edge.inflowId,
        name: edge.row.name,
        fromAccountId: edge.from,
        toAccountId: edge.to,
        priority: edge.priority,
        requestedMinor: requested,
        ownBeforeMinor: ownBefore,
        fundedFromOwnMinor: fromOwn,
        ownAfterMinor: own,
        inflowBeforeMinor: inflowBefore,
        fundedFromInflowMinor: fromInflow,
        inflowAfterMinor: inflow,
        fundedMinor: funded,
        status,
        deliveredToPartition,
      });
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
        status,
      });
    }
    ownPool.set(accountId, own);
    inflowPool.set(accountId, inflow);
    if (accountDebug) {
      accountDebug.ownPoolEndMinor = own;
      accountDebug.inflowPoolEndMinor = inflow;
      debug!.accountSteps.push(accountDebug);
    }
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
      const movement: ScopeMovement = {
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
      };
      movements.push(movement);
      debug?.unknownSources.push({
        rank: debug.unknownSources.length + 1,
        inflowId: movement.inflowId,
        name: row.name,
        fromAccountId: movement.fromAccountId,
        toAccountId: movement.toAccountId,
        priority: movement.priority,
        requestedMinor: movement.requestedMinor,
        ownBeforeMinor: 0,
        fundedFromOwnMinor: 0,
        ownAfterMinor: 0,
        inflowBeforeMinor: 0,
        fundedFromInflowMinor: 0,
        inflowAfterMinor: 0,
        fundedMinor: 0,
        status: "unknown_source",
        deliveredToPartition: false,
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
