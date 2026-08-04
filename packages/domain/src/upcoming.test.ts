import { describe, expect, it } from "vitest";
import type { PaymentInput } from "./types.js";
import { clampUpcomingDays, upcomingPayments } from "./upcoming.js";

const AS_OF = "2026-08-03";

// --- factories ---------------------------------------------------------------

function pay(over: Partial<PaymentInput> & { id: string }): PaymentInput {
  return {
    name: over.id,
    category: "monthly_recurring",
    amountMinor: 5_000,
    ...over,
  };
}

const feed = (payments: PaymentInput[], days = 14, asOfDate = AS_OF) =>
  upcomingPayments(payments, asOfDate, days);

const due = (payments: PaymentInput[], days = 14, asOfDate = AS_OF) =>
  feed(payments, days, asOfDate).map((r) => r.dueDate);

// --- window ------------------------------------------------------------------

describe("upcomingPayments — window", () => {
  const goal = (dueDate: string) => pay({ id: dueDate, category: "fixed_point", dueDate });

  it("includes something due today with daysUntil 0", () => {
    const rows = feed([goal(AS_OF)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.daysUntil).toBe(0);
    expect(rows[0]!.dueDate).toBe(AS_OF);
  });

  it("includes the last day of the window and excludes the day after", () => {
    expect(due([goal("2026-08-17"), goal("2026-08-18")])).toEqual(["2026-08-17"]);
  });

  it("reports whole days until each hit", () => {
    expect(feed([goal("2026-08-13")])[0]!.daysUntil).toBe(10);
  });

  it("excludes an overdue goal — the plan already flags it off-track", () => {
    expect(feed([goal("2026-08-02")])).toEqual([]);
  });

  it("skips inactive payments", () => {
    expect(feed([{ ...goal("2026-08-10"), active: false }])).toEqual([]);
  });

  it("carries the payment's identity onto every row", () => {
    const rows = feed([
      pay({
        id: "p1",
        name: "Car tax",
        category: "fixed_point",
        amountMinor: 22_000,
        dueDate: "2026-08-09",
      }),
    ]);
    expect(rows[0]).toEqual({
      paymentId: "p1",
      name: "Car tax",
      category: "fixed_point",
      amountMinor: 22_000,
      dueDate: "2026-08-09",
      daysUntil: 6,
    });
  });

  it("prefers a goal's target date over its due date", () => {
    const rows = feed([
      pay({ id: "g", category: "fixed_point", dueDate: "2026-12-01", targetDate: "2026-08-11" }),
    ]);
    expect(rows[0]!.dueDate).toBe("2026-08-11");
  });

  it("skips a dateless goal", () => {
    expect(feed([pay({ id: "g", category: "fixed_point" })])).toEqual([]);
  });
});

// --- cadences ----------------------------------------------------------------

describe("upcomingPayments — cadences", () => {
  it("emits every hit of a fortnightly cadence in the window", () => {
    const rent = pay({
      id: "cleaner",
      category: "custom_recurring",
      dueDate: "2026-08-05",
      recurrence: { interval: 2, unit: "week", anchor: "2026-08-05" },
    });
    expect(due([rent], 30)).toEqual(["2026-08-05", "2026-08-19", "2026-09-02"]);
  });

  it("steps a yearly bill from its due date", () => {
    const insurance = pay({ id: "insurance", category: "yearly_recurring", dueDate: "2026-08-10" });
    expect(due([insurance])).toEqual(["2026-08-10"]);
    // A year on, the same bill lands again.
    expect(due([insurance], 14, "2027-08-01")).toEqual(["2027-08-10"]);
  });

  it("skips a yearly bill with no due date to pin it to", () => {
    expect(feed([pay({ id: "vague", category: "yearly_recurring" })], 90)).toEqual([]);
  });

  it("treats a cadence-less custom bill as a single dated hit", () => {
    const oneShot = pay({ id: "one-shot", category: "custom_recurring", dueDate: "2026-08-08" });
    expect(due([oneShot])).toEqual(["2026-08-08"]);
    expect(due([oneShot], 14, "2026-09-01")).toEqual([]);
  });

  it("anchors a due-date-less cadence to the window start", () => {
    const gym = pay({
      id: "gym",
      category: "custom_recurring",
      recurrence: { interval: 1, unit: "week", anchor: "2026-08-03" },
    });
    expect(due([gym])).toEqual(["2026-08-03", "2026-08-10", "2026-08-17"]);
  });

  it("skips a cadence-less custom bill with no due date", () => {
    expect(feed([pay({ id: "nothing", category: "custom_recurring" })])).toEqual([]);
  });
});

// --- monthly bills -----------------------------------------------------------

describe("upcomingPayments — monthly bills", () => {
  it("repeats the due date's day-of-month, clamped to short months", () => {
    const rent = pay({ id: "rent", dueDate: "2026-01-31" });
    // 60 days from 1 April: 30 April (clamped from the 31st) and 31 May (the
    // window's inclusive last day).
    expect(due([rent], 60, "2026-04-01")).toEqual(["2026-04-30", "2026-05-31"]);
  });

  it("skips the current month once the day has passed", () => {
    expect(due([pay({ id: "phone", dueDate: "2026-01-01" })], 40)).toEqual(["2026-09-01"]);
  });

  it("skips a monthly bill with no due date — no calendar day to pin", () => {
    expect(feed([pay({ id: "subs" })], 90)).toEqual([]);
  });

  it("rolls a monthly bill over the year boundary", () => {
    expect(due([pay({ id: "rent", dueDate: "2026-05-15" })], 90, "2026-11-20")).toEqual([
      "2026-12-15",
      "2027-01-15",
      "2027-02-15",
    ]);
  });

  it("hits every month across a long window", () => {
    expect(due([pay({ id: "rent", dueDate: "2026-08-15" })], 90)).toEqual([
      "2026-08-15",
      "2026-09-15",
      "2026-10-15",
    ]);
  });
});

// --- ordering + clamping -----------------------------------------------------

describe("upcomingPayments — ordering and window length", () => {
  it("sorts by due date, then by name", () => {
    const rows = feed([
      pay({ id: "b", name: "Zebra", category: "fixed_point", dueDate: "2026-08-10" }),
      pay({ id: "c", name: "Apple", category: "fixed_point", dueDate: "2026-08-10" }),
      pay({ id: "a", name: "Milk", category: "fixed_point", dueDate: "2026-08-04" }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Milk", "Apple", "Zebra"]);
  });

  it("clamps the window to 1..90 days, defaulting garbage to a fortnight", () => {
    expect(clampUpcomingDays(0)).toBe(1);
    expect(clampUpcomingDays(-5)).toBe(1);
    expect(clampUpcomingDays(500)).toBe(90);
    expect(clampUpcomingDays(7.9)).toBe(7);
    expect(clampUpcomingDays(undefined)).toBe(14);
    expect(clampUpcomingDays(Number.NaN)).toBe(14);
  });

  it("applies the clamp to the feed itself", () => {
    const goal = pay({ id: "g", category: "fixed_point", dueDate: "2026-08-04" });
    const far = pay({ id: "f", category: "fixed_point", dueDate: "2026-10-30" });
    // days: 0 → 1, so tomorrow is in and October is not.
    expect(due([goal, far], 0)).toEqual(["2026-08-04"]);
    // days: 500 → 90, which reaches 1 November.
    expect(due([goal, far], 500)).toEqual(["2026-08-04", "2026-10-30"]);
  });

  it("returns an empty feed for no payments", () => {
    expect(feed([])).toEqual([]);
  });
});
