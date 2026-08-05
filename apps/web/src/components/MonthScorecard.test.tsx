import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api.js";
import type { MonthCloseDto } from "../lib/types.js";
import { MonthScorecard, savingsRate, scorecardCards } from "./MonthScorecard.js";

function close(
  over: Partial<MonthCloseDto> & { id: string; month: string; currency: string },
): MonthCloseDto {
  return {
    userId: "u1",
    incomeMinor: 300_000,
    plannedMinor: 100_000,
    contributedMinor: 75_000,
    closedBy: "u1",
    closedAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

const noop = async (): Promise<void> => {};

/** The estate's shape through the HTTP surface: two currencies, one month. */
const TWO_CURRENCIES = [
  close({ id: "c-eur", month: "2026-07-01", currency: "EUR", incomeMinor: 90_000 }),
  close({ id: "c-gbp", month: "2026-07-01", currency: "GBP" }),
];

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

describe("scorecardCards", () => {
  it("splits a mixed list into one card per currency, A–Z", () => {
    const cards = scorecardCards([
      close({ id: "a", month: "2026-07-01", currency: "GBP" }),
      close({ id: "b", month: "2026-07-01", currency: "EUR" }),
    ]);
    expect(cards.map((c) => c.currency)).toEqual(["EUR", "GBP"]);
  });

  it("puts the newest month first inside a card, whatever order it arrived in", () => {
    const cards = scorecardCards([
      close({ id: "a", month: "2026-05-01", currency: "GBP" }),
      close({ id: "b", month: "2026-07-01", currency: "GBP" }),
      close({ id: "c", month: "2026-06-01", currency: "GBP" }),
    ]);
    expect(cards[0]!.closes.map((c) => c.month)).toEqual([
      "2026-07-01",
      "2026-06-01",
      "2026-05-01",
    ]);
  });

  it("calls a card empty only when every row in it is {0, 0, 0}", () => {
    const zero = { incomeMinor: 0, plannedMinor: 0, contributedMinor: 0 };
    expect(
      scorecardCards([close({ id: "a", month: "2026-07-01", currency: "EUR", ...zero })])[0]!.empty,
    ).toBe(true);
    expect(
      scorecardCards([
        close({ id: "a", month: "2026-07-01", currency: "EUR", ...zero }),
        close({ id: "b", month: "2026-06-01", currency: "EUR" }),
      ])[0]!.empty,
    ).toBe(false);
  });

  it("has no cards at all when nothing is closed", () => {
    expect(scorecardCards([])).toEqual([]);
  });
});

describe("MonthScorecard", () => {
  it("renders a row per closed month with a readable month label", () => {
    render(
      <MonthScorecard
        closes={[close({ id: "c1", month: "2026-07-01", currency: "GBP" })]}
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

  it("shows one card per currency, each in its own money", () => {
    render(
      <MonthScorecard closes={TWO_CURRENCIES} month="2026-08" onClose={noop} onReopen={noop} />,
    );

    const cards = document.querySelectorAll(".scorecard-card");
    expect(cards).toHaveLength(2);
    // A–Z, and no figure in one card is denominated in the other's currency.
    expect(within(cards[0] as HTMLElement).getByText("EUR")).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).getByText("€900.00")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText("GBP")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText("£3,000.00")).toBeInTheDocument();
  });

  it("counts months rather than rows, so two currencies are still one month", () => {
    render(
      <MonthScorecard closes={TWO_CURRENCIES} month="2026-08" onClose={noop} onReopen={noop} />,
    );
    expect(screen.getByText(/1 closed/)).toBeInTheDocument();
  });

  it("keeps a currency you hold no money in, and says why it is empty", () => {
    render(
      <MonthScorecard
        closes={[
          close({
            id: "c-eur",
            month: "2026-07-01",
            currency: "EUR",
            incomeMinor: 0,
            plannedMinor: 0,
            contributedMinor: 0,
          }),
          close({ id: "c-gbp", month: "2026-07-01", currency: "GBP" }),
        ]}
        month="2026-08"
        onClose={noop}
        onReopen={noop}
      />,
    );

    // Not hidden: the close wrote it, so "what I closed" has to show it.
    expect(document.querySelectorAll(".scorecard-card")).toHaveLength(2);
    expect(screen.getByText(/none of this money is yours/i)).toBeInTheDocument();
    // Income, planned and saved, all printed as the zeroes they are.
    expect(screen.getAllByText("€0.00")).toHaveLength(3);
    expect(document.querySelector("tr.dim-row")).not.toBeNull();
  });

  it("says nothing about emptiness on a card that has money in it", () => {
    render(
      <MonthScorecard closes={TWO_CURRENCIES} month="2026-08" onClose={noop} onReopen={noop} />,
    );
    expect(screen.queryByText(/none of this money is yours/i)).toBeNull();
  });

  it("dims the rate for a month with no income", () => {
    render(
      <MonthScorecard
        closes={[close({ id: "c1", month: "2026-07-01", currency: "GBP", incomeMinor: 0 })]}
        month="2026-08"
        onClose={noop}
        onReopen={noop}
      />,
    );
    expect(screen.getByText("—")).toHaveClass("dim");
  });

  it("offers the close to everyone — your own month is always yours to close", () => {
    render(
      <MonthScorecard
        closes={[close({ id: "c1", month: "2026-07-01", currency: "GBP" })]}
        month="2026-08"
        onClose={noop}
        onReopen={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "close aug 2026" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "reopen" })).toBeInTheDocument();
  });

  it("closes the current month on request, naming no scope", async () => {
    const onClose = vi.fn().mockResolvedValue(undefined);
    render(<MonthScorecard closes={[]} month="2026-08" onClose={onClose} onReopen={noop} />);

    fireEvent.click(screen.getByRole("button", { name: "close aug 2026" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith("2026-08"));
  });

  it("re-opens one row at a time, by id — closing is per month, this is not", async () => {
    const onReopen = vi.fn().mockResolvedValue(undefined);
    render(
      <MonthScorecard closes={TWO_CURRENCIES} month="2026-08" onClose={noop} onReopen={onReopen} />,
    );

    const reopens = screen.getAllByRole("button", { name: "reopen" });
    expect(reopens).toHaveLength(2);
    fireEvent.click(reopens[1]!);

    await waitFor(() => expect(onReopen).toHaveBeenCalledWith("c-gbp"));
  });

  it("surfaces the error code when the month is already closed", async () => {
    const onClose = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "already_closed", "Month already closed"));
    render(<MonthScorecard closes={[]} month="2026-08" onClose={onClose} onReopen={noop} />);

    fireEvent.click(screen.getByRole("button", { name: "close aug 2026" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already_closed");
  });

  it("keeps the 409 visible over a partly-closed month, where it is the whole story", async () => {
    const onClose = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "already_closed", "Month already closed"));
    render(
      <MonthScorecard
        closes={[close({ id: "c-gbp", month: "2026-08-01", currency: "GBP" })]}
        month="2026-08"
        onClose={onClose}
        onReopen={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "close aug 2026" }));

    // The GBP row is already frozen, so the month cannot be closed again until
    // it is re-opened — and the card it names is still on screen beside this.
    expect(await screen.findByRole("alert")).toHaveTextContent("already_closed");
    expect(screen.getByText("aug 2026")).toBeInTheDocument();
  });

  it("surfaces a future-month rejection", async () => {
    const onClose = vi
      .fn()
      .mockRejectedValue(new ApiError(422, "future_month", "Cannot close a future month"));
    render(<MonthScorecard closes={[]} month="2026-12" onClose={onClose} onReopen={noop} />);

    fireEvent.click(screen.getByRole("button", { name: "close dec 2026" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("future_month");
  });

  it("says something other than a code when the failure has none", async () => {
    const onClose = vi.fn().mockRejectedValue(new Error("network"));
    render(<MonthScorecard closes={[]} month="2026-08" onClose={onClose} onReopen={noop} />);

    fireEvent.click(screen.getByRole("button", { name: "close aug 2026" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("something went wrong");
  });

  it("invites the first close when nothing has been closed yet", () => {
    render(<MonthScorecard closes={[]} month="2026-08" onClose={noop} onReopen={noop} />);
    expect(screen.getByText(/no months closed yet/i)).toBeInTheDocument();
  });
});
