import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
      alreadySavedMinor: 0,
      onTrack: false,
      projectedCompletionDate: "2026-09-01",
    },
  ],
};

describe("PlanTable", () => {
  it("renders a row per payment with formatted amounts", () => {
    render(<PlanTable plan={plan} />);
    expect(screen.getByText("Holiday")).toBeInTheDocument();
    expect(screen.getByText("£150.00")).toBeInTheDocument(); // required/month for holiday
  });

  it("flags at-risk goals and marks on-track ones", () => {
    render(<PlanTable plan={plan} />);
    expect(screen.getByText("On track")).toBeInTheDocument();
    expect(screen.getByText("At risk")).toBeInTheDocument();
  });

  it("shows an empty state with no payments", () => {
    render(<PlanTable plan={{ ...plan, lines: [] }} />);
    expect(screen.getByText(/no payments yet/i)).toBeInTheDocument();
  });

  it("summary shows leftover when there is no shortfall", () => {
    render(<PlanSummary plan={plan} />);
    expect(screen.getByText("Left over")).toBeInTheDocument();
    expect(screen.getByText("£2,786.00")).toBeInTheDocument();
  });
});
