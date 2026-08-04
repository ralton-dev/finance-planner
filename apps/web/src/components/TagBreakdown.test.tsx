import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlanLineDto } from "../lib/types.js";
import { TagBreakdown } from "./TagBreakdown.js";

// The treemap itself is recharts inside a ResponsiveContainer, which measures
// nothing in jsdom. Stub the lazy chunk: what matters here is when the section
// renders at all, and what the legend says about the grouping.
vi.mock("./TagTreemap.js", () => ({
  TagTreemap: ({ groups }: { groups: { tag: string }[] }) => (
    <svg data-testid="treemap" data-tags={groups.map((g) => g.tag).join(",")} />
  ),
}));

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

  it("charts the split once tags are in play, biggest first", async () => {
    render(
      <TagBreakdown
        lines={[
          line({ paymentId: "rent", tag: "housing", requiredMonthlyMinor: 90_000 }),
          line({ paymentId: "mot", tag: "car", requiredMonthlyMinor: 10_000 }),
        ]}
        currency="GBP"
      />,
    );

    expect(screen.getByRole("heading", { name: "where the month goes" })).toBeInTheDocument();
    expect(screen.getByText("[2 tags · required / mo]")).toBeInTheDocument();
    expect(await screen.findByTestId("treemap")).toHaveAttribute("data-tags", "housing,car");
  });

  it("lists each tag's monthly cost and share in the legend", () => {
    render(
      <TagBreakdown
        lines={[
          line({ paymentId: "rent", tag: "housing", requiredMonthlyMinor: 90_000 }),
          line({ paymentId: "mot", tag: "car", requiredMonthlyMinor: 10_000 }),
        ]}
        currency="GBP"
      />,
    );

    const legend = screen.getByRole("list");
    expect(legend).toHaveTextContent("housing£900.0090.0%");
    expect(legend).toHaveTextContent("car£100.0010.0%");
    // Every figure carries the class privacy mode blurs.
    expect(legend.querySelectorAll(".amount")).toHaveLength(2);
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
