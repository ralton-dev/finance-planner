/**
 * Fixtures for TEST-PLAN.md, planted through the real HTTP API.
 *
 * The plan asks a person to work through thirteen sections on a real screen,
 * and until now it asked them to do it on data that does not exist. Several
 * sections are also destructive — §5b exports, wipes and re-imports; §6
 * deliberately exhausts the auth rate limits — so they cannot be run against a
 * profile anybody cares about. This plants a disposable estate that carries
 * every shape the plan names, alongside whatever the database already holds.
 *
 * **Through the API, never through SQL.** Half of these fixtures exist to
 * exercise a confirm handler, a guard or a refusal that only runs on the route.
 * A row inserted behind the server's back would prove the store can hold it and
 * nothing else, and the one defect this plan was written for (§1) lives in a
 * figure the *reader* assembles. So this registers, logs in, and drives the
 * gateway exactly as `apps/web/src/lib/api.ts` does.
 *
 * ## Running it
 *
 * ```bash
 * ./apps/api/node_modules/.bin/tsx deploy/local/seed-test-fixtures.mts
 * ```
 *
 * Point it somewhere else with `FP_BASE_URL` (default `http://localhost:8080`,
 * the nginx that serves the production bundle and proxies `/api`).
 *
 * **Safe to run twice.** Emails are fixed, so a re-run finds the same users and
 * *resets* them first: every account and household they own is deleted and
 * rebuilt. Nothing outside the fixture users is touched — no other user's data
 * is read, let alone written.
 *
 * ## It will look like it has hung. It has not.
 *
 * `POST /auth/register` is throttled to 3/min and `POST /auth/login` to 5/min,
 * per source address, which is §6's whole subject. Ten users therefore cost
 * several minutes of deliberate waiting before the first account is created.
 * Every wait is announced.
 *
 * ## What it asserts
 *
 * A fixture nobody checked is worse than none, because the plan then blames the
 * code for the fixture's shape. So the figures the plan quotes are read back
 * off the API afterwards and printed — §1's residue, §1a's silence, §1b's age,
 * §4a's two disagreeing months, §2b's two refusals, §9's withheld name. A
 * failed assertion is fatal and says which one.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.FP_BASE_URL ?? "http://localhost:8080";

/** The auth service's refresh cookie (`apps/auth/src/server.ts:45`). */
const REFRESH_COOKIE = "fp_refresh";

/** One password for every fixture user. Stated in TEST-PLAN.md §0. */
const PASSWORD = "TestPlan!2026";

// --- dates -----------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const TODAY = new Date().toISOString().slice(0, 10);
const THIS_MONTH = TODAY.slice(0, 7);

/** `days` either side of today, as an ISO date. */
function shift(days: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/** The same day, `n` months back — §4a needs a past month to ask a plan for. */
function monthsBack(n: number): string {
  const d = new Date(`${TODAY}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * A deadline for every contribution-first goal below, and it should not have to
 * exist.
 *
 * `createPaymentBody` says a `fixed_point` payment needs "a dueDate **or**
 * fixedMonthlyMinor", and the engine agrees: `contributionCapMinor` returns the
 * cap whenever one is set, so the date is genuinely not needed to pace the
 * goal. `db/migrations/0001_init.sql:112` disagrees —
 * `CHECK (category <> 'fixed_point' OR due_date IS NOT NULL)` — so a body the
 * contract calls valid is accepted by the route and then **500s** on the
 * insert. Found while building these fixtures; see §13.
 *
 * Setting a far date alongside the cap changes nothing the reader sees, because
 * the cap wins: `required = min(cap, remaining)`.
 */
const GOAL_DUE = shift(540);

/**
 * The 31st of December the goal in §4a is due on: this year's while it is still
 * ahead, next year's once it is not. A fixed seed date goes stale the moment
 * the calendar passes it — the same reason `demo.ts` computes its dates — and a
 * goal whose deadline is behind us proves nothing about two months disagreeing.
 */
function nextNewYearsEve(): string {
  const year = Number(TODAY.slice(0, 4));
  return TODAY <= `${year}-12-31` && TODAY < `${year}-12-01`
    ? `${year}-12-31`
    : `${year + 1}-12-31`;
}

// --- talking to the API ----------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let stepCount = 0;
function say(message: string): void {
  console.log(`  ${message}`);
}
function heading(message: string): void {
  console.log(`\n${message}`);
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Json {
  [key: string]: unknown;
}

/**
 * One signed-in user, holding its access token and its refresh cookie.
 *
 * The refresh cookie **rotates** on every use, so the newest value is kept and
 * the old one dropped — presenting a rotated token twice is read as theft and
 * signs the user out everywhere, which on a seeding run would look like a
 * mysterious 401 halfway through. Refreshing rather than logging in again also
 * keeps clear of the 5/min login limit.
 */
class User {
  accessToken: string | null = null;
  refreshCookie: string | null = null;
  id = "";

  constructor(
    readonly email: string,
    readonly displayName: string,
  ) {}

  async call<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    stepCount += 1;
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        ...(this.refreshCookie ? { cookie: this.refreshCookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && retry && (await this.refresh())) {
      return this.call<T>(method, path, body, false);
    }
    this.adoptCookie(res);
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private adoptCookie(res: Response): void {
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      if (!c.startsWith(REFRESH_COOKIE)) continue;
      this.refreshCookie = c.split(";")[0]!;
      rememberSession(this.email, this.refreshCookie);
    }
  }

  /** Pick a previous run's session back up. False when it has been rotated out
   *  from under us, which is not an error — the caller logs in instead. */
  async resume(cookie: string): Promise<boolean> {
    this.refreshCookie = cookie;
    if (!(await this.refresh())) return false;
    const me = await this.call<{ id: string }>("GET", "/api/auth/me");
    this.id = me.id;
    return true;
  }

  private async refresh(): Promise<boolean> {
    if (!this.refreshCookie) return false;
    const res = await fetch(`${BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { cookie: this.refreshCookie },
    });
    this.adoptCookie(res);
    if (!res.ok) return false;
    const json = (await res.json()) as { accessToken: string };
    this.accessToken = json.accessToken;
    return true;
  }

  async login(): Promise<void> {
    const res = await throttled(() =>
      fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: this.email, password: PASSWORD }),
      }),
    );
    if (!res.ok) throw await toError(res);
    this.adoptCookie(res);
    const json = (await res.json()) as { accessToken: string };
    this.accessToken = json.accessToken;
    const me = await this.call<{ id: string }>("GET", "/api/auth/me");
    this.id = me.id;
  }
}

async function toError(res: Response): Promise<ApiError> {
  let code = "error";
  let message = res.statusText;
  try {
    const json = (await res.json()) as { error?: { code?: string; message?: string } };
    code = json.error?.code ?? code;
    message = json.error?.message ?? message;
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, code, message);
}

/**
 * Send, and wait out a 429 rather than failing on it.
 *
 * The auth service answers with `retry-after` in seconds, which is the honest
 * number to sleep for; a second is added because the window is measured from
 * the service's clock and not ours.
 */
async function throttled(send: () => Promise<Response>): Promise<Response> {
  for (;;) {
    const res = await send();
    if (res.status !== 429) return res;
    const after = Number(res.headers.get("retry-after") ?? "60");
    const wait = (Number.isFinite(after) ? after : 60) + 1;
    say(`rate limited — waiting ${wait}s (this is §6's limit doing its job)`);
    await sleep(wait * 1000);
  }
}

/**
 * Refresh cookies from the last run, so a re-run costs no rate-limited request.
 *
 * Registering is 3/min and logging in 5/min, so ten users cost several minutes
 * of waiting *before anything is seeded* — every time. Refreshing is 20/min and
 * needs no password, so a second run of this script starts in seconds. The
 * cookie rotates on every use, so the file is rewritten each time; a stale one
 * simply fails and the login path takes over.
 *
 * Deliberately in the OS temp directory and not the repo: it holds live session
 * tokens for ten accounts, and nothing that grants access to a running service
 * belongs beside the source.
 */
const SESSION_FILE = join(tmpdir(), "fp-test-fixture-sessions.json");

function loadSessions(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

const sessions = loadSessions();

function rememberSession(email: string, cookie: string): void {
  sessions[email] = cookie;
  try {
    writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2), { mode: 0o600 });
  } catch {
    /* a cache that cannot be written is only a slower next run */
  }
}

/** Take up a session — from last run's cookie, else register and log in. */
async function ensureUser(email: string, displayName: string): Promise<User> {
  const user = new User(email, displayName);
  const cached = sessions[email];
  if (cached !== undefined && (await user.resume(cached))) {
    say(`resumed ${email}`);
    return user;
  }

  const res = await throttled(() =>
    fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, displayName }),
    }),
  );
  if (!res.ok && res.status !== 409) throw await toError(res);
  await user.login();
  say(`${res.status === 409 ? "reusing" : "registered"} ${email}`);
  return user;
}

// --- typed slivers of the API ----------------------------------------------
// Only the fields this script reads. The wire carries far more.

interface Account {
  id: string;
  name: string;
  currency: string;
  ownerUserId?: string;
}
interface Household {
  id: string;
  name: string;
}
interface PlanLine {
  paymentId: string;
  name: string;
  requiredMonthlyMinor: number;
  fundedMonthlyMinor: number;
  alreadySavedMinor: number;
}
interface AccountPlan {
  accountId: string;
  currency: string;
  asOfDate: string;
  reservedMinor?: number;
  allocatedInflowMinor?: number;
  latestBalance: { asOfDate: string; balanceMinor: number } | null;
  lines: PlanLine[];
  shortfallMinor: number;
  leftoverMinor: number;
}
interface FlowAccount {
  accountId: string;
  /** Absent when the caller is on the roster but may not be told the name. */
  name?: string;
  incomeMinor: number;
  spendingMinor: number;
  leftoverMinor: number;
}
interface FlowEdge {
  fromAccountId: string | null;
  toAccountId: string | null;
  amountMinor: number;
  /** Present only on an **authored** movement. A transfer the pass derived
   *  carries a `memberUserId` instead — which is how §2's case is told apart
   *  from the case that always worked. */
  inflowId?: string;
}
interface Flow {
  accounts: FlowAccount[];
  edges: FlowEdge[];
}
/** A row of `GET /api/households/:id/accounts`. `accountName` is **absent**,
 *  never null, when the caller may not be told it (decision 41). */
interface RosterRow {
  accountId: string;
  accountName?: string;
}

// --- fixture helpers -------------------------------------------------------

const account = (u: User, body: Json): Promise<Account> =>
  u.call<Account>("POST", "/api/accounts", body);

const income = (u: User, accountId: string, body: Json): Promise<Json> =>
  u.call<Json>("POST", `/api/accounts/${accountId}/incomes`, body);

/** An **authored** movement: one row with two faces, arriving here and leaving
 *  `sourceAccountId`. §2 is explicit that a derived transfer is not the case
 *  under test, so every pot in these fixtures that is meant to be fed by an
 *  authored movement gets one of these and not an empty account. */
const movement = (u: User, intoAccountId: string, body: Json): Promise<{ id: string }> =>
  u.call<{ id: string }>("POST", `/api/accounts/${intoAccountId}/inflows`, {
    source: "account",
    frequency: "monthly",
    anchorDate: `${THIS_MONTH}-28`,
    ...body,
  });

const payment = (u: User, accountId: string, body: Json): Promise<{ id: string }> =>
  u.call<{ id: string }>("POST", `/api/accounts/${accountId}/payments`, body);

const balance = (u: User, accountId: string, balanceMinor: number, asOfDate?: string) =>
  u.call<Json>("PUT", `/api/accounts/${accountId}/balance`, { balanceMinor, asOfDate });

const salary = (u: User, accountId: string, amountMinor: number, day = "25") =>
  income(u, accountId, {
    name: "Salary",
    amountMinor,
    frequency: "monthly",
    anchorDate: `${THIS_MONTH}-${day}`,
  });

const plan = (u: User, accountId: string, asOf?: string): Promise<AccountPlan> =>
  u.call<AccountPlan>("GET", `/api/accounts/${accountId}/plan${asOf ? `?asOf=${asOf}` : ""}`);

const household = (u: User, name: string): Promise<Household> =>
  u.call<Household>("POST", "/api/auth/households", { name });

const invite = (u: User, householdId: string, email: string, role = "member") =>
  u.call<Json>("POST", `/api/auth/households/${householdId}/members`, { email, role });

const assign = (u: User, householdId: string, accountId: string, body: Json) =>
  u.call<Json>("PUT", `/api/households/${householdId}/accounts/${accountId}`, body);

const share = (u: User, accountId: string, householdId: string, permission: "view" | "edit") =>
  u.call<Json>("POST", `/api/accounts/${accountId}/shares`, { householdId, permission });

/**
 * Everything this user owns, gone.
 *
 * Idempotency, done the only way that is honest here: rather than pretend a
 * dozen POSTs can be replayed, the fixture user's estate is torn down and built
 * again, so a re-run lands the same figures whatever state Ben left it in.
 * Scoped hard to the caller — their own accounts, their own households — so a
 * re-run can never reach the dev data this database already holds.
 */
async function reset(u: User): Promise<void> {
  const me = await u.call<{ households?: Household[] }>("GET", "/api/auth/me");
  for (const h of me.households ?? []) {
    try {
      await u.call("DELETE", `/api/auth/households/${h.id}`);
    } catch (e) {
      // A plain member cannot delete the household; the owner's reset does it.
      if (!(e instanceof ApiError) || e.status !== 403) throw e;
    }
  }
  const accounts = await u.call<Account[]>("GET", "/api/accounts");
  for (const a of accounts) {
    if (a.ownerUserId !== undefined && a.ownerUserId !== u.id) continue;
    try {
      await u.call("DELETE", `/api/accounts/${a.id}`);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 403) throw e;
    }
  }
}

// --- assertions ------------------------------------------------------------

const failures: string[] = [];

function check(ok: boolean, what: string): void {
  if (ok) {
    say(`✓ ${what}`);
  } else {
    failures.push(what);
    say(`✗ ${what}`);
  }
}

const gbp = (minor: number): string => `£${(minor / 100).toFixed(2)}`;

// --- the fixtures ----------------------------------------------------------

interface Fixtures {
  reality: User;
  flow: User;
  flowmate: User;
  bighouse: User;
  currencies: User;
  ledger: User;
  ledgermate: User;
  dupe: User;
  roundtrip: User;
  newbie: User;
}

/**
 * §1, §1a, §1b, §1c, §9a and §11's regression surface, on one login.
 *
 * The headline account is built to Ben's own reported figures: a balance of
 * £11.70 observed today, £234.64 recorded as saved across two payments, and
 * £46.39 arriving from a movement out of the current account. The residue the
 * banner must name is therefore `234.64 − (11.70 + 46.39)` = **£176.55**, and
 * the two SAVED cells beneath it still read £120.00 and £114.64.
 */
async function seedReality(u: User): Promise<void> {
  heading("reality@fp.test — §1, §1a, §1b, §1c, §9a, §11");
  await reset(u);

  const current = await account(u, {
    name: "Current Account",
    description: "Salary lands here and feeds the pots",
    openingBalanceMinor: 250_000,
  });
  await salary(u, current.id, 300_000);

  // §1 / §1c — the headline.
  //
  // **Every pot below is given an income of its own, and that is load-bearing.**
  // The pass transports expenses (decision 9): a pot with bills and no income is
  // fed by a transfer it *derives*, and `allocatedInflowMinor` is
  // `transferIn + movementIn`. A pot that has both an authored movement and a
  // derived transfer therefore reports twice what the movement delivers — £92.78
  // where §1 wants £46.39. Funding the bills from the pot's own income leaves the
  // authored movement as the only thing arriving, which is the shape §1 is about.
  // Rent Pot at the foot of this function deliberately keeps no income, because
  // §9a is precisely the derived case.
  const holiday = await account(u, {
    name: "Holiday Fund",
    description: "§1 — the account that reported £222.94",
    openingBalanceMinor: 1_170,
  });
  // £1,534.64/month, so LEFT OVER reads £1,534.64 — the third figure on the
  // screen the banner's docstring describes, alongside £46.39 arriving and two
  // goals on track.
  await income(u, holiday.id, {
    name: "Monthly credit",
    amountMinor: 153_464,
    frequency: "monthly",
    anchorDate: `${THIS_MONTH}-01`,
  });
  await payment(u, holiday.id, {
    name: "Summer holiday",
    category: "fixed_point",
    amountMinor: 120_000,
    dueDate: GOAL_DUE,
    fixedMonthlyMinor: 3_000,
    alreadySavedMinor: 12_000,
    priority: 10,
  });
  await payment(u, holiday.id, {
    name: "New laptop",
    category: "fixed_point",
    amountMinor: 90_000,
    dueDate: GOAL_DUE,
    fixedMonthlyMinor: 1_639,
    alreadySavedMinor: 11_464,
    priority: 20,
  });
  await movement(u, holiday.id, {
    name: "Monthly sweep",
    sourceAccountId: current.id,
    amountMinor: 4_639,
    priority: 10,
  });
  await balance(u, holiday.id, 1_170);
  say("Holiday Fund: balance £11.70, saved £120.00 + £114.64, £46.39 arriving");

  // §1a — arriving covers the gap, so the banner must stay silent.
  const covered = await account(u, {
    name: "Covered Pot",
    description: "§1a — arriving money covers the gap, so no banner",
    openingBalanceMinor: 1_170,
  });
  await income(u, covered.id, {
    name: "Monthly credit",
    amountMinor: 35_000,
    frequency: "monthly",
    anchorDate: `${THIS_MONTH}-01`,
  });
  await payment(u, covered.id, {
    name: "Winter tyres",
    category: "fixed_point",
    amountMinor: 120_000,
    dueDate: GOAL_DUE,
    fixedMonthlyMinor: 30_000,
    alreadySavedMinor: 23_464,
    priority: 10,
  });
  await movement(u, covered.id, {
    name: "Covering sweep",
    sourceAccountId: current.id,
    amountMinor: 30_000,
    priority: 20,
  });
  await balance(u, covered.id, 1_170);

  // §1b — a balance older than DEFAULT_STALE_AFTER_DAYS (10).
  const stale = await account(u, {
    name: "Stale Pot",
    description: "§1b — last checked in 20 days ago",
    openingBalanceMinor: 5_000,
  });
  await income(u, stale.id, {
    name: "Monthly credit",
    amountMinor: 2_500,
    frequency: "monthly",
    anchorDate: `${THIS_MONTH}-01`,
  });
  await payment(u, stale.id, {
    name: "Boiler service",
    category: "fixed_point",
    amountMinor: 40_000,
    dueDate: GOAL_DUE,
    fixedMonthlyMinor: 2_000,
    alreadySavedMinor: 20_000,
    priority: 10,
  });
  await balance(u, stale.id, 5_000, shift(-20));

  // §9a — a pot with a bill and no income, so the pass *derives* its feed and
  // the checklist row has to name the sender. That sender is the reader, and
  // decision 42 is why it must say "you" rather than "a household member".
  const rent = await account(u, {
    name: "Rent Pot",
    description: "§9a — fed by a transfer the plan derives, from you",
    openingBalanceMinor: 0,
  });
  await payment(u, rent.id, {
    name: "Rent",
    category: "monthly_recurring",
    amountMinor: 40_000,
    dueDate: `${THIS_MONTH}-15`,
    priority: 10,
  });

  const p = await plan(u, holiday.id);
  const reserved = p.reservedMinor ?? 0;
  const arriving = p.allocatedInflowMinor ?? 0;
  const bal = p.latestBalance?.balanceMinor ?? 0;
  const residue = reserved - (bal + arriving);
  say(
    `observed: reserved ${gbp(reserved)}, balance ${gbp(bal)}, arriving ${gbp(arriving)} → residue ${gbp(residue)}`,
  );
  check(reserved === 23_464, `§1 reserved is ${gbp(23_464)}`);
  check(arriving === 4_639, `§1 arriving is ${gbp(4_639)}`);
  check(bal === 1_170, `§1 latest balance is ${gbp(1_170)}`);
  check(residue === 17_655, `§1 banner residue is ${gbp(17_655)}`);
  check(
    p.lines.some((l) => l.alreadySavedMinor === 12_000) &&
      p.lines.some((l) => l.alreadySavedMinor === 11_464),
    "§1 SAVED column reads £120.00 and £114.64",
  );

  const cp = await plan(u, covered.id);
  const coveredResidue =
    (cp.reservedMinor ?? 0) -
    ((cp.latestBalance?.balanceMinor ?? 0) + (cp.allocatedInflowMinor ?? 0));
  check(coveredResidue <= 0, `§1a Covered Pot has no banner (residue ${gbp(coveredResidue)})`);

  const sp = await plan(u, stale.id);
  const age = Math.round(
    (Date.parse(`${sp.asOfDate}T00:00:00Z`) -
      Date.parse(`${sp.latestBalance!.asOfDate}T00:00:00Z`)) /
      MS_PER_DAY,
  );
  const staleResidue =
    (sp.reservedMinor ?? 0) -
    ((sp.latestBalance?.balanceMinor ?? 0) + (sp.allocatedInflowMinor ?? 0));
  check(
    age > 10 && staleResidue > 0,
    `§1b Stale Pot is ${age} days old with a ${gbp(staleResidue)} gap`,
  );
}

/** §2 and §2a — a household of two whose pot is fed by an **authored**
 *  movement, which is the case the flow diagram got wrong. */
async function seedFlow(owner: User, mate: User): Promise<void> {
  heading("flow@fp.test + flowmate@fp.test — §2, §2a");
  await reset(mate);
  await reset(owner);

  const h = await household(owner, "Flow House");
  await invite(owner, h.id, mate.email);

  const current = await account(owner, {
    name: "Flow Current",
    description: "Sends the authored movement into the pot",
    openingBalanceMinor: 200_000,
  });
  await salary(owner, current.id, 250_000);

  const pot = await account(owner, {
    name: "Flow Pot",
    description: "§2 — fed by an authored movement, not a derived transfer",
    openingBalanceMinor: 50_000,
  });
  await payment(owner, pot.id, {
    name: "Rent",
    category: "monthly_recurring",
    amountMinor: 40_000,
    dueDate: `${THIS_MONTH}-15`,
    priority: 10,
    tag: "housing",
  });
  await payment(owner, pot.id, {
    name: "Broadband",
    category: "monthly_recurring",
    amountMinor: 3_000,
    dueDate: `${THIS_MONTH}-20`,
    priority: 20,
    tag: "utilities",
  });
  await movement(owner, pot.id, {
    name: "Household sweep",
    sourceAccountId: current.id,
    amountMinor: 50_000,
    priority: 10,
  });
  await balance(owner, current.id, 200_000);
  await balance(owner, pot.id, 50_000);

  const mateCurrent = await account(mate, {
    name: "Mate Current",
    openingBalanceMinor: 150_000,
  });
  await salary(mate, mateCurrent.id, 200_000, "28");
  await balance(mate, mateCurrent.id, 150_000);

  await share(owner, current.id, h.id, "view");
  await share(owner, pot.id, h.id, "view");
  await share(mate, mateCurrent.id, h.id, "view");
  await assign(owner, h.id, current.id, { role: "personal", memberUserId: owner.id });
  await assign(owner, h.id, pot.id, { role: "shared", memberUserId: null });
  await assign(owner, h.id, mateCurrent.id, { role: "personal", memberUserId: mate.id });

  const flow = await owner.call<Flow>(
    "GET",
    `/api/flow?accounts=${[current.id, pot.id, mateCurrent.id].join(",")}`,
  );
  check(
    flow.accounts.some((n) => n.accountId === current.id),
    "§2 the sending account is a node of its own (no `elsewhere`)",
  );
  // The **authored** ribbon, told apart from the household's derived transfers
  // by carrying an `inflowId` — the whole point of §2, since a derived transfer
  // always drew correctly and is not the case under test.
  const ribbon = flow.edges.find(
    (e) => e.fromAccountId === current.id && e.toAccountId === pot.id && e.inflowId !== undefined,
  );
  check(
    ribbon !== undefined && ribbon.amountMinor === 50_000,
    `§2 the authored ribbon runs Flow Current → Flow Pot (${gbp(ribbon?.amountMinor ?? 0)})`,
  );
  const derived = flow.edges.filter((e) => e.inflowId === undefined).length;
  say(`Flow House draws ${flow.edges.length} ribbons — 1 authored, ${derived} derived`);
  say(`Flow House id ${h.id} — /flow?household=${h.id}`);
}

/** §2b, first refusal — a household above `MAX_FLOW_ACCOUNTS` (40). */
async function seedBigHouse(u: User): Promise<void> {
  heading("bighouse@fp.test — §2b, the 41-account refusal");
  await reset(u);

  const h = await household(u, "Forty One House");
  const ids: string[] = [];
  for (let i = 1; i <= 41; i += 1) {
    const a = await account(u, {
      name: `Account ${String(i).padStart(2, "0")}`,
      openingBalanceMinor: 10_000,
    });
    ids.push(a.id);
    await assign(u, h.id, a.id, { role: "shared", memberUserId: null });
    if (i % 10 === 0) say(`${i} of 41 accounts`);
  }
  await salary(u, ids[0]!, 400_000);
  await payment(u, ids[1]!, {
    name: "Ground rent",
    category: "monthly_recurring",
    amountMinor: 20_000,
    dueDate: `${THIS_MONTH}-12`,
    priority: 10,
  });

  let refused = "";
  try {
    await u.call("GET", `/api/flow?accounts=${ids.join(",")}`);
  } catch (e) {
    if (e instanceof ApiError) refused = `${e.status} ${e.code}: ${e.message}`;
  }
  check(refused !== "", `§2b 41 accounts are refused — ${refused || "NOT REFUSED"}`);
  say(`Forty One House id ${h.id} — /flow?household=${h.id}`);
}

/**
 * §2b, second refusal — a household is denominated once, by its first account.
 *
 * This fixture used to *build* the two-currency household and check that the
 * flow diagram refused to draw it. It could not build one now: the second
 * currency is refused at the assignment door, because a household holding two
 * had a plan that could only be one of them and dropped the other account
 * silently — off the plan, and off the diagram drawn from the plan's own account
 * list, which is why the diagram's refusal was never even reached.
 *
 * So the fixture proves the refusal instead of the symptom, and leaves the EUR
 * account owned, un-assigned and visible — which is the state a user is left in.
 */
async function seedCurrencies(u: User): Promise<void> {
  heading("currencies@fp.test — §2b, the two-currency refusal");
  await reset(u);

  const h = await household(u, "One Currency House");
  const gbpAccount = await account(u, {
    name: "Sterling Current",
    currency: "GBP",
    openingBalanceMinor: 100_000,
  });
  await salary(u, gbpAccount.id, 200_000);
  await payment(u, gbpAccount.id, {
    name: "Storage unit",
    category: "monthly_recurring",
    amountMinor: 8_000,
    dueDate: `${THIS_MONTH}-18`,
    priority: 10,
  });
  const eurAccount = await account(u, {
    name: "Euro Savings",
    currency: "EUR",
    openingBalanceMinor: 50_000,
  });
  await payment(u, eurAccount.id, {
    name: "Hosting",
    category: "monthly_recurring",
    amountMinor: 12_000,
    dueDate: `${THIS_MONTH}-09`,
    priority: 10,
  });
  // The first account denominates the household. Nothing refuses this one.
  await assign(u, h.id, gbpAccount.id, { role: "personal", memberUserId: u.id });

  let refused = "";
  try {
    await assign(u, h.id, eurAccount.id, { role: "personal", memberUserId: u.id });
  } catch (e) {
    if (e instanceof ApiError) refused = `${e.status} ${e.code}: ${e.message}`;
  }
  check(
    refused.includes("cannot mix currencies"),
    `§2b a second currency is refused at assignment — ${refused || "NOT REFUSED"}`,
  );

  // Refused means not on the roster: the account is not half-in, and the plan
  // is not quietly missing one of the accounts its own roster lists.
  const roster = await u.call<{ accountId: string }[]>("GET", `/api/households/${h.id}/accounts`);
  check(
    roster.length === 1 && roster[0]?.accountId === gbpAccount.id,
    `§2b the roster holds only the GBP account — ${roster.length} account(s)`,
  );

  const plan = await u.call<{ currency: string; accounts: unknown[] }>(
    "GET",
    `/api/households/${h.id}/plan`,
  );
  check(
    plan.currency === "GBP" && plan.accounts.length === roster.length,
    `§2b the plan covers every account on the roster — ${plan.accounts.length} of ${roster.length} in ${plan.currency}`,
  );
  say(`One Currency House id ${h.id} — /households/${h.id} to retry the refused assignment`);
}

/**
 * §3, §3a, §3b, §4a, §4b, §4c and §9, on one household of two.
 *
 * The two halves that have to coexist: an account shared with **edit**, so §4b
 * has a co-editor who is not the member on the confirmation, and an account
 * assigned to the household but **never shared**, so §9 has one member who can
 * see it and one who cannot.
 */
async function seedLedger(owner: User, mate: User): Promise<void> {
  heading("ledger@fp.test + ledgermate@fp.test — §3, §4, §9");
  await reset(mate);
  await reset(owner);

  const h = await household(owner, "Ledger House");
  await invite(owner, h.id, mate.email);

  const current = await account(owner, {
    name: "Ledger Current",
    description: "Sends every movement in this household",
    openingBalanceMinor: 300_000,
  });
  await salary(owner, current.id, 280_000);
  await balance(owner, current.id, 300_000);

  // §3 / §3a / §4 — two goals, funded by one confirmable movement.
  const goals = await account(owner, {
    name: "Ledger Goals",
    description: "§3 and §4 — two goals fed by one authored movement",
    openingBalanceMinor: 20_000,
  });
  const christmas = await payment(owner, goals.id, {
    name: "Christmas fund",
    category: "fixed_point",
    amountMinor: 60_000,
    dueDate: nextNewYearsEve(),
    priority: 10,
    tag: "gifts",
  });
  await payment(owner, goals.id, {
    name: "Ski trip",
    category: "fixed_point",
    amountMinor: 90_000,
    dueDate: GOAL_DUE,
    fixedMonthlyMinor: 12_000,
    priority: 20,
    tag: "travel",
  });
  const sweep = await movement(owner, goals.id, {
    name: "Goals sweep",
    sourceAccountId: current.id,
    amountMinor: 30_000,
    priority: 10,
  });
  await balance(owner, goals.id, 20_000);
  // §3's last bullet: the ledger must show earlier months too, so a row
  // corrected back to its true month does not read as a deletion.
  await owner.call("POST", `/api/payments/${christmas.id}/contributions`, {
    amountMinor: 5_000,
    month: monthsBack(2).slice(0, 7),
    note: "Seeded two months back, so the ledger has an earlier month to show",
  });

  // §9 — assigned to the household, never shared. The mate must see its money
  // and not its name.
  const priv = await account(owner, {
    name: "Ledger Private",
    description: "§9 — assigned to the household, deliberately not shared",
    openingBalanceMinor: 40_000,
  });
  await payment(owner, priv.id, {
    name: "Private subscription",
    category: "monthly_recurring",
    amountMinor: 12_000,
    dueDate: `${THIS_MONTH}-20`,
    priority: 10,
  });
  await movement(owner, priv.id, {
    name: "Private sweep",
    sourceAccountId: current.id,
    amountMinor: 20_000,
    priority: 20,
  });
  await balance(owner, priv.id, 40_000);

  // §4b's last bullet needs a *household* transfer, which only exists when a
  // shared account has to be funded by both members.
  const pot = await account(owner, {
    name: "Ledger House Pot",
    description: "§4b — the household transfer an admin may un-confirm",
    openingBalanceMinor: 30_000,
  });
  await payment(owner, pot.id, {
    name: "Council tax",
    category: "monthly_recurring",
    amountMinor: 18_000,
    dueDate: `${THIS_MONTH}-10`,
    priority: 10,
    tag: "housing",
  });
  await balance(owner, pot.id, 30_000);

  const mateCurrent = await account(mate, {
    name: "Mate Ledger Current",
    openingBalanceMinor: 180_000,
  });
  await salary(mate, mateCurrent.id, 190_000, "28");
  await balance(mate, mateCurrent.id, 180_000);

  // Shares: edit on the two the mate is a co-editor of (§4b), view on the pot
  // and the mate's own, and **nothing at all** on Ledger Private (§9).
  await share(owner, current.id, h.id, "edit");
  await share(owner, goals.id, h.id, "edit");
  await share(owner, pot.id, h.id, "view");
  await share(mate, mateCurrent.id, h.id, "view");

  await assign(owner, h.id, current.id, { role: "personal", memberUserId: owner.id });
  await assign(owner, h.id, goals.id, { role: "personal", memberUserId: owner.id });
  await assign(owner, h.id, priv.id, { role: "personal", memberUserId: owner.id });
  await assign(owner, h.id, pot.id, { role: "shared", memberUserId: null });
  await assign(owner, h.id, mateCurrent.id, { role: "personal", memberUserId: mate.id });

  // §4a — the two months must genuinely disagree. A `fixed_point` goal due 31
  // December is divided by a different number of whole months each month, so
  // last month's plan books a different figure from today's. A fixture whose
  // months agree proves nothing, so this is asserted rather than assumed.
  const now = await plan(owner, goals.id);
  const past = await plan(owner, goals.id, monthsBack(1));
  const lineOf = (p: AccountPlan): PlanLine | undefined =>
    p.lines.find((l) => l.paymentId === christmas.id);
  const nowRequired = lineOf(now)?.requiredMonthlyMinor ?? 0;
  const pastRequired = lineOf(past)?.requiredMonthlyMinor ?? 0;
  say(
    `Christmas fund (due ${nextNewYearsEve()}): ${monthsBack(1).slice(0, 7)} wants ${gbp(pastRequired)}, ` +
      `${THIS_MONTH} wants ${gbp(nowRequired)}`,
  );
  check(nowRequired !== pastRequired, "§4a the two months genuinely disagree");

  // §9 — read the household back as the member who may not see Ledger Private.
  const roster = await mate.call<RosterRow[]>("GET", `/api/households/${h.id}/accounts`);
  const hidden = roster.find((a) => a.accountId === priv.id);
  check(
    hidden !== undefined && hidden.accountName === undefined,
    `§9 the mate is on the roster row but not told the name (${JSON.stringify(hidden?.accountName)})`,
  );
  const seen = await owner.call<RosterRow[]>("GET", `/api/households/${h.id}/accounts`);
  check(
    seen.find((a) => a.accountId === priv.id)?.accountName === "Ledger Private",
    "§9 the owner still sees it by name",
  );

  // The other half of §9: the diagram must still *draw* that account, carrying
  // its real amounts under an anonymous label.
  const mateAccounts = roster.map((a) => a.accountId);
  const mateFlow = await mate.call<Flow>("GET", `/api/flow?accounts=${mateAccounts.join(",")}`);
  const anonymous = mateFlow.accounts.find((a) => a.accountId === priv.id);
  check(
    anonymous !== undefined && anonymous.name === undefined,
    `§9 the diagram draws it unnamed, spending ${gbp(anonymous?.spendingMinor ?? 0)}`,
  );

  say(`Ledger House id ${h.id} — movement to confirm: inflow ${sweep.id} on Ledger Goals`);
}

/** §5a — two accounts with one name: the export succeeds, the import refuses. */
async function seedDupe(u: User): Promise<void> {
  heading("dupe@fp.test — §5a");
  await reset(u);

  const current = await account(u, { name: "Dupe Current", openingBalanceMinor: 200_000 });
  await salary(u, current.id, 220_000);
  const first = await account(u, { name: "Savings", openingBalanceMinor: 10_000 });
  await payment(u, first.id, {
    name: "Rainy day",
    category: "fixed_point",
    amountMinor: 50_000,
    dueDate: GOAL_DUE,
    fixedMonthlyMinor: 5_000,
    priority: 10,
  });
  await movement(u, first.id, {
    name: "Savings sweep",
    sourceAccountId: current.id,
    amountMinor: 5_000,
    priority: 10,
  });
  const second = await account(u, { name: "Savings", openingBalanceMinor: 20_000 });
  await balance(u, first.id, 10_000);
  await balance(u, second.id, 20_000);

  const names = (await u.call<Account[]>("GET", "/api/accounts")).map((a) => a.name);
  check(
    names.filter((n) => n === "Savings").length === 2,
    "§5a two accounts are both called Savings",
  );
}

/** §5b — the disposable estate: confirm, export, wipe, import. */
async function seedRoundTrip(u: User): Promise<void> {
  heading("roundtrip@fp.test — §5b");
  await reset(u);

  const current = await account(u, {
    name: "RT Current",
    description: "Wipe this whole login freely — it exists to be destroyed",
    openingBalanceMinor: 250_000,
  });
  await salary(u, current.id, 240_000);
  const goals = await account(u, { name: "RT Goals", openingBalanceMinor: 10_000 });
  await payment(u, goals.id, {
    name: "Bike",
    category: "fixed_point",
    amountMinor: 80_000,
    dueDate: GOAL_DUE,
    fixedMonthlyMinor: 8_000,
    priority: 10,
  });
  await payment(u, goals.id, {
    name: "Camera",
    category: "fixed_point",
    amountMinor: 40_000,
    dueDate: GOAL_DUE,
    fixedMonthlyMinor: 4_000,
    priority: 20,
  });
  const sweep = await movement(u, goals.id, {
    name: "RT sweep",
    sourceAccountId: current.id,
    amountMinor: 12_000,
    priority: 10,
  });
  await balance(u, current.id, 250_000);
  await balance(u, goals.id, 10_000);
  say(`movement to confirm: inflow ${sweep.id} on RT Goals (funds two goals — §4c too)`);
}

/** §10 — a genuinely new profile, which is the half that is easy to break. */
async function seedNewbie(u: User): Promise<void> {
  heading("newbie@fp.test — §10");
  await reset(u);
  const accounts = await u.call<Account[]>("GET", "/api/accounts");
  check(accounts.length === 0, "§10 the new profile owns nothing");
}

// --- run -------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`seeding TEST-PLAN.md fixtures against ${BASE}`);
  const meta = await fetch(`${BASE}/api/meta`).then((r) => r.json() as Promise<Json>);
  console.log(`  meta: ${JSON.stringify(meta)}`);

  heading("registering (throttled to 3/min — this is the slow part)");
  const users: Fixtures = {
    reality: await ensureUser("reality@fp.test", "Reality Ben"),
    flow: await ensureUser("flow@fp.test", "Flow Owner"),
    flowmate: await ensureUser("flowmate@fp.test", "Flow Partner"),
    bighouse: await ensureUser("bighouse@fp.test", "Big House"),
    currencies: await ensureUser("currencies@fp.test", "Two Currencies"),
    ledger: await ensureUser("ledger@fp.test", "Ledger Owner"),
    ledgermate: await ensureUser("ledgermate@fp.test", "Ledger Partner"),
    dupe: await ensureUser("dupe@fp.test", "Duplicate Names"),
    roundtrip: await ensureUser("roundtrip@fp.test", "Round Trip"),
    newbie: await ensureUser("newbie@fp.test", "New Profile"),
  };

  await seedReality(users.reality);
  await seedFlow(users.flow, users.flowmate);
  await seedBigHouse(users.bighouse);
  await seedCurrencies(users.currencies);
  await seedLedger(users.ledger, users.ledgermate);
  await seedDupe(users.dupe);
  await seedRoundTrip(users.roundtrip);
  await seedNewbie(users.newbie);

  heading(`done — ${stepCount} API calls, password for every login: ${PASSWORD}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed:`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exitCode = 1;
  }
}

await main();
