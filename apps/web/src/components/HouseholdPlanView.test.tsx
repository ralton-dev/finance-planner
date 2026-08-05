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

/**
 * Decision 13 on screen: `leftoverMinor` keeps its meaning on the wire, and
 * every figure a person reads here is free-after-committed — which is also the
 * number the account page and the flow diagram print for the same account.
 * Printing the raw field is how this page came to read £2,793 against the
 * diagram's £2,093 (ONE-ENGINE.md).
 */
describe("HouseholdPlanView · the committed bucket", () => {
  /** Alex sweeps £400 a month into an ISA outside the household. */
  const WITH_SAVINGS: HouseholdPlanDto = {
    ...PLAN,
    committedMinor: 40_000,
    members: PLAN.members.map((m) =>
      m.userId === "alex" ? { ...m, committedMinor: 40_000 } : { ...m, committedMinor: 0 },
    ),
    accounts: PLAN.accounts.map((a) =>
      a.accountId === "alex-current"
        ? { ...a, committedMinor: 40_000 }
        : { ...a, committedMinor: 0 },
    ),
  };

  /** The cells of one table row, by the header above each. */
  function cells(table: HTMLTableElement, rowIndex: number): Record<string, string> {
    const heads = [...table.querySelectorAll("thead th")].map((h) => h.textContent ?? "");
    const row = [...table.querySelectorAll("tbody tr")][rowIndex]!;
    return Object.fromEntries(
      [...row.querySelectorAll("td")].map((td, i) => [heads[i]!, td.textContent ?? ""]),
    );
  }

  it("leads with what is free after committed, and names the committed alongside", () => {
    const { container } = render(<HouseholdPlanView plan={WITH_SAVINGS} />);
    const kpis = [...container.querySelectorAll(".kpi")].map((k) => k.textContent ?? "");

    expect(kpis).toContainEqual(expect.stringContaining("committed£400.00"));
    // £2,410 left over on the wire, £400 of it already spoken for.
    expect(kpis).toContainEqual(expect.stringContaining("left over£2,010.00"));
    expect(kpis.join(" ")).not.toContain("£2,410.00");
  });

  it("shows the same subtraction per account and per member", () => {
    const { container } = render(<HouseholdPlanView plan={WITH_SAVINGS} />);
    const [perAccount, perPerson] = tables(container);

    expect(cells(perAccount!, 1)).toMatchObject({
      account: expect.stringContaining("Alex current"),
      committed: "£400.00",
      "left over": "£886.00",
    });
    // The pot commits nothing, so its row says so rather than repeating a zero.
    expect(cells(perAccount!, 0)).toMatchObject({ committed: "—", "left over": "£0.00" });
    expect(cells(perPerson!, 0)).toMatchObject({ committed: "£400.00", "left over": "£886.00" });
    expect(cells(perPerson!, 1)).toMatchObject({ committed: "—", "left over": "£1,124.00" });
  });

  it("leaves the column out entirely for a household that has committed nothing", () => {
    const { container } = render(<HouseholdPlanView plan={PLAN} />);
    for (const table of tables(container)) {
      expect(headers(table).all).not.toContain("committed");
    }
    // ...and the headline is the plain figure, unchanged to the penny.
    expect([...container.querySelectorAll(".kpi")].map((k) => k.textContent)).toContainEqual(
      expect.stringContaining("left over£2,410.00"),
    );
  });
});

/**
 * The residual the pass stopped flooring, in a table cell.
 *
 * Measured in a browser: an account committed to sending out more than reaches
 * it — decision 11's member holding income somewhere other than the account
 * their transfers leave — printed **-£244.00 in green**. The pass reports the
 * sign so the screen can say the thing to do; a green minus says the opposite.
 */
describe("HouseholdPlanView · an account that has to be consolidated into", () => {
  const consolidating: HouseholdPlanDto = {
    ...PLAN,
    accounts: PLAN.accounts.map((a) =>
      a.accountId === "alex-current"
        ? { ...a, monthlyIncomeMinor: 50_000, transferOutMinor: 74_400, leftoverMinor: -24_400 }
        : a,
    ),
  };

  it("colours a negative left-over as a warning, never as a month that works", () => {
    const { container } = render(<HouseholdPlanView plan={consolidating} />);
    const row = [...tables(container)[0]!.querySelectorAll("tbody tr")][1]!;
    const cell = [...row.querySelectorAll("td")].find((td) =>
      td.textContent?.includes("-£244.00"),
    )!;
    expect(cell).toHaveClass("warn");
    expect(cell).not.toHaveClass("ok");
  });
});

/**
 * The figure that exceeded its own breakdown.
 *
 * THEIR COSTS is what the pass attributes to a person across the whole scope;
 * the lines and bars beneath this table cover only the household's own accounts.
 * Decision 9 made those two sets differ — Alex has a rent pot of his own, fed by
 * a transfer the plan derives — so the cell printed a figure nothing on the page
 * added up to, and nothing said why. The household view publishes the split now.
 */
describe("HouseholdPlanView · costs the household's lines do not carry", () => {
  const elsewhere: HouseholdPlanDto = {
    ...PLAN,
    members: PLAN.members.map((m) =>
      m.userId === "alex"
        ? {
            ...m,
            householdObligationMinor: 101_080,
            householdFundedMinor: 101_080,
            elsewhereObligationMinor: 30_320,
            elsewhereFundedMinor: 30_320,
          }
        : { ...m, elsewhereObligationMinor: 0, elsewhereFundedMinor: 0 },
    ),
  };

  it("says how much of a member's costs is somewhere this page is not", () => {
    const { container } = render(<HouseholdPlanView plan={elsewhere} />);
    const rows = [...tables(container)[1]!.querySelectorAll("tbody tr")];
    expect(rows[0]).toHaveTextContent("£1,314.00");
    expect(rows[0]!.querySelector(".cell-note")).toHaveTextContent("incl. £303.20 elsewhere");
    // ...and reconciles: what is left is exactly what the lines beneath carry.
    expect(131_400 - 30_320).toBe(101_080);
  });

  it("says nothing at all for a member whose costs are all in the household", () => {
    const { container } = render(<HouseholdPlanView plan={elsewhere} />);
    const rows = [...tables(container)[1]!.querySelectorAll("tbody tr")];
    expect(rows[1]!.querySelector(".cell-note")).toBeNull();
  });
});
