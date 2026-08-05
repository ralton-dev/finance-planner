import type { Recurrence } from "@finance-planner/contracts";
import {
  addUnit,
  ceilDiv,
  intervalInMonths,
  monthsUntil,
  nextOccurrence,
  occurrencesInMonth,
  parseISODate,
  toISODate,
} from "./dates.js";
import type { ScopeInput, ScopePlan } from "./scope.js";
import type {
  AccountPlan,
  IncomeInput,
  OutboundInflowPlan,
  PaymentInput,
  PaymentPlanLine,
  PaymentPlanStatus,
  TransferDeparture,
} from "./types.js";

/** Normalise a single income to its equivalent monthly amount (minor units). */
export function monthlyIncomeMinor(income: IncomeInput, now: Date): number {
  if (income.active === false) return 0;
  switch (income.frequency) {
    case "monthly":
      return income.amountMinor;
    case "yearly":
      return Math.round(income.amountMinor / 12);
    case "custom": {
      if (!income.recurrence) return income.amountMinor;
      const months = intervalInMonths(income.recurrence);
      return Math.round(income.amountMinor / Math.max(months, 1));
    }
    case "one_off": {
      const anchor = parseISODate(income.anchorDate);
      if (anchor.getTime() <= now.getTime()) return 0;
      return Math.round(income.amountMinor / monthsUntil(now, anchor));
    }
  }
}

function resolveRecurrence(p: PaymentInput): Recurrence | null {
  if (p.recurrence) return p.recurrence;
  if (p.category === "yearly_recurring" && p.dueDate) {
    return { interval: 1, unit: "year", anchor: p.dueDate };
  }
  // Note: monthly_recurring never reaches here — it returns earlier in
  // requiredMonthlyForPayment with the full amount due each month.
  return null;
}

interface RequiredResult {
  requiredMinor: number;
  /** The due/target date used for the computation (ISO date). */
  effectiveDate: string;
  monthsUntilDue: number;
  /** How many times the payment falls due in the as-of month (>= 1). */
  occurrencesThisMonth: number;
}

/**
 * The monthly contribution cap governing a payment, or null when none applies.
 *
 * Only a fixed_point goal can be contribution-first ("I'll put by £200 a month
 * until it's done"); the other categories are bills with real deadlines, so a
 * cap there would be a promise the calendar doesn't keep — it is ignored. A
 * non-positive cap is treated as absent (defensive: contracts require > 0).
 */
export function contributionCapMinor(p: PaymentInput): number | null {
  if (p.category !== "fixed_point") return null;
  const cap = p.fixedMonthlyMinor ?? null;
  return cap !== null && cap > 0 ? cap : null;
}

/**
 * Required monthly contribution to have a payment funded by its target date.
 * Per-category formulas:
 *   monthly_recurring → full amount due each month (nothing to "save up")
 *   fixed_point       → ceilDiv(amount - alreadySaved, monthsUntil(targetDate)),
 *                       or, when contribution-first (see below), the cap itself
 *   yearly_recurring  → ceilDiv(remaining, monthsUntil(nextOccurrence))
 *   custom_recurring  → if it falls due this month, (occurrences this month) ×
 *                       amount (a sub-monthly cadence like every-2-weeks can hit
 *                       2–3 times); otherwise save up toward the next occurrence
 * monthsUntil() floors at 1 to avoid divide-by-zero on past / this-month dates.
 *
 * Contribution-first goals (fixed_point + fixedMonthlyMinor):
 *   requiredMinor = min(cap, remaining) — the pace is chosen, not derived, and
 *   the final month asks only for what is left.
 *   With a dueDate:    the date no longer drives the amount (the cap does), but
 *                      it stays the effectiveDate, and monthsUntilDue still
 *                      counts to it — so the plan can still say "you'll be late".
 *   Without a dueDate: monthsUntilDue = ceilDiv(remaining, cap) (min 1) and the
 *                      effectiveDate is that many months on from the as-of date:
 *                      the goal's finish date is a consequence of the pace.
 */
export function requiredMonthlyForPayment(p: PaymentInput, now: Date): RequiredResult {
  const alreadySaved = p.alreadySavedMinor ?? 0;

  // Monthly recurring: the full amount is due every month — nothing to save up.
  if (p.category === "monthly_recurring") {
    const due = p.dueDate ? parseISODate(p.dueDate) : now;
    return {
      requiredMinor: p.amountMinor,
      effectiveDate: toISODate(due),
      monthsUntilDue: 1,
      occurrencesThisMonth: 1,
    };
  }

  const cap = contributionCapMinor(p);
  if (cap !== null) {
    const remaining = Math.max(0, p.amountMinor - alreadySaved);
    const target = p.targetDate ?? p.dueDate ?? null;
    // Dated: keep the promised date, count the months to it. Dateless: the pace
    // sets the date — as many whole months as the remaining amount needs.
    const paceMonths = Math.max(1, ceilDiv(remaining, cap));
    const dated = target ? parseISODate(target) : null;
    return {
      requiredMinor: Math.min(cap, remaining),
      effectiveDate: toISODate(dated ?? addUnit(now, paceMonths, "month")),
      monthsUntilDue: dated ? monthsUntil(now, dated) : paceMonths,
      occurrencesThisMonth: 1,
    };
  }

  let nextDue: Date;
  if (p.category === "fixed_point") {
    const target = p.targetDate ?? p.dueDate ?? null;
    nextDue = target ? parseISODate(target) : now;
  } else {
    const rec = resolveRecurrence(p);
    const anchor = p.dueDate ? parseISODate(p.dueDate) : now;
    nextDue = rec ? nextOccurrence(anchor, rec, now) : anchor;

    // A custom cadence can fall due several times in one calendar month (every
    // 2 weeks → 2–3 times). Those are paid as they land, like a monthly bill, so
    // the month's requirement is (occurrences this month) × the per-occurrence
    // amount — a figure that swings with the calendar. With none this month we
    // drop through to the save-up path, accumulating toward the next occurrence.
    if (p.category === "custom_recurring" && rec) {
      const count = occurrencesInMonth(anchor, rec, now);
      if (count >= 1) {
        return {
          requiredMinor: p.amountMinor * count,
          effectiveDate: toISODate(nextDue),
          monthsUntilDue: 1,
          occurrencesThisMonth: count,
        };
      }
    }
  }

  const months = monthsUntil(now, nextDue);
  const remaining = Math.max(0, p.amountMinor - alreadySaved);
  return {
    requiredMinor: ceilDiv(remaining, months),
    effectiveDate: toISODate(nextDue),
    monthsUntilDue: months,
    occurrencesThisMonth: 1,
  };
}

// ---------------------------------------------------------------------------
// The account plan, as a view of the one pass
// ---------------------------------------------------------------------------

/**
 * One account's `AccountPlan`, read off a planned scope.
 *
 * The `AccountPlan` shape, unchanged on the wire, and **no funding arithmetic**:
 * every amount here was decided once, by `computeScopePlan`, in one global
 * priority order over one set of member budgets. What is left to do is shape —
 * pick this account's lines out of the pass's funding order, hand back the
 * own/inflow split the pass already recorded, turn the confirmation overlay into
 * `funded | awaiting_transfer | at_risk`, and work out the completion dates,
 * which are a fact about a payment's pace rather than about anybody's money.
 *
 * Two things come from `input` rather than the plan, and only two: a payment's
 * contribution cap (`fixedMonthlyMinor`), which the pass has no reason to carry
 * because it never changes an answer. Passthroughs come from the input,
 * decisions come from the pass, and nothing is derived twice.
 *
 * Throws when `accountId` is not in the plan. An account outside the scope has
 * no plan to view, and inventing an empty one would report a funded month for an
 * account nobody planned — the failure mode this whole package exists to end.
 */
export function accountPlanFromScope(
  input: ScopeInput,
  plan: ScopePlan,
  accountId: string,
): AccountPlan {
  const account = plan.accounts.find((a) => a.accountId === accountId);
  if (!account) {
    throw new Error(`accountPlanFromScope: ${accountId} is not in the planned scope`);
  }
  const now = parseISODate(plan.asOfDate);
  const payments = new Map<string, PaymentInput>();
  for (const acc of input.accounts) {
    if (acc.accountId !== accountId) continue;
    for (const p of acc.payments) payments.set(p.id, p);
  }

  // What has been confirmed of the transfers the pass **derived** into this
  // account, and only those. A line's `fundedFromInflowMinor` is derived-transfer
  // money by construction: phase 2 funds every expense out of member budgets from
  // a pool holding nothing but the derived feed, and authored movements are
  // savings funded afterwards (decision 8). So the money a line leans on is this
  // money, and asking `confirmedInflowMinor` — which counts confirmed savings
  // arrivals too — let a confirmed £400 movement declare a bill funded that was
  // still waiting on an unconfirmed £303.20 feed.
  //
  // `plan.transfers` is every currency partition flattened, and this filters on
  // `toAccountId` alone — no currency in the predicate. That is safe because an
  // account belongs to exactly one partition, so at most one partition can hold
  // a transfer into it. WP-AC called that safe by construction rather than by
  // intent; it is now safe by intent too. An account's currency is fixed at
  // creation and can never be changed (Ben, 2026-08-05) — refused by
  // `updateAccountBody`, kept out of the Store's `AccountPatch`, and floored by
  // `0012_account_currency_is_fixed.sql` — so "one account, one partition" is
  // permanently true rather than incidentally so, and no currency test is
  // needed here to keep it that way.
  const confirmedTransferMinor = plan.transfers
    .filter((t) => t.toAccountId === accountId)
    .reduce((sum, t) => sum + t.confirmedMinor, 0);

  // How much of the arriving money the lines above have already leaned on.
  // Confirmed money is spent before merely promised money, so a line rests on a
  // transfer nobody has made exactly when its slice runs past the confirmed
  // mark — the account engine's rule, over the pass's own split.
  let inflowUsed = 0;
  const lines: PaymentPlanLine[] = plan.lines
    .filter((l) => l.accountId === accountId)
    .map((l) => {
      // The pass records the split against what the *bill* took, so this is the
      // funded amount by construction and never exceeds what was required.
      const funded = l.fundedFromOwnMinor + l.fundedFromInflowMinor;
      const drewOnUnconfirmed =
        l.fundedFromInflowMinor > 0 &&
        inflowUsed + l.fundedFromInflowMinor > confirmedTransferMinor;
      inflowUsed += l.fundedFromInflowMinor;
      const status: PaymentPlanStatus = !l.onTrack
        ? "at_risk"
        : drewOnUnconfirmed
          ? "awaiting_transfer"
          : "funded";

      const payment = payments.get(l.paymentId);
      if (!payment) {
        throw new Error(`accountPlanFromScope: ${l.paymentId} is not a payment of ${accountId}`);
      }
      const cap = contributionCapMinor(payment);
      const remaining = Math.max(0, l.amountMinor - l.alreadySavedMinor);
      let projectedCompletionDate: string | undefined;
      if (!l.onTrack) {
        projectedCompletionDate = toISODate(
          addUnit(now, ceilDiv(remaining, Math.max(funded, 1)), "month"),
        );
      } else if (remaining > 0 && cap !== null) {
        // On pace, but late: the cap sets the pace, so a capped goal can be
        // fully funded every month and still land after the date it carries.
        const finish = toISODate(addUnit(now, ceilDiv(remaining, l.requiredMonthlyMinor), "month"));
        if (finish > l.targetDate) projectedCompletionDate = finish;
      }

      return {
        paymentId: l.paymentId,
        name: l.name,
        category: l.category,
        amountMinor: l.amountMinor,
        dueDate: l.dueDate,
        targetDate: l.targetDate,
        dueDateIsDerived: l.dueDateIsDerived,
        monthsUntilDue: l.monthsUntilDue,
        requiredMonthlyMinor: l.requiredMonthlyMinor,
        fundedMonthlyMinor: funded,
        fundedFromOwnMinor: l.fundedFromOwnMinor,
        fundedFromInflowMinor: l.fundedFromInflowMinor,
        alreadySavedMinor: l.alreadySavedMinor,
        occurrencesThisMonth: l.occurrencesThisMonth,
        onTrack: l.onTrack,
        status,
        projectedCompletionDate,
        fixedMonthlyMinor: payment.fixedMonthlyMinor ?? null,
        tag: l.tag ?? null,
      };
    });

  // The transfers the pass derived *out* of this account, itemised by far end.
  //
  // `ScopeAccountPlan.transferOutMinor` is the sum of exactly these rows —
  // `computeScopePlan` tallies `transferOut` over the same `transfers` this
  // filters — so the scalar and the list can never disagree. Published because
  // the scalar alone could not answer "to which account?": the account page had
  // to draw one row for the lot and label a far end that was a set of accounts.
  //
  // Filtered on `fromAccountId` alone, no currency in the predicate, for the
  // reason `confirmedTransferMinor` above filters on `toAccountId` alone: an
  // account's currency is fixed at creation, so it belongs to exactly one
  // partition and no other partition can hold a transfer out of it.
  const transferDepartures: TransferDeparture[] = plan.transfers
    .filter((t) => t.fromAccountId === accountId)
    .map((t) => ({
      toAccountId: t.toAccountId,
      memberUserId: t.memberUserId,
      amountMinor: t.amountMinor,
      confirmedMinor: t.confirmedMinor,
    }))
    // Biggest first, as `inflowSourcesFor` orders the arriving side. No
    // tie-break: `computeScopePlan` hands `transfers` over sorted by
    // `(from, to, member)`, and `Array.prototype.sort` is stable by
    // specification — so two equal amounts keep that order, which is already a
    // total one. A comparator that said so again would be spelling out an
    // ordering the input has and adding two branches nothing can reach.
    .sort((a, b) => b.amountMinor - a.amountMinor);

  // Movements this account really sends. A loop's broken edge is not one of
  // them — it is not happening — and neither is a movement whose *sender* the
  // pass could not see, which can name an account in another currency partition
  // and would otherwise be reported as that account's outbound plan.
  const outboundInflows: OutboundInflowPlan[] = plan.movements
    .filter(
      (m) =>
        m.fromAccountId === accountId &&
        m.status !== "broken_cycle" &&
        m.status !== "unknown_source",
    )
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.toAccountId < b.toAccountId ? -1 : a.toAccountId > b.toAccountId ? 1 : 0) ||
        (a.inflowId < b.inflowId ? -1 : a.inflowId > b.inflowId ? 1 : 0),
    )
    .map((m) => ({
      inflowId: m.inflowId,
      toAccountId: m.toAccountId,
      requiredMonthlyMinor: m.requestedMinor,
      fundedMonthlyMinor: m.fundedMinor,
      fundedFromOwnMinor: m.fundedFromOwnMinor,
      fundedFromInflowMinor: m.fundedFromInflowMinor,
      onTrack: m.fundedMinor >= m.requestedMinor,
    }));

  return {
    accountId,
    asOfDate: plan.asOfDate,
    currency: account.currency,
    monthlyIncomeMinor: account.monthlyIncomeMinor,
    allocatedInflowMinor: account.allocatedInflowMinor,
    confirmedInflowMinor: account.confirmedInflowMinor,
    confirmedTransferMinor,
    bufferMinor: account.bufferMinor,
    totalRequiredMinor: account.requiredOutflowMinor,
    totalFundedMinor: account.fundedOutflowMinor,
    // The account's own income after its own bills and its owner's derived
    // transfers — `AccountPlan.leftoverMinor`'s meaning, unchanged (decision 13).
    // The signed residual a diagram needs is `ScopeAccountPlan.leftoverMinor`,
    // and it is deliberately a different figure.
    leftoverMinor: account.ownLeftoverMinor,
    // The signed residual, so the account page, the household page and the flow
    // diagram print one number rather than three derivations of it.
    residualMinor: account.leftoverMinor,
    shortfallMinor: account.shortfallMinor,
    inflowArrivals: account.inflowArrivals,
    outboundInflowMinor: account.committedMinor,
    transferOutMinor: account.transferOutMinor,
    transferDepartures,
    outboundInflows,
    fundingCycleAccountIds: account.fundingCycleAccountIds,
    fundingCycleBrokenInflowId: account.fundingCycleBrokenInflowId,
    lines,
  };
}

export interface AccountSummary {
  accountId: string;
  leftoverMinor: number;
  shortfallMinor: number;
  atRiskCount: number;
}

export interface CurrencyOverview {
  currency: string;
  monthlyIncomeMinor: number;
  bufferMinor: number;
  totalRequiredMinor: number;
  totalFundedMinor: number;
  /**
   * Surplus across the rollup: the per-account `leftoverMinor`s, summed.
   *
   * A plain sum, with nothing netted out of it — see `overviewFromPlans`.
   */
  leftoverMinor: number;
  shortfallMinor: number;
  accounts: AccountSummary[];
}

export interface Overview {
  asOfDate: string;
  perCurrency: CurrencyOverview[];
}

/**
 * Aggregate per-account plans into an all-accounts overview, grouped by
 * currency (no FX conversion — see decision #1). Currencies are returned in
 * stable alphabetical order.
 *
 * ## The netting is gone, and that is the point
 *
 * `computeOverview` used to subtract an `intraEstateMovementMinor` term from the
 * total surplus, because the two engines disagreed about whose money a
 * transferred pound was: the sending account's `leftoverMinor` still counted it
 * while the receiving account's `totalFundedMinor` counted it again, so a chain
 * inflated the estate once per hop. Netting was the patch.
 *
 * There is one pass now, and it settles the question in the accounts rather than
 * in the rollup. `ScopeAccountPlan.ownLeftoverMinor` — which is what
 * `AccountPlan.leftoverMinor` reports — is the account's own income after its own
 * bills **and after the derived transfers its owner has to make**, so a pound
 * that leaves is already gone from the sender's surplus before this function
 * sees it. Money that merely arrived is excluded at the receiver, because it is
 * not the receiver's income. Every pound is therefore counted exactly once, and
 * the identity
 *
 *     totalFundedMinor + leftoverMinor === monthlyIncomeMinor - bufferMinor
 *
 * holds for a scope that funds itself with no term to subtract.
 *
 * Those two rules only meet in the middle while every derived pound that leaves
 * a sender is spent or reserved where it lands — a pound subtracted at one end
 * and excluded at the other is counted nowhere, and the total is short by
 * exactly it. That is what decision 9's netting buys: the pass derives transport
 * only for what the destination cannot pay for out of its own income, so it
 * stops asking a member to move £40 into an account whose own interest already
 * covered the £40 subscription — a transfer that funded nothing and left this
 * identity £40 down (`scope.ts`, phase 3). The case it does not reach is a
 * co-member's transfer into a **personal** account with income of its own: Bob
 * really does owe Alice his half of the rent that leaves her current account,
 * her own salary pays the bill first, and his money lands as her reimbursement
 * rather than as funding. Genuinely arriving, genuinely not income — and no
 * netting can make it either.
 *
 * That matters beyond tidiness. The netted term meant "inflow the bills consumed
 * that came from another account **of the scope**", and a scope contains a
 * co-member's account while a caller's rollup does not: netted here, a partner's
 * transfer into a shared pot would be subtracted from a total that never counted
 * their income. A rollup over any subset of a scope's accounts is now just a sum.
 */
export function overviewFromPlans(plans: AccountPlan[], asOfDate: string): Overview {
  const byCurrency = new Map<string, CurrencyOverview>();

  for (const plan of plans) {
    let bucket = byCurrency.get(plan.currency);
    if (!bucket) {
      bucket = {
        currency: plan.currency,
        monthlyIncomeMinor: 0,
        bufferMinor: 0,
        totalRequiredMinor: 0,
        totalFundedMinor: 0,
        leftoverMinor: 0,
        shortfallMinor: 0,
        accounts: [],
      };
      byCurrency.set(plan.currency, bucket);
    }
    bucket.monthlyIncomeMinor += plan.monthlyIncomeMinor;
    bucket.bufferMinor += plan.bufferMinor;
    bucket.totalRequiredMinor += plan.totalRequiredMinor;
    bucket.totalFundedMinor += plan.totalFundedMinor;
    bucket.leftoverMinor += plan.leftoverMinor;
    bucket.shortfallMinor += plan.shortfallMinor;
    bucket.accounts.push({
      accountId: plan.accountId,
      leftoverMinor: plan.leftoverMinor,
      shortfallMinor: plan.shortfallMinor,
      atRiskCount: plan.lines.filter((l) => !l.onTrack).length,
    });
  }

  return {
    asOfDate,
    perCurrency: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}
