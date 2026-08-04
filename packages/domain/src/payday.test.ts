import { describe, expect, it } from "vitest";
import type { Transfer } from "./household.js";
import { type MemberIncomes, splitTransfersByPayday } from "./payday.js";
import type { IncomeInput } from "./types.js";

const AS_OF = "2026-08-03"; // a Monday in a 31-day month

// --- factories ---------------------------------------------------------------

function income(anchorDate: string, over: Partial<IncomeInput> = {}): IncomeInput {
  return { id: "inc", amountMinor: 300_000, frequency: "monthly", anchorDate, ...over };
}

function transfer(amountMinor: number, over: Partial<Transfer> = {}): Transfer {
  return {
    fromAccountId: "alice-cur",
    toAccountId: "bills",
    memberUserId: "alice",
    amountMinor,
    ...over,
  };
}

const forMember = (memberUserId: string, incomes: IncomeInput[]): MemberIncomes => ({
  memberUserId,
  incomes,
});

/** The one schedule of a single-member split. */
function only(transfers: Transfer[], incomes: IncomeInput[], asOfDate = AS_OF) {
  const schedules = splitTransfersByPayday(transfers, [forMember("alice", incomes)], asOfDate);
  expect(schedules).toHaveLength(1);
  return schedules[0]!;
}

const dates = (schedule: { events: { date: string }[] }) => schedule.events.map((e) => e.date);
const totals = (schedule: { events: { totalMinor: number }[] }) =>
  schedule.events.map((e) => e.totalMinor);

// --- locating paydays --------------------------------------------------------

describe("splitTransfersByPayday — pay dates", () => {
  it("puts a monthly income's payday on its anchor day-of-month", () => {
    const schedule = only([transfer(120_000)], [income("2026-01-15")]);
    expect(dates(schedule)).toEqual(["2026-08-15"]);
    expect(totals(schedule)).toEqual([120_000]);
  });

  it("clamps a month-end anchor into a shorter month", () => {
    // Paid on the 31st; September only has 30 days.
    const schedule = only([transfer(1_000)], [income("2026-01-31")], "2026-09-10");
    expect(dates(schedule)).toEqual(["2026-09-30"]);
  });

  it("splits across a fortnightly cadence's three paydays", () => {
    const custom = income("2026-07-01", {
      frequency: "custom",
      recurrence: { interval: 2, unit: "week", anchor: "2026-07-01" },
    });
    const schedule = only([transfer(90_000)], [custom], "2026-07-20");
    expect(dates(schedule)).toEqual(["2026-07-01", "2026-07-15", "2026-07-29"]);
    expect(totals(schedule)).toEqual([30_000, 30_000, 30_000]);
  });

  it("drops to two paydays in a month the same cadence only hits twice", () => {
    const custom = income("2026-07-01", {
      frequency: "custom",
      recurrence: { interval: 2, unit: "week", anchor: "2026-07-01" },
    });
    const schedule = only([transfer(90_000)], [custom]);
    expect(dates(schedule)).toEqual(["2026-08-12", "2026-08-26"]);
    expect(totals(schedule)).toEqual([45_000, 45_000]);
  });

  it("lets a recurrence override a monthly frequency", () => {
    const weekly = income("2026-08-04", {
      recurrence: { interval: 2, unit: "week", anchor: "2026-08-04" },
    });
    expect(dates(only([transfer(100)], [weekly]))).toEqual(["2026-08-04", "2026-08-18"]);
  });

  it("falls back to the anchor day for a custom income with no recurrence", () => {
    const custom = income("2026-01-09", { frequency: "custom" });
    expect(dates(only([transfer(100)], [custom]))).toEqual(["2026-08-09"]);
  });

  it("pays a yearly income only in its anchor month", () => {
    const yearly = income("2025-08-20", { frequency: "yearly" });
    expect(dates(only([transfer(100)], [yearly]))).toEqual(["2026-08-20"]);
    // A different month → no payday at all, so the synthetic event stands in.
    expect(dates(only([transfer(100)], [yearly], "2026-09-03"))).toEqual(["2026-09-01"]);
  });

  it("pays a one-off income only in the month it falls in", () => {
    const oneOff = income("2026-08-22", { frequency: "one_off" });
    expect(dates(only([transfer(100)], [oneOff]))).toEqual(["2026-08-22"]);
    expect(dates(only([transfer(100)], [oneOff], "2026-09-03"))).toEqual(["2026-09-01"]);
    // Same month number, different year → not this month's income.
    expect(dates(only([transfer(100)], [oneOff], "2027-08-03"))).toEqual(["2027-08-01"]);
  });

  it("ignores inactive incomes", () => {
    const schedule = only([transfer(100)], [income("2026-01-15", { active: false })]);
    expect(dates(schedule)).toEqual(["2026-08-01"]);
  });

  it("falls back to the first of the month when there is no income", () => {
    const schedule = only([transfer(75_000)], []);
    expect(dates(schedule)).toEqual(["2026-08-01"]);
    expect(totals(schedule)).toEqual([75_000]);
  });

  it("merges two incomes that pay on the same day and sorts the rest", () => {
    const schedule = only(
      [transfer(300)],
      [
        income("2026-01-25", { id: "salary" }),
        income("2026-03-25", { id: "second-job" }),
        income("2026-05-07", { id: "rental" }),
      ],
    );
    expect(dates(schedule)).toEqual(["2026-08-07", "2026-08-25"]);
    expect(totals(schedule)).toEqual([150, 150]);
  });
});

// --- splitting ---------------------------------------------------------------

describe("splitTransfersByPayday — splitting", () => {
  const twoPaydays = [income("2026-08-05"), income("2026-08-20", { id: "inc2" })];

  it("lands the rounding remainder on the earliest payday", () => {
    const schedule = only([transfer(1_001)], twoPaydays);
    expect(totals(schedule)).toEqual([501, 500]);
    expect(totals(schedule).reduce((s, t) => s + t, 0)).toBe(1_001);
  });

  it("splits three ways with the remainder walking forward from the earliest", () => {
    const schedule = only([transfer(100)], [...twoPaydays, income("2026-08-28", { id: "inc3" })]);
    expect(totals(schedule)).toEqual([34, 33, 33]);
  });

  it("drops zero slices but keeps the payday", () => {
    const schedule = only([transfer(1)], twoPaydays);
    expect(schedule.events[0]!.transfers).toHaveLength(1);
    expect(schedule.events[1]!.transfers).toEqual([]);
    expect(totals(schedule)).toEqual([1, 0]);
  });

  it("keeps a line item per transfer on each payday", () => {
    const schedule = only(
      [transfer(100_000, { toAccountId: "bills" }), transfer(50_000, { toAccountId: "savings" })],
      twoPaydays,
    );
    expect(schedule.events[0]!.transfers).toEqual([
      { fromAccountId: "alice-cur", toAccountId: "bills", amountMinor: 50_000 },
      { fromAccountId: "alice-cur", toAccountId: "savings", amountMinor: 25_000 },
    ]);
    expect(totals(schedule)).toEqual([75_000, 75_000]);
  });

  it("sums each member's events back to their planned transfers", () => {
    const transfers = [transfer(66_667), transfer(33_333, { toAccountId: "savings" })];
    const schedule = only(transfers, twoPaydays);
    const moved = schedule.events
      .flatMap((e) => e.transfers)
      .reduce((s, t) => s + t.amountMinor, 0);
    expect(moved).toBe(100_000);
  });
});

// --- members -----------------------------------------------------------------

describe("splitTransfersByPayday — members", () => {
  const members = [
    forMember("alice", [income("2026-08-05")]),
    forMember("bob", [income("2026-08-14")]),
    forMember("carol", [income("2026-08-21")]),
  ];

  it("preserves input member order and gives the transfer-less an empty schedule", () => {
    const schedules = splitTransfersByPayday(
      [transfer(60_000, { memberUserId: "carol", fromAccountId: "carol-cur" }), transfer(40_000)],
      members,
      AS_OF,
    );
    expect(schedules.map((s) => s.memberUserId)).toEqual(["alice", "bob", "carol"]);
    expect(schedules[1]!.events).toEqual([]);
    expect(dates(schedules[0]!)).toEqual(["2026-08-05"]);
    expect(dates(schedules[2]!)).toEqual(["2026-08-21"]);
    expect(totals(schedules[2]!)).toEqual([60_000]);
  });

  it("ignores transfers belonging to nobody in the roster", () => {
    const schedules = splitTransfersByPayday(
      [transfer(10_000, { memberUserId: "dave" })],
      members,
      AS_OF,
    );
    expect(schedules.every((s) => s.events.length === 0)).toBe(true);
  });

  it("returns nothing for an empty roster", () => {
    expect(splitTransfersByPayday([transfer(10_000)], [], AS_OF)).toEqual([]);
  });

  it("never mutates its inputs", () => {
    const transfers = [transfer(1_001), transfer(2_000, { memberUserId: "bob" })];
    const roster = members.map((m) => ({ ...m, incomes: m.incomes.map((i) => ({ ...i })) }));
    const before = JSON.stringify({ transfers, roster });
    splitTransfersByPayday(transfers, roster, AS_OF);
    expect(JSON.stringify({ transfers, roster })).toBe(before);
  });
});
