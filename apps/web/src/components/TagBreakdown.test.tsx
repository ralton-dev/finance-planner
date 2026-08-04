import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PlanLineDto } from "../lib/types.js";
import { TagBreakdown } from "./TagBreakdown.js";

// Nothing is stubbed here any more: the bar list is plain DOM, so it renders in
// jsdom exactly as it does on screen. (The treemap it replaced was recharts
// inside a ResponsiveContainer, which measures nothing without a layout engine.)

function line(over: Partial<PlanLineDto> & { paymentId: string }): PlanLineDto {
  return {
    name: over.paymentId,
    category: "monthly_recurring",
    amountMinor: 0,
    dueDate: "2026-08-01",
    targetDate: "2026-08-01",
    monthsUntilDue: 0,
    requiredMonthlyMinor: 10_000,
    fundedMonthlyMinor: 10_000,
    alreadySavedMinor: 0,
    onTrack: true,
    ...over,
  };
}

describe("TagBreakdown", () => {
  it("renders nothing when there are no lines", () => {
    const { container } = render(<TagBreakdown lines={[]} currency="GBP" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when every line is untagged", () => {
    const { container } = render(
      <TagBreakdown
        lines={[line({ paymentId: "a" }), line({ paymentId: "b", tag: null })]}
        currency="GBP"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("charts the split once tags are in play, biggest first", () => {
    render(
      <TagBreakdown
        lines={[
          line({ paymentId: "mot", tag: "car", requiredMonthlyMinor: 10_000 }),
          line({ paymentId: "rent", tag: "housing", requiredMonthlyMinor: 90_000 }),
        ]}
        currency="GBP"
      />,
    );

    expect(screen.getByRole("heading", { name: "where the month goes" })).toBeInTheDocument();
    expect(screen.getByText("[2 tags · required / mo]")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "housing£900.00/mo90.0%",
      "car£100.00/mo10.0%",
    ]);
  });

  it("lists each tag's monthly cost and share", () => {
    render(
      <TagBreakdown
        lines={[
          line({ paymentId: "rent", tag: "housing", requiredMonthlyMinor: 90_000 }),
          line({ paymentId: "mot", tag: "car", requiredMonthlyMinor: 10_000 }),
        ]}
        currency="GBP"
      />,
    );

    const bars = screen.getByRole("list");
    expect(bars).toHaveTextContent("housing£900.00/mo90.0%");
    expect(bars).toHaveTextContent("car£100.00/mo10.0%");
    // Every figure carries the class privacy mode blurs.
    expect(bars.querySelectorAll(".amount")).toHaveLength(2);
  });

  it("keeps an untagged remainder visible alongside real tags", () => {
    render(
      <TagBreakdown
        lines={[
          line({ paymentId: "rent", tag: "housing", requiredMonthlyMinor: 50_000 }),
          line({ paymentId: "misc", requiredMonthlyMinor: 50_000 }),
        ]}
        currency="GBP"
      />,
    );
    expect(screen.getByText("untagged")).toBeInTheDocument();
  });
});
