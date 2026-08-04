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
import { type Account, type AccountAccess, createStore, type Store } from "@finance-planner/data";
import {
  type AccountPlan,
  clampUpcomingDays,
  computeAccountPlan,
  computeEstateProjection,
  computeHouseholdProjection,
  computeOverview,
  toISODate,
  withoutArrival,
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
  buildAccountInput,
  buildHouseholdInput,
  computeEstateFor,
  computeHouseholdPlanFor,
  computeHouseholdPlanWithSchedule,
  computePlanForAccount,
  createPlanContext,
  fundingClosure,
  type InflowSource,
  type PlanContext,
  previewPlanForAccount,
  resolveAccountInflow,
  upcomingForUser,
} from "./plan.js";
import { buildExport, importExport } from "./portability.js";

const SERVICE = "api";
const VERSION = process.env.npm_package_version ?? "0.0.0";
const startedAt = Date.now();
/** Row cap on the upcoming feed — see the handler comment. */
const MAX_UPCOMING_ITEMS = 50;
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
 * twice — once as its own row, once inside its household's members. An account
 * assigned in two households takes the first; households come back in a stable
 * order, so the answer is deterministic.
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
    asOfDate: string,
    ctx: PlanContext,
  ): Promise<PlanInflowSource[] | null> => {
    const sources: PlanInflowSource[] = [];

    // Memoised by the plan computation that precedes every call, so this is a
    // map lookup rather than a second household plan.
    const inflow = await resolveAccountInflow(store, account, asOfDate, ctx);
    if (inflow && (await store.getMembership(inflow.householdId, userId))) {
      sources.push(...inflow.sources.map((s) => ({ kind: "member" as const, ...s })));
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

  app.patch("/api/accounts/:id", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { access } = await requireAccess(userId, id, "edit");
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
    const plan = await computePlanForAccount(store, account, asOfDate, ctx);
    return {
      ...plan,
      ...(await accountReality(store, plan, asOfDate)),
      inflowSources: await planInflowSources(userId, account, plan, asOfDate, ctx),
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
   * Simulated as part of its estate, not on its own. What arrives in month
   * seven is another account's month-seven surplus — after month-seven's bills,
   * out of month-seven's income — and one account's input does not contain the
   * other account. `computeAccountProjection` holds the as-of month's arrival
   * flat instead, which is right for a standing transfer out of a steady
   * account and wrong as soon as the sender's own month changes. So the whole
   * funding closure is walked forward and this account's slice read back out.
   *
   * The closure is the estate **as authored**, deliberately: a completed pass's
   * `inputs` already carry the money that arrived, and re-feeding them would
   * hand the account its allocation again in every simulated month. Senders the
   * caller cannot see are in the closure and never leave it — the same rule the
   * plan endpoint follows, for the same reason.
   */
  app.get("/api/accounts/:id/projection", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { asOf, months } = req.query as { asOf?: string; months?: string };
    const { account } = await requireAccess(userId, id, "view");
    const asOfDate = asOf ?? today();
    const [closure, balances] = await Promise.all([
      fundingClosure(store, [account], asOfDate),
      store.listBalanceSnapshots(id),
    ]);
    const latest = balances.at(-1);
    const estate = computeEstateProjection(closure, asOfDate, {
      months: intParam(months),
      // Only this account's opening balance is known here, and only this
      // account's months are returned; the senders' balances are irrelevant to
      // what they can afford to send, which is an income-and-bills question.
      startingBalancesMinor: { [id]: latest?.balanceMinor ?? null },
    });
    // Always present: the account is in its own funding closure.
    return estate.accounts.find((a) => a.accountId === id)!;
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

  // ---- month closes for a standalone account ----
  /** Freeze the month's scorecard: what the plan asked for vs what was actually
   *  contributed. The household equivalent lives under /api/households. */
  app.post("/api/accounts/:id/close", async (req, reply) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { account } = await requireAccess(userId, id, "edit");
    const body = closeMonthBody.parse(req.body);
    const asOfDate = closeAsOfDate(body.month);
    const month = monthToFirstDay(body.month);
    if (await store.getMonthClose({ accountId: id }, month)) {
      throw new HttpError(409, "already_closed", "Month already closed");
    }
    const [plan, contributions] = await Promise.all([
      computePlanForAccount(store, account, asOfDate),
      store.listContributionsForAccount(id, month),
    ]);
    const close = await store.createMonthClose({
      householdId: null,
      accountId: id,
      month,
      // The money the account actually had this month: its own income plus the
      // inflow that has been confirmed moving into it. A household-funded pot
      // has no income of its own, so recording `monthlyIncomeMinor` alone would
      // freeze £0 against a contributed figure fed entirely by transfers — a
      // scorecard row that can never say anything, and one that cannot be
      // recomputed later because closing is what makes it history. Only
      // *confirmed* inflow counts: a close scores what happened, not what was
      // planned. Safe against the double-count decision (#3) because account
      // closes are read per account and never summed across an estate — the
      // household close a few handlers down keeps summing own income alone,
      // since inflow inside a household is money it already counted.
      incomeMinor: plan.monthlyIncomeMinor + plan.confirmedInflowMinor,
      plannedMinor: plan.totalRequiredMinor,
      contributedMinor: contributions.reduce((sum, c) => sum + c.amountMinor, 0),
      closedBy: userId,
    });
    return reply.code(201).send(close);
  });

  app.get("/api/accounts/:id/closes", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireAccess(userId, id, "view");
    return store.listMonthCloses({ accountId: id });
  });

  app.delete("/api/accounts/:id/closes/:closeId", async (req, reply) => {
    const userId = await authenticate(req);
    const { id, closeId } = req.params as { id: string; closeId: string };
    await requireAccess(userId, id, "edit");
    const close = await store.getMonthCloseById(closeId);
    if (!close || close.accountId !== id) {
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
   * Nothing is refused for closing a funding loop. A cycle is a property of the
   * estate rather than of the edge that completes it, so it is detected by the
   * ordered pass and reported on every plan involved as
   * `fundingCycleAccountIds` — see `computeEstatePlan`. Authoring stays
   * permissive; the plan is where the loop is named.
   */
  app.post("/api/accounts/:id/inflows", async (req, reply) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireAccess(userId, id, "edit");
    const body = createInflowBody.parse(req.body);
    const sourceAccountId = body.sourceAccountId ?? null;
    if (sourceAccountId === id) {
      throw new HttpError(
        422,
        "validation_error",
        "An inflow cannot be sourced from the account it arrives in",
      );
    }
    if (sourceAccountId) await requireAccess(userId, sourceAccountId, "edit");
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
   * **One estate pass, not one per account.** Planning each account in turn ran
   * a separate ordered pass over that account's own funding closure, so the
   * rollup was assembled from plans no two of which had been computed together
   * — and `computeOverview` nets money that moved *between accounts in the same
   * rollup*, a question no single-account pass is in a position to answer. Now
   * every account the caller can see is seeded into one pass. The pass reaches
   * further than the caller can — it must, since money can arrive from an
   * account they cannot see — so only the seeded accounts' plans are read back
   * out of it, which is where the access filter lives.
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
    const estate = await computeEstateFor(store, accounts, asOfDate, ctx);
    const planById = new Map(estate.plans.map((p) => [p.accountId, p]));
    for (const account of accounts) {
      // Always present: every account seeded into the pass is planned by it.
      const plan = planById.get(account.id)!;
      const reality = await accountReality(store, plan, asOfDate);
      const planSummary = summarisePlanLines(plan, reality.contributionsMTD);
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
        latestBalanceMinor: reality.latestBalance?.balanceMinor ?? null,
        latestBalanceDate: reality.latestBalance?.asOfDate ?? null,
        reservedMinor: reality.reservedMinor,
        planSummary,
        // The index's chip, off the very lines the checklist will draw rows for.
        unrecordedCount: planSummary.unrecorded.length,
        unrecordedTotalMinor: planSummary.unrecorded.reduce((n, l) => n + l.remainderMinor, 0),
      });
    }

    const overview = computeOverview(plans, asOfDate);
    return {
      ...overview,
      perCurrency: overview.perCurrency.map((c) => ({
        ...c,
        accounts: c.accounts.map((summary) => ({ ...summary, ...state.get(summary.accountId) })),
      })),
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
    return computeHouseholdPlanWithSchedule(store, id, asOf ?? today());
  });

  /** The household's pooled plan simulated month by month. Members only — same
   *  rule as the plan it projects. */
  app.get("/api/households/:id/projection", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { asOf, months } = req.query as { asOf?: string; months?: string };
    await requireMembership(userId, id);
    const input = await buildHouseholdInput(store, id);
    return computeHouseholdProjection(input, asOf ?? today(), { months: intParam(months) });
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

    const plan = await computeHouseholdPlanFor(store, id, today());
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

    // What the movement actually delivered, as the ordered pass over the estate
    // settled it: the sending account's own bills come first (decision 6), so
    // an authored £300 out of an account with £120 to spare moves £120 and this
    // is that £120. Nothing arrived means the sender could spare nothing —
    // confirming it books nothing, because there is nothing the plan says it
    // paid for.
    const input = await buildAccountInput(store, account, asOfDate);
    const arrival = input.inflow?.sources?.find((s) => s.inflowId === inflowId);
    const amountMinor = arrival?.amountMinor ?? 0;

    // What this money pays for, answered by the engine rather than by a second
    // allocator written here. The movement is *already* in the plan — the pass
    // delivers it whether or not anyone has said it moved — so the base is this
    // account's month with this one movement taken back out, and the plan as it
    // stands is the month with it. The difference, line by line, is what the
    // movement funds. Adding the amount on top instead would diff against an
    // imaginary second copy of the movement: zero rows on an account that can
    // absorb it, and rows against the wrong payments on one that cannot.
    const before = computeAccountPlan(withoutArrival(input, inflowId), asOfDate);
    const after = computeAccountPlan(input, asOfDate);

    const confirmation = await store.createTransferConfirmation({
      householdId: null,
      inflowId,
      month,
      fromAccountId: inflow.sourceAccountId,
      toAccountId: inflow.accountId,
      memberUserId: userId,
      amountMinor,
    });
    const fundedBefore = new Map(before.lines.map((l) => [l.paymentId, l.fundedFromInflowMinor]));
    const contributions = [];
    for (const line of after.lines) {
      const funded = line.fundedFromInflowMinor - (fundedBefore.get(line.paymentId) ?? 0);
      if (funded <= 0) continue;
      contributions.push(
        await store.createContribution({
          paymentId: line.paymentId,
          accountId: inflow.accountId,
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

  /** Movements touching this account this month, from both sides: what arrived
   *  here and what left here. No household needed to ask. */
  app.get("/api/accounts/:id/transfers/confirmations", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const { month } = req.query as { month?: string };
    await requireAccess(userId, id, "view");
    return store.listTransferConfirmationsForAccount(id, monthQuery(month));
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

  // ---- household month closes ----
  /**
   * Freeze the household's month: the plan's income and requirement against
   * what members actually contributed across the household's accounts.
   */
  app.post("/api/households/:id/close", async (req, reply) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireMembership(userId, id, ["owner", "admin"]);
    const body = closeMonthBody.parse(req.body);
    const asOfDate = closeAsOfDate(body.month);
    const month = monthToFirstDay(body.month);
    if (await store.getMonthClose({ householdId: id }, month)) {
      throw new HttpError(409, "already_closed", "Month already closed");
    }
    const [plan, assignments] = await Promise.all([
      computeHouseholdPlanFor(store, id, asOfDate),
      store.listAccountAssignments(id),
    ]);
    let contributedMinor = 0;
    for (const assignment of assignments) {
      const contributions = await store.listContributionsForAccount(assignment.accountId, month);
      contributedMinor += contributions.reduce((sum, c) => sum + c.amountMinor, 0);
    }
    const close = await store.createMonthClose({
      householdId: id,
      accountId: null,
      month,
      incomeMinor: plan.monthlyIncomeMinor,
      plannedMinor: plan.totalRequiredMinor,
      contributedMinor,
      closedBy: userId,
    });
    return reply.code(201).send(close);
  });

  app.get("/api/households/:id/closes", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    await requireMembership(userId, id);
    return store.listMonthCloses({ householdId: id });
  });

  app.delete("/api/households/:id/closes/:closeId", async (req, reply) => {
    const userId = await authenticate(req);
    const { id, closeId } = req.params as { id: string; closeId: string };
    await requireMembership(userId, id, ["owner", "admin"]);
    const close = await store.getMonthCloseById(closeId);
    if (!close || close.householdId !== id) {
      throw new HttpError(404, "not_found", "Month close not found");
    }
    await store.deleteMonthClose(closeId);
    return reply.code(204).send();
  });

  // ---- projects ----
  /**
   * Projects are cross-account groupings of payments. Each project belongs to
   * exactly one user (the creator). Member payments may live on any account
   * the user has access to.
   *
   * No new permission surface yet — owner == manager == reader. If shared
   * projects become a thing later, factor into packages/policies.
   */
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

  /** GET /api/projects/:id — returns the project plus its member payments and
   *  per-account totals. Non-owners get 404 (existence leak prevention). */
  app.get("/api/projects/:id", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const project = await store.getProject(id);
    if (!project || project.ownerUserId !== userId) {
      throw new HttpError(404, "not_found", "Project not found");
    }
    const payments = await store.listPaymentsForProject(id);
    const accountIds = [...new Set(payments.map((p) => p.accountId))];
    const accounts = await Promise.all(accountIds.map((aid) => store.getAccount(aid)));
    const accountMap = new Map<string, { name: string; currency: string }>();
    for (const a of accounts) if (a) accountMap.set(a.id, { name: a.name, currency: a.currency });
    return {
      ...project,
      payments: payments.map((p) => ({
        id: p.id,
        accountId: p.accountId,
        accountName: accountMap.get(p.accountId)?.name ?? "(unknown)",
        currency: accountMap.get(p.accountId)?.currency ?? "",
        name: p.name,
        category: p.category,
        amountMinor: p.amountMinor,
        alreadySavedMinor: p.alreadySavedMinor,
        dueDate: p.dueDate,
      })),
    };
  });

  app.patch("/api/projects/:id", async (req) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const project = await store.getProject(id);
    if (!project || project.ownerUserId !== userId) {
      throw new HttpError(404, "not_found", "Project not found");
    }
    const body = updateProjectBody.parse(req.body);
    return store.updateProject(id, defined(body));
  });

  app.delete("/api/projects/:id", async (req, reply) => {
    const userId = await authenticate(req);
    const { id } = req.params as { id: string };
    const project = await store.getProject(id);
    if (!project || project.ownerUserId !== userId) {
      throw new HttpError(404, "not_found", "Project not found");
    }
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
