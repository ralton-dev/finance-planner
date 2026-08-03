import { z } from "zod";

/**
 * Shared API contracts (DTOs / Zod schemas) used by both the backend services
 * and the web client. Keeping them here removes drift between client and server.
 *
 * Money is always expressed in integer **minor units** (e.g. pennies). Never use
 * floats for currency.
 */

/** ISO 4217 currency code, e.g. "GBP". */
export const currencyCode = z.string().length(3).toUpperCase();

/** Integer amount in minor units (pennies). Non-negative. */
export const amountMinor = z.number().int().nonnegative();

/** ISO date string (date-only), e.g. "2026-08-01". */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

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

export const createAccountBody = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  currency: currencyCode.default("GBP"),
  openingBalanceMinor: amountMinor.default(0),
  monthlyBufferMinor: amountMinor.default(0),
});
export type CreateAccountBody = z.infer<typeof createAccountBody>;
export const updateAccountBody = createAccountBody.partial();

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
export const updateIncomeBody = createIncomeBody.partial().extend({
  accountId: z.string().uuid().optional(),
});

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
});
export const createPaymentBody = paymentObject.refine(
  (p) => p.category !== "fixed_point" || !!p.dueDate,
  { message: "fixed_point payments require a dueDate", path: ["dueDate"] },
);
export type CreatePaymentBody = z.infer<typeof createPaymentBody>;
/** Updates may also move the payment to another account via `accountId`
 *  (requires edit access to both the source and destination accounts). */
export const updatePaymentBody = paymentObject.partial().extend({
  accountId: z.string().uuid().optional(),
});

export const reorderPaymentsBody = z.object({
  orderedPaymentIds: z.array(z.string().uuid()),
});

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

/** Freeze a month's scorecard: planned vs contributed. */
export const closeMonthBody = z.object({
  month: monthString,
});
export type CloseMonthBody = z.infer<typeof closeMonthBody>;

export const createProjectBody = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  color: z.string().nullish(),
  targetDate: isoDate.nullish(),
});
export type CreateProjectBody = z.infer<typeof createProjectBody>;
export const updateProjectBody = createProjectBody.partial();
