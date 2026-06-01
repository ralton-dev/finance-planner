import { describe, expect, it } from "vitest";
import {
  addUnit,
  ceilDiv,
  intervalInMonths,
  monthsUntil,
  nextOccurrence,
  occurrencesInMonth,
  parseISODate,
  toISODate,
  wholeMonthsBetween,
} from "./dates.js";

describe("parseISODate / toISODate", () => {
  it("round-trips an ISO date in UTC", () => {
    expect(toISODate(parseISODate("2026-08-01"))).toBe("2026-08-01");
  });
});

describe("wholeMonthsBetween", () => {
  it("subtracts a month when the target day-of-month is earlier", () => {
    expect(wholeMonthsBetween(parseISODate("2026-01-15"), parseISODate("2026-03-10"))).toBe(1);
  });
  it("returns negative spans", () => {
    expect(wholeMonthsBetween(parseISODate("2026-03-01"), parseISODate("2026-01-01"))).toBe(-2);
  });
});

describe("monthsUntil", () => {
  it("floors at 1 for past/this-month dates", () => {
    expect(monthsUntil(parseISODate("2026-01-01"), parseISODate("2025-06-01"))).toBe(1);
    expect(monthsUntil(parseISODate("2026-01-01"), parseISODate("2026-01-20"))).toBe(1);
  });
});

describe("intervalInMonths", () => {
  it("handles month and year units exactly", () => {
    expect(intervalInMonths({ interval: 3, unit: "month", anchor: "2026-01-01" })).toBe(3);
    expect(intervalInMonths({ interval: 1, unit: "year", anchor: "2026-01-01" })).toBe(12);
  });
  it("approximates week and day units", () => {
    expect(intervalInMonths({ interval: 2, unit: "week", anchor: "2026-01-01" })).toBeCloseTo(
      0.46,
      2,
    );
    expect(intervalInMonths({ interval: 15, unit: "day", anchor: "2026-01-01" })).toBeCloseTo(
      0.49,
      2,
    );
  });
});

describe("addUnit", () => {
  it("adds days and weeks", () => {
    expect(toISODate(addUnit(parseISODate("2026-01-01"), 10, "day"))).toBe("2026-01-11");
    expect(toISODate(addUnit(parseISODate("2026-01-01"), 2, "week"))).toBe("2026-01-15");
  });
  it("clamps month-ends", () => {
    expect(toISODate(addUnit(parseISODate("2026-01-31"), 1, "month"))).toBe("2026-02-28");
  });
  it("adds years", () => {
    expect(toISODate(addUnit(parseISODate("2026-01-31"), 1, "year"))).toBe("2027-01-31");
  });
});

describe("nextOccurrence", () => {
  it("advances a past anchor to the first occurrence on/after now", () => {
    const occ = nextOccurrence(
      parseISODate("2025-01-15"),
      { interval: 1, unit: "month", anchor: "2025-01-15" },
      parseISODate("2026-01-01"),
    );
    expect(toISODate(occ)).toBe("2026-01-15");
  });
  it("returns a future anchor unchanged", () => {
    const occ = nextOccurrence(
      parseISODate("2026-03-01"),
      { interval: 3, unit: "month", anchor: "2026-03-01" },
      parseISODate("2026-01-01"),
    );
    expect(toISODate(occ)).toBe("2026-03-01");
  });
});

describe("occurrencesInMonth", () => {
  it("counts a fortnightly cadence that falls twice in the month", () => {
    // 06-11 and 06-25 land in June; 07-09 does not.
    expect(
      occurrencesInMonth(
        parseISODate("2026-06-11"),
        { interval: 2, unit: "week", anchor: "2026-06-11" },
        parseISODate("2026-06-01"),
      ),
    ).toBe(2);
  });

  it("counts three when the dates straddle the whole month", () => {
    // 07-01, 07-15, 07-29 all land in July.
    expect(
      occurrencesInMonth(
        parseISODate("2026-07-01"),
        { interval: 2, unit: "week", anchor: "2026-07-01" },
        parseISODate("2026-07-20"),
      ),
    ).toBe(3);
  });

  it("ignores occurrences before the anchor", () => {
    // Anchor mid-month → only 06-20 counts in June, not an imagined 06-06.
    expect(
      occurrencesInMonth(
        parseISODate("2026-06-20"),
        { interval: 2, unit: "week", anchor: "2026-06-20" },
        parseISODate("2026-06-01"),
      ),
    ).toBe(1);
  });

  it("returns zero when the next occurrence is a future month", () => {
    expect(
      occurrencesInMonth(
        parseISODate("2026-03-01"),
        { interval: 3, unit: "month", anchor: "2026-03-01" },
        parseISODate("2026-01-01"),
      ),
    ).toBe(0);
  });

  it("counts a past anchor advanced into the reference month", () => {
    // Anchor a year back; fortnightly steps still land twice in June 2026.
    expect(
      occurrencesInMonth(
        parseISODate("2025-06-11"),
        { interval: 2, unit: "week", anchor: "2025-06-11" },
        parseISODate("2026-06-15"),
      ),
    ).toBe(2);
  });
});

describe("ceilDiv", () => {
  it("rounds up", () => {
    expect(ceilDiv(10, 3)).toBe(4);
  });
  it("returns the numerator for a non-positive divisor", () => {
    expect(ceilDiv(10, 0)).toBe(10);
  });
});
