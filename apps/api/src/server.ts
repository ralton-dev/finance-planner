import {
  assignAccountBody,
  closeMonthBody,
  confirmTransferBody,
  createAccountBody,
  createContributionBody,
  createIncomeBody,
  createInflowBody,
  createPaymentBody,
  createProjectBody,
  type HealthResponse,
  importBody,
  planPreviewBody,
  type ReadinessResponse,
  reorderPaymentsBody,
  shareAccountBody,
  updateAccountBody,
  updateIncomeBody,
  updateInflowBody,
  updatePaymentBody,
  updateProjectBody,
  upsertBalanceBody,
} from "@finance-planner/contracts";
import {
  type Account,
  type AccountAccess,
  type Contribution,
  createStore,
  type MonthClose,
  type Project,
  type Store,
} from "@finance-planner/data";
import {
  type AccountPlan,
  clampUpcomingDays,
  type CloseContribution,
  closeForUser,
  computeScopeProjection,
  flowFromScope,
  householdPlanFromScope,
  householdProjectionFromScope,
  leftoverForUser,
  overviewFromPlans,
  toISODate,
  type Transfer,
  type TransferDeparture,
  type UserLeftover,
  type UserMonthClose,
} from "@finance-planner/domain";
import { createMailer, type Mailer } from "@finance-planner/mailer";
import { type Action, type AppAbility, buildAbility, subject } from "@finance-planner/policies";
import { verifyAccessToken } from "@finance-planner/security";
import fastifyHttpProxy from "@fastify/http-proxy";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { seedDemoData } from "./demo.js";
import { type ApiEnv, loadEnv } from "./env.js";
import { startNotifier } from "./notify.js";
import {
  accessibleAccounts,
  computeHouseholdPlanWithSchedule,
  computePlanForAccount,
  type HouseholdPlanWithSchedule,
  createPlanContext,
  type InflowSource,
  inflowSourcesFor,
  type PlanContext,
  type PlannedScope,
  plansForAccounts,
  previewPlanForAccount,
  scopeForAccount,
  scopeForHousehold,
  scopesFor,
  upcomingForUser,
} from "./plan.js";
import { buildExport, importExport } from "./portability.js";

const SERVICE = "api";
const VERSION = process.env.npm_package_version ?? "0.0.0";
const startedAt = Date.now();
/** Row cap on the upcoming feed — see the handler comment. */
const MAX_UPCOMING_ITEMS = 50;
/** Accounts one diagram may span. A Sankey stops being readable long before
 *  this, and the ordered pass behind it is not free. */
const MAX_FLOW_ACCOUNTS = 40;
/** Rank a movement takes among a sending account's outbound inflows when the
 *  caller does not say. The same 100 a payment's priority defaults to. */
const DEFAULT_INFLOW_PRIORITY = 100;

export interface ApiDeps {
  store?: Store;
  env?: ApiEnv;
  /** Forward /api/auth/* to the auth service. Disabled in unit tests. */
  registerAuthProxy?: boolean;
  /** Digest sender. Defaults to SMTP-or-log from env; injected in tests. */
  mailer?: Mailer;
}

class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function defined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Today's ISO date. The domain engine never reads the clock — the API feeds it
 *  an explicit as-of date, defaulting to today. */
const today = (): string => toISODate(new Date());

/** Months are stored as the ISO date of their first day ("2026-08" → "2026-08-01"). */
const monthToFirstDay = (month: string): string => `${month}-01`;

/** Parse an integer query param. Absent or unparseable → undefined, leaving the
 *  domain to apply its own default; the domain also clamps the range. */
const intParam = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** The "YYYY-MM" month an ISO date falls in. */
const monthOf = (date: string): string => date.slice(0, 7);

/**
 * A `?month=YYYY-MM` query param as the ISO first-of-month a confirmation is
 * keyed by; absent means the month running now.
 *
 * Validated, unlike the older read-only month params: this one reaches a write,
 * and an unparseable month would otherwise arrive at the database as a date
 * literal it cannot make sense of.
 */
const monthQuery = (month: string | undefined): string => {
  const value = month ?? monthOf(today());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new HttpError(422, "validation_error", "month must be YYYY-MM");
  }
  return monthToFirstDay(value);
};

/**
 * As-of date for closing a month: today when closing the month still running,
 * otherwise that month's last day, so a past month is scored on the plan it
 * actually had. Months that haven't started can't be closed.
 */
function closeAsOfDate(month: string): string {
  const now = today();
  const current = monthOf(now);
  if (month > current) throw new HttpError(422, "future_month", "Cannot close a future month");
  if (month === current) return now;
  const [year, mon] = month.split("-").map(Number);
  return toISODate(new Date(Date.UTC(year!, mon!, 0))); // day 0 of the next month
}

/** Per-payment money set aside during the current month. */
interface ContributionTotal {
  paymentId: string;
  amountMinor: number;
}

/** The reality half of an account's plan: what was set aside this month, what
 *  the plan has spoken for in total, and the last real balance check-in. */
interface AccountReality {
  contributionsMTD: ContributionTotal[];
  latestBalance: { asOfDate: string; balanceMinor: number } | null;
  reservedMinor: number;
}

/**
 * Read the reality that sits alongside a computed plan.
 *
 * The account page and the accounts index both come through here — the detail
 * strip reads it off GET /accounts/:id/plan, the index off the overview — so
 * the two screens cannot end up quoting different balances for one account.
 * Balance snapshots are stored one-per-day in ascending date order, so the last
 * one is the current balance.
 */
async function accountReality(
  store: Store,
  plan: AccountPlan,
  asOfDate: string,
): Promise<AccountReality> {
  const [monthContributions, balances] = await Promise.all([
    store.listContributionsForAccount(plan.accountId, monthToFirstDay(monthOf(asOfDate))),
    store.listBalanceSnapshots(plan.accountId),
  ]);

  const mtd = new Map<string, number>();
  for (const c of monthContributions) {
    mtd.set(c.paymentId, (mtd.get(c.paymentId) ?? 0) + c.amountMinor);
  }
  const latest = balances.at(-1);

  return {
    contributionsMTD: [...mtd.entries()].map(([paymentId, amountMinor]) => ({
      paymentId,
      amountMinor,
    })),
    latestBalance: latest ? { asOfDate: latest.asOfDate, balanceMinor: latest.balanceMinor } : null,
    reservedMinor: plan.lines.reduce((sum, l) => sum + l.alreadySavedMinor, 0),
  };
}

/**
 * One user's month, per currency: the rows `POST /api/me/closes` freezes.
 *
 * Everything a close needs is already derived — `closeForUser` reads a member's
 * income and obligation straight off the pass and sums the ledger — so all this
 * does is find the plan to read and the ledger rows to sum.
 *
 * **Every scope the caller can see is planned, not just the one they own.** A
 * scope closes over common ownership, so all of a user's own accounts are always
 * in one of them; a household member who owns nothing still has a share of the
 * rent, and their scope is reached through the accounts shared with them. Two
 * disjoint scopes can each hold the same person in the same currency — they
 * share no money, which is what makes summing them the right answer and not a
 * double count — and the store keys one row per (user, month, currency), so they
 * are merged here rather than written twice.
 *
 * Contributions are read per scope, from the scope's own accounts, so a row can
 * only ever be counted by the plan that knows what currency it is in.
 */
async function closesForUser(
  store: Store,
  userId: string,
  asOfDate: string,
  month: string,
): Promise<UserMonthClose[]> {
  const ctx = createPlanContext();
  const scopes = await scopesFor(store, await accessibleAccounts(store, userId), asOfDate, ctx);

  const byCurrency = new Map<string, UserMonthClose>();
  for (const scope of scopes) {
    const contributions: CloseContribution[] = (
      await Promise.all(
        scope.accountIds.map((accountId) => store.listContributionsForAccount(accountId, month)),
      )
    ).flat();
    for (const row of closeForUser(scope.plan, contributions, userId)) {
      const known = byCurrency.get(row.currency);
      if (!known) {
        byCurrency.set(row.currency, row);
        continue;
      }
      known.incomeMinor += row.incomeMinor;
      known.plannedMinor += row.plannedMinor;
      known.contributedMinor += row.contributedMinor;
    }
  }
  // The pass's own partition order, currency ascending, whichever scope each row
  // came out of.
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** What one currency bucket holds **of the caller's own** — `UserLeftover`
 *  without the currency, which the bucket it hangs off already names. */
type OwnLeftover = Omit<UserLeftover, "currency">;

/**
 * What is left over **for the caller**, per currency, across every scope they
 * appear in (decisions 19, 20 and 24).
 *
 * `closesForUser`'s shape exactly, and for the same reason: accessible accounts
 * seed the *scopes*, and then a per-user function narrows the answer to the
 * person. `leftoverForUser` was deliberately built to be used this way.
 *
 * The sum across scopes is safe and exact rather than a double count. A scope
 * closes over common ownership — `closeScope` pulls in every account an owner
 * owns — so all of a caller's accounts in one currency are in one scope with
 * them, and any second scope reaching this caller reaches them through an
 * account somebody else owns, where they own nothing to add. Two disjoint scopes
 * share no money, which is what makes adding them the right answer.
 *
 * A bucket with no row here reads zero rather than being absent: the caller can
 * see accounts in that currency and owns none of them, which is a fact worth
 * printing rather than a gap.
 */
async function leftoverForCaller(
  store: Store,
  userId: string,
  accounts: readonly Account[],
  asOfDate: string,
  ctx: PlanContext,
): Promise<Map<string, OwnLeftover>> {
  const byCurrency = new Map<string, OwnLeftover>();
  // A memo hit: the overview has already planned these scopes.
  for (const scope of await scopesFor(store, accounts, asOfDate, ctx)) {
    for (const row of leftoverForUser(scope.plan, userId)) {
      const known = byCurrency.get(row.currency);
      if (!known) {
        byCurrency.set(row.currency, {
          leftoverMinor: row.leftoverMinor,
          shortfallMinor: row.shortfallMinor,
          paymentCount: row.paymentCount,
        });
        continue;
      }
      known.leftoverMinor += row.leftoverMinor;
      known.shortfallMinor += row.shortfallMinor;
      known.paymentCount += row.paymentCount;
    }
  }
  return byCurrency;
}

/**
 * A save-up the plan funded this month with money nobody has recorded against
 * it yet — as much of the line as it takes to *act* on it: which payment, what
 * to call it, what the month asked for, and what is still missing.
 */
interface UnrecordedLine {
  paymentId: string;
  name: string;
  /** The month's target — what the row is asking for. */
  fundedMonthlyMinor: number;
  /** What is still missing — the amount the record action prefills. */
  remainderMinor: number;
}

/**
 * What the Overview's checklist would otherwise read off an account plan's line
 * list, and the reason it used to fetch a plan per account.
 *
 * Only the unrecorded lines travel. The rest of the list is the account page's
 * business and shipping it per account is the round trip this replaces; the two
 * counts alongside are the facts the fold's sentences need from lines nobody is
 * being asked to act on.
 */
interface PlanLineSummary {
  unrecorded: UnrecordedLine[];
  /** How many payment lines the plan has — "all N payments funded". */
  lineCount: number;
  /** The last line the plan still funds: what a tighter month would cut first. */
  lastFundedName: string | null;
}

/**
 * Save-up money the plan funded this month that nobody has recorded yet, line
 * by line, alongside the two counts above.
 *
 * Same test as the web checklist's `record` rule (`web/src/lib/needsYou.ts`): a
 * non-monthly line is covered once this month's contributions reach what the
 * plan funded for it, and a line still waiting on a transfer is not asked for at
 * all. Each line carries the remainder rather than the month's target, so the
 * index chip, the checklist row and its prefill are all read off this one
 * derivation and cannot disagree.
 */
function summarisePlanLines(
  plan: AccountPlan,
  contributionsMTD: readonly ContributionTotal[],
): PlanLineSummary {
  const mtd = new Map(contributionsMTD.map((c) => [c.paymentId, c.amountMinor]));
  const unrecorded: UnrecordedLine[] = [];
  let lastFundedName: string | null = null;

  for (const line of plan.lines) {
    // Lines arrive in funding order, so the last funded one is the lowest
    // priority the plan reached.
    if (line.fundedMonthlyMinor > 0) lastFundedName = line.name;
    if (line.category === "monthly_recurring" || line.fundedMonthlyMinor <= 0) continue;
    // A line the plan funds with money nobody has moved yet is not money you
    // can set aside, so asking to record it is the wrong way round: the
    // outstanding thing is the transfer, and that already has its own prompt.
    // The straddling line — part own income, part unconfirmed inflow — is
    // deferred whole rather than split, for the same reason at smaller scale.
    if (line.status === "awaiting_transfer") continue;
    const contributed = mtd.get(line.paymentId) ?? 0;
    if (contributed >= line.fundedMonthlyMinor) continue;
    unrecorded.push({
      paymentId: line.paymentId,
      name: line.name,
      fundedMonthlyMinor: line.fundedMonthlyMinor,
      remainderMinor: line.fundedMonthlyMinor - contributed,
    });
  }

  return { unrecorded, lineCount: plan.lines.length, lastFundedName };
}

/**
 * One sender's share of the money arriving into an account this month.
 *
 * Two producers, because there are two: a household member the household plan
 * asks to transfer, and another account of your own that a movement drains.
 * Discriminated rather than merged — a member has a name and no account, an
 * account has an id and no member — so a client can render each honestly
 * instead of guessing which fields are populated.
 */
type PlanInflowSource =
  | ({ kind: "member" } & InflowSource)
  | {
      kind: "account";
      /** The authored inflow, so "I moved it" has something to post to. */
      inflowId: string;
      fromAccountId: string;
      /** Only when the caller can see the sending account — see
       *  `planInflowSources`. */
      accountName?: string;
      amountMinor: number;
      confirmedMinor: number;
    };

/**
 * One derived transfer leaving an account, with the far end's name wherever the
 * caller may be told it.
 *
 * `PlanInflowSource`'s opposite number, and gated the same way for the same
 * reason: the id and the amount travel, the name is gated on `getAccess`. See
 * `withTransferDestinations`.
 */
type PlanTransferDeparture = TransferDeparture & { toAccountName?: string };

/**
 * The household plan on the wire: its own shape, plus the source account's name
 * on any transfer arriving from an account the household does not hold.
 *
 * Optional for the reason `PlanInflowSource.accountName` is — it is absent both
 * when there is nothing to say and when the caller may not be told, and a client
 * renders the same honest fallback either way. See `withTransferSources`.
 */
type PlanTransfer = Transfer & { fromAccountName?: string };

interface HouseholdPlanResponse extends Omit<HouseholdPlanWithSchedule, "transfers"> {
  transfers: PlanTransfer[];
}

/** Where an account sits in the user's households, when it sits in one. */
interface AccountPlacement {
  householdId: string | null;
  householdRole: "shared" | "personal" | null;
}

const NO_HOUSEHOLD: AccountPlacement = { householdId: null, householdRole: null };

/**
 * Which household each of the caller's accounts is planned in, and as what.
 * The index needs the role to say "shared pot" rather than guess at it, and the
 * Overview needs the household id to keep from counting an account's shortfall
 * twice — once as its own row, once inside its household's members.
 *
 * Still a loop over households, and still first-wins, although a user belongs
 * to exactly one household now (WP-W). The rule is enforced from
 * `0011_one_household_per_user.sql` forward, never retroactively — an additive
 * migration may not delete the rows of an instance that predates it — so data
 * written before then can still put somebody in two, and first-wins over a
 * stable order is what keeps the answer deterministic when it does. On
 * everything written since, the outer loop runs at most once.
 */
async function accountPlacements(
  store: Store,
  userId: string,
): Promise<Map<string, AccountPlacement>> {
  const placements = new Map<string, AccountPlacement>();
  for (const household of await store.listHouseholdsForUser(userId)) {
    for (const assignment of await store.listAccountAssignments(household.id)) {
      if (placements.has(assignment.accountId)) continue;
      placements.set(assignment.accountId, {
        householdId: household.id,
        householdRole: assignment.role,
      });
    }
  }
  return placements;
}

export function buildServer(deps: ApiDeps = {}): FastifyInstance {
  const env = deps.env ?? loadEnv();
  const handle = deps.store
    ? { store: deps.store, close: async () => {} }
    : createStore(env.databaseUrl);
  const store = handle.store;

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  app.addHook("onClose", async () => handle.close());

  // Daily digest sender. Off unless NOTIFY_ENABLED=true, so nothing is running
  // in tests or in a deployment that hasn't asked for mail.
  if (env.notifyEnabled) {
    const mailer = deps.mailer ?? createMailer(env, (msg) => app.log.info(msg));
    const stop = startNotifier(store, mailer, env, (msg) => app.log.info(msg));
    app.addHook("onClose", async () => stop());
  }

  // Single public entrypoint: forward /api/auth/* to the auth service.
  if (deps.registerAuthProxy ?? true) {
    app.register(fastifyHttpProxy, {
      upstream: env.authUrl,
      prefix: "/api/auth",
      rewritePrefix: "/auth",
    });
  }

  app.setErrorHandler((err: Error & { validation?: unknown }, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if ((err as { validation?: unknown }).validation || err.name === "ZodError") {
      return reply.code(422).send({ error: { code: "validation_error", message: err.message } });
    }
    app.log.error(err);
    return reply.code(500).send({ error: { code: "internal", message: "Internal error" } });
  });

  const authenticate = async (req: FastifyRequest): Promise<string> => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new HttpError(401, "unauthorized", "Missing bearer token");
    }
    try {
      return (await verifyAccessToken(env.jwtSecret, header.slice(7))).sub;
    } catch {
      throw new HttpError(401, "unauthorized", "Invalid token");
    }
  };

  /** Build the caller's per-request ability from their effective access. */
  const abilityFor = async (userId: string): Promise<AppAbility> => {
    const accountAccess = await store.listAccessibleAccounts(userId);
    return buildAbility({
      userId,
      accountAccess: accountAccess.map((a) => ({
        id: a.accountId,
        isOwner: a.owner,
        permission: a.permission,
      })),
      // The api gateway doesn't authorize household actions; those endpoints
      // proxy to the auth service which builds its own ability.
      households: [],
    });
  };

  /**
   * Resolve access to an account at a specific action level. The policy
   * package handles the 404-vs-403 leak rule: no access at all → 404, has
   * access but insufficient → 403. Mirrors the prior requireAccess contract
   * so call sites don't need to change.
   */
  const requireAccess = async (
    userId: string,
    accountId: string,
    action: Action,
  ): Promise<{ account: Account; access: AccountAccess; ability: AppAbility }> => {
    const ability = await abilityFor(userId);
    const ref = subject("Account", { id: accountId });
    if (!ability.hasAnyAccess(ref)) {
      throw new HttpError(404, "not_found", "Account not found");
    }
    if (!ability.can(action, ref)) {
      throw new HttpError(403, "forbidden", `${action} access required`);
    }
    const [account, access] = await Promise.all([
      store.getAccount(accountId),
      store.getAccess(userId, accountId),
    ]);
    if (!account || !access) throw new HttpError(404, "not_found", "Account not found");
    return { account, access, ability };
  };

  /**
   * The project a payment is being filed under, or a 422 naming the id.
   *
   * A project is a grouping of *your* payments, so the id in a payment body has
   * to be a project you may edit. Until this existed, `projectId` went from the
   * body to the store, which enforced existence and nothing else — so a payment
   * on your own account could be filed into a stranger's project, and the
   * detail route below would then print your account's name on their screen.
   * The two holes composed; this closes the first.
   *
   * 422 rather than 404, because the failure is in the body rather than in the
   * URL: the account named by the route is yours and the request is well
   * formed, and one field in it names something that is not. The message
   * carries the **id the caller supplied** and never the project's name —
   * echoing that back would hand over exactly what the gate protects.
   *
   * Returns the project so a caller that needs more of it than its existence
   * does not fetch it twice. Nothing needs that yet; decision 23's shared-side
   * constraint (WP-AH) will.
   */
  const requireProjectForPayment = async (userId: string, projectId: string): Promise<Project> => {
    const project = await store.getProject(projectId);
    const ability = await abilityFor(userId);
    if (!project || ability.cannot("edit", subject("Project", project))) {
      throw new HttpError(422, "unknown_project", `No project ${projectId}`);
    }
    return project;
  };

  const accountIdOf = async (kind: "income" | "payment", id: string): Promise<string> => {
    const entity = kind === "income" ? await store.getIncome(id) : await store.getPayment(id);
    if (!entity) throw new HttpError(404, "not_found", `${kind} not found`);
    return entity.accountId;
  };

  /**
   * Gate a household action on membership. No membership → 404 (existence leak
   * prevention, mirroring the auth service). When `roles` is given, the caller
   * must hold one of them (managing the plan roster is owner/admin only).
   */
  const requireMembership = async (
    userId: string,
    householdId: string,
    roles?: readonly ("owner" | "admin" | "member")[],
  ): Promise<void> => {
    const membership = await store.getMembership(householdId, userId);
    if (!membership) throw new HttpError(404, "not_found", "Household not found");
    if (roles && !roles.includes(membership.role)) {
      throw new HttpError(403, "forbidden", "Household admin access required");
    }
  };

  /**
   * Where the money arriving into an account is coming from, as much of it as
   * this caller may be told.
   *
   * The gate is on **names**, and only on names. A household's allocation names
   * members, and an account can be shared with someone outside the household
   * that funds it, so the member rows are attached only for a caller who can
   * see the household — exactly as strict as it has always been. The sending
   * account's *name* is gated the same way, on being able to see that account.
   *
   * Everything else travels. `plan.inflowArrivals` already itemises what each
   * movement delivered, by account id, with no name in it, and it rides on this
   * very response — so withholding the arrivals here would hide nothing while
   * leaving a standalone estate unable to say which of its own accounts fed
   * this one. Household membership was never what made that safe to answer.
   */
  const planInflowSources = async (
    userId: string,
    account: Account,
    plan: AccountPlan,
    scope: PlannedScope,
  ): Promise<PlanInflowSource[] | null> => {
    const sources: PlanInflowSource[] = [];

    // Read off the pass that produced `plan`, so there is nothing to recompute.
    // The gate is unchanged: a household's transfers name its members, and an
    // account can be shared with someone outside the household funding it, so
    // the member rows travel only for a caller who can see the household. A
    // scope with no household in it derives transfers too (decision 9) and they
    // are the caller's own to see — nobody else's name is in them.
    const householdId = scope.householdOf.get(account.id) ?? null;
    const canNameMembers = householdId
      ? (await store.getMembership(householdId, userId)) !== null
      : false;
    for (const source of inflowSourcesFor(scope, account.id, account.currency)) {
      if (!canNameMembers && source.memberUserId !== userId) continue;
      sources.push({ kind: "member", ...source });
    }

    for (const arrival of plan.inflowArrivals) {
      const sender = (await store.getAccess(userId, arrival.fromAccountId))
        ? await store.getAccount(arrival.fromAccountId)
        : null;
      sources.push({
        kind: "account",
        inflowId: arrival.inflowId,
        fromAccountId: arrival.fromAccountId,
        ...(sender ? { accountName: sender.name } : {}),
        amountMinor: arrival.amountMinor,
        confirmedMinor: arrival.confirmedMinor ?? 0,
      });
    }

    // Null rather than an empty array keeps the old contract: nothing arriving
    // that you may be told about reads the same as nothing arriving.
    return sources.length > 0 ? sources : null;
  };

  /**
   * The derived transfers leaving this account, carrying each destination's name
   * wherever this caller is allowed it.
   *
   * The plan publishes them itemised (`AccountPlan.transferDepartures`) because
   * `transferOutMinor` alone could not say where the money goes: the account page
   * drew one synthetic row for the lot and had to label a far end that was a set
   * of accounts. Names are the only thing gated, and by the mechanism WP-J
   * established and `339afcc` reused for transfer *sources* rather than a third
   * one: `getAccess` decides, the ids and the amounts travel regardless.
   *
   * The destinations are the caller's own accounts or their household's, so in
   * practice the name is nearly always theirs to see — but "nearly always" is
   * not a rule. An expense pot shared into the caller's scope by someone who has
   * since un-shared it, or a household pot the caller can reach through
   * membership and not through the account, both land here; the client renders
   * the same honest absence for either, exactly as it does for a sender it
   * cannot see.
   */
  const withTransferDestinations = async (
    userId: string,
    departures: readonly TransferDeparture[],
  ): Promise<PlanTransferDeparture[]> => {
    /** id → name, or null for "not this caller's to see". Memoised because one
     *  destination can take a transfer from each member, not one row. */
    const seen = new Map<string, string | null>();
    const named: PlanTransferDeparture[] = [];
    for (const d of departures) {
      if (!seen.has(d.toAccountId)) {
        const destination = (await store.getAccess(userId, d.toAccountId))
          ? await store.getAccount(d.toAccountId)
          : null;
        seen.set(d.toAccountId, destination?.name ?? null);
      }
      const name = seen.get(d.toAccountId);
      named.push(name == null ? { ...d } : { ...d, toAccountName: name });
    }
    return named;
  };

  /**
   * The household's transfers, carrying the source account's name wherever this
   * caller is allowed it.
   *
   * A transfer belongs to the household its money **arrives** in (WP-X), so once
   * `f3acef8` put a member's private accounts in the same scope, a private
   * account funding the shared pot became a household transfer with a source the
   * household does not hold. `householdPlanFromScope` reports only the roster's
   * accounts — rightly — so the name was dropped at this boundary although the
   * scope knew it, and the checklist fell through to a bare lowercase "account",
   * which reads like a lookup that broke.
   *
   * Gated exactly as `planInflowSources` gates a sender's name, and by the same
   * mechanism rather than a second one: the id travels, the name is gated on
   * `getAccess`. The person who has to move this money is the account's owner,
   * and an owner can always see their own account's name — so the owner reads
   * "Ben · Side account → Shared pot" and a co-member reads "Ben · other
   * account". Amounts are never gated and none is gated here.
   *
   * Only sources off the roster are looked up: an account the household holds is
   * already named in `plan.accounts`, for every member, and paying for a store
   * round trip to say so again would be a second answer to a settled question.
   */
  const withTransferSources = async (
    userId: string,
    plan: HouseholdPlanWithSchedule,
  ): Promise<HouseholdPlanResponse> => {
    const onRoster = new Set(plan.accounts.map((a) => a.accountId));
    /** id → name, or null for "not this caller's to see". Memoised because one
     *  source account funds one destination per member, not one row. */
    const seen = new Map<string, string | null>();
    const transfers: PlanTransfer[] = [];
    for (const t of plan.transfers) {
      if (onRoster.has(t.fromAccountId)) {
        transfers.push(t);
        continue;
      }
      if (!seen.has(t.fromAccountId)) {
        const source = (await store.getAccess(userId, t.fromAccountId))
          ? await store.getAccount(t.fromAccountId)
          : null;
        seen.set(t.fromAccountId, source?.name ?? null);
      }
      const name = seen.get(t.fromAccountId);
      transfers.push(name == null ? t : { ...t, fromAccountName: name });
    }
    return { ...plan, transfers };
  };

  // ---- health ----
  app.get(
    "/healthz",
    async (): Promise<HealthResponse> => ({
      status: "ok",
      service: SERVICE,
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );
  app.get("/readyz", async (): Promise<ReadinessResponse> => ({ ready: true, checks: {} }));

  /** What the SPA needs before anyone has signed in: which optional features
   *  this deployment has turned on. Public, and deliberately tiny. */
  app.get("/api/meta", async () => ({ demoSeedEnabled: env.enableDemoSeed }));

  // ---- accounts ----
  app.get("/api/accounts", async (req) => {
    const userId = await authenticate(req);
    const access = await store.listAccessibleAccounts(userId);
    const accounts = await Promise.all(access.map((a) => store.getAccount(a.accountId)));
    return accounts
      .filter((a): a is Account => a !== null)
      .map((a) => ({
        ...a,
        permission: access.find((x) => x.accountId === a.id)?.permission,
        owner: access.find((x) => x.accountId === a.id)?.owner,
      }));
  });

  app.post("/api/accounts", async (req, reply) => {
    const userId = await authenticate(req);
    const body = createAccountBody.parse(req.body);
    const account = await store.createAccount({ ownerUserId: userId, ...body });
    return reply.code(201).send(account);
  });

  app.get("/api/accounts/:id", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { account, access } = await requireAccess(userId, id, "view");
    return { ...account, owner: access.owner, permission: access.permission };
  });

  /**
   * Change what an account is called, what it opened with, what it holds back.
   *
   * **Not what it is denominated in** — see `updateAccountBody`. The attempt is
   * rejected rather than silently dropped, the same answer re-pointing an
   * inflow's ends gets: an account that redenominated itself crossed a currency
   * partition after the POST-time guard that refuses to author a movement across
   * one, and a caller who believes they have converted their money must be told
   * they have not. Sending back the currency the account already has is not an
   * attempt to change it and passes through untouched.
   */
  app.patch("/api/accounts/:id", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { account, access } = await requireAccess(userId, id, "edit");
    if (req.body && typeof req.body === "object" && "currency" in req.body) {
      const asked = (req.body as { currency: unknown }).currency;
      if (String(asked).toUpperCase() !== account.currency) {
        throw new HttpError(
          422,
          "validation_error",
          "currency cannot be changed; an account is denominated once, when it is created",
        );
      }
    }
    const body = updateAccountBody.parse(req.body);
    const updated = await store.updateAccount(id, defined(body));
    if (!updated) return null;
    return { ...updated, owner: access.owner, permission: access.permission };
  });

  app.delete("/api/accounts/:id", async (req, reply) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireAccess(userId, id, "delete");
    await store.deleteAccount(id);
    return reply.code(204).send();
  });

  /**
   * The account's plan, plus the reality alongside it: what was contributed
   * this month, what is reserved in total, and the last real balance check-in.
   * Bundled onto the plan so the UI can show plan-vs-reality in one round trip.
   *
   * `allocatedInflowMinor` / `confirmedInflowMinor` come off the plan itself and
   * are always present — what is arriving is a fact about an account the caller
   * can already see. `inflowSources` says where it is coming from; see
   * `planInflowSources` for what is gated and why. Null means nothing is
   * arriving that this caller may be told about.
   */
  app.get("/api/accounts/:id/plan", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { asOf } = req.query as { asOf?: string };
    const { account } = await requireAccess(userId, id, "view");
    const asOfDate = asOf ?? today();
    const ctx = createPlanContext();
    const scope = await scopeForAccount(store, account, asOfDate, ctx);
    const plan = await computePlanForAccount(store, account, asOfDate, ctx);
    return {
      ...plan,
      // The one field on the plan that gets enriched rather than passed through:
      // the same list, with the destinations this caller may be told named. See
      // `withTransferDestinations`.
      transferDepartures: await withTransferDestinations(userId, plan.transferDepartures),
      ...(await accountReality(store, plan, asOfDate)),
      inflowSources: await planInflowSources(userId, account, plan, scope),
    };
  });

  /**
   * What-if: the account's plan as it stands, and as it would stand with some
   * hypothetical payments/incomes added. Nothing is written — the overlay is
   * built into the engine input, given synthetic ids, and thrown away with the
   * request.
   *
   * "view" access is enough, and it is a POST only because the overlay is a
   * body: the response reveals nothing GET /plan doesn't already, and the
   * hypothetical is the caller's own.
   *
   * A household equivalent is deliberately not built this round. A household
   * overlay would have to say which account each hypothetical payment lands in
   * and who bears it, then re-derive the transfers — a design question of its
   * own rather than a second call site for this one.
   */
  app.post("/api/accounts/:id/plan/preview", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { asOf } = req.query as { asOf?: string };
    const { account } = await requireAccess(userId, id, "view");
    const body = planPreviewBody.parse(req.body);
    return previewPlanForAccount(store, account, asOf ?? today(), body);
  });

  /**
   * Month-by-month simulation of the account's plan, so the UI can show where
   * the money lands rather than just this month's slice. The balance trajectory
   * starts from the latest real balance check-in; with no check-in there is no
   * honest opening figure, so every month reports a null balance.
   *
   * Simulated as part of its scope, not on its own. What arrives in month seven
   * is another account's month-seven surplus — after month-seven's bills, out of
   * month-seven's income, and after whatever its owner's other obligations claim
   * — and one account's input contains none of that. So the whole scope is
   * walked forward, one funding pass per simulated month, and this account's
   * slice is read back out.
   *
   * Accounts the caller cannot see are in the scope and never leave it — the
   * same rule the plan endpoint follows, for the same reason.
   */
  app.get("/api/accounts/:id/projection", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { asOf, months } = req.query as { asOf?: string; months?: string };
    const { account } = await requireAccess(userId, id, "view");
    const asOfDate = asOf ?? today();
    const [scope, balances] = await Promise.all([
      scopeForAccount(store, account, asOfDate),
      store.listBalanceSnapshots(id),
    ]);
    const latest = balances.at(-1);
    const walk = computeScopeProjection(scope.input, asOfDate, {
      months: intParam(months),
      // Only this account's opening balance is known here, and only this
      // account's months are returned; the others' balances are irrelevant to
      // what they can afford to send, which is an income-and-bills question.
      startingBalancesMinor: { [id]: latest?.balanceMinor ?? null },
    });
    // Always present: the account is in its own scope.
    return walk.accounts.find((a) => a.accountId === id)!;
  });

  // ---- contributions (the money-set-aside ledger) ----
  /**
   * Record money set aside toward a payment. The plan derives each payment's
   * already-saved from its manual base plus these, so recording a contribution
   * moves the plan without editing the payment.
   */
  app.post("/api/payments/:paymentId/contributions", async (req, reply) => {
    const userId = await authenticate(req);
    const { paymentId } = req.params as { paymentId: string };
    const accountId = await accountIdOf("payment", paymentId);
    await requireAccess(userId, accountId, "edit");
    const body = createContributionBody.parse(req.body);
    const contribution = await store.createContribution({
      paymentId,
      accountId,
      userId,
      month: monthToFirstDay(body.month ?? monthOf(today())),
      amountMinor: body.amountMinor,
      note: body.note ?? null,
      transferConfirmationId: null,
    });
    return reply.code(201).send(contribution);
  });

  app.get("/api/accounts/:id/contributions", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { month } = req.query as { month?: string };
    await requireAccess(userId, id, "view");
    return store.listContributionsForAccount(id, month ? monthToFirstDay(month) : undefined);
  });

  app.delete("/api/contributions/:contributionId", async (req, reply) => {
    const userId = await authenticate(req);
    const { contributionId } = req.params as { contributionId: string };
    const contribution = await store.getContribution(contributionId);
    if (!contribution) throw new HttpError(404, "not_found", "Contribution not found");
    await requireAccess(userId, contribution.accountId, "edit");
    await store.deleteContribution(contributionId);
    return reply.code(204).send();
  });

  // ---- balance check-ins ----
  /** Anchor the plan to real money. One snapshot per account per day; restating
   *  a day overwrites it. */
  app.put("/api/accounts/:id/balance", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireAccess(userId, id, "edit");
    const body = upsertBalanceBody.parse(req.body);
    return store.upsertBalanceSnapshot({
      accountId: id,
      asOfDate: body.asOfDate ?? today(),
      balanceMinor: body.balanceMinor,
    });
  });

  app.get("/api/accounts/:id/balances", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireAccess(userId, id, "view");
    return store.listBalanceSnapshots(id);
  });

  // ---- my month closes ----
  /**
   * Freeze **my** month: what I earned, what my plan asked of me, and what I
   * actually set aside — one row per currency I plan in.
   *
   * A scorecard is a fact about a person, not a place (`MONTH-CLOSE.md`
   * decision 14). Asked of an account, "what did you earn?" had to be redefined
   * as "what arrived here", so a household holding a fed bills pot froze £0 of
   * income against a contributed figure made entirely of transfers; asked of a
   * household, the same field meant own income alone, and the two producers of
   * the one row could not both be right. Asked of a person, it needs no
   * redefinition — and it partitions by currency, because planning does, and a
   * household denominated in its first assigned account's currency could not see
   * a second one at all.
   *
   * Nothing here is computed. `closeForUser` reads the figures off the pass the
   * planning endpoints already read, and the only sum is over the contributions
   * ledger — freeze the view, never invent a second computation.
   *
   * **All partitions or none.** The month is the unit of the action, so an
   * existing row for it in *any* currency is `409 already_closed`, and a write
   * that fails part-way takes the rows it already made with it.
   */
  app.post("/api/me/closes", async (req, reply) => {
    const userId = await authenticate(req);
    const body = closeMonthBody.parse(req.body);
    const asOfDate = closeAsOfDate(body.month);
    const month = monthToFirstDay(body.month);
    // Named without a currency, this asks about the month rather than about one
    // partition of it — which is the question, since closing takes them all.
    if (await store.getMonthClose({ userId }, month)) {
      throw new HttpError(409, "already_closed", "Month already closed");
    }

    const rows = await closesForUser(store, userId, asOfDate, month);
    const written: MonthClose[] = [];
    try {
      for (const row of rows) {
        written.push(
          await store.createMonthClose({
            householdId: null,
            accountId: null,
            userId,
            currency: row.currency,
            month,
            incomeMinor: row.incomeMinor,
            plannedMinor: row.plannedMinor,
            contributedMinor: row.contributedMinor,
            closedBy: userId,
          }),
        );
      }
    } catch (err) {
      // Half a scorecard is worse than none: it would read as a closed month
      // missing a currency, and the 409 above would then refuse to complete it.
      // Two callers racing is how this happens — the second loses its partner's
      // uniqueness check — so the loser puts the estate back as it found it.
      for (const close of written) await store.deleteMonthClose(close.id);
      throw err;
    }
    return reply.code(201).send(written);
  });

  /** My frozen months, newest first. Mine only: a scorecard names what somebody
   *  earned, and nobody else's rows are ever in scope here. */
  app.get("/api/me/closes", async (req) => {
    const userId = await authenticate(req);
    return store.listMonthCloses({ userId });
  });

  /**
   * Re-open one frozen row.
   *
   * By id, and only a row whose `userId` is the caller's — someone else's close
   * answers 404 rather than 403, the existence-leak rule this file applies
   * everywhere. Re-opening is per row where closing is per month, so a month
   * left half-open cannot be closed again until its remaining rows go too; the
   * scorecard offers a re-open beside each card, which is where that shows up.
   */
  app.delete("/api/me/closes/:closeId", async (req, reply) => {
    const userId = await authenticate(req);
    const { closeId } = req.params as { closeId: string };
    const close = await store.getMonthCloseById(closeId);
    if (!close || close.userId !== userId) {
      throw new HttpError(404, "not_found", "Month close not found");
    }
    await store.deleteMonthClose(closeId);
    return reply.code(204).send();
  });

  // ---- incomes ----
  app.get("/api/accounts/:id/incomes", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireAccess(userId, id, "view");
    return store.listIncomes(id);
  });

  app.post("/api/accounts/:id/incomes", async (req, reply) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireAccess(userId, id, "edit");
    const body = createIncomeBody.parse(req.body);
    const income = await store.createIncome({
      accountId: id,
      name: body.name,
      amountMinor: body.amountMinor,
      frequency: body.frequency,
      recurrence: body.recurrence ?? null,
      anchorDate: body.anchorDate,
      active: body.active,
    });
    return reply.code(201).send(income);
  });

  app.patch("/api/incomes/:incomeId", async (req) => {
    const userId = await authenticate(req);
    const { incomeId } = req.params as { incomeId: string };
    const sourceAccountId = await accountIdOf("income", incomeId);
    await requireAccess(userId, sourceAccountId, "edit");
    const body = updateIncomeBody.parse(req.body);
    // Moving to another account requires edit access to the destination too.
    if (body.accountId && body.accountId !== sourceAccountId) {
      await requireAccess(userId, body.accountId, "edit");
    }
    return store.updateIncome(incomeId, defined(body));
  });

  app.delete("/api/incomes/:incomeId", async (req, reply) => {
    const userId = await authenticate(req);
    const { incomeId } = req.params as { incomeId: string };
    await requireAccess(userId, await accountIdOf("income", incomeId), "edit");
    await store.deleteIncome(incomeId);
    return reply.code(204).send();
  });

  // ---- inflows (money arriving, whatever its source) ----
  /**
   * Everything arriving into this account: money from outside the estate and
   * movements out of other accounts alike. `/incomes` above is the external
   * half of these very rows — one table, two doors, and the income door
   * deliberately cannot see a movement.
   */
  app.get("/api/accounts/:id/inflows", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireAccess(userId, id, "view");
    return store.listInflows(id);
  });

  /**
   * The other face of the same rows: movements *leaving* this account. What its
   * surplus is already committed to, which is a question only the sending end
   * can ask and which nothing else answers.
   */
  app.get("/api/accounts/:id/inflows/outbound", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireAccess(userId, id, "view");
    return store.listOutboundInflows(id);
  });

  /**
   * Author an inflow on the account the money arrives in.
   *
   * **An account-sourced inflow needs `edit` on both ends, not `edit` here and
   * `view` there.** Creating one commits the *sending* account's surplus: from
   * this call onward that account's plan funds the movement after its own bills
   * and the money leaves, every month, whether or not its owner ever looks. A
   * `view` grant says "you may see my money"; it must not silently also mean
   * "you may spend it", or an account shared read-only into a household becomes
   * a funding source for any member's private pot. Confirming a movement takes
   * only `view` on the sender (see the confirm route) because it records a fact
   * about money already planned to move — it commits nothing.
   *
   * A source account the caller cannot see at all answers 404 for the *account*,
   * the same answer a source account that does not exist gets, so this cannot
   * be used to probe for accounts. A self-reference is refused here as well as
   * by the store's CHECK: the API should not need the database to tell it that
   * an account cannot fund itself.
   *
   * **A movement between two currencies is refused**, because there is no rate
   * anywhere in this system to convert it with. Nothing would be wrong at the
   * two ends — each account would report an honest figure in its own money —
   * but the pass plans per currency (decision 10) and would see the money leave
   * one partition without arriving in any, so the identity
   * `totalFundedMinor + leftoverMinor === monthlyIncomeMinor - bufferMinor`
   * would break in **both**. Refusing is the only answer that stays true;
   * converting would mean inventing a rate.
   *
   * Nothing is refused for closing a funding loop. A cycle is a property of the
   * estate rather than of the edge that completes it, so it is detected by the
   * ordered pass and reported on every plan involved as
   * `fundingCycleAccountIds` — see `computeScopePlan`. Authoring stays
   * permissive; the plan is where the loop is named.
   */
  app.post("/api/accounts/:id/inflows", async (req, reply) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { account } = await requireAccess(userId, id, "edit");
    const body = createInflowBody.parse(req.body);
    const sourceAccountId = body.sourceAccountId ?? null;
    if (sourceAccountId === id) {
      throw new HttpError(
        422,
        "validation_error",
        "An inflow cannot be sourced from the account it arrives in",
      );
    }
    if (sourceAccountId) {
      const { account: source } = await requireAccess(userId, sourceAccountId, "edit");
      if (source.currency !== account.currency) {
        throw new HttpError(
          422,
          "validation_error",
          `A movement cannot cross currencies: ${source.currency} to ${account.currency}`,
        );
      }
    }
    const inflow = await store.createInflow({
      accountId: id,
      name: body.name,
      source: body.source,
      sourceAccountId,
      amountMinor: body.amountMinor,
      frequency: body.frequency,
      recurrence: body.recurrence ?? null,
      anchorDate: body.anchorDate,
      priority: body.priority ?? DEFAULT_INFLOW_PRIORITY,
      active: body.active,
    });
    return reply.code(201).send(inflow);
  });

  /**
   * Change what an inflow asks for. Same rule as authoring it, and for the same
   * reason: raising a movement's amount commits more of the sending account's
   * surplus, so it takes `edit` at both ends.
   *
   * Which two accounts a movement runs between is not editable — see
   * `updateInflowBody`. The attempt is rejected rather than silently dropped.
   */
  app.patch("/api/inflows/:inflowId", async (req) => {
    const userId = await authenticate(req);
    const { inflowId } = req.params as { inflowId: string };
    const inflow = await store.getInflow(inflowId);
    if (!inflow) throw new HttpError(404, "not_found", "Inflow not found");
    await requireAccess(userId, inflow.accountId, "edit");
    if (inflow.sourceAccountId) await requireAccess(userId, inflow.sourceAccountId, "edit");
    for (const key of ["accountId", "source", "sourceAccountId"]) {
      if (req.body && typeof req.body === "object" && key in req.body) {
        throw new HttpError(
          422,
          "validation_error",
          `${key} cannot be changed; delete the inflow and author it again`,
        );
      }
    }
    const body = updateInflowBody.parse(req.body);
    if (body.priority !== undefined && inflow.source !== "account") {
      throw new HttpError(
        422,
        "validation_error",
        "priority is meaningful only for an account-sourced inflow",
      );
    }
    return store.updateInflow(inflowId, defined(body));
  });

  /**
   * Call a movement off. **Either end may, with `edit` on that end.**
   *
   * Deliberately looser than authoring, because it is the opposite act:
   * creating a movement lays a claim on the sending account's money, deleting
   * one releases it, and releasing a claim can harm neither account. The
   * asymmetry also closes a trap — an account shared with edit, used to author
   * a movement out of it, and then un-shared would otherwise leave its owner
   * with money draining every month and no way to stop it.
   */
  app.delete("/api/inflows/:inflowId", async (req, reply) => {
    const userId = await authenticate(req);
    const { inflowId } = req.params as { inflowId: string };
    const inflow = await store.getInflow(inflowId);
    if (!inflow) throw new HttpError(404, "not_found", "Inflow not found");
    const ability = await abilityFor(userId);
    const ends = [inflow.accountId, ...(inflow.sourceAccountId ? [inflow.sourceAccountId] : [])];
    const refs = ends.map((accountId) => subject("Account", { id: accountId }));
    // The policy package's 404-vs-403 rule, applied to a record with two
    // owners: no access to either end and it does not exist as far as you are
    // concerned; access to an end you cannot edit and you are simply refused.
    if (!refs.some((ref) => ability.hasAnyAccess(ref))) {
      throw new HttpError(404, "not_found", "Inflow not found");
    }
    if (!refs.some((ref) => ability.can("edit", ref))) {
      throw new HttpError(403, "forbidden", "edit access required");
    }
    await store.deleteInflow(inflowId);
    return reply.code(204).send();
  });

  // ---- payments ----
  app.get("/api/accounts/:id/payments", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireAccess(userId, id, "view");
    return store.listPayments(id);
  });

  app.post("/api/accounts/:id/payments", async (req, reply) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireAccess(userId, id, "edit");
    const body = createPaymentBody.parse(req.body);
    if (body.projectId) await requireProjectForPayment(userId, body.projectId);
    const payment = await store.createPayment({
      accountId: id,
      name: body.name,
      category: body.category,
      amountMinor: body.amountMinor,
      dueDate: body.dueDate ?? null,
      recurrence: body.recurrence ?? null,
      targetDate: body.targetDate ?? null,
      priority: body.priority,
      alreadySavedMinor: body.alreadySavedMinor,
      autoRenew: body.autoRenew,
      active: body.active,
      notes: body.notes ?? null,
      projectId: body.projectId ?? null,
      scope: body.scope,
      bearerUserId: body.bearerUserId ?? null,
      fixedMonthlyMinor: body.fixedMonthlyMinor ?? null,
      tag: body.tag ?? null,
    });
    return reply.code(201).send(payment);
  });

  app.patch("/api/payments/:paymentId", async (req) => {
    const userId = await authenticate(req);
    const { paymentId } = req.params as { paymentId: string };
    const sourceAccountId = await accountIdOf("payment", paymentId);
    await requireAccess(userId, sourceAccountId, "edit");
    const body = updatePaymentBody.parse(req.body);
    // Moving to another account requires edit access to the destination too.
    if (body.accountId && body.accountId !== sourceAccountId) {
      await requireAccess(userId, body.accountId, "edit");
    }
    // Filing it into a project requires that project to be yours, the same as
    // on create — a gate on the create route alone is a gate one PATCH wide.
    // `null` is unfiling, which needs no permission on the project it leaves:
    // the payment is the caller's either way, and letting go of a link cannot
    // reach anything.
    if (body.projectId) await requireProjectForPayment(userId, body.projectId);
    return store.updatePayment(paymentId, defined(body));
  });

  app.delete("/api/payments/:paymentId", async (req, reply) => {
    const userId = await authenticate(req);
    const { paymentId } = req.params as { paymentId: string };
    await requireAccess(userId, await accountIdOf("payment", paymentId), "edit");
    await store.deletePayment(paymentId);
    return reply.code(204).send();
  });

  app.patch("/api/accounts/:id/payments/reorder", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireAccess(userId, id, "edit");
    const body = reorderPaymentsBody.parse(req.body);
    await store.reorderPayments(id, body.orderedPaymentIds);
    return store.listPayments(id);
  });

  // ---- sharing ----
  app.post("/api/accounts/:id/shares", async (req, reply) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireAccess(userId, id, "share");
    const body = shareAccountBody.parse(req.body);
    const membership = await store.getMembership(body.householdId, userId);
    if (!membership) throw new HttpError(403, "forbidden", "Not a member of that household");
    const share = await store.createAccountShare(id, body.householdId, body.permission);
    return reply.code(201).send(share);
  });

  app.delete("/api/accounts/:id/shares/:shareId", async (req, reply) => {
    const userId = await authenticate(req);
    const { id, shareId } = req.params as { id: string; shareId: string };
    await requireAccess(userId, id, "share");
    await store.deleteAccountShare(shareId);
    return reply.code(204).send();
  });

  // ---- overview ----
  /**
   * Every accessible account, aggregated per currency — and, per account, the
   * state the accounts index leads with: where it is planned, what it actually
   * holds, and what is waiting on a human. The aggregation itself stays in the
   * engine; everything added here is read off the same plan and the same
   * reality the account page reads, so no screen can disagree with another.
   *
   * That includes `planSummary`: the handler has every account's plan in hand,
   * so the Overview's checklist gets the lines it must act on from here rather
   * than paying a plan request per row for work already done in this loop.
   *
   * **One pass per scope, not one per account.** Planning each account in turn
   * ran a separate pass over that account's own closure, so the rollup was
   * assembled from plans no two of which had been computed together. Now every
   * account the caller can see is seeded, and the accounts that share a scope
   * are planned together. A scope reaches further than the caller can — it must,
   * since money can arrive from an account they cannot see — so only the seeded
   * accounts' plans are read back out of it, which is where the access filter
   * lives, and the rollup is a plain sum over them (see `overviewFromPlans` for
   * why there is no longer anything to net).
   */
  app.get("/api/overview", async (req) => {
    const userId = await authenticate(req);
    const { asOf } = req.query as { asOf?: string };
    const asOfDate = asOf ?? today();
    const [accounts, placements] = await Promise.all([
      accessibleAccounts(store, userId),
      accountPlacements(store, userId),
    ]);

    const plans: AccountPlan[] = [];
    const state = new Map<string, Record<string, unknown>>();
    // One memo for the whole handler. Planning an account in a household means
    // planning the household, and every account of a one-household estate would
    // otherwise ask for the identical plan in turn.
    const ctx = createPlanContext();
    const planById = await plansForAccounts(store, accounts, asOfDate, ctx);
    for (const account of accounts) {
      // Always present: every account seeded into a scope is planned by it.
      const plan = planById.get(account.id)!;
      const reality = await accountReality(store, plan, asOfDate);
      const planSummary = summarisePlanLines(plan, reality.contributionsMTD);
      // The scope is already planned and memoised in `ctx` — this is a map
      // lookup, not a second pass.
      const scope = await scopeForAccount(store, account, asOfDate, ctx);
      const inflowSources = await planInflowSources(userId, account, plan, scope);
      plans.push(plan);
      state.set(account.id, {
        name: account.name,
        ...(placements.get(account.id) ?? NO_HOUSEHOLD),
        monthlyIncomeMinor: plan.monthlyIncomeMinor,
        // Amounts only — the index never names who is sending it, so this needs
        // no household gate. Own income stays own income (decision #3).
        allocatedInflowMinor: plan.allocatedInflowMinor,
        confirmedInflowMinor: plan.confirmedInflowMinor,
        // The same amounts, itemised by the authored inflow that delivered
        // them. Sent for the same reason `planSummary` is: a checklist row has
        // to name the movement to confirm against it, and without this the
        // Overview paid a whole account plan per account with money in transit
        // for the ids alone. Still no name in it — `planInflowSources` gates
        // names and nothing else, and these ids ride ungated on the account
        // plan already. Omitted rather than sent empty on the ordinary account
        // nothing moves into.
        ...(plan.inflowArrivals.length > 0 ? { inflowArrivals: plan.inflowArrivals } : {}),
        // Who is sending it, as much of it as this caller may be told — the same
        // `planInflowSources` the account plan sends, applying the same gate.
        //
        // The index used to carry ids and amounts and no name, and the browser
        // named the senders it could see off the account list it already held.
        // That worked for an authored movement, which the arrivals itemise, and
        // could not work at all for a transfer the pass **derived**: nobody
        // authored one, so there is no arrival to itemise, and the checklist's
        // derived-transfer row was drawn from member sources the Overview never
        // sent. It was therefore never drawn — which is why the confirmation
        // endpoint had no reachable client (ONE-ENGINE.md, WP-V).
        ...(inflowSources ? { inflowSources } : {}),
        latestBalanceMinor: reality.latestBalance?.balanceMinor ?? null,
        latestBalanceDate: reality.latestBalance?.asOfDate ?? null,
        reservedMinor: reality.reservedMinor,
        planSummary,
        // The index's chip, off the very lines the checklist will draw rows for.
        unrecordedCount: planSummary.unrecorded.length,
        unrecordedTotalMinor: planSummary.unrecorded.reduce((n, l) => n + l.remainderMinor, 0),
      });
    }

    const overview = overviewFromPlans(plans, asOfDate);
    const yours = await leftoverForCaller(store, userId, accounts, asOfDate, ctx);
    return {
      ...overview,
      perCurrency: overview.perCurrency.map((c) => ({
        ...c,
        // **The caller's own money** (decisions 19, 20, 24), computed by the
        // pass rather than assembled in the browser.
        //
        // Everything else in this bucket is summed over every account the
        // caller can **see**, which is the right set for a list of accounts and
        // the wrong one for a figure about a person: on a household of two, the
        // dashboard's headline was a co-member's money as much as the reader's.
        // Those totals keep their meanings on the wire to the penny and simply
        // stop being what any screen reads.
        //
        // The shortfall and the payment count ride along with the left over
        // because a headline pairing a left over that is yours with a shortfall
        // that is the household's would state two bases in one sentence.
        you: yours.get(c.currency) ?? { leftoverMinor: 0, shortfallMinor: 0, paymentCount: 0 },
        accounts: c.accounts.map((summary) => ({ ...summary, ...state.get(summary.accountId) })),
      })),
    };
  });

  // ---- money flow over a set of accounts ----
  /**
   * Where money goes across **any set of accounts the caller can see**.
   *
   * The diagram used to be reachable only inside a household, which meant the
   * most interesting picture — everything you own, at once — could not be drawn
   * at all. Scope here is a user-defined set: two households' accounts and a
   * standalone pot is an ordinary request.
   *
   * Nothing new is derived. The funding pass already works out which money
   * crosses which account boundary — the transfers it derives for expenses and
   * the movements the user authored for savings — and `flowFromScope` reshapes
   * its answer into ribbons.
   *
   * The pass reaches beyond the picture, to whatever the drawn accounts share
   * money with; only the requested accounts are drawn, and money crossing that
   * edge is drawn with a null end. Access is checked per account, so a set is
   * exactly as visible as its least visible member.
   *
   * **Visibility is not scope.** Hiding a noisy account from a diagram is a
   * presentation act and must not change a computed figure, so it is never sent
   * here: the client asks for the whole set and draws a subset of it. Dropping a
   * hidden account from the request would drop its money from everyone else's
   * plan, which is precisely the bug that rule exists to prevent.
   */
  app.get("/api/flow", async (req) => {
    const userId = await authenticate(req);
    const { accounts: csv, asOf } = req.query as { accounts?: string; asOf?: string };
    const asOfDate = asOf ?? today();

    // De-duplicated, order preserved: the set is a list the user made, and the
    // diagram draws it in the order they made it.
    const ids = [
      ...new Set(
        (csv ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (ids.length === 0) {
      throw new HttpError(422, "validation_error", "accounts must name at least one account");
    }
    if (ids.length > MAX_FLOW_ACCOUNTS) {
      throw new HttpError(
        422,
        "validation_error",
        `a diagram covers at most ${MAX_FLOW_ACCOUNTS} accounts`,
      );
    }

    const ability = await abilityFor(userId);
    const scope: Account[] = [];
    for (const id of ids) {
      const ref = subject("Account", { id });
      if (!ability.hasAnyAccess(ref) || !ability.can("view", ref)) {
        throw new HttpError(404, "not_found", "Account not found");
      }
      const account = await store.getAccount(id);
      if (!account) throw new HttpError(404, "not_found", "Account not found");
      scope.push(account);
    }

    // One diagram, one money. There is no rate anywhere in this system, so a
    // scope spanning two currencies has no honest ribbon width — refused rather
    // than drawn at an invented rate, the same answer authoring a cross-currency
    // movement gets.
    const currencies = [...new Set(scope.map((a) => a.currency))].sort();
    if (currencies.length > 1) {
      throw new HttpError(
        422,
        "validation_error",
        `a diagram cannot span currencies: ${currencies.join(", ")}`,
      );
    }

    const ctx = createPlanContext();
    const planned = await scopesFor(store, scope, asOfDate, ctx);
    // **Names are gated, amounts are not.** A derived transfer names the member
    // whose money it is, and an account can be drawn by somebody outside the
    // household that funds it — so a name travels only when the caller can see
    // the household it belongs to, or when it is their own.
    const memberNames = new Map<string, string>();
    for (const p of planned) {
      const householdId = p.input.householdId;
      const visible = householdId
        ? (await store.getMembership(householdId, userId)) !== null
        : false;
      for (const [id, name] of p.memberNames) {
        if (visible || id === userId) memberNames.set(id, name);
      }
    }
    // A picture can span two scopes that share no money; each contributes the
    // nodes and ribbons it knows about, and neither invents an edge to the other.
    const picture = scope.map((a) => ({ accountId: a.id, name: a.name }));
    const flows = planned.map((p) => flowFromScope(p.plan, picture, currencies[0]!, memberNames));
    return {
      asOfDate,
      currency: currencies[0]!,
      accounts: picture.flatMap((entry) =>
        flows.flatMap((f) => f.accounts.filter((a) => a.accountId === entry.accountId)),
      ),
      edges: flows.flatMap((f) => f.edges),
      totalInflowMinor: flows.reduce((sum, f) => sum + f.totalInflowMinor, 0),
    };
  });

  // ---- upcoming payments ----
  /**
   * What falls due next across every account the caller can see, merged into
   * one dated feed. Each row carries its account so the UI needs no second
   * lookup. Capped at MAX_UPCOMING_ITEMS rows: this is a "what's next" glance,
   * not a report — a 90-day window over many accounts is otherwise unbounded,
   * and a caller wanting the full picture has the per-account plan.
   */
  app.get("/api/upcoming", async (req) => {
    const userId = await authenticate(req);
    const { asOf, days } = req.query as { asOf?: string; days?: string };
    const asOfDate = asOf ?? today();
    const window = clampUpcomingDays(intParam(days));
    // The assembly lives in plan.ts because the daily digest sends the same feed.
    const items = await upcomingForUser(store, userId, asOfDate, window);
    return { asOfDate, days: window, items: items.slice(0, MAX_UPCOMING_ITEMS) };
  });

  // ---- household plan + account assignments ----
  /**
   * Pooled household plan: proportional shared-cost split, cross-account
   * priority funding, and derived transfers. Any member can view the joint
   * plan, regardless of per-account share grants — it is the household's
   * shared financial picture by design.
   */
  app.get("/api/households/:id/plan", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { asOf } = req.query as { asOf?: string };
    await requireMembership(userId, id);
    return withTransferSources(
      userId,
      await computeHouseholdPlanWithSchedule(store, id, asOf ?? today()),
    );
  });

  /** The household's pooled plan simulated month by month. Members only — same
   *  rule as the plan it projects. */
  app.get("/api/households/:id/projection", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { asOf, months } = req.query as { asOf?: string; months?: string };
    await requireMembership(userId, id);
    const asOfDate = asOf ?? today();
    const { scope, accountIds, currency } = await scopeForHousehold(store, id, asOfDate);
    return householdProjectionFromScope(
      computeScopeProjection(scope.input, asOfDate, { months: intParam(months) }),
      id,
      accountIds,
      currency,
      // The household's members, so the strip's left over is the members' sum
      // and not the roster's — the same set `householdPlanFromScope` reads off
      // the partition for `membersLeftoverMinor`, so the strip and the headline
      // above it cannot be summed over different accounts.
      scope.input.members.map((m) => m.userId),
    );
  });

  /** The roster of accounts in this household's plan, with their roles. */
  app.get("/api/households/:id/accounts", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireMembership(userId, id);
    const assignments = await store.listAccountAssignments(id);
    return Promise.all(
      assignments.map(async (a) => {
        const account = await store.getAccount(a.accountId);
        return {
          accountId: a.accountId,
          accountName: account?.name ?? "(unknown account)",
          currency: account?.currency ?? "",
          role: a.role,
          memberUserId: a.memberUserId,
        };
      }),
    );
  });

  /** Assign an account a role in the household plan (shared, or personal to a
   *  member). Owner/admin only; the caller must be able to see the account. */
  app.put("/api/households/:id/accounts/:accountId", async (req) => {
    const userId = await authenticate(req);
    const { id, accountId } = req.params as { id: string; accountId: string };
    await requireMembership(userId, id, ["owner", "admin"]);
    const body = assignAccountBody.parse(req.body);
    if (!(await store.getAccess(userId, accountId))) {
      throw new HttpError(404, "not_found", "Account not found");
    }
    if (body.role === "personal" && body.memberUserId) {
      if (!(await store.getMembership(id, body.memberUserId))) {
        throw new HttpError(422, "validation_error", "memberUserId is not a household member");
      }
    }
    return store.upsertAccountAssignment({
      householdId: id,
      accountId,
      role: body.role,
      memberUserId: body.memberUserId ?? null,
    });
  });

  app.delete("/api/households/:id/accounts/:accountId", async (req, reply) => {
    const userId = await authenticate(req);
    const { id, accountId } = req.params as { id: string; accountId: string };
    await requireMembership(userId, id, ["owner", "admin"]);
    await store.deleteAccountAssignment(id, accountId);
    return reply.code(204).send();
  });

  // ---- transfer confirmations ("I moved the money") ----
  /**
   * Confirm one of the transfers the household plan derived. The confirmation
   * credits the receiving account's payments with the member's funded slice, so
   * the plan reflects money that has actually moved. Members confirm their own
   * transfers; owners/admins may confirm on anyone's behalf.
   */
  app.post("/api/households/:id/transfers/confirm", async (req, reply) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireMembership(userId, id);
    const body = confirmTransferBody.parse(req.body);
    if (body.memberUserId !== userId) {
      await requireMembership(userId, id, ["owner", "admin"]);
    }
    const month = monthToFirstDay(body.month ?? monthOf(today()));

    // Idempotency guard first: once confirmed, stay confirmed even if the plan
    // has since moved on and no longer derives that transfer.
    const confirmed = await store.listTransferConfirmations(id, month);
    const duplicate = confirmed.some(
      (c) =>
        c.fromAccountId === body.fromAccountId &&
        c.toAccountId === body.toAccountId &&
        c.memberUserId === body.memberUserId,
    );
    if (duplicate) {
      throw new HttpError(409, "already_confirmed", "Transfer already confirmed this month");
    }

    const { scope, accountIds, currency } = await scopeForHousehold(store, id, today());
    const plan = householdPlanFromScope(scope.plan, id, accountIds, currency);
    const transfer = plan.transfers.find(
      (t) =>
        t.fromAccountId === body.fromAccountId &&
        t.toAccountId === body.toAccountId &&
        t.memberUserId === body.memberUserId,
    );
    if (!transfer) {
      throw new HttpError(422, "no_planned_transfer", "No matching planned transfer");
    }

    const confirmation = await store.createTransferConfirmation({
      householdId: id,
      // A household transfer is derived from the plan, not authored: there is no
      // inflow row behind it to point at.
      inflowId: null,
      month,
      fromAccountId: body.fromAccountId,
      toAccountId: body.toAccountId,
      memberUserId: body.memberUserId,
      amountMinor: transfer.amountMinor,
    });
    // The transfer funds this member's share of every bill in the destination
    // account; book each slice against its payment so un-confirming can undo it.
    const contributions = [];
    for (const line of plan.lines) {
      if (line.accountId !== body.toAccountId) continue;
      const funded = line.allocations.find((a) => a.userId === body.memberUserId)?.fundedMinor ?? 0;
      if (funded <= 0) continue;
      contributions.push(
        await store.createContribution({
          paymentId: line.paymentId,
          accountId: body.toAccountId,
          userId: body.memberUserId,
          month,
          amountMinor: funded,
          note: null,
          transferConfirmationId: confirmation.id,
        }),
      );
    }
    return reply.code(201).send({ confirmation, contributions });
  });

  app.get("/api/households/:id/transfers/confirmations", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { month } = req.query as { month?: string };
    await requireMembership(userId, id);
    return store.listTransferConfirmations(id, monthToFirstDay(month ?? monthOf(today())));
  });

  /** Un-confirm: drops the confirmation and the contributions it created. */
  app.delete("/api/households/:id/transfers/confirmations/:confId", async (req, reply) => {
    const userId = await authenticate(req);
    const { id, confId } = req.params as { id: string; confId: string };
    await requireMembership(userId, id);
    const confirmation = await store.getTransferConfirmation(confId);
    if (!confirmation || confirmation.householdId !== id) {
      throw new HttpError(404, "not_found", "Confirmation not found");
    }
    if (confirmation.memberUserId !== userId) {
      await requireMembership(userId, id, ["owner", "admin"]);
    }
    await store.deleteTransferConfirmation(confId);
    return reply.code(204).send();
  });

  // ---- standalone movements ("I moved the money", with no household) ----
  /**
   * Confirm an account-sourced inflow — money you moved between two accounts you
   * own. The household handler above answers the same question for a transfer
   * the household plan derived; this one asks no household anything, because a
   * movement between your own accounts has none in it.
   *
   * Keyed on the inflow rather than on (from, to, member): a movement is one
   * authored `core.inflows` row, two accounts can have several movements between
   * them, and a solo movement has no member to key on. Month defaults to the one
   * running now.
   */
  app.post("/api/inflows/:inflowId/confirm", async (req, reply) => {
    const userId = await authenticate(req);
    const { inflowId } = req.params as { inflowId: string };
    const { month: monthParam } = req.query as { month?: string };
    const inflow = await store.getInflow(inflowId);
    // Only a movement can be moved. An external inflow is money arriving from
    // outside the estate — nobody transfers their own salary to themselves.
    if (!inflow || inflow.source !== "account" || !inflow.sourceAccountId) {
      throw new HttpError(404, "not_found", "Movement not found");
    }
    // Both ends of it: money lands in one account and leaves the other, and you
    // have to be able to watch it go to be able to say that it went.
    const { account } = await requireAccess(userId, inflow.accountId, "edit");
    await requireAccess(userId, inflow.sourceAccountId, "view");
    const month = monthQuery(monthParam);
    const asOfDate = today();

    // Idempotency guard first, exactly as the household handler does it: once
    // confirmed, stay confirmed even if the plan has since moved on. The
    // database says the same thing through
    // `transfer_confirmations_inflow_month_unique`; this is the answer with an
    // error code on it.
    const confirmed = await store.listTransferConfirmationsForAccount(inflow.accountId, month);
    if (confirmed.some((c) => c.inflowId === inflowId)) {
      throw new HttpError(409, "already_confirmed", "Movement already confirmed this month");
    }

    // What the movement actually delivered, as the one pass settled it: every
    // expense in the scope is funded first (decision 8), so an authored £300 out
    // of an account with £120 to spare moves £120 and this is that £120.
    // `ScopeMovement` answers directly — the old handler planned the account
    // twice, once with the arrival taken back out, and diffed the two, because
    // the only way to ask "what did this movement pay for" of an engine that had
    // already been handed the money was to take it away again.
    //
    // The status filter is `engine.ts`'s, for its reasons, and it is what makes
    // this the *sending* account's row. `plan.movements` is every partition's
    // flattened in alphabetical currency order, and a movement whose two ends
    // are in different currencies appears twice: really, in the sender's
    // partition, and as an `unknown_source` £0 twin in the partition that cannot
    // see the sender — and an unfiltered `find` returned the EUR zero for a
    // GBP→EUR movement and wrote the user's confirmation as £0.
    //
    // **No new account can reach that state.** `PATCH /api/accounts/:id` used to
    // take a currency, which let an account cross partitions after the POST-time
    // cross-currency guard; it is refused now, so an account is denominated once
    // (see the handler). The filter stays for the two cases that remain: rows
    // that pre-date the refusal — the API allowed this and `0012` deliberately
    // does not rewrite them — and a sender the scope never loaded at all, which
    // `scope.ts` also reports as `unknown_source`. A `broken_cycle` edge is the
    // third: the pass has decided it is not happening, so there is nothing to
    // confirm.
    const scope = await scopeForAccount(store, account, asOfDate);
    const movement = scope.plan.movements.find(
      (m) =>
        m.inflowId === inflowId && m.status !== "broken_cycle" && m.status !== "unknown_source",
    );
    // 422, like the derived-transfer handler's `no_planned_transfer`: the request
    // is well formed and the movement exists, but this month's plan does not move
    // it, and booking £0 records a fact nobody stated.
    if (!movement) {
      throw new HttpError(422, "no_planned_movement", "No matching planned movement");
    }
    const amountMinor = movement.fundedMinor;

    const confirmation = await store.createTransferConfirmation({
      householdId: null,
      inflowId,
      month,
      fromAccountId: inflow.sourceAccountId,
      toAccountId: inflow.accountId,
      memberUserId: userId,
      amountMinor,
    });
    // **No contributions.** An authored movement is savings (decision 9), and
    // savings money never pays for an expense: the pass funds every obligation
    // from the members' budgets and delivers the transfers those need itself, so
    // a movement into a bills pot arrives *on top of* the feed rather than
    // instead of it (decision 12 — netting the two would put savings money
    // inside expense arithmetic). There is nothing the plan says this paid for,
    // so booking a contribution against a payment would be inventing one. The
    // duplication is real and the UI flags it; the ledger does not hide it.
    const contributions: Contribution[] = [];
    return reply.code(201).send({ confirmation, contributions });
  });

  /**
   * Movements touching this account this month, from both sides: what arrived
   * here and what left here. No household needed to ask.
   *
   * Both shapes a household-free movement comes in — the authored one, which
   * names its `inflowId`, and the one the pass derived, which names neither a
   * household nor an inflow because nobody wrote it down. They are two different
   * movements between the same two accounts, each confirmed on its own, and a
   * caller that could see only the first had no way to un-confirm the second.
   */
  app.get("/api/accounts/:id/transfers/confirmations", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { month } = req.query as { month?: string };
    await requireAccess(userId, id, "view");
    const asked = monthQuery(month);
    const [authored, derived] = await Promise.all([
      store.listTransferConfirmationsForAccount(id, asked),
      store.listDerivedTransferConfirmationsForAccount(id, asked),
    ]);
    return [...authored, ...derived].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
  });

  /**
   * Confirm a transfer the plan **derived** — the feed into a pot nobody
   * authored a movement for.
   *
   * The household handler above answers the same question when a household
   * attributes the transfer; this one asks no household anything, because a
   * solo user's derived feed has none in it. That case had nowhere to go before
   * migration 0010: a derived solo transfer carries neither a `household_id` nor
   * an `inflow_id`, and the old CHECK constraint required one of them. It is
   * scoped by `(from, to, month, member)`, which is what it always was.
   *
   * `edit` on the receiving account and `view` on the sending one — the same
   * rule the authored-movement handler applies, for the same reason: recording
   * that money moved commits nothing, so it does not take `edit` at both ends.
   */
  app.post("/api/accounts/:id/transfers/confirm", async (req, reply) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { month: monthParam } = req.query as { month?: string };
    const { account } = await requireAccess(userId, id, "edit");
    const body = confirmTransferBody.parse(req.body);
    if (body.toAccountId !== id) {
      throw new HttpError(422, "validation_error", "toAccountId must be this account");
    }
    // Only your own: a derived transfer is a member's own money moving, and
    // there is no household roster here to make anybody an admin of it.
    if (body.memberUserId !== userId) {
      throw new HttpError(403, "forbidden", "You may only confirm your own transfer");
    }
    await requireAccess(userId, body.fromAccountId, "view");
    const month = monthQuery(monthParam);
    const asOfDate = today();

    // Idempotency guard first, exactly as the other two handlers do it: once
    // confirmed, stay confirmed even if the plan has since moved on. The
    // database says the same thing through
    // `transfer_confirmations_derived_month_unique`.
    const confirmed = await store.listDerivedTransferConfirmationsForAccount(id, month);
    if (
      confirmed.some(
        (c) =>
          c.fromAccountId === body.fromAccountId &&
          c.toAccountId === id &&
          c.memberUserId === userId,
      )
    ) {
      throw new HttpError(409, "already_confirmed", "Transfer already confirmed this month");
    }

    const scope = await scopeForAccount(store, account, asOfDate);
    const partition = scope.plan.partitions.find((p) => p.currency === account.currency);
    const transfer = (partition?.transfers ?? []).find(
      (t) =>
        t.fromAccountId === body.fromAccountId && t.toAccountId === id && t.memberUserId === userId,
    );
    if (!transfer) {
      throw new HttpError(422, "no_planned_transfer", "No matching planned transfer");
    }

    const confirmation = await store.createTransferConfirmation({
      // Neither: a transfer the pass derived for a scope no household applies to
      // is scoped by its two accounts, its month and the member who moves it.
      householdId: null,
      inflowId: null,
      month,
      fromAccountId: body.fromAccountId,
      toAccountId: id,
      memberUserId: userId,
      amountMinor: transfer.amountMinor,
    });
    // The transfer funds this member's share of every bill in the destination
    // account; book each slice against its payment so un-confirming can undo it.
    const contributions: Contribution[] = [];
    for (const line of partition?.lines ?? []) {
      if (line.accountId !== id) continue;
      const funded = line.allocations.find((a) => a.userId === userId)?.fundedMinor ?? 0;
      if (funded <= 0) continue;
      contributions.push(
        await store.createContribution({
          paymentId: line.paymentId,
          accountId: id,
          userId,
          month,
          amountMinor: funded,
          note: null,
          transferConfirmationId: confirmation.id,
        }),
      );
    }
    return reply.code(201).send({ confirmation, contributions });
  });

  /**
   * Un-confirm a derived transfer: drops it and the contributions it created.
   *
   * Nested under the receiving account deliberately, so it can only ever reach a
   * confirmation with no household and no inflow. The household route keeps its
   * own rule — a plain member may only un-confirm their own — and this must not
   * become a way around it.
   */
  app.delete("/api/accounts/:id/transfers/confirmations/:confId", async (req, reply) => {
    const userId = await authenticate(req);
    const { id, confId } = req.params as { id: string; confId: string };
    const confirmation = await store.getTransferConfirmation(confId);
    if (
      !confirmation ||
      confirmation.toAccountId !== id ||
      confirmation.householdId !== null ||
      confirmation.inflowId !== null
    ) {
      throw new HttpError(404, "not_found", "Confirmation not found");
    }
    await requireAccess(userId, id, "edit");
    await store.deleteTransferConfirmation(confId);
    return reply.code(204).send();
  });

  /**
   * Un-confirm a movement: drops it and the contributions it created.
   *
   * Nested under the inflow deliberately, so it can only ever reach an
   * inflow-scoped confirmation. A household one keeps its own route and its own
   * rule — a plain member may only un-confirm their own — and this must not
   * become a way around it.
   */
  app.delete("/api/inflows/:inflowId/confirmations/:confId", async (req, reply) => {
    const userId = await authenticate(req);
    const { inflowId, confId } = req.params as { inflowId: string; confId: string };
    const confirmation = await store.getTransferConfirmation(confId);
    if (!confirmation || confirmation.inflowId !== inflowId) {
      throw new HttpError(404, "not_found", "Confirmation not found");
    }
    await requireAccess(userId, confirmation.toAccountId, "edit");
    await store.deleteTransferConfirmation(confId);
    return reply.code(204).send();
  });

  // ---- projects ----
  /**
   * Projects are cross-account groupings of payments. Each project belongs to
   * exactly one user (the creator). Member payments may live on any account
   * the user has access to — which is why this is the one surface in the
   * product that reads accounts the caller was never checked against, and why
   * both of its access rules are now stated rather than assumed.
   *
   * Owner == manager == reader, and the ownership test lives in
   * `packages/policies` (`subject("Project", …)`) rather than being spelled out
   * at each of the four places that need it. That is where a second arm goes if
   * a project ever becomes shareable.
   */
  const requireProject = async (userId: string, id: string, action: Action): Promise<Project> => {
    const project = await store.getProject(id);
    const ability = await abilityFor(userId);
    // 404 rather than 403, by the policy package's leak rule that
    // `requireAccess` applies to accounts: a project you have no access to at
    // all reads exactly like one that does not exist.
    if (!project || !ability.hasAnyAccess(subject("Project", project))) {
      throw new HttpError(404, "not_found", "Project not found");
    }
    // Each route names the action it needs rather than all three sharing one
    // opaque owner test, so reading a project and renaming it are different
    // questions on the page even while the only role a project has answers yes
    // to both. The insufficient-access branch is therefore unreachable today
    // and deliberately present: it is what a co-member of a shared project
    // (decision 23) meets on PATCH, and a 403 is honest to them — they can
    // already see it exists.
    if (!ability.can(action, subject("Project", project))) {
      throw new HttpError(403, "forbidden", `${action} access required`);
    }
    return project;
  };

  app.get("/api/projects", async (req) => {
    const userId = await authenticate(req);
    return store.listProjectsForOwner(userId);
  });

  app.post("/api/projects", async (req, reply) => {
    const userId = await authenticate(req);
    const body = createProjectBody.parse(req.body);
    const project = await store.createProject({
      ownerUserId: userId,
      name: body.name,
      description: body.description ?? null,
      color: body.color ?? null,
      targetDate: body.targetDate ?? null,
    });
    return reply.code(201).send(project);
  });

  /**
   * GET /api/projects/:id — the project plus its member payments, each named
   * with its account wherever this caller may be told.
   *
   * `listPaymentsForProject` has no access filter and correctly so: it answers
   * "what is in this project", and a project's contents legitimately cross
   * accounts — that is what a project is for. The gate belongs here, where the
   * caller is known, and it is the gate `planInflowSources` already applies:
   * `getAccess` decides, and only the **name** turns on it. The amount, the
   * payment's own name, its due date and its account id all travel — they are
   * facts about the caller's own project, and withholding them would empty the
   * page without hiding anything.
   *
   * The currency is **not** gated with the name, and deliberately: it is the
   * amount's unit rather than a second fact about the account. A minor-unit
   * integer with no currency cannot be rendered at all — `formatMinor` throws
   * on an absent code — so gating it would be gating the amount by the back
   * door, which the rule above forbids.
   *
   * The name is absent rather than `"(unknown)"`, which is what this route used
   * to say for an account it could not find. Absent is what every other gated
   * name on the wire does (`PlanInflowSource.accountName`,
   * `PlanTransferDeparture.toAccountName`), and it lets a client render one
   * honest fallback — "another account" — instead of printing a parenthesis at
   * somebody.
   *
   * The shape that reaches this without anybody doing anything wrong: a payment
   * filed on an account shared into your household, and then the share is taken
   * away. The payment stays in your project, and the account behind it stops
   * being yours to name.
   */
  app.get("/api/projects/:id", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const project = await requireProject(userId, id, "view");
    const payments = await store.listPaymentsForProject(id);
    const accountIds = [...new Set(payments.map((p) => p.accountId))];
    /** id → { currency, and the name only if this caller may be told it }. */
    const seen = new Map<string, { name: string | null; currency: string }>();
    for (const aid of accountIds) {
      const [account, access] = await Promise.all([
        store.getAccount(aid),
        store.getAccess(userId, aid),
      ]);
      if (!account) continue;
      seen.set(aid, { name: access ? account.name : null, currency: account.currency });
    }
    return {
      ...project,
      payments: payments.map((p) => {
        const account = seen.get(p.accountId);
        return {
          id: p.id,
          accountId: p.accountId,
          ...(account?.name != null ? { accountName: account.name } : {}),
          currency: account?.currency ?? "",
          name: p.name,
          category: p.category,
          amountMinor: p.amountMinor,
          alreadySavedMinor: p.alreadySavedMinor,
          dueDate: p.dueDate,
        };
      }),
    };
  });

  app.patch("/api/projects/:id", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireProject(userId, id, "edit");
    const body = updateProjectBody.parse(req.body);
    return store.updateProject(id, defined(body));
  });

  app.delete("/api/projects/:id", async (req, reply) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireProject(userId, id, "delete");
    await store.deleteProject(id);
    return reply.code(204).send();
  });

  // ---- export / import ----
  /**
   * Take your data with you: every owned account and its history, plus your
   * projects, as one JSON document. Served as a download so a browser hitting
   * this URL saves a file instead of rendering it.
   */
  app.get("/api/export", async (req, reply) => {
    const userId = await authenticate(req);
    const file = await buildExport(store, userId, today());
    return reply
      .header(
        "content-disposition",
        `attachment; filename="finance-planner-export-${today()}.json"`,
      )
      .send(file);
  });

  /**
   * Restore (or clone) an export under the caller, with fresh ids. Additive:
   * existing data is left alone, so importing twice gives two copies rather
   * than a silent overwrite. A file that doesn't match the schema is a 422.
   */
  app.post("/api/import", async (req) => {
    const userId = await authenticate(req);
    const file = importBody.parse(req.body);
    return importExport(store, userId, file);
  });

  // ---- demo seed ----
  /**
   * Plant a worked example so a brand-new account has something to look at.
   * Exists for first-run exploration and demos, and is off unless
   * ENABLE_DEMO_SEED=true — when it is off the route 404s rather than 403s, so a
   * deployment without it doesn't advertise that it exists. (GET /api/meta is
   * the honest, deliberate way to ask.)
   */
  app.post("/api/demo/seed", async (req, reply) => {
    const userId = await authenticate(req);
    if (!env.enableDemoSeed) throw new HttpError(404, "not_found", "Not found");
    if ((await store.listAccountsForOwner(userId)).length > 0) {
      throw new HttpError(409, "demo_not_empty", "Demo data is only seeded into an empty account");
    }
    const counts = await seedDemoData(store, userId, today());
    return reply.code(201).send(counts);
  });

  return app;
}
