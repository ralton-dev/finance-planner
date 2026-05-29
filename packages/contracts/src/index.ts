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
