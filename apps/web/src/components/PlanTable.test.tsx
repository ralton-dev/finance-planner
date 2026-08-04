import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AccountPlanDto } from "../lib/types.js";
import { PlanSummary, PlanTable } from "./PlanTable.js";

const plan: AccountPlanDto = {
  accountId: "a1",
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
