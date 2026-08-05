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
 */
async function movementLines(
  store: Store,
  accounts: readonly Account[],
  scopes: readonly PlannedScope[],
  asOfDate: string,
): Promise<string[]> {
  const mine = new Map(accounts.map((a) => [a.id, a]));
  const month = monthStart(asOfDate);

  const lines: string[] = [];
  for (const movement of scopes.flatMap((s) => s.plan.movements)) {
    const from = mine.get(movement.fromAccountId);
    // Only movements out of an account this user can see: it is their list of
    // things to do, and money leaving somebody else's account is not on it.
    if (!from || movement.fundedMinor <= 0) continue;
    const confirmed = await store.listTransferConfirmationsForAccount(from.id, month);
    if (confirmed.some((c) => c.inflowId === movement.inflowId)) continue;
    const to = mine.get(movement.toAccountId);
    lines.push(
      `- ${formatMoney(movement.fundedMinor, from.currency)} from ${from.name} to ` +
        `${to?.name ?? "another account"}`,
    );
  }
  return lines;
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
 *   (c) what to move between their own accounts this month — see
 *       `movementLines`, which is (b)'s answer for an estate with no household
 *       anywhere in it.
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

  const due = await upcomingForUser(store, userId, asOfDate, DIGEST_WINDOW_DAYS, ctx);
  const movements = await movementLines(store, accounts, scopes, asOfDate);

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
    const accountName = new Map(
      scope.input.accounts.map((a) => [a.accountId, a.name ?? "an account"]),
    );
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
          transferLines.push(
            `- ${event.date} — ${formatMoney(t.amountMinor, currency)} from ` +
              `${accountName.get(t.fromAccountId) ?? "an account"} to ` +
              `${accountName.get(t.toAccountId) ?? "an account"}` +
              `${household ? ` (${household})` : ""}`,
          );
        }
      }
    }
  }

  // Nothing due and nothing to move is not news. Send no mail at all rather
  // than a daily "all clear" nobody asked for.
  if (due.length === 0 && transferLines.length === 0 && movements.length === 0) return null;

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

  if (movements.length > 0) {
    // Sorted for the same reason the transfers are: the same estate must read
    // the same way two days running.
    sections.push(["Money to move between your own accounts", ...movements.sort()].join("\n"));
  }

  sections.push("You are getting this because email notifications are on for your account.");
  return `${sections.join("\n\n")}\n`;
}

/**
 * One pass of the notifier: every opted-in user gets at most one digest for
 * `now`'s date. `tryLogNotification` is the gate — it claims the (user, date,
 * kind) slot before any mail goes out, so a retry, a restart, or a second
 * replica cannot send the same digest twice.
 *
 * Returns how many messages were actually sent, which is what the tests assert
 * on. Exported (and timer-free) precisely so it can be driven with explicit
 * dates rather than by waiting on a clock.
 */
export async function runNotifierOnce(store: Store, mailer: Mailer, now: Date): Promise<number> {
  const date = toISODate(now);
  let sent = 0;
  for (const user of await store.listUsersWithNotifications()) {
    if (!(await store.tryLogNotification(user.id, date, DAILY_DIGEST_KIND))) continue;
    const body = await buildDailyDigest(store, user.id, date);
    if (!body) continue;
    await mailer.sendDigest(user.email, `Finance Planner: your ${date} digest`, body);
    sent += 1;
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
  const tick = async (): Promise<void> => {
    if (running) return; // a slow pass must not overlap the next tick
    if (new Date().getHours() < env.notifyHour) return;
    running = true;
    try {
      const sent = await runNotifierOnce(store, mailer, new Date());
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
