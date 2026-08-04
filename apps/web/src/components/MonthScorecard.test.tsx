import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api.js";
import type { MonthCloseDto } from "../lib/types.js";
import { MonthScorecard, savingsRate } from "./MonthScorecard.js";

function close(over: Partial<MonthCloseDto> & { id: string; month: string }): MonthCloseDto {
  return {
    householdId: null,
    accountId: "a1",
    incomeMinor: 300_000,
    plannedMinor: 100_000,
    contributedMinor: 75_000,
    closedBy: "u1",
    closedAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

const noop = async (): Promise<void> => {};

describe("savingsRate", () => {
  it("is contributed over income, to one decimal", () => {
    expect(savingsRate(75_000, 300_000)).toBe("25.0%");
    expect(savingsRate(12_345, 100_000)).toBe("12.3%");
  });

  it("has no rate when there was no income", () => {
    expect(savingsRate(50_000, 0)).toBe("—");
    expect(savingsRate(0, 0)).toBe("—");
  });

  it("guards against a negative income figure rather than inverting the sign", () => {
    expect(savingsRate(50_000, -100)).toBe("—");
  });

  it("can exceed 100% when more was saved than earned that month", () => {
    expect(savingsRate(400_000, 300_000)).toBe("133.3%");
  });
});

describe("MonthScorecard", () => {
  it("renders a row per closed month with a readable month label", () => {
    render(
      <MonthScorecard
        closes={[close({ id: "c1", month: "2026-07-01" })]}
        currency="GBP"
        month="2026-08"
        onClose={noop}
        onReopen={noop}
      />,
    );
    expect(screen.getByText("jul 2026")).toBeInTheDocument();
    expect(screen.getByText("£3,000.00")).toBeInTheDocument();
    expect(screen.getByText("£750.00")).toBeInTheDocument();
    expect(screen.getByText("25.0%")).toBeInTheDocument();
  });

  it("dims the rate for a month with no income", () => {
    render(
      <MonthScorecard
        closes={[close({ id: "c1", month: "2026-07-01", incomeMinor: 0 })]}
        currency="GBP"
        month="2026-08"
        onClose={noop}
        onReopen={noop}
      />,
    );
    expect(screen.getByText("—")).toHaveClass("dim");
  });

  it("hides close and reopen from callers who may not close", () => {
    render(
      <MonthScorecard
        closes={[close({ id: "c1", month: "2026-07-01" })]}
        currency="GBP"
        month="2026-08"
        onClose={noop}
        onReopen={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "reopen" })).toBeNull();
  });

  it("closes the current month on request", async () => {
    const onClose = vi.fn().mockResolvedValue(undefined);
    render(
      <MonthScorecard
        closes={[]}
        currency="GBP"
        month="2026-08"
        canClose
        onClose={onClose}
        onReopen={noop}
      />,
    );

    const button = screen.getByRole("button", { name: "close aug 2026" });
    fireEvent.click(button);

    await waitFor(() => expect(onClose).toHaveBeenCalledWith("2026-08"));
  });

  it("reopens a closed month on request", async () => {
    const onReopen = vi.fn().mockResolvedValue(undefined);
    render(
      <MonthScorecard
        closes={[close({ id: "c1", month: "2026-07-01" })]}
        currency="GBP"
        month="2026-08"
        canClose
        onClose={noop}
        onReopen={onReopen}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "reopen" }));

    await waitFor(() => expect(onReopen).toHaveBeenCalledWith("c1"));
  });

  it("surfaces the error code when the month is already closed", async () => {
    const onClose = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "already_closed", "Month already closed"));
    render(
      <MonthScorecard
        closes={[]}
        currency="GBP"
        month="2026-08"
        canClose
        onClose={onClose}
        onReopen={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "close aug 2026" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already_closed");
  });

  it("surfaces a future-month rejection", async () => {
    const onClose = vi
      .fn()
      .mockRejectedValue(new ApiError(422, "future_month", "Cannot close a future month"));
    render(
      <MonthScorecard
        closes={[]}
        currency="GBP"
        month="2026-12"
        canClose
        onClose={onClose}
        onReopen={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "close dec 2026" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("future_month");
  });

  it("invites the first close when nothing has been closed yet", () => {
    render(
      <MonthScorecard closes={[]} currency="GBP" month="2026-08" onClose={noop} onReopen={noop} />,
    );
    expect(screen.getByText(/no months closed yet/i)).toBeInTheDocument();
  });
});
