import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AccountPlanDto } from "../lib/types.js";
import { daysUntilNextMonthly, PlanSummary, PlanTable } from "./PlanTable.js";

const AS_OF = "2026-08-04";

const plan: AccountPlanDto = {
  accountId: "a1",
  asOfDate: AS_OF,
  currency: "GBP",
  monthlyIncomeMinor: 300_000,
  bufferMinor: 0,
  totalRequiredMinor: 21_400,
  totalFundedMinor: 21_400,
  leftoverMinor: 278_600,
  shortfallMinor: 0,
  contributionsMTD: [],
  latestBalance: null,
  reservedMinor: 0,
  lines: [
    {
      paymentId: "p1",
      name: "Holiday",
      category: "fixed_point",
      amountMinor: 120_000,
      dueDate: "2026-09-01",
      targetDate: "2026-09-01",
      monthsUntilDue: 8,
      requiredMonthlyMinor: 15_000,
      fundedMonthlyMinor: 15_000,
      alreadySavedMinor: 0,
      onTrack: true,
    },
    {
      paymentId: "p2",
      name: "Car repair",
      category: "fixed_point",
      amountMinor: 50_000,
      dueDate: "2026-03-01",
      targetDate: "2026-03-01",
      monthsUntilDue: 2,
      requiredMonthlyMinor: 25_000,
      fundedMonthlyMinor: 6_400,
      alreadySavedMinor: 12_500,
      onTrack: false,
      projectedCompletionDate: "2026-09-01",
    },
  ],
};

const monthlyBill: AccountPlanDto["lines"][number] = {
  paymentId: "p3",
  name: "Broadband",
  category: "monthly_recurring",
  amountMinor: 3_500,
  dueDate: "2026-03-01",
  targetDate: "2026-03-01",
  monthsUntilDue: 0,
  requiredMonthlyMinor: 3_500,
  fundedMonthlyMinor: 3_500,
  alreadySavedMinor: 0,
  onTrack: true,
};

describe("PlanTable", () => {
  it("renders a row per payment with formatted amounts", () => {
    render(<PlanTable plan={plan} />);
    expect(screen.getByText("Holiday")).toBeInTheDocument();
    expect(screen.getByText("£150.00")).toBeInTheDocument(); // required/month for holiday
  });

  it("flags at-risk goals and marks on-track ones", () => {
    render(<PlanTable plan={plan} />);
    expect(screen.getByText("on track")).toBeInTheDocument();
    expect(screen.getByText("at risk")).toBeInTheDocument();
  });

  it("shows an empty state with no payments", () => {
    render(<PlanTable plan={{ ...plan, lines: [] }} />);
    expect(screen.getByText(/no payments yet/i)).toBeInTheDocument();
  });

  it("annotates save/mo with the occurrence count for sub-monthly recurrences", () => {
    const fortnightly: AccountPlanDto = {
      ...plan,
      lines: [
        {
          paymentId: "p3",
          name: "Butternut",
          category: "custom_recurring",
          amountMinor: 8_213,
          dueDate: "2026-06-11",
          targetDate: "2026-06-11",
          monthsUntilDue: 1,
          requiredMonthlyMinor: 16_426,
          fundedMonthlyMinor: 16_426,
          alreadySavedMinor: 0,
          occurrencesThisMonth: 2,
          onTrack: true,
        },
      ],
    };
    render(<PlanTable plan={fortnightly} />);
    expect(screen.getByText("£164.26")).toBeInTheDocument();
    expect(screen.getByText("(2)")).toBeInTheDocument();
  });

  it("omits the count when a payment falls due once", () => {
    render(<PlanTable plan={plan} />);
    // The single-occurrence Holiday line shows no "(1)" annotation.
    expect(screen.queryByText("(1)")).not.toBeInTheDocument();
  });

  it("summary shows leftover when there is no shortfall", () => {
    render(<PlanSummary plan={plan} />);
    expect(screen.getByText("left over")).toBeInTheDocument();
    expect(screen.getByText("£2,786.00")).toBeInTheDocument();
  });

  it("renders a saved column, dimming rows with nothing saved yet", () => {
    render(<PlanTable plan={plan} />);
    expect(screen.getByRole("columnheader", { name: "saved" })).toBeInTheDocument();

    const saved = screen.getByText("£125.00"); // Car repair's alreadySaved
    expect(saved).toBeInTheDocument();
    expect(saved).not.toHaveClass("dim");

    // Holiday has saved nothing — still numeric, just dimmed.
    const [zero] = screen.getAllByText("£0.00");
    expect(zero).toHaveClass("dim");
  });

  it("marks payments that already had money recorded this month", () => {
    render(
      <PlanTable plan={{ ...plan, contributionsMTD: [{ paymentId: "p2", amountMinor: 6_400 }] }} />,
    );
    expect(screen.getByText("✓ £64.00")).toBeInTheDocument();
  });

  it("hides the record action for view-only callers", () => {
    render(<PlanTable plan={plan} onRecord={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "record" })).toBeNull();
  });

  it("hides the record action on monthly recurring bills", () => {
    render(
      <PlanTable
        plan={{ ...plan, lines: [monthlyBill] }}
        canRecord
        onRecord={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.queryByRole("button", { name: "record" })).toBeNull();
  });

  it("offers the record action on savings goals when the caller may edit", () => {
    render(<PlanTable plan={plan} canRecord onRecord={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getAllByRole("button", { name: "record" })).toHaveLength(2);
  });

  it("prefills with the funded amount and records what the user types", async () => {
    const onRecord = vi.fn().mockResolvedValue(undefined);
    render(<PlanTable plan={plan} canRecord onRecord={onRecord} />);

    fireEvent.click(screen.getAllByRole("button", { name: "record" })[0]!);

    const input = screen.getByLabelText("amount to record for Holiday");
    expect(input).toHaveValue("150.00"); // fundedMonthlyMinor, in major units

    fireEvent.change(input, { target: { value: "42.50" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(onRecord).toHaveBeenCalledWith("p1", 4_250));
    // The form closes once the contribution lands.
    await waitFor(() => expect(screen.queryByLabelText("amount to record for Holiday")).toBeNull());
  });

  it("tells a dated goal from a paced one in the type column", () => {
    const paced: AccountPlanDto["lines"][number] = {
      ...plan.lines[0]!,
      paymentId: "p9",
      name: "New bike",
      fixedMonthlyMinor: 5_000,
    };
    render(<PlanTable plan={{ ...plan, lines: [plan.lines[0]!, paced] }} />);

    // Holiday has a deadline and no cap; the bike has a cap and no deadline.
    expect(screen.getByText("goal · dated")).toBeInTheDocument();
    expect(screen.getByText("goal · paced")).toBeInTheDocument();
  });

  it("tildes the due date a paced goal's finish date was worked out from", () => {
    const paced: AccountPlanDto["lines"][number] = {
      ...plan.lines[0]!,
      paymentId: "p9",
      name: "New bike",
      targetDate: "2027-02-01",
      fixedMonthlyMinor: 5_000,
      dueDateIsDerived: true,
    };
    render(<PlanTable plan={{ ...plan, lines: [plan.lines[0]!, paced] }} />);

    const derived = screen.getByText("~2027-02-01");
    expect(derived).toHaveClass("derived");
    // The dated goal keeps its date plain: the user typed that one.
    expect(screen.getByText("2026-09-01")).not.toHaveClass("derived");
    expect(screen.queryByText("~2026-09-01")).toBeNull();
  });

  it("leaves a paced goal's own deadline plain — the cap alone proves nothing", () => {
    // A cap *and* a deadline: paced by type, but the date is the user's, and
    // the engine is the only thing that can tell the two apart.
    const pacedAndDated: AccountPlanDto["lines"][number] = {
      ...plan.lines[0]!,
      paymentId: "p9",
      name: "New bike",
      targetDate: "2027-02-01",
      fixedMonthlyMinor: 5_000,
      dueDateIsDerived: false,
    };
    render(<PlanTable plan={{ ...plan, lines: [pacedAndDated] }} />);

    expect(screen.getByText("goal · paced")).toBeInTheDocument();
    expect(screen.getByText("2027-02-01")).not.toHaveClass("derived");
    expect(screen.queryByText("~2027-02-01")).toBeNull();
  });

  it("says nothing about derivation when the API is silent", () => {
    // An older payload, or the household plan's lines: no flag, no tilde.
    render(
      <PlanTable plan={{ ...plan, lines: [{ ...plan.lines[0]!, fixedMonthlyMinor: 5_000 }] }} />,
    );
    expect(screen.getByText("2026-09-01")).not.toHaveClass("derived");
  });

  it("treats a zero cap as no cap at all", () => {
    render(<PlanTable plan={{ ...plan, lines: [{ ...plan.lines[0]!, fixedMonthlyMinor: 0 }] }} />);
    expect(screen.getByText("goal · dated")).toBeInTheDocument();
  });

  it("counts a monthly bill down to its next payment", () => {
    render(<PlanTable plan={{ ...plan, lines: [monthlyBill] }} asOfDate="2026-08-04" />);
    // Anchored to the 1st, so the next one is 1 sep — 28 days out.
    expect(screen.getByText("due in 28 d")).toBeInTheDocument();
  });

  it("says so on the day a monthly bill lands", () => {
    render(<PlanTable plan={{ ...plan, lines: [monthlyBill] }} asOfDate="2026-08-01" />);
    expect(screen.getByText("due today")).toBeInTheDocument();
  });

  it("counts nothing down without an as-of date, and never on a goal", () => {
    const { rerender } = render(<PlanTable plan={{ ...plan, lines: [monthlyBill] }} />);
    expect(screen.queryByText(/^due /)).toBeNull();

    rerender(<PlanTable plan={plan} asOfDate="2026-08-04" />);
    expect(screen.queryByText(/^due /)).toBeNull();
  });

  it("refuses to record a zero amount", async () => {
    const onRecord = vi.fn().mockResolvedValue(undefined);
    render(<PlanTable plan={plan} canRecord onRecord={onRecord} />);

    fireEvent.click(screen.getAllByRole("button", { name: "record" })[0]!);
    fireEvent.change(screen.getByLabelText("amount to record for Holiday"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/greater than zero/i);
    expect(onRecord).not.toHaveBeenCalled();
  });
});

describe("daysUntilNextMonthly", () => {
  it("counts to the anchor day this month while it is still ahead", () => {
    expect(daysUntilNextMonthly("2026-03-20", "2026-08-04")).toBe(16);
  });

  it("rolls to next month once the day has passed", () => {
    expect(daysUntilNextMonthly("2026-03-01", "2026-08-04")).toBe(28);
  });

  it("counts zero on the day itself", () => {
    expect(daysUntilNextMonthly("2026-03-15", "2026-08-15")).toBe(0);
  });

  it("clamps an end-of-month anchor to the length of the month it lands in", () => {
    // The 31st in a 30-day month is the 30th, not the 1st of the next.
    expect(daysUntilNextMonthly("2026-01-31", "2026-09-04")).toBe(26);
    // February, in a non-leap year.
    expect(daysUntilNextMonthly("2026-01-31", "2026-02-04")).toBe(24);
  });

  it("rolls the year over in december", () => {
    expect(daysUntilNextMonthly("2026-06-05", "2026-12-31")).toBe(5);
  });

  it("gives back nothing for a date it cannot read", () => {
    expect(daysUntilNextMonthly("", "2026-08-04")).toBeNull();
    expect(daysUntilNextMonthly("2026-08-01", "")).toBeNull();
  });
});
