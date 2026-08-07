import { z } from "zod";

/**
 * Shared API contracts (DTOs / Zod schemas) used by both the backend services
 * and the web client. Keeping them here removes drift between client and server.
 *
 * Money is always expressed in integer **minor units** (e.g. pennies). Never use
 * floats for currency. The arithmetic that shares money out lives next door in
 * `./money.js`, re-exported below — it is also importable on its own, as
 * `@finance-planner/contracts/money`, by anything that wants it without zod.
 */

export * from "./money.js";

/** ISO 4217 currency code, e.g. "GBP". */
export const currencyCode = z.string().length(3).toUpperCase();

/** Integer amount in minor units (pennies). Non-negative. */
export const amountMinor = z.number().int().nonnegative();

/** ISO date string (date-only), e.g. "2026-08-01". */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** ISO timestamp, e.g. "2026-08-04T07:00:00.000Z". */
export const isoDateTime = z.string().datetime();

/** Calendar month, e.g. "2026-08". Stored as the month's first day. */
export const monthString = z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM");

export const paymentCategory = z.enum([
  "monthly_recurring",
  "yearly_recurring",
  "custom_recurring",
  "fixed_point",
]);
export type PaymentCategory = z.infer<typeof paymentCategory>;

/**
 * Who bears an expense within a household plan.
 *   shared   → split across members by their contribution share
 *   personal → borne entirely by one member (the bearer)
 */
export const paymentScope = z.enum(["shared", "personal"]);
export type PaymentScope = z.infer<typeof paymentScope>;

/** Whether a household account is a shared pot or assigned to one member. */
export const accountRole = z.enum(["shared", "personal"]);
export type AccountRole = z.infer<typeof accountRole>;

export const frequency = z.enum(["monthly", "yearly", "custom", "one_off"]);
export type Frequency = z.infer<typeof frequency>;

export const recurrenceUnit = z.enum(["day", "week", "month", "year"]);
export type RecurrenceUnit = z.infer<typeof recurrenceUnit>;

export const recurrence = z.object({
  interval: z.number().int().positive(),
  unit: recurrenceUnit,
  anchor: isoDate,
});
export type Recurrence = z.infer<typeof recurrence>;

/** Health-check response shape exposed by every service. */
export const healthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
});
export type HealthResponse = z.infer<typeof healthResponse>;

export const readinessResponse = z.object({
  ready: z.boolean(),
  checks: z.record(z.string(), z.boolean()),
});
export type ReadinessResponse = z.infer<typeof readinessResponse>;

// ---------------------------------------------------------------------------
// Request body schemas (shared by services and the web client)
// ---------------------------------------------------------------------------

/**
 * A create schema's shape, made partial, with every `.default()` taken off
 * first — the shape a PATCH body has to have.
 *
 * `.partial()` on its own used to be enough. Zod 3 short-circuited an absent
 * optional before its default ran, so an update body only ever held what the
 * caller actually sent. Zod 4 runs the default instead, and the field arrives
 * carrying a value nobody asked for. Nothing downstream can tell the
 * difference: the API writes what it is handed, and its `defined()` filter only
 * drops `undefined`. So a request that renamed a payment would also reset its
 * priority, zero the money already set aside against it, re-activate it if it
 * had been paused, and turn a personal expense into a household-shared one —
 * answering 200 the whole way, with nothing logged and nothing to notice.
 *
 * Stripping the defaults restores the older meaning: absent stays absent. The
 * field keeps its type and every check on it, so an update that *does* name a
 * field is validated exactly as before.
 */
type WithoutDefaults<T extends z.ZodRawShape> = {
  [K in keyof T]: T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K];
};

function patchable<T extends z.ZodRawShape>(shape: T) {
  const stripped = Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      field instanceof z.ZodDefault ? field.removeDefault() : field,
    ]),
  ) as WithoutDefaults<T>;
  return z.object(stripped).partial();
}

export const registerBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1),
});
export type RegisterBody = z.infer<typeof registerBody>;

export const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginBody>;

/** A six-digit authenticator code. Spacing and dashes are tolerated. */
const totpCodeString = z.string().min(6).max(10);

/** Prove the staged TOTP secret works before it becomes binding. */
export const totpEnableBody = z.object({ code: totpCodeString });
export type TotpEnableBody = z.infer<typeof totpEnableBody>;

/** Turning 2FA off accepts either a live code or an unused recovery code. */
export const totpDisableBody = z.object({ code: z.string().min(6).max(32) });
export type TotpDisableBody = z.infer<typeof totpDisableBody>;

/**
 * Second leg of a two-factor login. `pendingToken` comes from the 200 the
 * password step returned; exactly one of `code` / `recoveryCode` is required.
 */
export const loginTotpBody = z
  .object({
    pendingToken: z.string().min(1),
    code: totpCodeString.optional(),
    recoveryCode: z.string().min(6).max(32).optional(),
  })
  .refine((b) => !!b.code !== !!b.recoveryCode, {
    message: "provide either code or recoveryCode",
    path: ["code"],
  });
export type LoginTotpBody = z.infer<typeof loginTotpBody>;

/** Kicks off a password reset. Always answered identically (no enumeration). */
export const forgotPasswordBody = z.object({ email: z.string().email() });
export type ForgotPasswordBody = z.infer<typeof forgotPasswordBody>;

export const resetPasswordBody = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});
export type ResetPasswordBody = z.infer<typeof resetPasswordBody>;

export const createAccountBody = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  currency: currencyCode.default("GBP"),
  openingBalanceMinor: amountMinor.default(0),
  monthlyBufferMinor: amountMinor.default(0),
});
export type CreateAccountBody = z.infer<typeof createAccountBody>;

/**
 * What may be changed about an account: everything except the money it is
 * denominated in.
 *
 * **An account's currency is fixed at creation** (Ben, 2026-08-05). Planning is
 * per currency (ONE-ENGINE decision 10): the pass partitions the scope by
 * currency and derives transfers only within a partition, and a movement whose
 * two ends sit in different partitions has no rate anywhere in this system to
 * convert it with — which is why authoring one is refused. Redenominating an
 * account moved an end *after* that refusal, so a movement could cross a
 * partition boundary that nothing had ever agreed to. Fixing the currency does
 * not handle that state; it stops it existing.
 *
 * `.omit()` is not the whole answer — on its own zod would *strip* the field and
 * answer 200, telling a caller who asked to redenominate an account that they
 * had. The handler rejects the attempt, the same way re-pointing an inflow's
 * ends is rejected. Re-sending the currency the account already has is not an
 * attempt and passes: a client that PATCHes its whole form is not asking for
 * anything.
 */
export const updateAccountBody = patchable(createAccountBody.omit({ currency: true }).shape);
export type UpdateAccountBody = z.infer<typeof updateAccountBody>;

export const createIncomeBody = z.object({
  name: z.string().min(1),
  amountMinor,
  frequency,
  recurrence: recurrence.nullish(),
  anchorDate: isoDate,
  active: z.boolean().default(true),
});
export type CreateIncomeBody = z.infer<typeof createIncomeBody>;
/** Updates may also move the income to another account via `accountId`
 *  (requires edit access to both the source and destination accounts). */
export const updateIncomeBody = patchable(createIncomeBody.shape).extend({
  accountId: z.string().uuid().optional(),
});

/** Where money arriving into an account came from: outside everything you own,
 *  or another account you own. */
export const inflowSourceKind = z.enum(["external", "account"]);
export type InflowSourceKind = z.infer<typeof inflowSourceKind>;

/**
 * Money arriving into an account, authored on the account it arrives in.
 *
 * `source: "external"` is what an income has always been. `source: "account"`
 * is one row with two faces — it arrives on the account it is posted to and
 * leaves `sourceAccountId` — so the two ends can never drift apart.
 *
 * `priority` ranks a movement among everything else leaving the *sending*
 * account, lower first, and is meaningless on an external inflow: nothing sends
 * a salary. Supplying one anyway is refused rather than quietly dropped — a
 * caller who believes they have ordered their income should be told they have
 * not.
 */
const inflowObject = z.object({
  name: z.string().min(1),
  source: inflowSourceKind.default("external"),
  /** Required exactly when `source` is "account", forbidden otherwise, and
   *  never the account the money arrives in. */
  sourceAccountId: z.string().uuid().nullish(),
  amountMinor,
  frequency,
  recurrence: recurrence.nullish(),
  anchorDate: isoDate,
  /** Only for `source: "account"`. Absent means the default rank. */
  priority: z.number().int().optional(),
  active: z.boolean().default(true),
});

export const createInflowBody = inflowObject
  .refine((i) => i.source !== "account" || !!i.sourceAccountId, {
    message: "an account-sourced inflow requires a sourceAccountId",
    path: ["sourceAccountId"],
  })
  .refine((i) => i.source === "account" || !i.sourceAccountId, {
    message: "only an account-sourced inflow may name a sourceAccountId",
    path: ["sourceAccountId"],
  })
  .refine((i) => i.source === "account" || i.priority === undefined, {
    message: "priority is meaningful only for an account-sourced inflow",
    path: ["priority"],
  });
export type CreateInflowBody = z.infer<typeof createInflowBody>;

/**
 * What may be changed about an inflow: everything except which two accounts it
 * runs between.
 *
 * Re-pointing an end is deliberately not an update. A movement is a claim on
 * the sending account's surplus, and moving that claim onto a different account
 * is authoring a new one — it needs the same rights over the new sender that
 * creating it did, and leaves the old sender's plan changed by a request that
 * never named it. Delete and author again; the API rejects the attempt rather
 * than ignoring it.
 */
export const updateInflowBody = patchable(
  inflowObject.omit({ source: true, sourceAccountId: true }).shape,
);
export type UpdateInflowBody = z.infer<typeof updateInflowBody>;

const paymentObject = z.object({
  name: z.string().min(1),
  category: paymentCategory,
  amountMinor,
  dueDate: isoDate.nullish(),
  recurrence: recurrence.nullish(),
  targetDate: isoDate.nullish(),
  priority: z.number().int().default(100),
  alreadySavedMinor: amountMinor.default(0),
  autoRenew: z.boolean().default(true),
  active: z.boolean().default(true),
  notes: z.string().nullish(),
  projectId: z.string().uuid().nullish(),
  /** Household cost-sharing: shared (split by share) or personal (one bearer). */
  scope: paymentScope.default("shared"),
  /** When scope === "personal": the member who bears it. Defaults at compute
   *  time to the owning member of a personal account. */
  bearerUserId: z.string().uuid().nullish(),
  /**
   * Contribution-first goals: "I will set aside this much per month". Honoured
   * only for category "fixed_point" — a recurring bill has a real deadline, so
   * the engine ignores the cap there. With one set, a dueDate is optional: the
   * goal's finish date is derived from the pace instead.
   */
  fixedMonthlyMinor: z.number().int().positive().nullish(),
  /** Free-text label for grouping payments in charts ("housing", "car", …). */
  tag: z.string().trim().min(1).max(40).nullish(),
});
export const createPaymentBody = paymentObject.refine(
  (p) => p.category !== "fixed_point" || !!p.dueDate || !!p.fixedMonthlyMinor,
  {
    message: "fixed_point payments require a dueDate or fixedMonthlyMinor",
    path: ["dueDate"],
  },
);
export type CreatePaymentBody = z.infer<typeof createPaymentBody>;
/** Updates may also move the payment to another account via `accountId`
 *  (requires edit access to both the source and destination accounts). */
export const updatePaymentBody = patchable(paymentObject.shape).extend({
  accountId: z.string().uuid().optional(),
});

export const reorderPaymentsBody = z.object({
  orderedPaymentIds: z.array(z.string().uuid()),
});

/**
 * A what-if overlay for the plan preview: payments and/or incomes to add on top
 * of the account as it stands. Nothing is persisted — the overlay lives for one
 * request. Capped at five of each so a preview stays a glance, not a bulk import;
 * at least one addition is required (an empty overlay is just GET /plan).
 */
export const planPreviewBody = z
  .object({
    addPayments: z.array(createPaymentBody).max(5).optional(),
    addIncomes: z.array(createIncomeBody).max(5).optional(),
  })
  .refine((b) => (b.addPayments?.length ?? 0) + (b.addIncomes?.length ?? 0) > 0, {
    message: "provide at least one payment or income to preview",
    path: ["addPayments"],
  });
export type PlanPreviewBody = z.infer<typeof planPreviewBody>;

export const createHouseholdBody = z.object({ name: z.string().min(1) });
export const addMemberBody = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]).default("member"),
});
export const updateMemberRoleBody = z.object({
  role: z.enum(["admin", "member"]),
});
export const shareAccountBody = z.object({
  householdId: z.string().uuid(),
  permission: z.enum(["view", "edit"]).default("view"),
});

/**
 * A member's proportional contribution to the household's shared costs, in
 * basis points (0–10000, i.e. hundredths of a percent). The engine normalises
 * each member's value by the household total, so the absolute scale is free —
 * 6600/3400 and 66/34 produce the same split.
 */
export const updateMemberShareBody = z.object({
  shareBp: z.number().int().min(0).max(10_000),
});
export type UpdateMemberShareBody = z.infer<typeof updateMemberShareBody>;

/** Assign an account a role within a household plan: a shared pot, or personal
 *  to one member. `memberUserId` is required when role is "personal". */
export const assignAccountBody = z
  .object({
    role: accountRole,
    memberUserId: z.string().uuid().nullish(),
  })
  .refine((a) => a.role !== "personal" || !!a.memberUserId, {
    message: "personal accounts require a memberUserId",
    path: ["memberUserId"],
  });
export type AssignAccountBody = z.infer<typeof assignAccountBody>;

/**
 * Money actually set aside toward a payment. A payment's effective already-saved
 * is its manual base plus the sum of its contributions, so recording one moves
 * the plan without editing the payment. Defaults to the current month.
 */
export const createContributionBody = z.object({
  amountMinor: z.number().int().positive(),
  month: monthString.optional(),
  note: z.string().nullish(),
});
export type CreateContributionBody = z.infer<typeof createContributionBody>;

/**
 * Correcting one that was recorded (decision 30). A mistyped amount is an edit,
 * not a delete and a re-record: deleting one is how a ledger loses the note and
 * the month that said what it was for.
 *
 * Every field optional, because a patch says only what changed — and `note:
 * null` clears the note rather than leaving it. Unlike recording, the month may
 * not be moved into the future: money cannot have been set aside in a month
 * that has not started, and a contribution counts toward what a payment has
 * already saved the moment it is written.
 *
 * A contribution a transfer confirmation wrote is not patchable at all. It is
 * one line of somebody's statement that they moved money, not a fact of its
 * own, and the API refuses rather than letting the statement disagree with its
 * own ledger.
 */
export const updateContributionBody = z.object({
  amountMinor: z.number().int().positive().optional(),
  month: monthString.optional(),
  note: z.string().nullish(),
});
export type UpdateContributionBody = z.infer<typeof updateContributionBody>;

/** A manual balance check-in. Negative balances are allowed (overdraft). One
 *  per account per day; re-stating a day overwrites it. Defaults to today. */
export const upsertBalanceBody = z.object({
  balanceMinor: z.number().int(),
  asOfDate: isoDate.optional(),
});
export type UpsertBalanceBody = z.infer<typeof upsertBalanceBody>;

/** "I made this month's planned transfer." Identifies one of the transfers the
 *  household plan derived. Defaults to the current month. */
export const confirmTransferBody = z.object({
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  memberUserId: z.string().uuid(),
  month: monthString.optional(),
});
export type ConfirmTransferBody = z.infer<typeof confirmTransferBody>;

/**
 * Freeze a month's scorecard: planned vs contributed.
 *
 * The month and nothing else. Closing is a self-scoped action — the caller's
 * own month, every currency partition they plan in, in one go (`MONTH-CLOSE.md`
 * decision 14) — so there is no scope to name and no currency to pick.
 */
export const closeMonthBody = z.object({
  month: monthString,
});
export type CloseMonthBody = z.infer<typeof closeMonthBody>;

/**
 * Personal, or shared into your household — the whole of a project's audience
 * (MINE-AND-OURS decision 22).
 *
 * There is no household id beside it and no permission: a user belongs to
 * exactly one household (`0011`), so "shared" has exactly one possible target
 * and never needs a picker, and it resolves through the owner's membership on
 * the day it is read rather than being stored.
 */
export const projectVisibility = z.enum(["personal", "shared"]);
export type ProjectVisibility = z.infer<typeof projectVisibility>;

export const createProjectBody = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  color: z.string().nullish(),
  targetDate: isoDate.nullish(),
  /** Defaulted, so a client that has never heard of sharing keeps creating
   *  personal projects and every existing caller reads unchanged. */
  visibility: projectVisibility.default("personal"),
});
export type CreateProjectBody = z.infer<typeof createProjectBody>;
/**
 * This is where the hazard `patchable` exists for was first found, back when
 * only one field had it: a `ZodDefault` that survives into a PATCH body makes
 * every update saying nothing about visibility silently set `personal`,
 * quietly un-sharing a project on a rename. The bare optional that used to be
 * hand-written here is now what `patchable` does to every defaulted field, so
 * the special case has gone.
 */
export const updateProjectBody = patchable(createProjectBody.shape);

// ---------------------------------------------------------------------------
// Account settings
// ---------------------------------------------------------------------------

/** Settings a user can change about themselves. Only the digest opt-in so far. */
export const updateMeBody = z.object({
  notifyEmail: z.boolean(),
});
export type UpdateMeBody = z.infer<typeof updateMeBody>;

/**
 * Erasure confirmation. The password is only checked for accounts that have one
 * — an SSO-only user proves themselves by holding a valid access token, so they
 * may send `{"password": ""}` (or any value; it is ignored).
 */
export const deleteMeBody = z.object({
  password: z.string().min(1),
});
export type DeleteMeBody = z.infer<typeof deleteMeBody>;

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

/**
 * A user's data, portable as one JSON document. Deliberately id-free: nothing
 * in here references a database row, so a file exported from one deployment can
 * be imported into another (or back into the same one, as a copy).
 *
 * Consequences of that choice, all intentional:
 *   - Cross-entity links that only exist as ids (a payment's project, a
 *     payment's bearer, a contribution's author) are not carried; see the
 *     per-field notes below.
 *   - Household data (memberships, shares, transfer confirmations) is absent: it
 *     belongs to the household, not to one member, and re-creating it under a
 *     single importing user would invent facts about other people. Month closes
 *     used to be named here too, as a household's; they are one person's now
 *     (`MONTH-CLOSE.md` decision 14), so they travel.
 */
const exportContribution = z.object({
  /** The month this belongs to, as its first day ("2026-08-01"). */
  month: isoDate,
  amountMinor: z.number().int().positive(),
  note: z.string().nullable().default(null),
});

const exportPayment = z.object({
  name: z.string().min(1),
  category: paymentCategory,
  amountMinor,
  dueDate: isoDate.nullable().default(null),
  recurrence: recurrence.nullable().default(null),
  targetDate: isoDate.nullable().default(null),
  priority: z.number().int().default(100),
  alreadySavedMinor: amountMinor.default(0),
  autoRenew: z.boolean().default(true),
  active: z.boolean().default(true),
  notes: z.string().nullable().default(null),
  scope: paymentScope.default("shared"),
  fixedMonthlyMinor: z.number().int().positive().nullable().default(null),
  tag: z.string().nullable().default(null),
  // Deliberately absent: `bearerUserId` and `projectId`. Both are ids of other
  // rows; an id that means nothing on the far side of an import would be a
  // dangling reference, so the link is dropped rather than guessed at.
  contributions: z.array(exportContribution).default([]),
});

const exportIncome = z.object({
  name: z.string().min(1),
  amountMinor,
  frequency,
  recurrence: recurrence.nullable().default(null),
  anchorDate: isoDate,
  active: z.boolean().default(true),
});

/**
 * Money arriving from another of the exporter's own accounts.
 *
 * Its own array rather than a flag on `incomes`, so a file written before
 * movements existed still reads exactly as it did: `incomes` is, and stays, the
 * external inflows.
 *
 * The source account travels **by name**, not by id: ids are minted fresh on
 * import, so an id would land on the far side as a dangling reference — the same
 * reasoning that drops `bearerUserId` from a payment. A movement whose source
 * account is not in the same file is dropped on import rather than imported
 * pointing at nothing.
 */
/**
 * "I moved this money", for one month of one movement.
 *
 * Household transfer confirmations stay out of the file for the reason the
 * header gives — they are an arrangement between people. A *standalone* one is
 * not: it is a fact about two accounts the exporter owns, and it drives
 * `confirmedInflowMinor` and whether a line reads funded or still awaiting a
 * transfer. Dropping it would let a restore quietly un-move money that moved.
 */
const exportInflowConfirmation = z.object({
  /** The month it was confirmed for, as its first day ("2026-08-01"). */
  month: isoDate,
  /** What the movement delivered when it was confirmed. */
  amountMinor,
});

const exportAccountInflow = z.object({
  name: z.string().min(1),
  /** The exported account this money leaves. */
  fromAccountName: z.string().min(1),
  amountMinor,
  frequency,
  recurrence: recurrence.nullable().default(null),
  anchorDate: isoDate,
  /** Rank among the sending account's movements, lower first. */
  priority: z.number().int().default(100),
  active: z.boolean().default(true),
  /** Months this movement was confirmed as actually made. */
  confirmations: z.array(exportInflowConfirmation).default([]),
});

/**
 * "I moved this money", for a transfer the **plan derived** rather than one
 * anybody authored.
 *
 * The same fact as `exportInflowConfirmation` about a movement with no row: an
 * expense pot with no income of its own is fed by a transfer the pass works
 * out, and since migration 0010 that transfer can be confirmed by a user with
 * no household. There is no `accountInflow` to hang it off — that is the whole
 * point of a derived feed — so it travels beside them, on the account the money
 * lands in, naming its sender the way `exportAccountInflow` does: by name,
 * because ids are minted fresh on import.
 *
 * Confirmations belonging to a household stay out of the file for the reason
 * the header gives, and so does one recorded by anybody but the exporter: it is
 * somebody else's record of their own money moving.
 */
const exportDerivedTransferConfirmation = exportInflowConfirmation.extend({
  /** The exported account this money left. */
  fromAccountName: z.string().min(1),
});

const exportBalanceSnapshot = z.object({
  asOfDate: isoDate,
  /** May be negative (overdraft). */
  balanceMinor: z.number().int(),
});

/**
 * A month the exporter has closed, in one currency.
 *
 * **At the file's top level, not inside an account**, because that is where the
 * fact lives: a close is per user, per currency (`MONTH-CLOSE.md` decision 14),
 * scoring what one person earned, planned and set aside across every account
 * they plan in. Hanging it off an account would have to pick one, and there is
 * no account it is about.
 *
 * The version does not move for this. A file written before the change carries
 * its closes inside `accounts[]`, where nothing reads them any more, and the
 * schema drops unknown keys — so an old file still restores, minus a scorecard.
 * That is a loss of nothing: no close row has ever been written by a shipped
 * scope (decision 17, the alpha grant), so there is no data behind the shape.
 */
const exportMonthClose = z.object({
  /** The closed month, as its first day ("2026-07-01"). */
  month: isoDate,
  /** Which currency partition it scores — a user plans in as many as they hold
   *  accounts in, and closes every one of them at once. */
  currency: currencyCode,
  incomeMinor: amountMinor,
  plannedMinor: amountMinor,
  contributedMinor: amountMinor,
});

const exportAccount = z.object({
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  currency: currencyCode,
  openingBalanceMinor: amountMinor.default(0),
  monthlyBufferMinor: amountMinor.default(0),
  incomes: z.array(exportIncome).default([]),
  accountInflows: z.array(exportAccountInflow).default([]),
  /** Confirmed transfers into this account that no movement above describes,
   *  because the plan derived them. Defaulted, so a file written before this
   *  field existed still reads. */
  derivedTransferConfirmations: z.array(exportDerivedTransferConfirmation).default([]),
  payments: z.array(exportPayment).default([]),
  balanceSnapshots: z.array(exportBalanceSnapshot).default([]),
});

const exportProject = z.object({
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  color: z.string().nullable().default(null),
  targetDate: isoDate.nullable().default(null),
});

export const exportFileSchema = z.object({
  /** Bump when the shape changes incompatibly; importers reject anything else. */
  version: z.literal(1),
  exportedAt: isoDateTime,
  accounts: z.array(exportAccount).default([]),
  projects: z.array(exportProject).default([]),
  /** The exporter's own frozen months, one row per month per currency. */
  closes: z.array(exportMonthClose).default([]),
});
export type ExportFile = z.infer<typeof exportFileSchema>;
export type ExportAccount = z.infer<typeof exportAccount>;
export type ExportPayment = z.infer<typeof exportPayment>;

/**
 * Import takes what export produced — and refuses what it cannot restore.
 *
 * An account name is this file's only way of saying *which account*. A movement
 * names the account it leaves, a derived confirmation names its sender, and a
 * contribution names the confirmation that wrote it, all by name, because ids
 * are minted fresh on import. Two accounts called the same thing make every one
 * of those references ambiguous, and resolving them to whichever account came
 * first is a guess wearing a restore's clothes: **the file is refused, naming
 * the duplicate** (Ben, 2026-08-07, decision 29).
 *
 * Refused whole, and whether or not anything in it happens to point at the twin.
 * A document whose names are not identities is not one this schema can promise
 * to restore, and "it would have been fine this time" is not a property a backup
 * should be trusted on.
 *
 * The rule lives here, at the one point the file is validated, rather than at
 * each of the four places a name is looked up — so it is asked once, and
 * answered before a single row is written.
 *
 * `exportFileSchema` itself stays permissive on purpose: a user really can own
 * two accounts called "Savings", and the export of that estate is an honest
 * record of it. What it is not is importable, and the loud refusal is the point
 * — the alternative is a restore that silently reassembles somebody's money
 * under the wrong account.
 */
export const importBody = exportFileSchema.superRefine((file, ctx) => {
  const firstIndex = new Map<string, number>();
  const count = new Map<string, number>();
  file.accounts.forEach((a, index) => {
    if (!firstIndex.has(a.name)) firstIndex.set(a.name, index);
    count.set(a.name, (count.get(a.name) ?? 0) + 1);
  });
  for (const [name, n] of count) {
    if (n < 2) continue;
    // Single quotes around the name deliberately: this message travels to the
    // client inside a JSON-encoded issue list, and a double-quoted name comes
    // out the far side backslash-escaped and harder to read than the name it
    // is trying to show somebody.
    ctx.addIssue({
      code: "custom",
      path: ["accounts", firstIndex.get(name)!, "name"],
      message: `${n} accounts in this file are named '${name}'. An account name is how this file says which account, so a repeated one cannot be restored faithfully - rename one of them and export again.`,
    });
  }
});
export type ImportBody = ExportFile;
