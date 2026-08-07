import { describe, expect, it } from "vitest";
import {
  createAccountBody,
  createIncomeBody,
  createPaymentBody,
  createProjectBody,
  updateAccountBody,
  updateIncomeBody,
  updateInflowBody,
  updatePaymentBody,
  updateProjectBody,
} from "./index.js";

/**
 * A PATCH body may only carry what the caller actually sent.
 *
 * The update schemas are built by making a create schema partial, and several
 * of the fields underneath carry `.default()`. Under zod 3 a default sitting
 * inside an optional never ran, so an absent field stayed `undefined` and the
 * API's `defined()` filter dropped it before it reached the store. Zod 4 runs
 * it — so without the stripping these schemas now do, a request that renamed a
 * payment would arrive carrying `priority: 100`, `alreadySavedMinor: 0`,
 * `scope: "shared"` and `active: true`, and overwrite every one of them.
 *
 * That is silent data loss with no error anywhere: a personal expense becomes
 * a household-shared one, money already set aside is zeroed, a deactivated
 * payment comes back to life, and the caller is told 200.
 */
describe("PATCH bodies carry only what was sent", () => {
  it("leaves an empty account update empty", () => {
    expect(updateAccountBody.parse({})).toEqual({});
  });

  it("does not reset an account's balances on a rename", () => {
    const body = updateAccountBody.parse({ name: "Renamed" });
    expect(body).toEqual({ name: "Renamed" });
    expect(body).not.toHaveProperty("openingBalanceMinor");
    expect(body).not.toHaveProperty("monthlyBufferMinor");
  });

  it("does not reset a payment's priority, savings, scope or active flag on a rename", () => {
    const body = updatePaymentBody.parse({ name: "Renamed" });
    expect(body).toEqual({ name: "Renamed" });
    for (const field of [
      "priority",
      "alreadySavedMinor",
      "autoRenew",
      "active",
      "scope",
    ] as const) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it("does not reactivate a paused income or inflow", () => {
    expect(updateIncomeBody.parse({})).toEqual({});
    expect(updateInflowBody.parse({})).toEqual({});
  });

  it("does not un-share a shared project on a rename", () => {
    const body = updateProjectBody.parse({ name: "Renamed" });
    expect(body).toEqual({ name: "Renamed" });
    expect(body).not.toHaveProperty("visibility");
  });

  it("still carries a field the caller did send, including a falsy one", () => {
    expect(updatePaymentBody.parse({ active: false, priority: 5 })).toEqual({
      active: false,
      priority: 5,
    });
    expect(updateAccountBody.parse({ openingBalanceMinor: 0 })).toEqual({
      openingBalanceMinor: 0,
    });
  });

  it("still validates the fields it does carry", () => {
    expect(updatePaymentBody.safeParse({ priority: 1.5 }).success).toBe(false);
    expect(updatePaymentBody.safeParse({ scope: "nonsense" }).success).toBe(false);
    expect(updateAccountBody.safeParse({ openingBalanceMinor: -1 }).success).toBe(false);
    expect(updateIncomeBody.safeParse({ frequency: "fortnightly" }).success).toBe(false);
  });

  it("still lets an update move a payment or income to another account", () => {
    const accountId = "9f8b2c1d-4e5a-4b6c-8d9e-0f1a2b3c4d5e";
    expect(updatePaymentBody.parse({ accountId })).toEqual({ accountId });
    expect(updateIncomeBody.parse({ accountId })).toEqual({ accountId });
  });

  it("still refuses to carry an account's currency, which is fixed at creation", () => {
    expect(updateAccountBody.parse({ name: "A", currency: "USD" })).toEqual({ name: "A" });
  });

  it("still refuses to re-point an inflow's ends", () => {
    expect(updateInflowBody.parse({ source: "account", sourceAccountId: null, name: "M" })).toEqual(
      { name: "M" },
    );
  });
});

/**
 * `patchable` maps over a shape, so its return type is inferred rather than
 * written down. These assertions are compile-time, not runtime: if the mapping
 * ever collapsed to `any` the `@ts-expect-error` lines would stop erroring and
 * `tsc` would fail on the unused directives — which is the point of them.
 */
describe("PATCH bodies keep their inferred types", () => {
  it("still knows each field's type, and that every field is optional", () => {
    const payment = updatePaymentBody.parse({});
    const priority: number | undefined = payment.priority;
    const scope: "shared" | "personal" | undefined = payment.scope;
    const account = updateAccountBody.parse({});
    const opening: number | undefined = account.openingBalanceMinor;
    expect([priority, scope, opening]).toEqual([undefined, undefined, undefined]);

    // @ts-expect-error priority is a number, not a string
    const wrong: string | undefined = payment.priority;
    // @ts-expect-error the field is optional, so it is not assignable to a bare number
    const notOptional: number = payment.priority;
    expect([wrong, notOptional]).toEqual([undefined, undefined]);
  });
});

/** The mirror image: creating something must still apply every default. */
describe("create bodies still apply their defaults", () => {
  it("defaults a new account's currency and balances", () => {
    expect(createAccountBody.parse({ name: "Acct" })).toEqual({
      name: "Acct",
      currency: "GBP",
      openingBalanceMinor: 0,
      monthlyBufferMinor: 0,
    });
  });

  it("defaults a new payment's priority, scope and flags", () => {
    expect(
      createPaymentBody.parse({ name: "Bill", category: "monthly_recurring", amountMinor: 1000 }),
    ).toMatchObject({
      priority: 100,
      alreadySavedMinor: 0,
      autoRenew: true,
      active: true,
      scope: "shared",
    });
  });

  it("defaults a new income to active and a new project to personal", () => {
    expect(
      createIncomeBody.parse({
        name: "Pay",
        amountMinor: 100,
        frequency: "monthly",
        anchorDate: "2026-08-01",
      }),
    ).toMatchObject({ active: true });
    expect(createProjectBody.parse({ name: "Proj" })).toMatchObject({ visibility: "personal" });
  });
});
