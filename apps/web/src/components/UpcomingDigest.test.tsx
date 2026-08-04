import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UpcomingItemDto } from "../lib/types.js";
import { relativeDayLabel, UpcomingDigest } from "./UpcomingDigest.js";

function item(over: Partial<UpcomingItemDto> & { paymentId: string }): UpcomingItemDto {
  return {
    name: "rent",
    category: "monthly_recurring",
    amountMinor: 120_000,
    dueDate: "2026-08-05",
    daysUntil: 1,
    accountId: "a1",
    accountName: "Joint bills",
    currency: "GBP",
    ...over,
  };
}

describe("relativeDayLabel", () => {
  it("reads the next fortnight the way people say it", () => {
    expect(relativeDayLabel(0)).toBe("today");
    expect(relativeDayLabel(1)).toBe("tomorrow");
    expect(relativeDayLabel(5)).toBe("in 5d");
    expect(relativeDayLabel(14)).toBe("in 14d");
  });

  it("treats an overdue row as due today rather than in negative days", () => {
    expect(relativeDayLabel(-2)).toBe("today");
  });
});

describe("UpcomingDigest", () => {
  it("lists what falls due, when, and out of which account", () => {
    render(
      <UpcomingDigest
        days={14}
        items={[
          item({ paymentId: "p1", daysUntil: 0, name: "council tax" }),
          item({ paymentId: "p2", daysUntil: 5, name: "car insurance", amountMinor: 4_500 }),
        ]}
      />,
    );

    expect(screen.getByText("today")).toBeInTheDocument();
    expect(screen.getByText("in 5d")).toBeInTheDocument();
    expect(screen.getByText("council tax")).toBeInTheDocument();
    expect(screen.getByText("£45.00")).toBeInTheDocument();
    expect(screen.getAllByText("Joint bills")).toHaveLength(2);
  });

  it("dims anything past the coming week", () => {
    render(
      <UpcomingDigest
        days={14}
        items={[
          item({ paymentId: "p1", daysUntil: 7, name: "near" }),
          item({ paymentId: "p2", daysUntil: 8, name: "far" }),
        ]}
      />,
    );

    expect(screen.getByText("near").closest("li")).not.toHaveClass("far");
    expect(screen.getByText("far").closest("li")).toHaveClass("far");
  });

  it("caps the list and counts the rest", () => {
    const items = Array.from({ length: 14 }, (_, i) =>
      item({ paymentId: `p${i}`, name: `bill ${i}`, daysUntil: i }),
    );
    render(<UpcomingDigest days={14} items={items} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.getByText("…and 4 more within 14 days")).toBeInTheDocument();
    expect(screen.queryByText("bill 12")).toBeNull();
  });

  it("names the currency only when more than one is in play", () => {
    const gbp = item({ paymentId: "p1", name: "rent" });
    render(<UpcomingDigest days={14} items={[gbp]} />);
    expect(screen.queryByText("GBP")).toBeNull();

    render(
      <UpcomingDigest
        days={14}
        items={[gbp, item({ paymentId: "p2", name: "eu bill", currency: "EUR" })]}
      />,
    );
    expect(screen.getByText("GBP")).toBeInTheDocument();
    expect(screen.getByText("EUR")).toBeInTheDocument();
  });

  it("says the fortnight is clear when nothing is due", () => {
    render(<UpcomingDigest days={14} items={[]} />);
    expect(screen.getByText("nothing due in the next 14 days")).toBeInTheDocument();
  });

  it("waits rather than claiming nothing is due while loading", () => {
    render(<UpcomingDigest days={14} items={[]} loading />);
    expect(screen.queryByText(/nothing due/)).toBeNull();
    expect(screen.getByText(/checking what's due/)).toBeInTheDocument();
  });
});
