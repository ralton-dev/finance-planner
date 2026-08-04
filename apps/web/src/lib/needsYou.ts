import { formatDayMonth, formatMonth, monthOf } from "./months.js";
import { formatMinor } from "./money.js";
import { tagKey, UNTAGGED } from "./tags.js";
import type {
  AccountPlanDto,
  HouseholdPlanDto,
  HouseholdPlanLineDto,
  PlanLineDto,
  TransferConfirmationDto,
  UpcomingItemDto,
} from "./types.js";

/**
 * "What needs you today", derived from plan data the app already has.
 *
 * Every screen knows the answer and none of them says it: the shortfall is a
 * legend swatch two thousand pixels down, the transfers are a table you scroll
 * to, and an account nobody has checked in for a month looks exactly like one
 * checked in this morning. This module turns all of that into one ordered list
 * of things waiting on a human, plus the single number that leads the page.
 *
 * Pure and deterministic: no clock, no fetch, no formatting of anything the
 * caller could format itself beyond the sentences the design specifies. Dates
 * are compared against an explicit `asOfDate` so a test can sit anywhere in
 * time. Money is integer minor units throughout.
 */

/** A balance older than this many days is worth confirming. Injectable. */
export const DEFAULT_STALE_AFTER_DAYS = 10;

/** How far ahead a due payment is still context for a stale balance. */
const CHECKIN_LOOKAHEAD_DAYS = 14;

const MS_PER_DAY = 86_400_000;

// --- input -----------------------------------------------------------------
// Shaped as arrays from the start: the plan page passes one household, the
// Overview will pass every household plus the accounts that belong to none.

/** A household's plan alongside the reality data the checklist needs. */
export interface NeedsYouHouseholdInput {
  plan: HouseholdPlanDto;
  /** This month's confirmations, from GET /transfers/confirmations. */
  confirmations: readonly TransferConfirmationDto[];
}

/**
 * An account's plan, which already carries `contributionsMTD`, `latestBalance`
 * and `reservedMinor`. The name is passed alongside because `AccountPlanDto`
 * has none — the plan is keyed by id and the pages hold the account list.
 */
export interface NeedsYouAccountInput {
  plan: AccountPlanDto;
  name: string;
  /**
   * The household this account is assigned to, when it has one. Set it and the
   * account's shortfall is left to the household's member rows, which say whose
   * money is missing; the record and check-in rules still apply.
   */
  householdId?: string;
}

export interface NeedsYouInput {
  /** ISO date every day-count is measured against. */
  asOfDate: string;
  households?: readonly NeedsYouHouseholdInput[];
  /** Household members' accounts and standalone ones alike. */
  accounts?: readonly NeedsYouAccountInput[];
  /** From GET /upcoming — dates a stale balance against what lands next. */
  upcoming?: readonly UpcomingItemDto[];
  /** Defaults to {@link DEFAULT_STALE_AFTER_DAYS}. */
  staleAfterDays?: number;
}

// --- output ----------------------------------------------------------------

/** Priority order, and the order items are returned in. */
export type NeedsYouKind = "shortfall" | "transfer" | "record" | "checkin";

/** What the row's button does, in terms the UI maps onto existing endpoints. */
export type NeedsYouAction =
  | {
      kind: "confirmTransfer";
      householdId: string;
      fromAccountId: string;
      toAccountId: string;
      memberUserId: string;
      /** "YYYY-MM". */
      month: string;
      amountMinor: number;
    }
  | {
      kind: "recordContribution";
      paymentId: string;
      accountId: string;
      /** What is still missing this month — the amount to prefill. */
      amountMinor: number;
      /** "YYYY-MM". */
      month: string;
    }
  | { kind: "checkin"; accountId: string };

export interface NeedsYouItem {
  /** Stable across recomputations; safe as a React key. */
  key: string;
  kind: NeedsYouKind;
  label: string;
  /** Absent on `checkin`, where the row's figure is a count of days. */
  amountMinor?: number;
  /** Currency of `amountMinor`, and of any money inside `meta`. */
  currency: string;
  meta: string;
  href: string;
  action?: NeedsYouAction;
  /** `checkin` only: days since the last balance; absent when never checked in. */
  days?: number;
}

/** The one number a screen leads with. Shortfall outranks left-over always. */
export interface NeedsYouHeadline {
  kind: "shortfall" | "leftover";
  amountMinor: number;
  sentence: string;
}

/**
 * The currency the headline is counted in: the first household's, else the
 * first account's. One figure can only be in one currency, so on the Overview —
 * where the input spans every household and every standalone account — this is
 * also the filter that decides which of them the headline is allowed to add up.
 */
export function headlineCurrency(input: NeedsYouInput): string {
  return input.households?.[0]?.plan.currency ?? input.accounts?.[0]?.plan.currency ?? "GBP";
}

// --- dates -----------------------------------------------------------------

/** Whole days from `from` to `to`, both ISO date-only strings. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / MS_PER_DAY);
}

/** The human read of `daysUntil`, matching the upcoming digest's vocabulary. */
function dueLabel(daysUntil: number): string {
  if (daysUntil <= 0) return "today";
  if (daysUntil === 1) return "tomorrow";
  return `in ${daysUntil}d`;
}

// --- shortfall -------------------------------------------------------------

/** What the headline needs to name the gap, kept alongside the item itself. */
interface ShortfallFact {
  item: NeedsYouItem;
  /** "Alex's share of housing", or the account's name. */
  subject: string;
  amountMinor: number;
}

/**
 * The group a member's unfunded money belongs to: the tag with the biggest gap
 * between what they owe and what their income covered. Untagged lines have no
 * group worth naming, so the biggest one lends its payment name instead.
 */
function unfundedGroup(plan: HouseholdPlanDto, userId: string): string | null {
  const byTag = new Map<string, { gapMinor: number; name: string }>();
  for (const line of plan.lines) {
    const alloc = line.allocations.find((a) => a.userId === userId);
    if (!alloc) continue;
    const gap = alloc.requiredMinor - alloc.fundedMinor;
    if (gap <= 0) continue;
    const key = tagKey(line.tag);
    const entry = byTag.get(key) ?? { gapMinor: 0, name: line.name };
    entry.gapMinor += gap;
    byTag.set(key, entry);
  }

  const ranked = [...byTag.entries()].sort(
    (a, b) => b[1].gapMinor - a[1].gapMinor || a[0].localeCompare(b[0]),
  );
  const top = ranked[0];
  if (!top) return null;
  return top[0] === UNTAGGED ? top[1].name : top[0];
}

/**
 * What you would cut to free the money: the thing funded last. The engine funds
 * in priority order, so the lowest-priority line the member actually pays for
 * is the first casualty of a tighter month.
 */
function lastFundedForMember(plan: HouseholdPlanDto, userId: string): string | null {
  let worst: HouseholdPlanLineDto | null = null;
  for (const line of plan.lines) {
    const alloc = line.allocations.find((a) => a.userId === userId);
    if (!alloc || alloc.fundedMinor <= 0) continue;
    if (
      !worst ||
      line.priority > worst.priority ||
      (line.priority === worst.priority && line.name.localeCompare(worst.name) > 0)
    ) {
      worst = line;
    }
  }
  return worst?.name ?? null;
}

/** Same idea for an account plan, whose lines already arrive in funding order. */
function lastFundedOnAccount(lines: readonly PlanLineDto[]): string | null {
  let name: string | null = null;
  for (const line of lines) if (line.fundedMonthlyMinor > 0) name = line.name;
  return name;
}

function householdShortfalls(entry: NeedsYouHouseholdInput): ShortfallFact[] {
  const { plan } = entry;
  const facts: ShortfallFact[] = [];

  for (const member of plan.members) {
    if (member.shortfallMinor <= 0) continue;
    const who = member.displayName ?? "member";
    const group = unfundedGroup(plan, member.userId);
    const cut = lastFundedForMember(plan, member.userId);
    const amount = formatMinor(member.shortfallMinor, plan.currency);

    facts.push({
      amountMinor: member.shortfallMinor,
      subject: group ? `${who}'s share of ${group}` : `${who}'s share`,
      item: {
        key: `shortfall:member:${plan.householdId}:${member.userId}`,
        kind: "shortfall",
        label: group ? `cover ${who}'s unfunded ${group}` : `cover ${who}'s shortfall`,
        amountMinor: member.shortfallMinor,
        currency: plan.currency,
        meta: cut
          ? `raise ${who}'s share, or move ${amount} from ${cut}`
          : `raise ${who}'s share to cover it`,
        href: `/households/${plan.householdId}`,
      },
    });
  }

  return facts;
}

function accountShortfall(entry: NeedsYouAccountInput): ShortfallFact | null {
  const { plan } = entry;
  if (plan.shortfallMinor <= 0) return null;
  const cut = lastFundedOnAccount(plan.lines);
  const amount = formatMinor(plan.shortfallMinor, plan.currency);

  return {
    amountMinor: plan.shortfallMinor,
    subject: entry.name,
    item: {
      key: `shortfall:account:${plan.accountId}`,
      kind: "shortfall",
      label: `cover the shortfall on ${entry.name}`,
      amountMinor: plan.shortfallMinor,
      currency: plan.currency,
      meta: cut
        ? `income is ${amount} short — trim the plan, or move ${amount} from ${cut}`
        : `income is ${amount} short of what the plan needs this month`,
      href: `/accounts/${plan.accountId}`,
    },
  };
}

// --- transfers -------------------------------------------------------------

/** A transfer is identified by who moves money from where to where. */
const transferKey = (t: {
  fromAccountId: string;
  toAccountId: string;
  memberUserId: string;
}): string => `${t.fromAccountId}|${t.toAccountId}|${t.memberUserId}`;

function transferItems(entry: NeedsYouHouseholdInput, month: string): NeedsYouItem[] {
  const { plan } = entry;
  const accountName = new Map(plan.accounts.map((a) => [a.accountId, a.name ?? "account"]));
  const memberName = new Map(plan.members.map((m) => [m.userId, m.displayName ?? "member"]));
  // The caller passes this month's confirmations; filtering again keeps the
  // rule honest if it ever hands over a wider list.
  const confirmed = new Set(
    entry.confirmations.filter((c) => monthOf(c.month) === month).map(transferKey),
  );

  const total = plan.transfers.length;
  const done = plan.transfers.filter((t) => confirmed.has(transferKey(t))).length;

  return plan.transfers
    .filter((t) => !confirmed.has(transferKey(t)))
    .map((t) => {
      const who = memberName.get(t.memberUserId) ?? "member";
      return {
        key: `transfer:${plan.householdId}:${transferKey(t)}`,
        kind: "transfer" as const,
        label: `${who} → ${accountName.get(t.toAccountId) ?? "account"}`,
        amountMinor: t.amountMinor,
        currency: plan.currency,
        meta: `transfer · ${formatMonth(month)} · ${done} of ${total} done · waiting on ${who}`,
        href: `/households/${plan.householdId}/plan`,
        action: {
          kind: "confirmTransfer" as const,
          householdId: plan.householdId,
          fromAccountId: t.fromAccountId,
          toAccountId: t.toAccountId,
          memberUserId: t.memberUserId,
          month,
          amountMinor: t.amountMinor,
        },
      };
    });
}

// --- record ----------------------------------------------------------------

function recordItems(entry: NeedsYouAccountInput, month: string): NeedsYouItem[] {
  const { plan } = entry;
  const mtd = new Map((plan.contributionsMTD ?? []).map((c) => [c.paymentId, c.amountMinor]));

  return plan.lines
    .filter((line) => line.category !== "monthly_recurring" && line.fundedMonthlyMinor > 0)
    .map((line) => ({ line, contributed: mtd.get(line.paymentId) ?? 0 }))
    .filter(({ line, contributed }) => contributed < line.fundedMonthlyMinor)
    .map(({ line, contributed }) => ({
      key: `record:${line.paymentId}`,
      kind: "record" as const,
      label: `record ${line.name}`,
      // The month's target, not the remainder: it is what the row is asking for.
      amountMinor: line.fundedMonthlyMinor,
      currency: plan.currency,
      meta:
        contributed > 0
          ? `${entry.name} · ${formatMinor(contributed, plan.currency)} of ${formatMinor(
              line.fundedMonthlyMinor,
              plan.currency,
            )} set aside so far`
          : `${entry.name} · not yet set aside this month`,
      href: `/accounts/${plan.accountId}`,
      action: {
        kind: "recordContribution" as const,
        paymentId: line.paymentId,
        accountId: plan.accountId,
        amountMinor: line.fundedMonthlyMinor - contributed,
        month,
      },
    }));
}

// --- check-ins -------------------------------------------------------------

function nextDueOn(
  accountId: string,
  upcoming: readonly UpcomingItemDto[],
): UpcomingItemDto | null {
  let soonest: UpcomingItemDto | null = null;
  for (const item of upcoming) {
    if (item.accountId !== accountId) continue;
    if (item.daysUntil > CHECKIN_LOOKAHEAD_DAYS) continue;
    if (!soonest || item.daysUntil < soonest.daysUntil) soonest = item;
  }
  return soonest;
}

function checkinItem(
  entry: NeedsYouAccountInput,
  asOfDate: string,
  staleAfterDays: number,
  upcoming: readonly UpcomingItemDto[],
): NeedsYouItem | null {
  const { plan } = entry;
  const latest = plan.latestBalance;
  const days = latest ? daysBetween(latest.asOfDate, asOfDate) : undefined;
  if (days !== undefined && days <= staleAfterDays) return null;

  const next = nextDueOn(plan.accountId, upcoming);
  const dueClause = next
    ? ` · ${next.name} ${formatMinor(next.amountMinor, next.currency)} due ${dueLabel(next.daysUntil)}`
    : "";

  return {
    key: `checkin:${plan.accountId}`,
    kind: "checkin",
    label: `check in ${entry.name} balance`,
    currency: plan.currency,
    meta: latest
      ? `last confirmed ${formatDayMonth(latest.asOfDate)}${dueClause}`
      : `never checked in${dueClause}`,
    href: `/accounts/${plan.accountId}`,
    action: { kind: "checkin", accountId: plan.accountId },
    ...(days === undefined ? {} : { days }),
  };
}

// --- ordering --------------------------------------------------------------

const KIND_RANK: Record<NeedsYouKind, number> = {
  shortfall: 0,
  transfer: 1,
  record: 2,
  checkin: 3,
};

/** Never checked in is as stale as it gets, so it sorts above any day count. */
const staleness = (item: NeedsYouItem): number => item.days ?? Number.POSITIVE_INFINITY;

function compare(a: NeedsYouItem, b: NeedsYouItem): number {
  if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (a.kind === "checkin") {
    const diff = staleness(b) - staleness(a);
    if (diff !== 0) return diff;
  } else {
    const diff = (b.amountMinor ?? 0) - (a.amountMinor ?? 0);
    if (diff !== 0) return diff;
  }
  return a.key.localeCompare(b.key);
}

// --- the list --------------------------------------------------------------

/**
 * Accounts whose shortfall is nobody else's story to tell. An account assigned
 * to a household in this input is covered by that household's member rows, so
 * counting it again would report the same missing money twice.
 */
function standaloneAccounts(input: NeedsYouInput): readonly NeedsYouAccountInput[] {
  const known = new Set((input.households ?? []).map((h) => h.plan.householdId));
  return (input.accounts ?? []).filter((a) => !a.householdId || !known.has(a.householdId));
}

/**
 * The checklist: every outstanding thing, in fixed kind order — money that is
 * missing, then money that has not moved, then money that moved but was never
 * recorded, then balances nobody has confirmed.
 */
export function deriveNeedsYou(input: NeedsYouInput): NeedsYouItem[] {
  const month = monthOf(input.asOfDate);
  const staleAfterDays = input.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const upcoming = input.upcoming ?? [];
  const accounts = input.accounts ?? [];
  const items: NeedsYouItem[] = [];

  for (const household of input.households ?? []) {
    for (const fact of householdShortfalls(household)) items.push(fact.item);
    items.push(...transferItems(household, month));
  }

  for (const account of standaloneAccounts(input)) {
    const fact = accountShortfall(account);
    if (fact) items.push(fact.item);
  }

  for (const account of accounts) {
    items.push(...recordItems(account, month));
    const checkin = checkinItem(account, input.asOfDate, staleAfterDays, upcoming);
    if (checkin) items.push(checkin);
  }

  return items.sort(compare);
}

/** "[4]", or the empty state the mockup words as a count of nothing. */
export function needsYouCountLabel(items: readonly NeedsYouItem[]): string {
  return items.length > 0 ? `[${items.length}]` : "[0] · nothing outstanding";
}

// --- the headline ----------------------------------------------------------

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** ", both transfers settled" and its neighbours, or nothing to say. */
function transfersClause(count: number): string {
  if (count === 0) return "";
  if (count === 1) return ", the transfer settled";
  if (count === 2) return ", both transfers settled";
  return `, all ${count} transfers settled`;
}

/**
 * The number the page leads with. A shortfall wins whenever there is one: the
 * headline is the only place money can be reported missing, so it must never
 * be the cheerful figure while a member is short.
 *
 * `items` comes from {@link deriveNeedsYou} on the same input — it decides how
 * the left-over sentence ends, and nothing else.
 *
 * Aggregating is a matter of a wider input: every household and every account
 * planned outside one, summed worst-first, in the one currency the figure can
 * honestly be in. Money in another currency is left to that currency's own
 * screen rather than added to a total that would mean nothing.
 */
export function deriveHeadline(
  input: NeedsYouInput,
  items: readonly NeedsYouItem[],
): NeedsYouHeadline {
  const currency = headlineCurrency(input);
  // De-duplication first (an account inside a household is that household's
  // story), then the currency filter — an account is standalone or not
  // regardless of what the headline happens to be counted in.
  const households = (input.households ?? []).filter((h) => h.plan.currency === currency);
  const standalone = standaloneAccounts(input).filter((a) => a.plan.currency === currency);

  const sum = (pick: (p: { shortfallMinor: number; leftoverMinor: number }) => number): number =>
    households.reduce((n, h) => n + pick(h.plan), 0) +
    standalone.reduce((n, a) => n + pick(a.plan), 0);

  const shortfallMinor = sum((p) => p.shortfallMinor);
  const leftoverMinor = sum((p) => p.leftoverMinor);
  const paymentCount =
    households.reduce((n, h) => n + h.plan.lines.length, 0) +
    standalone.reduce((n, a) => n + a.plan.lines.length, 0);

  if (shortfallMinor > 0) {
    const facts = [
      ...households.flatMap(householdShortfalls),
      ...standalone.map(accountShortfall).filter((f): f is ShortfallFact => f !== null),
    ].sort((a, b) => b.amountMinor - a.amountMinor || a.item.key.localeCompare(b.item.key));
    const amount = formatMinor(shortfallMinor, currency);
    // The number is always the total; the sentence names the biggest cause it
    // can find. A household total can exceed what its members individually
    // explain (a buffer nobody's income reached), hence the third form.
    const subject = facts[0]?.subject;
    const lead =
      subject === undefined
        ? `${amount} is short this month.`
        : facts.length === 1
          ? `${subject} is ${amount} short this month.`
          : `${amount} is short this month, most of it ${subject}.`;

    return {
      kind: "shortfall",
      amountMinor: shortfallMinor,
      sentence:
        `${lead} Everything else across ${plural(paymentCount, "payment")} is covered — ` +
        `clear it and you're left with ${formatMinor(leftoverMinor, currency)} for the month.`,
    };
  }

  if (paymentCount === 0) {
    return {
      kind: "leftover",
      amountMinor: leftoverMinor,
      sentence: "Nothing planned yet. Nothing is waiting on you.",
    };
  }

  const outstanding = items.length;
  const sentence =
    outstanding > 0
      ? `All ${plural(paymentCount, "payment")} funded. ` +
        `${plural(outstanding, "thing")} still waiting on a human — see the list.`
      : `All ${plural(paymentCount, "payment")} funded` +
        `${transfersClause(households.reduce((n, h) => n + h.plan.transfers.length, 0))}, ` +
        `balances current. Nothing is waiting on you.`;

  return { kind: "leftover", amountMinor: leftoverMinor, sentence };
}
