import type { Account, Store } from "@finance-planner/data";
import { type DerivedTransfer, toISODate } from "@finance-planner/domain";
import type { Mailer } from "@finance-planner/mailer";
import {
  accessibleAccounts,
  createPlanContext,
  type PlannedScope,
  paydayScheduleFor,
  scopesFor,
  upcomingForUser,
} from "./plan.js";

/** How far ahead the digest looks, in days. Inclusive at both ends. */
const DIGEST_WINDOW_DAYS = 7;
/** The `kind` recorded in the notification log for this digest. */
export const DAILY_DIGEST_KIND = "daily_digest";
/** How often the scheduler wakes up to check whether it is time to send. */
const TICK_MS = 15 * 60 * 1000;
const MS_PER_DAY = 86_400_000;
/**
 * How many times one day's digest may be attempted before the day is given up.
 *
 * Two, not one, because a claim is not a send and the old code treated them as
 * the same fact. Two, not "until it works", because every attempt after a send
 * that delivered and *then* threw is a duplicate in somebody's inbox, and a
 * dead address would otherwise be retried every fifteen minutes until midnight.
 */
const MAX_DIGEST_ATTEMPTS = 2;

/** Minor units to a readable amount with its currency: 4500 → "45.00 GBP". */
export function formatMoney(minor: number, currency: string): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")} ${currency}`;
}

/** ISO date `days` after `asOfDate`. */
function plusDays(asOfDate: string, days: number): string {
  return toISODate(new Date(Date.parse(`${asOfDate}T00:00:00.000Z`) + days * MS_PER_DAY));
}

const dayLabel = (daysUntil: number): string =>
  daysUntil === 0 ? "today" : daysUntil === 1 ? "in 1 day" : `in ${daysUntil} days`;

/**
 * What an account is called in a digest line when the reader may not be told.
 *
 * Prose, not a wire field, so decision 41's "absence over placeholder" cannot
 * apply here — a sentence has nowhere to put a missing word, and `/api/flow`'s
 * client-side `UNNAMED_ACCOUNT` is a diagram label, not a phrase that reads in
 * "from X to …". One spelling, in one place, so the two sections of a digest
 * cannot disagree about how they name what they are not naming.
 */
const UNNAMED_ACCOUNT = "another account";

/** Every account the reader may be told the name of, by id. */
type VisibleAccounts = ReadonlyMap<string, Account>;

/** An account's name, or the honest fallback when it is not this reader's to
 *  learn. The one gate every name in a digest passes through. */
const nameFor = (visible: VisibleAccounts, accountId: string): string =>
  visible.get(accountId)?.name ?? UNNAMED_ACCOUNT;

/** The ISO first-of-month a date falls in — how a confirmation is keyed. */
const monthStart = (asOfDate: string): string => `${asOfDate.slice(0, 7)}-01`;

/** The pass's derived transfers, by the currency each one is denominated in.
 *  Insertion order, which is the pass's own (partitions are alphabetical). */
function groupByCurrency(transfers: readonly DerivedTransfer[]): Map<string, DerivedTransfer[]> {
  const byCurrency = new Map<string, DerivedTransfer[]>();
  for (const t of transfers) {
    const list = byCurrency.get(t.currency) ?? [];
    list.push(t);
    byCurrency.set(t.currency, list);
  }
  return byCurrency;
}

/**
 * A month's outstanding movements, split by whose account each one lands in.
 *
 * Two lists rather than one because the heading over a list is a claim about
 * every line under it, and one heading cannot be true of both.
 */
interface MovementSections {
  /** Out of an account the reader owns, into another account they own. */
  own: string[];
  /** Out of an account the reader owns, into one they do not. */
  outward: string[];
}

/**
 * The savings movements this month's plan funds out of the user's own accounts
 * and nobody has said they made yet — decision 13's committed bucket, as a list
 * of things to do.
 *
 * Only the *committed* ones: a movement the sender could not afford moves
 * nothing, and telling somebody to move £0 is not news. Read from the same
 * scopes every other surface reads, so the digest and the flow diagram cannot
 * disagree about what is leaving.
 *
 * No date on these lines, deliberately. A derived transfer is anchored to a
 * payday and the schedule below says when; an authored movement says only that
 * it happens each month, and inventing a day for it would be a fact the plan
 * does not hold. They are a month's outstanding list, not a diary.
 *
 * **Split by the receiving end's owner**, which is the half WP-AF left undone.
 * The sender predicate below made every line's *from* an account the reader
 * owns; nothing ever looked at the *to*, so a movement out of your current
 * account into a co-member's pot — an honest instruction, genuinely yours to
 * make — was listed under "between your own accounts", which is a falsehood
 * about somebody else's money in the one place a reader cannot correct it.
 * `needsYou.ts`'s `movementEnds` says the same thing on the checklist; these
 * two lists are the two of its readings this surface can reach.
 */
async function movementLines(
  store: Store,
  userId: string,
  visible: VisibleAccounts,
  scopes: readonly PlannedScope[],
  asOfDate: string,
): Promise<MovementSections> {
  const month = monthStart(asOfDate);

  const sections: MovementSections = { own: [], outward: [] };
  for (const movement of scopes.flatMap((s) => s.plan.movements)) {
    const from = visible.get(movement.fromAccountId);
    // Only movements out of an account this user **owns**: it is their list of
    // things to do, and money leaving somebody else's account is not on it.
    //
    // Ownership, never access (decision 20). This read `accounts` — every
    // account the caller can *see* — so a co-member's current account shared
    // into the household put their monthly sweep in your inbox as an
    // instruction, and an email is the one surface a reader cannot correct
    // afterwards. The rule was already written above; only the predicate was
    // missing.
    if (!from || from.ownerUserId !== userId || movement.fundedMinor <= 0) continue;
    const confirmed = await store.listTransferConfirmationsForAccount(from.id, month);
    if (confirmed.some((c) => c.inflowId === movement.inflowId)) continue;
    // The destination is only ever *named* here, so access is the right gate
    // for it: an owner reads "to Pot" and everyone else reads the honest
    // fallback below.
    //
    // And an *unseeable* destination is safely "not yours": every account you
    // own is in `listAccessibleAccounts` by construction, in both stores, so
    // absence from `visible` proves non-ownership. That is what keeps this to
    // two buckets instead of three — there is no "cannot say" case here, unlike
    // the checklist, which reads an owner id off the wire and can be missing it.
    // A scope closes over funding relationships, so the destination really can
    // be an account outside the reader's own list.
    const to = visible.get(movement.toAccountId);
    const line =
      `- ${formatMoney(movement.fundedMinor, from.currency)} from ${from.name} to ` +
      `${nameFor(visible, movement.toAccountId)}`;
    (to?.ownerUserId === userId ? sections.own : sections.outward).push(line);
  }
  return sections;
}

/**
 * Build one user's daily digest, or null when there is nothing worth an email.
 *
 * Three sections:
 *   (a) what falls due over the next seven days — the same assembly GET
 *       /api/upcoming serves, so the mail and the screen never disagree;
 *   (b) what to move over the next seven days — this user's slice of each of
 *       their households' payday schedules, from the same household plan GET
 *       /api/households/:id/plan returns;
 *   (c) what to move out of their own accounts this month — see
 *       `movementLines`, which is (b)'s answer for an estate with no household
 *       anywhere in it, and which is two sections rather than one because the
 *       far end is not always theirs.
 *
 * Pure with respect to mail: it reads the store and returns text. Deciding
 * whether to send (and to whom) belongs to the runner below.
 */
export async function buildDailyDigest(
  store: Store,
  userId: string,
  asOfDate: string,
): Promise<string | null> {
  const windowEnd = plusDays(asOfDate, DIGEST_WINDOW_DAYS);

  const ctx = createPlanContext();
  const accounts = await accessibleAccounts(store, userId);
  const scopes = await scopesFor(store, accounts, asOfDate, ctx);

  // **The one name gate this whole file has.** Built from the accounts the
  // reader can *see*, never from a scope: a scope closes over funding
  // relationships and deliberately does not check access (`plan.ts`'s
  // `closeScope`), because the money arriving in your account is a fact about
  // your account whoever sent it. That is the right rule for the arithmetic and
  // the wrong one for the labels, and reading it as both is what put a
  // co-member's account name in somebody's inbox.
  const visible: VisibleAccounts = new Map(accounts.map((a) => [a.id, a]));

  const due = await upcomingForUser(store, userId, asOfDate, DIGEST_WINDOW_DAYS, ctx);
  const movements = await movementLines(store, userId, visible, scopes, asOfDate);

  // The transfers the pass derived for *this* user, whether or not a household
  // is involved: `splitTransfersByPayday` serves a solo user's derived feed into
  // a bills pot for free, because the pass derives it exactly as it derives a
  // member's share of the rent. The old loop asked `listHouseholdsForUser` and
  // was therefore structurally blind to every standalone estate.
  const householdNames = new Map<string, string>(
    (await store.listHouseholdsForUser(userId)).map((h) => [h.id, h.name]),
  );
  const transferLines: string[] = [];
  for (const scope of scopes) {
    const household = scope.input.householdId
      ? householdNames.get(scope.input.householdId)
      : undefined;
    // Split by the pass's own `DerivedTransfer.currency` before the payday
    // schedule, which keeps only the two accounts and the amount. A scope spans
    // as many currencies as its accounts do (decision 10 plans each on its own),
    // so labelling every line with `accounts[0]`'s posted a EUR transfer as
    // "45.00 GBP" — the wrong money, in an email nobody can correct afterwards.
    for (const [currency, transfers] of groupByCurrency(scope.plan.transfers)) {
      const mine = paydayScheduleFor(scope, transfers, asOfDate).find(
        (s) => s.memberUserId === userId,
      );
      for (const event of mine?.events ?? []) {
        if (event.date < asOfDate || event.date > windowEnd) continue;
        for (const t of event.transfers) {
          // **Both ends, through `visible`** (decision 41). This read the map
          // the pass built from `scope.input.accounts` — the whole closed scope,
          // access unchecked — and so named a co-member's assigned-but-unshared
          // account at either end. Assignment is not a share and a roster is not
          // access: `listAccessibleAccounts` is ownership plus explicit shares,
          // and nothing else. `movementLines` fifty lines above always got this
          // right; the two now ask one function the one question.
          transferLines.push(
            `- ${event.date} — ${formatMoney(t.amountMinor, currency)} from ` +
              `${nameFor(visible, t.fromAccountId)} to ` +
              `${nameFor(visible, t.toAccountId)}` +
              `${household ? ` (${household})` : ""}`,
          );
        }
      }
    }
  }

  // Nothing due and nothing to move is not news. Send no mail at all rather
  // than a daily "all clear" nobody asked for.
  const movementCount = movements.own.length + movements.outward.length;
  if (due.length === 0 && transferLines.length === 0 && movementCount === 0) return null;

  const sections: string[] = [`Your Finance Planner digest for ${asOfDate}.`];

  if (due.length > 0) {
    sections.push(
      [
        `Due in the next ${DIGEST_WINDOW_DAYS} days`,
        ...due.map(
          (d) =>
            `- ${d.dueDate} (${dayLabel(d.daysUntil)}) — ${d.name}: ` +
            `${formatMoney(d.amountMinor, d.currency)} [${d.accountName}]`,
        ),
      ].join("\n"),
    );
  }

  if (transferLines.length > 0) {
    // Sorted by date so the two sections read the same way round.
    sections.push(
      [`Transfers for the next ${DIGEST_WINDOW_DAYS} days`, ...transferLines.sort()].join("\n"),
    );
  }

  // Two headings, each true of every line beneath it. A plain-text to-do list
  // is read down its left edge, so the ownership fact belongs once above a
  // group rather than repeated as a suffix on every line — and the two are
  // different kinds of task anyway: housekeeping between your own pots, versus
  // sending money to somebody else. An estate with no cross-owner movement gets
  // exactly the mail it got before.
  //
  // Sorted for the same reason the transfers are: the same estate must read the
  // same way two days running.
  if (movements.own.length > 0) {
    sections.push(["Money to move between your own accounts", ...movements.own.sort()].join("\n"));
  }

  if (movements.outward.length > 0) {
    sections.push(
      ["Money to move into somebody else's account", ...movements.outward.sort()].join("\n"),
    );
  }

  sections.push("You are getting this because email notifications are on for your account.");
  return `${sections.join("\n\n")}\n`;
}

/**
 * Digests this process claimed and did not manage to deliver, as
 * `${userId}|${date}` → attempts already made.
 *
 * Deliberately *not* in the notification log, and deliberately not module
 * state. See `runNotifierOnce` for why the log is the wrong place; it is a
 * parameter rather than a global so that two notifiers in one process, and
 * every test, get their own, and so the only thing shared between passes is a
 * value somebody chose to share.
 */
export type DigestAttempts = Map<string, number>;

export interface NotifierPassOptions {
  /** Carried across passes by `startNotifier`. Omit for a one-shot pass. */
  attempts?: DigestAttempts;
  /** Where a failed attempt is reported. Silent by default. */
  log?: (msg: string) => void;
}

/**
 * One pass of the notifier: every opted-in user gets at most one digest for
 * `now`'s date. `tryLogNotification` is the gate — it claims the (user, date,
 * kind) slot before any mail goes out, so a retry, a restart, or a second
 * replica cannot send the same digest twice.
 *
 * The claim stays exactly one claim, taken exactly where it was taken before.
 * What changed is who is responsible for the rest of the day. Claiming the slot
 * and *sending* the mail were being read as the same fact: a throw out of the
 * builder or the mailer left the slot claimed, and the day was gone for good —
 * the log said a digest had been sent when nothing had. So the pass that holds
 * the claim now owns delivery, and remembers a failure well enough to try again
 * on its next tick, **under the claim it already holds**.
 *
 * That is why the retry lives in `attempts` and not in the log. The log's
 * primitive is insert-on-conflict-do-nothing: a one-way claim with no read and
 * no release. Making the day retryable *through* the log would mean either
 * un-claiming it (a release the store does not offer) or writing a second row
 * some later pass could claim as a retry token — and that token is exactly what
 * a second replica would race for while the first is still mid-send, which
 * trades the load-bearing property away for the one being fixed. Keeping the
 * retry in the process that failed keeps the atomic claim the only arbitration
 * point there has ever been: a replica that loses the claim asks for nothing
 * else and sends nothing.
 *
 * What that leaves open, honestly: this process's memory is the retry's only
 * record, so a restart between the failure and the retry loses the day, and a
 * send that delivered and then threw is attempted a second time. Both are the
 * at-least-once boundary and neither is closable here — a durable, releasable
 * claim is a store-level primitive.
 *
 * Returns how many messages were actually sent, which is what the tests assert
 * on. Exported (and timer-free) precisely so it can be driven with explicit
 * dates rather than by waiting on a clock.
 */
export async function runNotifierOnce(
  store: Store,
  mailer: Mailer,
  now: Date,
  options: NotifierPassOptions = {},
): Promise<number> {
  const date = toISODate(now);
  const { attempts = new Map<string, number>(), log } = options;
  // Yesterday's unfinished business is not today's: the digest that failed was
  // for that date, and that date is over.
  for (const key of attempts.keys()) if (!key.endsWith(`|${date}`)) attempts.delete(key);

  let sent = 0;
  for (const user of await store.listUsersWithNotifications()) {
    const key = `${user.id}|${date}`;
    const made = attempts.get(key) ?? 0;
    // The gate, unmoved. It is asked once per day per user: a pass already
    // holding the day — because an earlier pass in this process claimed it and
    // then failed — carries on under that claim rather than asking for another.
    if (made === 0 && !(await store.tryLogNotification(user.id, date, DAILY_DIGEST_KIND))) continue;

    try {
      const body = await buildDailyDigest(store, user.id, date);
      // An empty digest is a finished day, not a failure. The claim covers
      // "looked, nothing to say" on purpose, so a user with a quiet estate is
      // not re-examined every fifteen minutes for the rest of the day.
      if (!body) {
        attempts.delete(key);
        continue;
      }
      await mailer.sendDigest(user.email, `Finance Planner: your ${date} digest`, body);
      attempts.delete(key);
      sent += 1;
    } catch (err) {
      // Per user, because one unreachable address used to abort the pass and
      // cost everybody after it in the list their digest too.
      const next = made + 1;
      if (next < MAX_DIGEST_ATTEMPTS) attempts.set(key, next);
      else attempts.delete(key);
      log?.(
        `[notify] digest for ${user.id} on ${date} failed (attempt ${next} of ` +
          `${MAX_DIGEST_ATTEMPTS}): ${String(err)}`,
      );
    }
  }
  return sent;
}

export interface NotifierEnv {
  notifyEnabled: boolean;
  /** Local hour from which the day's digests may go out. */
  notifyHour: number;
}

/**
 * Start the background digest sender: wake every 15 minutes and, once the local
 * hour has reached `notifyHour`, run a pass. The notification log means an
 * extra pass is a no-op, so the schedule only has to be roughly right.
 *
 * Single-replica assumption: compose and the Helm chart both run one api pod,
 * and this runs in-process with it. If that ever changes, enable NOTIFY_ENABLED
 * on one replica only — though the (user, date, kind) unique key would keep a
 * double-send harmless anyway.
 *
 * The tick is also the retry interval: a pass that claimed a day and failed to
 * deliver it holds that failure in `attempts` and tries once more fifteen
 * minutes later, which is why the map is created here rather than per pass.
 *
 * Returns a stop function; the caller wires it to shutdown.
 */
export function startNotifier(
  store: Store,
  mailer: Mailer,
  env: NotifierEnv,
  log: (msg: string) => void,
): () => void {
  if (!env.notifyEnabled) return () => {};
  let running = false;
  const attempts: DigestAttempts = new Map();
  const tick = async (): Promise<void> => {
    if (running) return; // a slow pass must not overlap the next tick
    if (new Date().getHours() < env.notifyHour) return;
    running = true;
    try {
      const sent = await runNotifierOnce(store, mailer, new Date(), { attempts, log });
      if (sent > 0) log(`[notify] sent ${sent} digest(s)`);
    } catch (err) {
      log(`[notify] digest run failed: ${String(err)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.(); // never hold the process open on our account
  return () => clearInterval(timer);
}
