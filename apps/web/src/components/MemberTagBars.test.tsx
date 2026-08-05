import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  HouseholdMemberPlanDto,
  HouseholdPlanDto,
  HouseholdPlanLineDto,
} from "../lib/types.js";
import { MemberTagBars } from "./MemberTagBars.js";

function member(over: Partial<HouseholdMemberPlanDto> & { userId: string }) {
  return {
    displayName: over.userId,
    shareBp: 5_000,
    monthlyIncomeMinor: 300_000,
    obligationMinor: 0,
    fundedMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    ...over,
  };
}

function line(over: Partial<HouseholdPlanLineDto> & { paymentId: string }): HouseholdPlanLineDto {
  return {
    accountId: "acc",
    name: over.paymentId,
    category: "monthly_recurring",
    scope: "shared",
    amountMinor: 0,
    dueDate: "2026-08-01",
    targetDate: "2026-08-01",
    priority: 100,
    requiredMonthlyMinor: 0,
    fundedMonthlyMinor: 0,
    occurrencesThisMonth: 1,
    onTrack: true,
    allocations: [],
    ...over,
  };
}

function plan(over: Partial<HouseholdPlanDto>): HouseholdPlanDto {
  return {
    householdId: "hh",
    asOfDate: "2026-08-01",
    currency: "GBP",
    monthlyIncomeMinor: 0,
    totalRequiredMinor: 0,
    totalFundedMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    members: [],
    accounts: [],
    lines: [],
    transfers: [],
    ...over,
  };
}

/** Segment widths as numbers, in render order. */
function widths(bar: HTMLElement): number[] {
  return [...bar.querySelectorAll<HTMLElement>(".member-bar-seg")].map((s) =>
    Number.parseFloat(s.style.width),
  );
}

describe("MemberTagBars", () => {
  const funded = plan({
    members: [member({ userId: "alice", displayName: "Alice", obligationMinor: 100_000 })],
    lines: [
      line({
        paymentId: "rent",
        tag: "housing",
        allocations: [{ userId: "alice", requiredMinor: 75_000, fundedMinor: 75_000 }],
      }),
      line({
        paymentId: "mot",
        tag: "car",
        allocations: [{ userId: "alice", requiredMinor: 25_000, fundedMinor: 25_000 }],
      }),
    ],
  });

  it("renders nothing for a household with no members", () => {
    const { container } = render(<MemberTagBars plan={plan({})} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws one bar per member, headed by what they owe", () => {
    render(<MemberTagBars plan={funded} />);
    expect(screen.getByRole("heading", { name: "who carries what" })).toBeInTheDocument();
    const bar = screen.getByTestId("member-bar-alice");
    expect(bar).toHaveTextContent("Alice");
    expect(bar).toHaveTextContent("£1,000.00");
  });

  it("splits the full width across tags when everything is funded", () => {
    render(<MemberTagBars plan={funded} />);
    const bar = screen.getByTestId("member-bar-alice");

    expect(widths(bar)).toEqual([75, 25]);
    expect(widths(bar).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
    expect(bar.querySelector(".member-bar-seg.unfunded")).toBeNull();
    expect(bar.querySelector('[data-tag="housing"]')).not.toBeNull();
  });

  it("tops the bar up with a warn-coloured unfunded tail", () => {
    const short = plan({
      members: [
        member({
          userId: "bob",
          displayName: "Bob",
          obligationMinor: 100_000,
          shortfallMinor: 70_000,
        }),
      ],
      lines: [
        line({
          paymentId: "rent",
          tag: "housing",
          allocations: [{ userId: "bob", requiredMinor: 100_000, fundedMinor: 30_000 }],
        }),
      ],
    });
    render(<MemberTagBars plan={short} />);
    const bar = screen.getByTestId("member-bar-bob");

    expect(widths(bar)).toEqual([30, 70]);
    const tail = bar.querySelector<HTMLElement>(".member-bar-seg.unfunded")!;
    expect(tail).not.toBeNull();
    expect(tail.getAttribute("title")).toBe("unfunded · £700.00");
    expect(bar).toHaveTextContent("unfunded");
  });

  /**
   * Measured in a browser: Ben's bar read "unfunded £303.20" in red on a
   * household with a shortfall of zero. His obligation covers the whole scope
   * the pass planned; this page's lines cover only the household's own accounts,
   * and decision 9 has the same pass fund a standalone pot for him too. Every
   * penny of it was there — none of it was on a line this page draws.
   */
  it("does not paint an obligation funded outside this household as unfunded", () => {
    const elsewhere = plan({
      members: [
        member({
          userId: "ben",
          displayName: "Ben",
          obligationMinor: 137_420,
          fundedMinor: 137_420,
          // The split the household view publishes: what these lines carry, and
          // what the same pass funds on an account this household does not hold.
          householdObligationMinor: 107_100,
          householdFundedMinor: 107_100,
          elsewhereObligationMinor: 30_320,
          elsewhereFundedMinor: 30_320,
          shortfallMinor: 0,
        }),
      ],
      lines: [
        line({
          paymentId: "rent",
          tag: "housing",
          allocations: [{ userId: "ben", requiredMinor: 107_100, fundedMinor: 107_100 }],
        }),
      ],
    });
    render(<MemberTagBars plan={elsewhere} />);
    const bar = screen.getByTestId("member-bar-ben");

    expect(bar.querySelector(".member-bar-seg.unfunded")).toBeNull();
    expect(bar).not.toHaveTextContent("unfunded");
    const rest = bar.querySelector<HTMLElement>(".member-bar-seg.elsewhere")!;
    expect(rest.getAttribute("title")).toBe("elsewhere in your plan · £303.20");
    // ...and the bar still fills exactly.
    expect(widths(bar).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });

  it("splits the tail when a member is both short and funded elsewhere", () => {
    const both = plan({
      members: [
        member({
          userId: "cass",
          displayName: "Cass",
          obligationMinor: 100_000,
          fundedMinor: 80_000,
          householdObligationMinor: 60_000,
          householdFundedMinor: 50_000,
          elsewhereObligationMinor: 40_000,
          elsewhereFundedMinor: 30_000,
          shortfallMinor: 20_000,
        }),
      ],
      lines: [
        line({
          paymentId: "rent",
          tag: "housing",
          allocations: [{ userId: "cass", requiredMinor: 60_000, fundedMinor: 50_000 }],
        }),
      ],
    });
    render(<MemberTagBars plan={both} />);
    const bar = screen.getByTestId("member-bar-cass");

    expect(bar.querySelector<HTMLElement>(".member-bar-seg.unfunded")!.getAttribute("title")).toBe(
      "unfunded · £200.00",
    );
    expect(bar.querySelector<HTMLElement>(".member-bar-seg.elsewhere")!.getAttribute("title")).toBe(
      "elsewhere in your plan · £300.00",
    );
    expect(widths(bar).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });

  it("describes the bar for anyone who can't see it", () => {
    render(<MemberTagBars plan={funded} />);
    expect(
      screen.getByRole("img", { name: "Alice: £1,000.00 funded of £1,000.00" }),
    ).toBeInTheDocument();
  });

  it("says so rather than drawing an empty bar when nothing is owed", () => {
    render(
      <MemberTagBars
        plan={plan({ members: [member({ userId: "carol", displayName: "Carol" })] })}
      />,
    );
    const bar = screen.getByTestId("member-bar-carol");
    expect(bar).toHaveTextContent("nothing owed this month");
    expect(bar.querySelector(".member-bar-track")).toBeNull();
  });
});
