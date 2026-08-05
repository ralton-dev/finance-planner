import { splitByShares, type AccountRole, type PaymentCategory } from "@finance-planner/contracts";
import type { PaymentScope } from "@finance-planner/contracts";
import type { ScopeCurrencyPlan, ScopePlan } from "./scope.js";

/**
 * The household plan, as a **view** of the one pass.
 *
 * A household is a scope with sharing rules, so it has no engine of its own any
 * more. `computeHouseholdPlan` used to be the second funding engine — member
 * budgets, one global priority order, derived transfers — and it could not see
 * money leaving one of its own accounts, because `HouseholdAccountInput` carried
 * incomes and payments and nothing else. That blindness is what made the same
 * account read £2,793 here and £2,093 on the flow diagram (ONE-ENGINE.md). The
 * pass generalised its structure and gained the term it was missing; this file
 * keeps the shape the household page reads and none of the arithmetic.
 *
 * Everything below is a projection of `ScopeCurrencyPlan`, restricted to the
 * accounts the household actually holds. A scope normally *is* the household —
 * but it reaches upstream to whatever funds it, and a sender nobody assigned to
 * the household is not one of its accounts, however necessary it was to plan.
 */

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** How a single payment's monthly cost is split across members. */
export interface MemberAllocation {
  userId: string;
  requiredMinor: number;
  fundedMinor: number;
}

export interface HouseholdPlanLine {
  paymentId: string;
  accountId: string;
  name: string;
  category: PaymentCategory;
  scope: PaymentScope;
  amountMinor: number;
  dueDate: string;
  targetDate: string;
  priority: number;
  requiredMonthlyMinor: number;
  fundedMonthlyMinor: number;
  occurrencesThisMonth: number;
  onTrack: boolean;
  /** Passthrough of the payment's grouping label, so charts can group without
   *  refetching the payments. */
  tag?: string | null;
  allocations: MemberAllocation[];
}

export interface HouseholdMemberPlan {
  userId: string;
  displayName?: string;
  /** Share normalised to sum 10000 across members, for display. */
  shareBp: number;
  /** Everything this member earns anywhere in the scope. Scope-wide, and it
   *  keeps that meaning exactly — the split below is added alongside it
   *  (decision 4/13). */
  monthlyIncomeMinor: number;
  /**
   * Of that, what lands in the accounts they **own** that are on this
   * household's roster — the INCOME column of the account table above, for
   * their rows.
   *
   * Ownership, not the roster's `memberUserId` (decision 15): a shared pot is
   * still somebody's account, and a pot on this very table earning £500 of
   * lodger rent earns it for whoever owns it. While income followed the
   * household *role*, that £500 belonged to nobody — absent from every member's
   * figure here, and from the budget that pays the pot's own bills.
   */
  householdIncomeMinor: number;
  /**
   * The rest of it, named: what they earn into accounts this household does not
   * hold.
   *
   * Two accounts an owner keeps out of a household used to be two accounts it
   * could not see the income of, because a member's budget was only ever the
   * roster's. `f3acef8` closed ownership and assignment into one relation so a
   * member's private pot could reach their salary, and their salary joined the
   * budget that pays their household share — correctly, and visibly, on a page
   * whose every other member figure was already scope-wide.
   *
   * Published as an amount and no more (Ben, 2026-08-05): a co-member reading
   * "incl. £1,000 elsewhere" can judge whether the hand-set `contributionShareBp`
   * split still makes sense, and *which* account it arrives in tells them
   * nothing they need. `elsewhereObligationMinor`'s sibling on the other side of
   * the row, and permanent like it — the figure has two halves whether or not
   * any money crosses between them.
   *
   * `householdIncomeMinor + elsewhereIncomeMinor === monthlyIncomeMinor`.
   */
  elsewhereIncomeMinor: number;
  /** Total monthly cost attributed to this member (their personal + their
   *  proportional slice of shared costs). Scope-wide, and it keeps that meaning
   *  exactly — the split below is added alongside it (decision 4/13). */
  obligationMinor: number;
  fundedMinor: number;
  /**
   * Of `obligationMinor`, the part this household's own `lines` carry — what the
   * breakdown printed beneath the figure explains — and what the pass funded of
   * it.
   *
   * The figure and its breakdown were computed over two different sets of
   * accounts: `obligationMinor` comes off the scope-wide partition, `lines` off
   * the household's own accounts. That was harmless while they were the same
   * set, and decision 9 ended that — a member's solo bills pot is fed by a
   * derived transfer, so they genuinely bear expenses on accounts the household
   * does not hold, and the page read "their costs £1,374.20" over a breakdown
   * explaining something else.
   */
  householdObligationMinor: number;
  householdFundedMinor: number;
  /**
   * The rest of it, named.
   *
   * Chiefly cost on accounts this household does not hold — a member's own bills
   * pot, a personal account nobody assigned here — plus their share of any
   * reserve on a shared pot, which is a real obligation with no line to carry
   * it. `committedMinor`'s missing sibling: money **leaving** as savings had a
   * category and money **spent elsewhere** had none, so it simply inflated the
   * headline with nothing naming it, and the web invented the category by
   * subtraction (`apps/web/src/lib/tags.ts`, now deleted).
   *
   * `householdObligationMinor + elsewhereObligationMinor === obligationMinor`,
   * and the same for funded — which is what lets the page reconcile.
   */
  elsewhereObligationMinor: number;
  elsewhereFundedMinor: number;
  /** Discretionary surplus after the buffer + obligations (>= 0). Keeps its
   *  meaning exactly (decision 13): **not** reduced by `committedMinor`. */
  leftoverMinor: number;
  /** Of that leftover, what funded savings movements out of this member's own
   *  **household** accounts have spoken for (decision 13). Added alongside,
   *  never netted, and narrowed to this household deliberately: a member's
   *  private ISA draining a private current account is not its business. */
  committedMinor: number;
  /**
   * The rest of what they have committed, named — `elsewhereObligationMinor`'s
   * sibling in the one direction the committed bucket has.
   *
   * `committedMinor` is household-only and `leftoverMinor` is scope-wide, so
   * netting one against the other spanned two different sets of accounts: a
   * member sweeping £100 into a pot out of a personal account the household
   * does not hold had that £100 in neither term, and their free money was
   * over-stated by exactly it. Measured in a browser: a member reading £2,154
   * free with £1,150 of it already promised to two movements leaving her own
   * current account.
   *
   * `committedMinor + elsewhereCommittedMinor === ScopeMemberPlan.committedMinor`,
   * which is what lets a row about a person subtract a person's whole
   * commitment from a person's whole surplus.
   */
  elsewhereCommittedMinor: number;
  /** Obligation the member's income can't cover (>= 0). */
  shortfallMinor: number;
}

export interface HouseholdAccountPlan {
  accountId: string;
  name?: string;
  role: AccountRole;
  memberUserId: string | null;
  currency: string;
  monthlyIncomeMinor: number;
  /** Bills funded out of this account each month. */
  requiredOutflowMinor: number;
  fundedOutflowMinor: number;
  transferInMinor: number;
  transferOutMinor: number;
  /**
   * What authored savings movements delivered into this account.
   *
   * `ScopeAccountPlan.movementInMinor` passed straight through. Published
   * because the flow page needed it and had to rearrange `leftoverMinor`'s
   * published identity to get it — arithmetic that was right, and that stops
   * being right the moment any term in the identity changes meaning, which is
   * the thing this work keeps finding. Additive: no existing field moves
   * (decision 4/13).
   */
  movementInMinor: number;
  /**
   * What remains in the account after the month's flows (includes any buffer
   * reserve, and the pennies members rounded their shares up by) — **before**
   * the savings movements leaving it.
   *
   * Keeps its meaning to the penny (decision 13): for a household with no
   * authored movement anywhere it is the same `income + in − out − spending` it
   * always was. `committedMinor` sits alongside, and free-after-committed is the
   * difference — which is the figure that now agrees with the flow diagram and
   * the account page (`packages/domain/src/parity.test.ts`).
   */
  leftoverMinor: number;
  /** What funded savings movements take out of this account (decision 13). */
  committedMinor: number;
  shortfallMinor: number;
}

/** A monthly money movement one member should make between two accounts. */
export interface Transfer {
  fromAccountId: string;
  toAccountId: string;
  memberUserId: string;
  amountMinor: number;
}

export interface HouseholdPlan {
  householdId: string;
  asOfDate: string;
  currency: string;
  monthlyIncomeMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  /**
   * The **members'** discretionary surplus, scope-wide, plus income sitting in
   * one of this household's accounts that no member's budget counted.
   *
   * Scope-wide, and it keeps that meaning exactly (decision 13) — but it is the
   * only field on this interface that is, and that is what made it wrong as a
   * headline. Everything else here is the household's own accounts: the income,
   * the requirement, the funded total, the committed total, the shortfall, the
   * lines, the transfers. Printed beside them, this said "left over £2,000" over
   * an income of £0 for a household holding nothing but its bills pot — money
   * its own income figure did not contain, sitting in accounts its own account
   * table does not list.
   *
   * `householdLeftoverMinor` below is the figure a household headline wants.
   * The two are not two halves of one thing and there is no "elsewhere" term
   * that would make them so: this one measures **people** (budget less
   * obligations, wherever their accounts are), and that one measures
   * **accounts** (what is in them when the month's flows have happened). They
   * coincide for a household that holds every account its members own, which is
   * why nobody noticed, and decision 9 ended that by feeding a member's own
   * bills pot with a derived transfer.
   */
  leftoverMinor: number;
  /**
   * What is left **in this household's accounts** once the month has happened —
   * before the savings movements leaving them, exactly as
   * `HouseholdAccountPlan.leftoverMinor` is.
   *
   * Summed off the very rows the page prints beneath the figure (WP-V's
   * discipline: figure and breakdown can never again be computed over different
   * sets of accounts), so free-after-committed at the top of the page is the
   * LEFT OVER column of the account table, added up.
   *
   *     householdLeftoverMinor
   *       === Σ accounts[].leftoverMinor
   *       === monthlyIncomeMinor + Σ transferInMinor + Σ movementInMinor
   *           − Σ fundedOutflowMinor − Σ transferOutMinor
   *
   * The second line is the household's ribbons meeting: every term is a
   * published field of the accounts listed below, so a reader can check it and
   * a test does (`household.test.ts`). Signed, like the account figure — a
   * household committed to sending out more than reaches it is a fact the screen
   * has to be able to say.
   */
  householdLeftoverMinor: number;
  /** Of that leftover, what the household's funded savings movements have
   *  spoken for (decision 13). */
  committedMinor: number;
  shortfallMinor: number;
  members: HouseholdMemberPlan[];
  accounts: HouseholdAccountPlan[];
  lines: HouseholdPlanLine[];
  /** The transfers that fund **this household's** accounts — money arriving,
   *  whoever it comes from. What one of its accounts sends on to a member's own
   *  pot is that member's business and is not listed; see the filter below. */
  transfers: Transfer[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The share split lives in `@finance-planner/contracts` so the web client can
 *  promise exactly what this engine does without depending on the domain.
 *  Re-exported here because it is part of the domain's public surface. */
export { splitByShares };

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/**
 * A household's pooled plan, read off a planned scope.
 *
 * `accountIds` are the accounts assigned to the household — the roster
 * `listAccountAssignments` returns — and nothing outside it is reported, even
 * though the pass had to plan more of the graph than that to answer honestly.
 * `currency` picks the partition: a household is single-currency by assumption
 * (see BACKLOG), and a scope that spans two plans each on its own.
 *
 * No funding arithmetic. Every figure below is a sum or a passthrough of
 * decisions `computeScopePlan` already made, which is why the household page and
 * the account page cannot disagree: they are reading the same pass.
 */
export function householdPlanFromScope(
  plan: ScopePlan,
  householdId: string,
  accountIds: readonly string[],
  currency: string,
): HouseholdPlan {
  const partition: Pick<ScopeCurrencyPlan, "members" | "accounts" | "lines" | "transfers"> =
    plan.partitions.find((p) => p.currency === currency) ?? {
      members: [],
      accounts: [],
      lines: [],
      transfers: [],
    };
  const inHousehold = new Set(accountIds);
  const memberIds = new Set(partition.members.map((m) => m.userId));
  // Whose each account is, off the pass. Income is attributed by ownership
  // (decision 15) and `HouseholdAccountPlan` deliberately does not republish it:
  // whose account a shared pot is belongs on the accounts page, not among a
  // household's figures. Every account below is one of `partition.accounts`, so
  // every lookup hits.
  const ownerOf = new Map(partition.accounts.map((a) => [a.accountId, a.ownerUserId] as const));

  const accounts: HouseholdAccountPlan[] = partition.accounts
    .filter((a) => inHousehold.has(a.accountId))
    .map((a) => ({
      accountId: a.accountId,
      name: a.name,
      role: a.role,
      memberUserId: a.memberUserId,
      currency: a.currency,
      monthlyIncomeMinor: a.monthlyIncomeMinor,
      requiredOutflowMinor: a.requiredOutflowMinor,
      fundedOutflowMinor: a.fundedOutflowMinor,
      transferInMinor: a.transferInMinor,
      transferOutMinor: a.transferOutMinor,
      movementInMinor: a.movementInMinor,
      // The pass's residual is already net of the savings leaving; adding the
      // committed total back gives the field its historical meaning, and the two
      // are published side by side rather than one being derived from the other
      // by whoever reads them.
      leftoverMinor: a.leftoverMinor + a.committedMinor,
      committedMinor: a.committedMinor,
      shortfallMinor: a.shortfallMinor,
    }));

  const lines: HouseholdPlanLine[] = partition.lines
    .filter((l) => inHousehold.has(l.accountId))
    .map((l) => ({
      paymentId: l.paymentId,
      accountId: l.accountId,
      name: l.name,
      category: l.category,
      scope: l.scope,
      amountMinor: l.amountMinor,
      dueDate: l.dueDate,
      targetDate: l.targetDate,
      priority: l.priority,
      requiredMonthlyMinor: l.requiredMonthlyMinor,
      fundedMonthlyMinor: l.fundedMonthlyMinor,
      occurrencesThisMonth: l.occurrencesThisMonth,
      onTrack: l.onTrack,
      tag: l.tag,
      allocations: l.allocations,
    }));

  const committedByAccount = accounts.reduce((s, a) => s + a.committedMinor, 0);
  const members: HouseholdMemberPlan[] = partition.members.map((m) => {
    // What this household's own lines ask of them, and got. Read off the very
    // rows the page prints beneath the figure, so the two cannot be computed
    // over different sets of accounts again.
    let householdObligationMinor = 0;
    let householdFundedMinor = 0;
    for (const line of lines) {
      const allocation = line.allocations.find((a) => a.userId === m.userId);
      if (!allocation) continue;
      householdObligationMinor += allocation.requiredMinor;
      householdFundedMinor += allocation.fundedMinor;
    }
    // And what this household's own account rows earn for them and commit for
    // them — the same accounts, read once, for the same reason: both figures are
    // printed on the page beneath the halves they explain.
    let householdIncomeMinor = 0;
    let householdCommittedMinor = 0;
    for (const a of accounts) {
      // Income by **ownership**, whatever the account's role (decision 15): a
      // shared pot on this roster earning its own lodger rent earns it for
      // whoever owns the pot, and that income is in their budget, so calling it
      // "elsewhere" on the very page the pot is listed on would be a lie the
      // reader could see. Committed stays a role question, matching
      // `ScopeMemberPlan.committedMinor` exactly — the identity beneath it is
      // that the two halves sum to the pass's figure, and they cannot if one
      // half counts a set of accounts the other does not.
      if (ownerOf.get(a.accountId) === m.userId) householdIncomeMinor += a.monthlyIncomeMinor;
      if (a.role === "personal" && a.memberUserId === m.userId) {
        householdCommittedMinor += a.committedMinor;
      }
    }
    return {
      userId: m.userId,
      displayName: m.displayName,
      shareBp: m.shareBp,
      monthlyIncomeMinor: m.monthlyIncomeMinor,
      householdIncomeMinor,
      // Floored like the two below, and for the same reason: the halves come off
      // one pass, and only a caller pairing a plan with a roster that disagrees
      // about the roster can make the difference negative.
      elsewhereIncomeMinor: Math.max(0, m.monthlyIncomeMinor - householdIncomeMinor),
      obligationMinor: m.obligationMinor,
      fundedMinor: m.fundedMinor,
      householdObligationMinor,
      householdFundedMinor,
      // Floored: the two halves are read off one pass, so the difference cannot
      // go negative unless a caller hands this a plan and a roster that disagree
      // about which accounts the household holds.
      elsewhereObligationMinor: Math.max(0, m.obligationMinor - householdObligationMinor),
      elsewhereFundedMinor: Math.max(0, m.fundedMinor - householdFundedMinor),
      leftoverMinor: m.leftoverMinor,
      // Restricted to the household's own accounts, so a member's private ISA
      // draining a private current account is not the household's business.
      committedMinor: householdCommittedMinor,
      // Floored for the same reason `elsewhereObligationMinor` is: the two
      // halves come off one pass, so the difference can only go negative if a
      // caller hands this a plan and a roster that disagree about the roster.
      elsewhereCommittedMinor: Math.max(0, m.committedMinor - householdCommittedMinor),
      shortfallMinor: m.shortfallMinor,
    };
  });

  // Counted as the members were *asked* for it — each share rounded up, so a
  // bill is never a penny short — plus anything a line needed that reached no
  // member at all. A household with nobody in it still owes the rent, and a
  // total that silently dropped it would report no shortfall while every account
  // on it was short (the defect WP-P found in `computeHouseholdPlan` and
  // declined to patch in a live surface).
  const totalRequired = lines.reduce(
    (s, l) =>
      s +
      Math.max(
        l.allocations.reduce((t, a) => t + a.requiredMinor, 0),
        l.requiredMonthlyMinor,
      ),
    0,
  );
  const totalFunded = lines.reduce(
    (s, l) => s + l.allocations.reduce((t, a) => t + a.fundedMinor, 0),
    0,
  );
  const monthlyIncome = accounts.reduce((s, a) => s + a.monthlyIncomeMinor, 0);
  // Income no member's budget counted — an account on the roster owned by
  // somebody who is not a member of it. A shared pot's own income is no longer
  // one of those: since decision 15 it belongs to whoever owns the pot, so if
  // they are a member it is already inside `leftoverMinor`'s first term, and
  // adding it here as well would put the same £500 in the headline twice.
  const unattributedIncome = accounts
    .filter((a) => !memberIds.has(ownerOf.get(a.accountId)!))
    .reduce((s, a) => s + a.monthlyIncomeMinor, 0);

  return {
    householdId,
    asOfDate: plan.asOfDate,
    currency,
    monthlyIncomeMinor: monthlyIncome,
    totalRequiredMinor: totalRequired,
    totalFundedMinor: totalFunded,
    leftoverMinor: members.reduce((s, m) => s + m.leftoverMinor, 0) + unattributedIncome,
    // Off the account rows above, not off the members: the household's money is
    // what is in the household's accounts. See the field's comment for why the
    // two are different questions rather than a whole and a part.
    householdLeftoverMinor: accounts.reduce((s, a) => s + a.leftoverMinor, 0),
    committedMinor: committedByAccount,
    shortfallMinor: Math.max(0, totalRequired - totalFunded),
    members,
    accounts,
    lines,
    // Money **arriving** at one of the household's accounts, and only that.
    //
    // The same narrowing `committedMinor` gets above, in the one direction a
    // transfer has and a balance does not. A member's private account feeding
    // the bills pot is the household's business — it pays for a line on this
    // list. A household account feeding that member's *own* pot is not: it is
    // their money going to their own bills, on an account this view does not
    // report, against an obligation `lines` does not carry — no more the
    // household's business than their private ISA.
    //
    // `||` published both, and the second kind was a row the household could
    // not even name ("Ben → account", since the far end is not in `accounts`)
    // with a working "mark done" that booked nothing: the confirm endpoint
    // credits `plan.lines` filtered to `toAccountId`, and there are no such
    // lines. Every row published here has some, which is the same statement as
    // the totals being coherent — the set is exactly the transport for the
    // obligations `totalRequiredMinor` and `totalFundedMinor` count, and it
    // sums to `sum(accounts[].transferInMinor)` to the penny.
    transfers: partition.transfers
      .filter((t) => inHousehold.has(t.toAccountId))
      .map((t) => ({
        fromAccountId: t.fromAccountId,
        toAccountId: t.toAccountId,
        memberUserId: t.memberUserId,
        amountMinor: t.amountMinor,
      })),
  };
}
