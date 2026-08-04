import {
  splitByShares,
  type AccountRole,
  type PaymentCategory,
  type PaymentScope,
} from "@finance-planner/contracts";
import { parseISODate } from "./dates.js";
import { monthlyIncomeMinor, requiredMonthlyForPayment } from "./engine.js";
import type { IncomeInput, PaymentInput } from "./types.js";

const DEFAULT_PRIORITY = 100;
/** Buffer reservations fund after every dated payment. */
const RESERVE_PRIORITY = Number.MAX_SAFE_INTEGER;
const FAR_FUTURE = "9999-12-31";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A household member with a proportional contribution to shared costs. */
export interface HouseholdMemberInput {
  userId: string;
  displayName?: string;
  /** Relative contribution weight (basis points). Normalised by the engine
   *  against the household total, so the absolute scale is free. */
  shareBp: number;
}

/** A payment carrying its household cost-sharing classification. */
export interface HouseholdPaymentInput extends PaymentInput {
  scope: PaymentScope;
  /** When scope === "personal": the member who bears it. Falls back to a
   *  personal account's owning member. */
  bearerUserId?: string | null;
}

/** An account participating in a household plan, with its role. */
export interface HouseholdAccountInput {
  accountId: string;
  name?: string;
  role: AccountRole;
  /** Set when role === "personal": the member who owns this account. */
  memberUserId?: string | null;
  currency: string;
  monthlyBufferMinor?: number;
  incomes: IncomeInput[];
  payments: HouseholdPaymentInput[];
}

/**
 * A household plan request. All accounts are assumed to share one currency
 * (multi-currency households are out of scope — see BACKLOG).
 */
export interface HouseholdInput {
  householdId: string;
  currency: string;
  members: HouseholdMemberInput[];
  accounts: HouseholdAccountInput[];
}

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
   *  proportional slice of shared costs). */
  obligationMinor: number;
  fundedMinor: number;
  /** Discretionary surplus after the buffer + obligations (>= 0). */
  leftoverMinor: number;
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
  /** What remains in the account after the month's flows (includes any buffer
   *  reserve, and the pennies members rounded their shares up by). */
  leftoverMinor: number;
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

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Compute a household's pooled monthly plan as of `asOfDate`.
 *
 * Unlike the per-account plan, money is considered across all accounts at once:
 *   - Shared costs are split across members by their contribution share, each
 *     member's slice rounded up (see `splitByShares`). The split happens once
 *     per line, so a pot can end the month up to (lines × (members − 1)) minor
 *     units over-funded — deliberately, so no bill is ever a penny short.
 *   - Personal costs are borne entirely by one member (their bearer / the
 *     owning member of a personal account).
 *   - Each member funds their attributed costs from their own income in global
 *     priority order; whatever they can't cover surfaces as their shortfall.
 *   - The money each member must move between accounts to fund everything is
 *     derived as a set of transfers (the input to the Sankey view).
 *
 * Assumptions (see BACKLOG): one currency per household; shared-pot income is
 * uncommon and accumulates as pot surplus rather than reducing contributions.
 */
export function computeHouseholdPlan(input: HouseholdInput, asOfDate: string): HouseholdPlan {
  const now = parseISODate(asOfDate);
  const members = input.members;
  const memberIdx = new Map(members.map((m, i) => [m.userId, i] as const));
  const shareWeights = members.map((m) => Math.max(0, m.shareBp));
  const totalShareBp = shareWeights.reduce((s, w) => s + w, 0);

  // --- income per account ---
  const accountIncome = new Map<string, number>();
  for (const acc of input.accounts) {
    accountIncome.set(
      acc.accountId,
      acc.incomes.reduce((sum, i) => sum + monthlyIncomeMinor(i, now), 0),
    );
  }

  // --- per member: income, reserved buffer, and their "source" account ---
  // (the personal account income lands in — where their transfers originate).
  const memberIncome = members.map(() => 0);
  const memberPersonalBuffer = members.map(() => 0);
  const memberSource: (string | undefined)[] = members.map(() => undefined);
  for (let i = 0; i < members.length; i++) {
    const personal = input.accounts
      .filter((a) => a.role === "personal" && a.memberUserId === members[i]!.userId)
      .sort((a, b) => (a.accountId < b.accountId ? -1 : 1));
    let bestInc = -1;
    for (const a of personal) {
      const inc = accountIncome.get(a.accountId) ?? 0;
      memberIncome[i]! += inc;
      memberPersonalBuffer[i]! += Math.max(0, a.monthlyBufferMinor ?? 0);
      if (inc > bestInc) {
        bestInc = inc;
        memberSource[i] = a.accountId;
      }
    }
  }

  // --- build lines + obligations ---
  const lines: HouseholdPlanLine[] = [];
  const obligations: Obligation[] = [];

  for (const acc of input.accounts) {
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
        name: p.name,
        category: p.category,
        scope: p.scope,
        amountMinor: p.amountMinor,
        dueDate: p.dueDate ?? req.effectiveDate,
        targetDate: req.effectiveDate,
        priority,
        requiredMonthlyMinor: req.requiredMinor,
        fundedMonthlyMinor: 0,
        occurrencesThisMonth: req.occurrencesThisMonth,
        onTrack: false,
        tag: p.tag ?? null,
        allocations: members.map((m) => ({ userId: m.userId, requiredMinor: 0, fundedMinor: 0 })),
      });
      for (let i = 0; i < members.length; i++) {
        lines[lineIdx]!.allocations[i]!.requiredMinor = allocReq[i]!;
        if (allocReq[i]! > 0) {
          obligations.push({
            accountId: acc.accountId,
            memberIdx: i,
            requiredMinor: allocReq[i]!,
            fundedMinor: 0,
            priority,
            sortDate: req.effectiveDate,
            lineIdx,
          });
        }
      }
    }

    // Shared-pot buffer: a reserve the members fund into the pot proportionally,
    // at the lowest priority. (Personal-account buffers reduce that member's
    // budget instead — handled below.)
    const buffer = Math.max(0, acc.monthlyBufferMinor ?? 0);
    if (acc.role === "shared" && buffer > 0) {
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

  // --- fund obligations in global priority order, per member budget ---
  const budget = members.map((_, i) => Math.max(0, memberIncome[i]! - memberPersonalBuffer[i]!));
  const remaining = budget.slice();
  const ordered = obligations
    .map((o, idx) => ({ o, idx }))
    .sort(
      (a, b) =>
        a.o.priority - b.o.priority ||
        (a.o.sortDate < b.o.sortDate ? -1 : a.o.sortDate > b.o.sortDate ? 1 : 0) ||
        a.idx - b.idx,
    );
  for (const { o } of ordered) {
    const funded = Math.max(0, Math.min(o.requiredMinor, remaining[o.memberIdx]!));
    o.fundedMinor = funded;
    remaining[o.memberIdx]! -= funded;
    if (o.lineIdx !== undefined) {
      const alloc = lines[o.lineIdx]!.allocations[o.memberIdx]!;
      alloc.fundedMinor = funded;
    }
  }

  // --- roll up payment lines ---
  for (const line of lines) {
    line.fundedMonthlyMinor = line.allocations.reduce((s, a) => s + a.fundedMinor, 0);
    line.onTrack = line.fundedMonthlyMinor >= line.requiredMonthlyMinor;
  }

  // --- derive transfers (funded obligations that cross account boundaries) ---
  const transferMap = new Map<string, Transfer>();
  for (const o of obligations) {
    if (o.fundedMinor <= 0) continue;
    const from = memberSource[o.memberIdx];
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
        amountMinor: o.fundedMinor,
      });
    }
  }
  const transfers = [...transferMap.values()].sort(
    (a, b) =>
      (a.fromAccountId < b.fromAccountId ? -1 : a.fromAccountId > b.fromAccountId ? 1 : 0) ||
      (a.toAccountId < b.toAccountId ? -1 : a.toAccountId > b.toAccountId ? 1 : 0),
  );

  // --- per-member summary ---
  const memberPlans: HouseholdMemberPlan[] = members.map((m, i) => {
    const ob = obligations.filter((o) => o.memberIdx === i);
    const obligation = ob.reduce((s, o) => s + o.requiredMinor, 0);
    const funded = ob.reduce((s, o) => s + o.fundedMinor, 0);
    return {
      userId: m.userId,
      displayName: m.displayName,
      shareBp:
        totalShareBp > 0
          ? Math.round((shareWeights[i]! / totalShareBp) * 10_000)
          : Math.round(10_000 / members.length),
      monthlyIncomeMinor: memberIncome[i]!,
      obligationMinor: obligation,
      fundedMinor: funded,
      leftoverMinor: remaining[i]!,
      shortfallMinor: Math.max(0, obligation - funded),
    };
  });

  // --- per-account summary ---
  const transferIn = new Map<string, number>();
  const transferOut = new Map<string, number>();
  for (const t of transfers) {
    transferIn.set(t.toAccountId, (transferIn.get(t.toAccountId) ?? 0) + t.amountMinor);
    transferOut.set(t.fromAccountId, (transferOut.get(t.fromAccountId) ?? 0) + t.amountMinor);
  }
  // Bills funded out of each account — the *bills*, taken off the lines rather
  // than off the member obligations that pay for them. Buffer reserves never
  // leave the account, and neither do the pennies members round up by: a bill
  // costs what it costs, so the over-contribution stays as the pot's leftover
  // instead of appearing as money the account paid out.
  const fundedOutflow = new Map<string, number>();
  const requiredOutflow = new Map<string, number>();
  for (const line of lines) {
    const paid = Math.min(line.fundedMonthlyMinor, line.requiredMonthlyMinor);
    fundedOutflow.set(line.accountId, (fundedOutflow.get(line.accountId) ?? 0) + paid);
    requiredOutflow.set(
      line.accountId,
      (requiredOutflow.get(line.accountId) ?? 0) + line.requiredMonthlyMinor,
    );
  }
  const accountPlans: HouseholdAccountPlan[] = input.accounts.map((acc) => {
    const income = accountIncome.get(acc.accountId) ?? 0;
    const tin = transferIn.get(acc.accountId) ?? 0;
    const tout = transferOut.get(acc.accountId) ?? 0;
    const fout = fundedOutflow.get(acc.accountId) ?? 0;
    const rout = requiredOutflow.get(acc.accountId) ?? 0;
    return {
      accountId: acc.accountId,
      name: acc.name,
      role: acc.role,
      memberUserId: acc.memberUserId ?? null,
      currency: acc.currency,
      monthlyIncomeMinor: income,
      requiredOutflowMinor: rout,
      fundedOutflowMinor: fout,
      transferInMinor: tin,
      transferOutMinor: tout,
      leftoverMinor: income + tin - tout - fout,
      shortfallMinor: Math.max(0, rout - fout),
    };
  });

  // --- household totals ---
  const monthlyIncome = [...accountIncome.values()].reduce((s, v) => s + v, 0);
  const totalRequired = obligations.reduce((s, o) => s + o.requiredMinor, 0);
  const totalFunded = obligations.reduce((s, o) => s + o.fundedMinor, 0);
  const sharedIncome = input.accounts
    .filter((a) => a.role === "shared")
    .reduce((s, a) => s + (accountIncome.get(a.accountId) ?? 0), 0);
  const leftover = memberPlans.reduce((s, m) => s + m.leftoverMinor, 0) + sharedIncome;

  return {
    householdId: input.householdId,
    asOfDate,
    currency: input.currency,
    monthlyIncomeMinor: monthlyIncome,
    totalRequiredMinor: totalRequired,
    totalFundedMinor: totalFunded,
    leftoverMinor: leftover,
    shortfallMinor: Math.max(0, totalRequired - totalFunded),
    members: memberPlans,
    accounts: accountPlans,
    lines,
    transfers,
  };
}
