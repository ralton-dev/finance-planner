import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HouseholdPlanDto } from "../lib/types.js";
import { HouseholdPlanView } from "./HouseholdPlanView.js";

/** A two-account, two-member household: one shared pot, one personal account
 *  with a salary landing in it. Enough for both tables to have every shape. */
const PLAN: HouseholdPlanDto = {
  householdId: "hh",
  asOfDate: "2026-08-04",
  currency: "GBP",
  monthlyIncomeMinor: 460_000,
  totalRequiredMinor: 219_000,
  totalFundedMinor: 219_000,
  leftoverMinor: 241_000,
  shortfallMinor: 0,
  members: [
    {
      userId: "alex",
      displayName: "Alex",
      shareBp: 6_000,
      monthlyIncomeMinor: 260_000,
      obligationMinor: 131_400,
      fundedMinor: 131_400,
      leftoverMinor: 128_600,
      shortfallMinor: 0,
    },
    {
      userId: "bo",
      displayName: "Bo",
      shareBp: 4_000,
      monthlyIncomeMinor: 200_000,
      obligationMinor: 87_600,
      fundedMinor: 87_600,
      leftoverMinor: 112_400,
      shortfallMinor: 0,
    },
  ],
  accounts: [
    {
      accountId: "bills",
      name: "Bills joint",
      role: "shared",
      memberUserId: null,
      currency: "GBP",
      monthlyIncomeMinor: 0,
      requiredOutflowMinor: 219_000,
      fundedOutflowMinor: 219_000,
      transferInMinor: 219_000,
      transferOutMinor: 0,
      leftoverMinor: 0,
      shortfallMinor: 0,
    },
    {
      accountId: "alex-current",
      name: "Alex current",
      role: "personal",
      memberUserId: "alex",
      currency: "GBP",
      monthlyIncomeMinor: 260_000,
      requiredOutflowMinor: 0,
      fundedOutflowMinor: 0,
      transferInMinor: 0,
      transferOutMinor: 131_400,
      leftoverMinor: 128_600,
      shortfallMinor: 0,
    },
  ],
  lines: [],
  transfers: [],
};

/** The two tables in the order the view renders them. */
function tables(container: HTMLElement): HTMLTableElement[] {
  return [...container.querySelectorAll("table")];
}

/** A table's headers, and which of them a phone keeps. */
function headers(table: HTMLTableElement): { all: string[]; kept: string[] } {
  const th = [...table.querySelectorAll("thead th")];
  return {
    all: th.map((h) => h.textContent ?? ""),
    kept: th.filter((h) => !h.classList.contains("wide-only")).map((h) => h.textContent ?? ""),
  };
}

// What jsdom can see of the narrow layout: the wrapper, the pinned column, and
// which columns are marked to drop. Whether the document actually stops
// scrolling sideways at 390px is a measurement, not an assertion.
describe("HouseholdPlanView · narrow layout", () => {
  it("scrolls each table inside a wrapper rather than dragging the document", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    for (const table of tables(container)) {
      expect(table.parentElement).toHaveClass("table-scroll");
    }
  });

  it("pins the first column of both tables", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    for (const table of tables(container)) {
      expect(table.querySelector("thead th")).toHaveClass("sticky-col");
      for (const row of table.querySelectorAll("tbody tr")) {
        expect(row.firstElementChild).toHaveClass("sticky-col");
      }
    }
  });

  it("keeps five columns per table on a phone, and the same five shape twice", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    const [perAccount, perPerson] = tables(container);

    expect(headers(perAccount!).kept).toEqual([
      "account",
      "transfer in",
      "transfer out",
      "left over",
      "shortfall",
    ]);
    expect(headers(perPerson!).kept).toEqual([
      "member",
      "income",
      "their costs",
      "left over",
      "shortfall",
    ]);

    // Every dropped header has exactly one dropped cell under it in each row —
    // a column half-hidden would misalign the rest.
    for (const table of tables(container)) {
      const { all, kept } = headers(table);
      const dropped = all.length - kept.length;
      for (const row of table.querySelectorAll("tbody tr")) {
        expect(row.querySelectorAll("td.wide-only")).toHaveLength(dropped);
      }
    }
  });

  it("folds the role and the income into a sub-line under the account", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    const [pot, personal] = tables(container)![0]!.querySelectorAll("tbody .row-sub");

    // A shared pot has no income of its own, so it is the role and nothing else.
    expect(pot).toHaveTextContent("shared pot");
    expect(pot?.querySelector(".amount")).toBeNull();

    expect(personal).toHaveTextContent("Alex · income £2,600.00");
    // Money in the sub-line still has to be something privacy mode can blur.
    expect(personal?.querySelector(".amount")).toHaveTextContent("£2,600.00");
  });

  it("folds the share into a sub-line under the member", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    const subs = tables(container)![1]!.querySelectorAll("tbody .row-sub");
    expect([...subs].map((s) => s.textContent)).toEqual(["60% share", "40% share"]);
  });
});
