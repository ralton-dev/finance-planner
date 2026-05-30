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

export const paymentCategory = z.enum([
  "monthly_recurring",
  "yearly_recurring",
  "custom_recurring",
  "fixed_point",
]);
export type PaymentCategory = z.infer<typeof paymentCategory>;

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
export const updateIncomeBody = createIncomeBody.partial();

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
});
export const createPaymentBody = paymentObject.refine(
  (p) => p.category !== "fixed_point" || !!p.dueDate,
  { message: "fixed_point payments require a dueDate", path: ["dueDate"] },
);
export type CreatePaymentBody = z.infer<typeof createPaymentBody>;
export const updatePaymentBody = paymentObject.partial();

export const reorderPaymentsBody = z.object({
  orderedPaymentIds: z.array(z.string().uuid()),
});

export const createHouseholdBody = z.object({ name: z.string().min(1) });
export const addMemberBody = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]).default("member"),
});
export const shareAccountBody = z.object({
  householdId: z.string().uuid(),
  permission: z.enum(["view", "edit"]).default("view"),
});
