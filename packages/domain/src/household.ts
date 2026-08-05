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
  monthlyIncomeMinor: number;
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
   *  accounts have spoken for (decision 13). Added alongside, never netted. */
  committedMinor: number;
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
  leftoverMinor: number;
  /** Of that leftover, what the household's funded savings movements have
   *  spoken for (decision 13). */
  committedMinor: number;
  shortfallMinor: number;
  members: HouseholdMemberPlan[];
  accounts: HouseholdAccountPlan[];
  lines: HouseholdPlanLine[];
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
    return {
      userId: m.userId,
      displayName: m.displayName,
      shareBp: m.shareBp,
      monthlyIncomeMinor: m.monthlyIncomeMinor,
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
      committedMinor: accounts
        .filter((a) => a.role === "personal" && a.memberUserId === m.userId)
        .reduce((s, a) => s + a.committedMinor, 0),
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
  // Income no member's budget counted — a shared pot's own income, chiefly, and
  // a personal account assigned to nobody.
  const unattributedIncome = accounts
    .filter((a) => !(a.role === "personal" && a.memberUserId && memberIds.has(a.memberUserId)))
    .reduce((s, a) => s + a.monthlyIncomeMinor, 0);

  return {
    householdId,
    asOfDate: plan.asOfDate,
    currency,
    monthlyIncomeMinor: monthlyIncome,
    totalRequiredMinor: totalRequired,
    totalFundedMinor: totalFunded,
    leftoverMinor: members.reduce((s, m) => s + m.leftoverMinor, 0) + unattributedIncome,
    committedMinor: committedByAccount,
    shortfallMinor: Math.max(0, totalRequired - totalFunded),
    members,
    accounts,
    lines,
    transfers: partition.transfers
      .filter((t) => inHousehold.has(t.toAccountId) || inHousehold.has(t.fromAccountId))
      .map((t) => ({
        fromAccountId: t.fromAccountId,
        toAccountId: t.toAccountId,
        memberUserId: t.memberUserId,
        amountMinor: t.amountMinor,
      })),
  };
}
