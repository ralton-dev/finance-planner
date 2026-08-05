import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildGridRows,
  buildProjectionPoints,
  hasBalanceSeries,
  hasShortfallSeries,
} from "../lib/projection.js";
import type { AccountProjectionDto, HouseholdProjectionDto } from "../lib/types.js";
import { ProjectionView, type ProjectionData } from "./ProjectionView.js";

// recharts needs a real layout engine (ResizeObserver) that jsdom has no use
// for; the chart's own shaping is covered by the series tests at the bottom.
vi.mock("./ProjectionChart.js", () => ({ ProjectionChart: () => null }));

function line(over: Partial<AccountProjectionDto["months"][number]["lines"][number]> = {}) {
  return {
    paymentId: "p1",
    name: "rent",
    category: "monthly_recurring" as const,
    requiredMonthlyMinor: 120_000,
    fundedMonthlyMinor: 120_000,
    alreadySavedEndMinor: 0,
    dueThisMonth: false,
    dueAmountMinor: 0,
    ...over,
  };
}

const projection: AccountProjectionDto = {
  accountId: "a1",
  currency: "GBP",
  asOfDate: "2026-08-04",
  months: [
    {
      month: "2026-08",
      monthlyIncomeMinor: 300_000,
      bufferMinor: 0,
      totalRequiredMinor: 140_000,
      totalFundedMinor: 140_000,
      leftoverMinor: 160_000,
      shortfallMinor: 0,
      reservedEndMinor: 20_000,
      projectedBalanceMinor: 500_000,
      lines: [line(), line({ paymentId: "p2", name: "car tax", requiredMonthlyMinor: 20_000 })],
    },
    {
      month: "2026-09",
      monthlyIncomeMinor: 300_000,
      bufferMinor: 0,
      totalRequiredMinor: 140_000,
      totalFundedMinor: 120_000,
      leftoverMinor: 0,
      shortfallMinor: 20_000,
      reservedEndMinor: 0,
      projectedBalanceMinor: 480_000,
      lines: [
        line(),
        line({
          paymentId: "p2",
          name: "car tax",
          requiredMonthlyMinor: 20_000,
          dueThisMonth: true,
          dueAmountMinor: 24_000,
        }),
      ],
    },
    {
      month: "2026-10",
      monthlyIncomeMinor: 300_000,
      bufferMinor: 0,
      totalRequiredMinor: 120_000,
      totalFundedMinor: 120_000,
      leftoverMinor: 180_000,
      shortfallMinor: 0,
      reservedEndMinor: 0,
      projectedBalanceMinor: 460_000,
      // car tax is done: the row keeps its column, the cell stays blank.
      lines: [line()],
    },
  ],
};

const loader = (data: ProjectionData = projection) => vi.fn().mockResolvedValue(data);

describe("ProjectionView", () => {
  it("renders a column per month and a row per payment", async () => {
    render(<ProjectionView load={loader()} />);

    expect(await screen.findByText("aug 26")).toBeInTheDocument();
    expect(screen.getByText("sep 26")).toBeInTheDocument();
    expect(screen.getByText("oct 26")).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "rent" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "car tax" })).toBeInTheDocument();
  });

  it("leaves the cell blank in months a payment is not in the plan", async () => {
    render(<ProjectionView load={loader()} />);

    const row = (await screen.findByRole("rowheader", { name: "car tax" })).closest("tr")!;
    const cells = row.querySelectorAll("td");
    expect(cells).toHaveLength(3);
    expect(cells[0]).toHaveTextContent("£200");
    expect(cells[2]).toBeEmptyDOMElement();
  });

  it("marks the month a payment falls due, with the amount in its title", async () => {
    render(<ProjectionView load={loader()} />);

    const due = await screen.findByTitle("due: £240.00");
    expect(due).toHaveClass("due");
    expect(due).toHaveTextContent("£200");
  });

  it("keys the grid's marks underneath it", async () => {
    render(<ProjectionView load={loader()} />);

    const key = await screen.findByText(/falls due that month/);
    expect(key).toHaveTextContent(
      "• falls due that month · tinted cell = due month · ~ derived date",
    );
    // The key sits outside the scroller, so it stays put as the months move.
    expect(key.closest(".grid-scroll")).toBeNull();
  });

  it("keeps the key off the page until there is a grid to key", async () => {
    render(<ProjectionView load={loader({ ...projection, months: [] })} />);
    await screen.findByText(/nothing to project yet/i);
    expect(screen.queryByText(/falls due that month/)).toBeNull();
  });

  it("foots each month with what it needs and what is left over", async () => {
    render(<ProjectionView load={loader()} />);

    const required = (await screen.findByRole("rowheader", { name: "required" })).closest("tr")!;
    expect([...required.querySelectorAll("td")].map((td) => td.textContent)).toEqual([
      "£1.4K",
      "£1.4K",
      "£1.2K",
    ]);
    // The exact figure lives in the title, since the cell is compacted.
    expect(screen.getAllByTitle("£1,400.00")).toHaveLength(2);
    expect(screen.getByTitle("£1,600.00")).toHaveClass("ok");
  });

  it("flags a short month in the leftover row with the warning styling", async () => {
    render(<ProjectionView load={loader()} />);

    const short = await screen.findByTitle("shortfall: £200.00");
    expect(short).toHaveClass("warn");
    expect(short).toHaveTextContent("-£200");
  });

  it("reloads with the window the user picks", async () => {
    const load = loader();
    render(<ProjectionView load={load} />);
    await screen.findByText("aug 26");
    expect(load).toHaveBeenCalledWith(12);

    fireEvent.click(screen.getByRole("button", { name: "24m" }));

    await waitFor(() => expect(load).toHaveBeenCalledWith(24));
    expect(screen.getByRole("button", { name: "24m" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the caller's hint above the chart", async () => {
    render(<ProjectionView load={loader()} hint="no balance check-in" />);
    expect(await screen.findByText("no balance check-in")).toBeInTheDocument();
  });

  it("says so when there is nothing to project", async () => {
    render(<ProjectionView load={loader({ ...projection, months: [] })} />);
    expect(await screen.findByText(/nothing to project yet/i)).toBeInTheDocument();
  });

  it("surfaces a failed load", async () => {
    const load = vi.fn().mockRejectedValue(new Error("boom"));
    render(<ProjectionView load={load} />);
    expect(await screen.findByText(/could not load the projection/i)).toBeInTheDocument();
  });

  it("names the account when two payments share a name (household variant)", async () => {
    const household: HouseholdProjectionDto = {
      householdId: "h1",
      currency: "GBP",
      asOfDate: "2026-08-04",
      months: [
        {
          month: "2026-08",
          monthlyIncomeMinor: 500_000,
          totalRequiredMinor: 40_000,
          totalFundedMinor: 40_000,
          leftoverMinor: 460_000,
          shortfallMinor: 0,
          transfersTotalMinor: 20_000,
          reservedEndMinor: 0,
          lines: [
            { ...line({ paymentId: "p1", name: "insurance" }), accountId: "acc-a" },
            { ...line({ paymentId: "p2", name: "insurance" }), accountId: "acc-b" },
            { ...line({ paymentId: "p3", name: "rent" }), accountId: "acc-a" },
          ],
        },
      ],
    };
    render(
      <ProjectionView
        load={loader(household)}
        accountNames={{ "acc-a": "Joint", "acc-b": "Ada current" }}
      />,
    );

    expect(await screen.findByRole("rowheader", { name: "insurance · Joint" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "insurance · Ada current" })).toBeInTheDocument();
    // A name that doesn't collide is left alone.
    expect(screen.getByRole("rowheader", { name: "rent" })).toBeInTheDocument();
  });
});

/**
 * **The account page stops disagreeing with itself.**
 *
 * The strip's footer is labelled `left over` and sat a few hundred pixels under
 * a KPI with the same label. It printed `MonthProjection.leftoverMinor`, which
 * is `plan.leftoverMinor` verbatim, while the KPI printed the residual — £2,501
 * under £2,051, and £0.00 under £200.00 for a savings pot. ONE-ENGINE WP-Q's
 * acceptance already read "an account's projection month 1 equals its plan for
 * the same date, asserted directly", and it did: against the field the strip
 * happened to read. That is the fifth instance in this repo of a test asserting
 * the field its component reads.
 *
 * Both surfaces now read one derivation, and the strip never reconstructs it —
 * `residualMinor` on an account, `membersLeftoverMinor` on a household, and
 * `leftoverMinor` only where an older payload carries nothing better.
 */
describe("the strip's left over, and the figure above it", () => {
  /** The savings pot: £400 arriving, £200 of it spent, £200 still in it. */
  const pot: AccountProjectionDto = {
    ...projection,
    months: projection.months.map((m, i) => ({
      ...m,
      leftoverMinor: 0,
      shortfallMinor: 0,
      residualMinor: 20_000 + i,
    })),
  };

  it("prints the month's residual, which is what the KPI above it prints", async () => {
    render(<ProjectionView load={loader(pot)} />);
    await screen.findByText("aug 26");

    const footer = [...document.querySelectorAll(".months-grid tfoot tr")].find(
      (r) => r.querySelector("th")?.textContent === "left over",
    )!;
    const cells = [...footer.querySelectorAll("td")].map((c) => c.textContent);
    expect(cells).toEqual(["£200", "£200", "£200"]);
    // The old field is nought in every month, so this cannot pass by accident.
    expect(cells).not.toContain("£0");
    // The full figure is on the title, and month 1 is the account page's KPI.
    expect(footer.querySelectorAll("td")[0]!.getAttribute("title")).toBe("£200.00");
  });

  it("prints the members' sum on a household, not the roster's", async () => {
    const household: ProjectionData = {
      currency: "GBP",
      months: projection.months.map((m) => ({
        ...m,
        shortfallMinor: 0,
        // The roster figure and the members' figure are two derivations, and
        // WP-AF established they differ: £4,705 against £4,025 on the estate.
        leftoverMinor: 470_500,
        membersLeftoverMinor: 402_500,
      })),
    };
    render(<ProjectionView load={loader(household)} />);
    await screen.findByText("aug 26");

    const footer = [...document.querySelectorAll(".months-grid tfoot tr")].find(
      (r) => r.querySelector("th")?.textContent === "left over",
    )!;
    expect(footer.querySelectorAll("td")[0]!.getAttribute("title")).toBe("£4,025.00");
  });

  it("says a negative month in amber rather than in green", async () => {
    // A residual is signed on purpose (decision 11), and the one reading it must
    // never get is a green minus.
    const overdrawn: AccountProjectionDto = {
      ...projection,
      months: [{ ...projection.months[0]!, shortfallMinor: 0, residualMinor: -24_400 }],
    };
    render(<ProjectionView load={loader(overdrawn)} />);
    await screen.findByText("aug 26");

    const footer = [...document.querySelectorAll(".months-grid tfoot tr")].find(
      (r) => r.querySelector("th")?.textContent === "left over",
    )!;
    const cell = footer.querySelectorAll("td")[0]!;
    expect(cell.className).toContain("warn");
    expect(cell.className).not.toContain("ok");
  });

  it("falls back to leftoverMinor when the wire carries neither", async () => {
    render(<ProjectionView load={loader()} />);
    await screen.findByText("aug 26");
    const footer = [...document.querySelectorAll(".months-grid tfoot tr")].find(
      (r) => r.querySelector("th")?.textContent === "left over",
    )!;
    expect(footer.querySelectorAll("td")[0]!.getAttribute("title")).toBe("£1,600.00");
  });
});

describe("projection series", () => {
  it("carries reserved, balance and shortfall per month", () => {
    expect(buildProjectionPoints(projection.months)[1]).toEqual({
      month: "2026-09",
      reserved: 0,
      balance: 480_000,
      shortfall: 20_000,
      transfers: null,
    });
  });

  it("omits the balance line when no month has a projected balance", () => {
    const unreconciled = projection.months.map((m) => ({ ...m, projectedBalanceMinor: null }));
    expect(hasBalanceSeries(projection.months)).toBe(true);
    expect(hasBalanceSeries(unreconciled)).toBe(false);
    expect(buildProjectionPoints(unreconciled).every((p) => p.balance === null)).toBe(true);
  });

  it("only draws shortfall when some month is actually short", () => {
    expect(hasShortfallSeries(projection.months)).toBe(true);
    expect(hasShortfallSeries(projection.months.filter((m) => m.shortfallMinor === 0))).toBe(false);
  });

  it("orders grid rows by first appearance and aligns cells to months", () => {
    const rows = buildGridRows(projection.months);
    expect(rows.map((r) => r.label)).toEqual(["rent", "car tax"]);
    expect(rows[1]!.cells.map((c) => c?.requiredMonthlyMinor ?? null)).toEqual([
      20_000,
      20_000,
      null,
    ]);
  });
});
