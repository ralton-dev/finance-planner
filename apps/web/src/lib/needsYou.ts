import { formatDayMonth, formatMonth, monthOf } from "./months.js";
import { money, type Phrase, type PhrasePart } from "./money.js";
import { tagKey, UNTAGGED } from "./tags.js";
import { lineStatus } from "./types.js";
import type {
  ContributionTotalDto,
  HouseholdPlanDto,
  HouseholdPlanLineDto,
  InflowArrivalDto,
  LatestBalanceDto,
  PlanInflowSourceDto,
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
 *
 * The sentences come out as `Phrase`s — words and figures as separate parts —
 * rather than finished strings. Privacy mode blurs elements, so a figure baked
 * into a template literal is a figure nobody can hide; the UI wraps each money
 * part in an `<Amount>` and the whole checklist goes soft with everything
 * else.
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

/** A save-up the plan funded this month with money still unrecorded against it. */
export interface NeedsYouUnrecorded {
  paymentId: string;
  name: string;
  /** The month's target — the row's figure. */
  fundedMonthlyMinor: number;
  /** What is still missing — the action's prefill. */
  remainderMinor: number;
}

/** Everything the checklist reads off an account plan's line list. */
export interface NeedsYouLineSummary {
  unrecorded: readonly NeedsYouUnrecorded[];
  /** How many payment lines the plan has — the headline's payment count. */
  lineCount: number;
  /** The last line the plan still funds — what a tighter month would cut. */
  lastFundedName: string | null;
}

/**
 * The parts of an account plan the checklist reads. A whole `AccountPlanDto`
 * satisfies it — the account and household plan pages read one per account
 * anyway — and so does the Overview, which has the same facts from its own
 * endpoint and would otherwise pay a request per row to restate them.
 */
export interface NeedsYouAccountPlan {
  accountId: string;
  currency: string;
  leftoverMinor: number;
  shortfallMinor: number;
  /** Last manual balance check-in, or null when never reconciled. */
  latestBalance: LatestBalanceDto | null;
  /** The plan's lines, in funding order. Absent when the caller has no line
   *  list and passes {@link NeedsYouAccountInput.lineSummary} instead. */
  lines?: readonly PlanLineDto[];
  /** Per-payment totals contributed this month — read alongside `lines`. */
  contributionsMTD?: readonly ContributionTotalDto[];
  /** Money arriving from anywhere but this account's own income. Amounts only,
   *  and never folded into income — it is here so a shortfall can name the right
   *  cause, not so it can be added to anything. */
  allocatedInflowMinor?: number;
  /**
   * What each movement from another account you own delivered into this account
   * this month. A whole `AccountPlanDto` carries it; a caller holding only the
   * overview's per-account summary has none, and draws no movement rows.
   *
   * Household allocations are deliberately *not* in here — they arrive as
   * member transfers on the household's own plan and have their own rows — so
   * an account can never be prompted twice for the same arriving money.
   */
  inflowArrivals?: readonly InflowArrivalDto[];
  /**
   * Where the arriving money comes from, when the caller may be told. The only
   * carrier of a sending account's *name*, and the API withholds it from anyone
   * who cannot see that account — so an absent name is rendered as an absence
   * rather than as an id.
   */
  inflowSources?: readonly PlanInflowSourceDto[] | null;
}

/**
 * An account's plan, which already carries `contributionsMTD`, `latestBalance`
 * and `reservedMinor`. The name is passed alongside because `AccountPlanDto`
 * has none — the plan is keyed by id and the pages hold the account list.
 */
export interface NeedsYouAccountInput {
  plan: NeedsYouAccountPlan;
  name: string;
  /**
   * The household this account is assigned to, when it has one. Set it and the
   * account's shortfall is left to the household's member rows, which say whose
   * money is missing; the record and check-in rules still apply.
   */
  householdId?: string;
  /**
   * The line-list facts, already derived. The Overview's API computes every
   * account's plan to aggregate it, so it sends these down with the summary and
   * the page needs no plan of its own. Otherwise left unset and derived from
   * `plan.lines` here, which is the same rule in the same order.
   */
  lineSummary?: NeedsYouLineSummary;
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
  /**
   * Per currency, money that left one of these accounts and was spent by
   * another of them — `CurrencyOverviewDto.intraEstateMovementMinor`, straight
   * off the overview, which is the only thing that computes it.
   *
   * The headline's left-over is a sum of per-account surpluses, and a pound that
   * moved between two accounts you own sits in the sender's surplus *and* in the
   * receiver's funded total. A chain (current → pot → ISA) counts it again at
   * every hop, so the error is invisible on a two-account fixture and grows
   * without bound on a real estate. Keyed by currency because the input spans
   * currencies and the headline is only ever counted in one of them.
   */
  intraEstateMovementMinor?: Readonly<Record<string, number>>;
}

// --- output ----------------------------------------------------------------

/**
 * Priority order, and the order items are returned in.
 *
 * `transfer` covers both producers of "money the plan counts on that nobody has
 * moved yet": a household asking a member to transfer their share, and a
 * movement between two accounts you own. They are one thing to a reader — the
 * money is where it should not be — and giving them separate kinds would only
 * split one queue into two that always interleave. What differs is the action,
 * and that is {@link NeedsYouAction}'s business.
 */
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
      /**
       * The standalone twin of `confirmTransfer`, with no household anywhere:
       * the authored inflow is the whole identity of a movement, which is also
       * why it is the only thing the endpoint asks for.
       */
      kind: "confirmMovement";
      inflowId: string;
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
  /** Currency of `amountMinor`. Money inside `meta` carries its own. */
  currency: string;
  meta: Phrase;
  href: string;
  action?: NeedsYouAction;
  /** `checkin` only: days since the last balance; absent when never checked in. */
  days?: number;
}

/** The one number a screen leads with. Shortfall outranks left-over always. */
export interface NeedsYouHeadline {
  kind: "shortfall" | "leftover";
  amountMinor: number;
  sentence: Phrase;
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

/**
 * Everything the account rules read off a plan's line list, from whichever the
 * caller has: the pre-derived summary, or the lines themselves.
 *
 * The two branches are one rule stated twice — a non-monthly line the plan
 * funded is outstanding until this month's contributions reach it, unless it is
 * still waiting on a transfer — because the API states it too, for the callers
 * that hold no lines. Change it here and in `api/src/server.ts`'s
 * `summarisePlanLines` together.
 */
function accountLines(entry: NeedsYouAccountInput): NeedsYouLineSummary {
  if (entry.lineSummary) return entry.lineSummary;

  const lines = entry.plan.lines ?? [];
  const mtd = new Map((entry.plan.contributionsMTD ?? []).map((c) => [c.paymentId, c.amountMinor]));
  const unrecorded: NeedsYouUnrecorded[] = [];
  let lastFundedName: string | null = null;

  for (const line of lines) {
    // Lines arrive in funding order, so the last funded one is what you would
    // cut first to free the money.
    if (line.fundedMonthlyMinor > 0) lastFundedName = line.name;
    if (line.category === "monthly_recurring" || line.fundedMonthlyMinor <= 0) continue;
    // A line the plan funds with money nobody has moved yet is not money you
    // can set aside, so asking to record it is the wrong way round: the
    // outstanding thing is the transfer, and that has a row of its own. The
    // straddling line — part own income, part unconfirmed inflow — is deferred
    // whole rather than split, for the same reason at smaller scale.
    if (lineStatus(line) === "awaiting_transfer") continue;
    const contributed = mtd.get(line.paymentId) ?? 0;
    if (contributed >= line.fundedMonthlyMinor) continue;
    unrecorded.push({
      paymentId: line.paymentId,
      name: line.name,
      fundedMonthlyMinor: line.fundedMonthlyMinor,
      remainderMinor: line.fundedMonthlyMinor - contributed,
    });
  }

  return { unrecorded, lineCount: lines.length, lastFundedName };
}

function householdShortfalls(entry: NeedsYouHouseholdInput): ShortfallFact[] {
  const { plan } = entry;
  const facts: ShortfallFact[] = [];

  for (const member of plan.members) {
    if (member.shortfallMinor <= 0) continue;
    const who = member.displayName ?? "member";
    const group = unfundedGroup(plan, member.userId);
    const cut = lastFundedForMember(plan, member.userId);
    const amount = money(member.shortfallMinor, plan.currency);

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
          ? [`raise ${who}'s share, or move `, amount, ` from ${cut}`]
          : [`raise ${who}'s share to cover it`],
        href: `/households/${plan.householdId}`,
      },
    });
  }

  return facts;
}

function accountShortfall(entry: NeedsYouAccountInput): ShortfallFact | null {
  const { plan } = entry;
  if (plan.shortfallMinor <= 0) return null;
  const cut = accountLines(entry).lastFundedName;
  const amount = money(plan.shortfallMinor, plan.currency);
  // An account living on its own income is short of income. One partly fed from
  // elsewhere — a household's allocation, or a movement from another account you
  // own — is not: its own income was never meant to cover the plan, so blaming
  // it points at the wrong thing to fix.
  const fed = (plan.allocatedInflowMinor ?? 0) > 0;
  const gap: Phrase = fed
    ? ["the plan needs ", amount, " more than arrives here"]
    : ["income is ", amount, " short"];

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
        ? [...gap, " — trim the plan, or move ", amount, ` from ${cut}`]
        : [...gap, fed ? " this month" : " of what the plan needs this month"],
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
        meta: [`transfer · ${formatMonth(month)} · ${done} of ${total} done · waiting on ${who}`],
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

// --- movements -------------------------------------------------------------

/**
 * What a sending account is called when access control withholds its name. The
 * same words `PlanTable`'s `senderName` uses, and for the same reason: the
 * honest answer is the *kind* of sender, never a made-up name and never an id —
 * and deliberately not "another of *your* accounts", since a caller who cannot
 * see the sender has not been told whose it is. Restated rather than imported
 * because this module is pure and knows nothing about components.
 */
const UNNAMED_SENDER = "another account";

/** What is still to move on one arrival: what it delivers, less what somebody
 *  has already said moved. */
const outstandingOf = (a: InflowArrivalDto): number => a.amountMinor - (a.confirmedMinor ?? 0);

/**
 * Money the plan moves between two accounts you own that nobody has said they
 * moved yet.
 *
 * The household transfers above are one producer of "the plan counts on money
 * being somewhere it is not"; this is the other, and until now it had no prompt
 * at all. A pot fed by your current account loses its red shortfall row the
 * moment the plan funds it from inflow — correctly — and used to gain nothing
 * in its place, leaving an `awaiting_transfer` line nothing in the app asked
 * about. The daily digest fixed the same blind spot one layer down; this is its
 * twin on the screen.
 *
 * Derived from the *receiving* account's arrivals, which is the side the app
 * holds a plan for. One authored inflow yields one row however many of the
 * accounts it touches are in the input, so the two ends can never both ask.
 */
function movementItems(entry: NeedsYouAccountInput, month: string): NeedsYouItem[] {
  const { plan } = entry;
  const arrivals = (plan.inflowArrivals ?? []).filter((a) => a.amountMinor > 0);
  // The sending account's name, for the movements this caller may be told about.
  const senderName = new Map(
    (plan.inflowSources ?? [])
      .filter((s) => s.kind === "account")
      .map((s) => [s.inflowId, s.accountName]),
  );

  const done = arrivals.filter((a) => outstandingOf(a) <= 0).length;

  return arrivals
    .filter((a) => outstandingOf(a) > 0)
    .map((a) => {
      const amountMinor = outstandingOf(a);
      return {
        // The inflow, never the pair of accounts: several distinct movements can
        // run between the same two accounts — a holiday pot and an ISA sweep out
        // of one current account — and the list has to tell them apart. Same key
        // a standalone confirmation is scoped by, minus the month the whole
        // derivation is already in.
        key: `movement:${a.inflowId}`,
        kind: "transfer" as const,
        label: `${senderName.get(a.inflowId) ?? UNNAMED_SENDER} → ${entry.name}`,
        amountMinor,
        currency: plan.currency,
        meta: [
          `between your own accounts · ${formatMonth(month)} · ` +
            `${done} of ${arrivals.length} done`,
        ],
        href: `/accounts/${plan.accountId}`,
        action: { kind: "confirmMovement" as const, inflowId: a.inflowId, month, amountMinor },
      };
    });
}

// --- record ----------------------------------------------------------------

function recordItems(entry: NeedsYouAccountInput, month: string): NeedsYouItem[] {
  const { plan } = entry;

  return accountLines(entry).unrecorded.map((line) => {
    const contributed = line.fundedMonthlyMinor - line.remainderMinor;
    return {
      key: `record:${line.paymentId}`,
      kind: "record" as const,
      label: `record ${line.name}`,
      // The month's target, not the remainder: it is what the row is asking for.
      amountMinor: line.fundedMonthlyMinor,
      currency: plan.currency,
      meta:
        contributed > 0
          ? [
              `${entry.name} · `,
              money(contributed, plan.currency),
              " of ",
              money(line.fundedMonthlyMinor, plan.currency),
              " set aside so far",
            ]
          : [`${entry.name} · not yet set aside this month`],
      href: `/accounts/${plan.accountId}`,
      action: {
        kind: "recordContribution" as const,
        paymentId: line.paymentId,
        accountId: plan.accountId,
        // The remainder: the row asks for the target, the box prefills the gap.
        amountMinor: line.remainderMinor,
        month,
      },
    };
  });
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
  const dueClause: PhrasePart[] = next
    ? [
        ` · ${next.name} `,
        money(next.amountMinor, next.currency),
        ` due ${dueLabel(next.daysUntil)}`,
      ]
    : [];

  return {
    key: `checkin:${plan.accountId}`,
    kind: "checkin",
    label: `check in ${entry.name} balance`,
    currency: plan.currency,
    meta: latest
      ? [`last confirmed ${formatDayMonth(latest.asOfDate)}`, ...dueClause]
      : ["never checked in", ...dueClause],
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
 *
 * "Money that has not moved" has two producers and one kind: a household member
 * asked to transfer their share, and a movement between two of your own
 * accounts. Exactly one row per outstanding thing is the whole contract here, so
 * neither may draw the other's.
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
    // Every account, not just the standalone ones: an account inside a household
    // can also be fed by another account you own, and that movement is nobody
    // else's story — the household's member rows do not know about it.
    items.push(...movementItems(account, month));
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
  // A pound that moved between two of these accounts is in the sender's surplus
  // *and* in the receiver's funded total, so a plain sum counts it once per hop
  // of the chain that carried it. `computeOverview` nets exactly this term out
  // of the estate's total and floors the result at zero — an estate can be
  // handed more money than it earns, and a negative surplus would be an
  // alarming way to say "somebody else is paying". This is the same total, so
  // it does the same thing to it.
  const movedInternally = input.intraEstateMovementMinor?.[currency] ?? 0;
  const leftoverMinor = Math.max(0, sum((p) => p.leftoverMinor) - movedInternally);
  const paymentCount =
    households.reduce((n, h) => n + h.plan.lines.length, 0) +
    standalone.reduce((n, a) => n + accountLines(a).lineCount, 0);

  if (shortfallMinor > 0) {
    const facts = [
      ...households.flatMap(householdShortfalls),
      ...standalone.map(accountShortfall).filter((f): f is ShortfallFact => f !== null),
    ].sort((a, b) => b.amountMinor - a.amountMinor || a.item.key.localeCompare(b.item.key));
    const amount = money(shortfallMinor, currency);
    // The number is always the total; the sentence names the biggest cause it
    // can find. A household total can exceed what its members individually
    // explain (a buffer nobody's income reached), hence the third form.
    const subject = facts[0]?.subject;
    const lead: PhrasePart[] =
      subject === undefined
        ? [amount, " is short this month."]
        : facts.length === 1
          ? [`${subject} is `, amount, " short this month."]
          : [amount, ` is short this month, most of it ${subject}.`];

    return {
      kind: "shortfall",
      amountMinor: shortfallMinor,
      sentence: [
        ...lead,
        ` Everything else across ${plural(paymentCount, "payment")} is covered — `,
        "clear it and you're left with ",
        money(leftoverMinor, currency),
        " for the month.",
      ],
    };
  }

  if (paymentCount === 0) {
    return {
      kind: "leftover",
      amountMinor: leftoverMinor,
      sentence: ["Nothing planned yet. Nothing is waiting on you."],
    };
  }

  // Everything that had to move for the month to be clear: the households' asks
  // of their members, and the movements between your own accounts. Counted in
  // the headline's currency and across every account, household or not, because
  // the rows they settled were drawn the same way.
  const settledTransfers =
    households.reduce((n, h) => n + h.plan.transfers.length, 0) +
    (input.accounts ?? [])
      .filter((a) => a.plan.currency === currency)
      .reduce(
        (n, a) => n + (a.plan.inflowArrivals ?? []).filter((x) => x.amountMinor > 0).length,
        0,
      );

  const outstanding = items.length;
  const sentence =
    outstanding > 0
      ? `All ${plural(paymentCount, "payment")} funded. ` +
        `${plural(outstanding, "thing")} still waiting on a human — see the list.`
      : `All ${plural(paymentCount, "payment")} funded` +
        `${transfersClause(settledTransfers)}, ` +
        `balances current. Nothing is waiting on you.`;

  // The left-over sentence never names a figure — the headline above it is the
  // figure — so it stays one part.
  return { kind: "leftover", amountMinor: leftoverMinor, sentence: [sentence] };
}
