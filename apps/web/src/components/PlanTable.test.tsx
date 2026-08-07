import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickAddProvider } from "../contexts/QuickAddContext.js";
import { phraseText } from "../lib/money.js";
import { AccountsPage } from "../pages/AccountsPage.js";
import { OverviewPage } from "../pages/OverviewPage.js";
import { stubApiFetch } from "../test/apiMock.js";
import type { AccountPlanDto, PlanInflowSourceDto } from "../lib/types.js";
import {
  daysUntilNextMonthly,
  inflowNote,
  PlanSummary,
  PlanTable,
  recordPrefillMinor,
  senderName,
} from "./PlanTable.js";

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

  /**
   * "add one to see your savings plan" was wrong twice on an account the page
   * beside it labels `shared · view`: the reader cannot add a payment, and the
   * plan they would be shown is not theirs. Ownership, never access (decision
   * 20) — an account shared to you with `edit` is still somebody else's, so it
   * keeps the instruction and loses the possessive.
   */
  it("does not call a co-member's plan yours, or tell a reader to add what they cannot", () => {
    const empty = { ...plan, lines: [] };

    render(<PlanTable plan={empty} canRecord owned />);
    expect(screen.getByText("no payments yet. add one to see your savings plan.")).toBeVisible();
    cleanup();

    // Shared with edit: the instruction stands, the claim of ownership does not.
    render(<PlanTable plan={empty} canRecord />);
    expect(
      screen.getByText("no payments yet. add one to see this account's savings plan."),
    ).toBeVisible();
    cleanup();

    // Shared, view-only: neither stands.
    render(<PlanTable plan={empty} />);
    expect(screen.getByText("no payments yet.")).toBeVisible();
    expect(screen.queryByText(/add one/)).toBeNull();
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

  // The narrow layout, as far as jsdom can see it: which columns are marked to
  // drop and what the sub-line taking them over says. Whether the document
  // actually stops scrolling sideways at 390px is a measurement, not an
  // assertion — see the browser pass.
  it("scrolls inside a wrapper rather than dragging the document sideways", () => {
    const { container } = render(<PlanTable plan={plan} />);
    expect(container.querySelector("table.plan-table")?.parentElement).toHaveClass("table-scroll");
  });

  it("pins the payment column, so a scrolled row still says which one it is", () => {
    const { container } = render(<PlanTable plan={plan} />);
    expect(container.querySelector("thead th")).toHaveClass("sticky-col");
    for (const row of container.querySelectorAll("tbody tr")) {
      expect(row.firstElementChild).toHaveClass("sticky-col");
    }
  });

  it("keeps five columns on a phone and marks the other three to drop", () => {
    const { container } = render(<PlanTable plan={plan} />);
    const headers = [...container.querySelectorAll("thead th")];
    const kept = headers.filter((th) => !th.classList.contains("wide-only"));
    expect(kept.map((th) => th.textContent)).toEqual([
      "payment",
      "save / mo",
      "saved",
      "status",
      "this month",
    ]);

    // Every dropped header has exactly one dropped cell under it in each row —
    // a column half-hidden would misalign the rest.
    const dropped = headers.length - kept.length;
    expect(dropped).toBe(3);
    for (const row of container.querySelectorAll("tbody tr")) {
      expect(row.querySelectorAll("td.wide-only")).toHaveLength(dropped);
    }
  });

  it("folds type, due date and amount into a sub-line under the name", () => {
    const { container } = render(<PlanTable plan={plan} />);
    const [holiday] = container.querySelectorAll(".row-sub");
    expect(holiday).toHaveTextContent("goal · dated · due 2026-09-01 · £1,200.00");
    // Money in the sub-line still has to be something privacy mode can blur.
    expect(holiday?.querySelector(".amount")).toHaveTextContent("£1,200.00");
  });

  it("leaves the amount off the sub-line when it is the monthly ask over again", () => {
    // A monthly bill's amount *is* its required-per-month. Repeating it under
    // the name would say nothing and cost two lines on a phone.
    const { container } = render(<PlanTable plan={{ ...plan, lines: [monthlyBill] }} />);
    expect(container.querySelector(".row-sub")).toHaveTextContent("monthly · due 2026-03-01");
    expect(container.querySelector(".row-sub .amount")).toBeNull();
  });

  it("marks a derived date in the sub-line with the tilde the column uses", () => {
    const paced: AccountPlanDto["lines"][number] = {
      ...plan.lines[0]!,
      targetDate: "2027-02-01",
      fixedMonthlyMinor: 5_000,
      dueDateIsDerived: true,
    };
    const { container } = render(<PlanTable plan={{ ...plan, lines: [paced] }} />);
    expect(container.querySelector(".row-sub")).toHaveTextContent("due ~2027-02-01");
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

// --- the third status -------------------------------------------------------
// The screen that prompted the whole piece of work: a bills pot with no income
// of its own, funded to the penny by £303.20 somebody has yet to move. It used
// to read REQUIRED £303.20 · SHORTFALL £303.20 with every line red.

/** A line the plan covers with money that has not moved yet. */
const awaiting: AccountPlanDto["lines"][number] = {
  paymentId: "b1",
  name: "Council tax",
  category: "monthly_recurring",
  amountMinor: 15_320,
  dueDate: "2026-08-01",
  targetDate: "2026-08-01",
  monthsUntilDue: 0,
  requiredMonthlyMinor: 15_320,
  fundedMonthlyMinor: 15_320,
  fundedFromOwnMinor: 0,
  fundedFromInflowMinor: 15_320,
  alreadySavedMinor: 0,
  onTrack: true,
  status: "awaiting_transfer",
};

/** The bills pot, exactly as the API now describes it. */
const billsPot: AccountPlanDto = {
  accountId: "pot",
  asOfDate: AS_OF,
  currency: "GBP",
  monthlyIncomeMinor: 0,
  bufferMinor: 0,
  totalRequiredMinor: 30_320,
  totalFundedMinor: 30_320,
  leftoverMinor: 0,
  shortfallMinor: 0,
  allocatedInflowMinor: 30_320,
  confirmedInflowMinor: 0,
  contributionsMTD: [],
  latestBalance: null,
  reservedMinor: 0,
  inflowSources: [
    {
      kind: "member",
      memberUserId: "u1",
      displayName: "Ben",
      fromAccountId: "current",
      amountMinor: 30_320,
      confirmedMinor: 0,
    },
  ],
  lines: [awaiting, { ...awaiting, paymentId: "b2", name: "Broadband", amountMinor: 15_000 }],
};

describe("PlanTable — the tri-state", () => {
  it("gives each of the three statuses its own words and its own tone", () => {
    const lines: AccountPlanDto["lines"] = [
      { ...awaiting, paymentId: "f", name: "Rent", status: "funded" },
      { ...awaiting, paymentId: "w", name: "Water" },
      { ...awaiting, paymentId: "r", name: "Gas", status: "at_risk", onTrack: false },
    ];
    render(<PlanTable plan={{ ...billsPot, lines }} />);

    expect(screen.getByText("on track")).toHaveClass("tag-status", "ok");
    expect(screen.getByText("awaiting transfer")).toHaveClass("tag-status", "needs-you");
    expect(screen.getByText("at risk")).toHaveClass("tag-status", "warn");
  });

  it("tints the waiting row amber and the short row red, and leaves funded plain", () => {
    const lines: AccountPlanDto["lines"] = [
      { ...awaiting, paymentId: "f", name: "Rent", status: "funded" },
      { ...awaiting, paymentId: "w", name: "Water" },
      { ...awaiting, paymentId: "r", name: "Gas", status: "at_risk", onTrack: false },
    ];
    const { container } = render(<PlanTable plan={{ ...billsPot, lines }} />);

    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows.map((r) => r.className)).toEqual(["", "awaiting", "at-risk"]);
  });

  it("falls back to the two states a payload without a status meant", () => {
    // The existing fixture carries no `status` at all: on-track is funded,
    // off-track is at risk, exactly as before the third state existed.
    const { container } = render(<PlanTable plan={plan} />);
    expect(screen.getByText("on track")).toBeInTheDocument();
    expect(screen.getByText("at risk")).toBeInTheDocument();
    expect(screen.queryByText("awaiting transfer")).toBeNull();
    expect(container.querySelector("tr.awaiting")).toBeNull();
  });

  it("shows no red anywhere on an account somebody else's money funds", () => {
    const { container } = render(
      <>
        <PlanSummary plan={billsPot} />
        <PlanTable plan={billsPot} />
      </>,
    );

    // Red lives in exactly three classes on this screen; none of them fires.
    expect(container.querySelectorAll(".tag-status.warn")).toHaveLength(0);
    expect(container.querySelectorAll(".kpi.warn")).toHaveLength(0);
    expect(container.querySelectorAll("tr.at-risk")).toHaveLength(0);
    expect(screen.queryByText("at risk")).toBeNull();
    expect(screen.queryByText("shortfall")).toBeNull();
    // And what it says instead.
    expect(screen.getAllByText("awaiting transfer")).toHaveLength(2);
  });
});

describe("PlanTable — recording what has actually arrived", () => {
  it("prefills a waiting line with the account's own money, not the transfer", () => {
    // The line is funded £153.20, of which £53.20 is this account's own income
    // and £100.00 is a transfer nobody has made. Asking to record £153.20 is
    // asking to record money that has not moved.
    const straddling = { ...awaiting, fundedFromOwnMinor: 5_320, fundedFromInflowMinor: 10_000 };
    expect(recordPrefillMinor(straddling)).toBe(5_320);
    expect(recordPrefillMinor({ ...straddling, status: "funded" })).toBe(15_320);
    // No split on the wire at all: nothing to be careful about.
    expect(recordPrefillMinor(plan.lines[0]!)).toBe(15_000);
  });

  it("opens the record box with that figure", () => {
    const goal: AccountPlanDto["lines"][number] = {
      ...plan.lines[0]!,
      fundedFromOwnMinor: 4_000,
      fundedFromInflowMinor: 11_000,
      status: "awaiting_transfer",
    };
    render(
      <PlanTable
        plan={{ ...plan, lines: [goal] }}
        canRecord
        onRecord={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "record" }));
    expect(screen.getByLabelText("amount to record for Holiday")).toHaveValue("40.00");
  });
});

describe("PlanSummary — where the money is coming from", () => {
  it("says the account has none of its own, and what is arriving instead", () => {
    const { container } = render(<PlanSummary plan={billsPot} />);

    // INCOME is an em dash, not £0.00 — there is no income, not a zero one.
    const income = screen.getByText("monthly income").parentElement;
    expect(income).toHaveTextContent("—");
    // The whole point: no SHORTFALL, and LEFT OVER does not claim £0.00 either.
    expect(screen.queryByText("shortfall")).toBeNull();
    expect(screen.getByText("left over").parentElement).toHaveTextContent("—");
    // The figure and where it comes from.
    expect(screen.getByText("arriving").parentElement).toHaveTextContent("£303.20");
    expect(container.querySelector(".plan-notes")).toHaveTextContent(
      "no income of its own · £303.20 arriving from Ben this month",
    );
    // The figure in the prose is wrapped, so privacy mode can still blur it.
    expect(container.querySelector(".plan-notes .amount")).toHaveTextContent("£303.20");
    expect(screen.getByText("none of it moved yet")).toBeInTheDocument();
  });

  it("turns the arriving KPI green once the money has moved", () => {
    const { container } = render(
      <PlanSummary plan={{ ...billsPot, confirmedInflowMinor: 30_320 }} />,
    );
    expect(container.querySelector(".kpi.needs-you")).toBeNull();
    expect(screen.getByText("all of it moved")).toBeInTheDocument();
  });

  it("counts what has moved so far when only part of it has", () => {
    render(<PlanSummary plan={{ ...billsPot, confirmedInflowMinor: 12_000 }} />);
    expect(screen.getByText(/moved so far/)).toHaveTextContent("£120.00 moved so far");
  });

  it("leaves an ordinary account exactly as it was", () => {
    const { container } = render(<PlanSummary plan={plan} />);
    expect(container.querySelector(".plan-notes")).toBeNull();
    expect(screen.queryByText("arriving")).toBeNull();
    expect(screen.getByText("left over")).toBeInTheDocument();
    expect(screen.getByText("£2,786.00")).toBeInTheDocument();
  });

  it("names a funding loop rather than hiding it", () => {
    render(<PlanSummary plan={{ ...billsPot, fundingCycleAccountIds: ["a", "b", "c"] }} />);
    expect(screen.getByText(/funding loop · 3 accounts feed each other/)).toBeInTheDocument();
  });
});

describe("inflowNote — the sentence, for each kind of sender", () => {
  const withSources = (
    sources: PlanInflowSourceDto[] | null,
    over: Partial<AccountPlanDto> = {},
  ): AccountPlanDto => ({ ...billsPot, inflowSources: sources, ...over });

  const text = (p: AccountPlanDto): string => phraseText(inflowNote(p) ?? []);

  it("names a household member sending money", () => {
    expect(text(billsPot)).toBe("no income of its own · £303.20 arriving from Ben this month");
  });

  it("names another of your own accounts, with no household invented", () => {
    const sentence = text(
      withSources([
        {
          kind: "account",
          inflowId: "i1",
          fromAccountId: "a1",
          accountName: "Ben current",
          amountMinor: 30_320,
          confirmedMinor: 0,
        },
      ]),
    );
    expect(sentence).toBe("no income of its own · £303.20 arriving from Ben current this month");
    expect(sentence).not.toMatch(/household/);
  });

  it("says the kind of sender when access control withholds the name", () => {
    expect(
      senderName({
        kind: "member",
        memberUserId: "u9",
        fromAccountId: "a9",
        amountMinor: 1,
        confirmedMinor: 0,
      }),
    ).toBe("a household member");
    expect(
      senderName({
        kind: "account",
        inflowId: "i9",
        fromAccountId: "a9",
        amountMinor: 1,
        confirmedMinor: 0,
      }),
    ).toBe("another account");

    const sentence = text(
      withSources([
        {
          kind: "account",
          inflowId: "i9",
          fromAccountId: "a9",
          amountMinor: 30_320,
          confirmedMinor: 0,
        },
      ]),
    );
    expect(sentence).toBe(
      "no income of its own · £303.20 arriving from another account this month",
    );
    // Never an id, and never "your account" for one you have not been shown.
    expect(sentence).not.toMatch(/a9/);
  });

  it("lists two senders", () => {
    expect(
      text(
        withSources([
          {
            kind: "member",
            memberUserId: "u1",
            displayName: "Ben",
            fromAccountId: "current",
            amountMinor: 20_000,
            confirmedMinor: 0,
          },
          {
            kind: "account",
            inflowId: "i1",
            fromAccountId: "a1",
            accountName: "Rainy day",
            amountMinor: 10_320,
            confirmedMinor: 0,
          },
        ]),
      ),
    ).toBe("no income of its own · £303.20 arriving from Ben and Rainy day this month");
  });

  it("names nobody when the API named nobody", () => {
    // `inflowSources: null` — something is arriving, but not who is sending it.
    expect(text(withSources(null))).toBe("no income of its own · £303.20 arriving this month");
  });

  it("drops the lead clause on an account that also earns", () => {
    expect(text(withSources(billsPot.inflowSources ?? null, { monthlyIncomeMinor: 250_000 }))).toBe(
      "£303.20 arriving from Ben this month",
    );
  });

  it("says nothing at all when nothing is arriving", () => {
    expect(inflowNote(plan)).toBeNull();
    expect(inflowNote({ ...billsPot, allocatedInflowMinor: 0 })).toBeNull();
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

/**
 * The last place the two-engine disagreement survived, and the one this whole
 * plan is named after.
 *
 * Measured in a browser: an account whose household page and flow diagram both
 * read £1,822.60 had this KPI reading £2,625.80 — the same account, the same
 * month, one £803.20 savings movement apart. LEFT OVER prints `residualMinor`
 * now, which is what is actually in the account once everything has moved, and
 * is the figure `packages/domain/src/parity.test.ts` asserts equal across all
 * three surfaces.
 */
describe("PlanSummary — one number, on every surface", () => {
  const sender = {
    ...plan,
    monthlyIncomeMinor: 400_000,
    totalRequiredMinor: 0,
    totalFundedMinor: 0,
    shortfallMinor: 0,
    // Own income after own bills and the transfers its owner must make. Keeps
    // its meaning on the wire (decision 13) and is not what a reader wants.
    leftoverMinor: 262_580,
    outboundInflowMinor: 80_320,
    residualMinor: 182_260,
    lines: [],
  };

  it("prints what stays put, not the surplus before the savings left", () => {
    render(<PlanSummary plan={sender} />);
    expect(screen.getByText("left over").parentElement).toHaveTextContent("£1,822.60");
    expect(screen.queryByText("£2,625.80")).toBeNull();
  });

  it("names the consolidation a negative residual means", () => {
    // Decision 11: more is committed to leave than reaches this account, which
    // happens when a member holds income somewhere other than the account their
    // transfers leave. A silent minus figure would be the one thing worse than
    // flooring it.
    const { container } = render(
      <PlanSummary plan={{ ...sender, residualMinor: -20_000, outboundInflowMinor: 300_000 }} />,
    );
    expect(screen.getByText("left over").parentElement).toHaveTextContent("-£200.00");
    expect(container.querySelector(".kpi.warn")).not.toBeNull();
    expect(
      screen.getByText("more leaves this account than reaches it — consolidate first"),
    ).toBeInTheDocument();
  });

  it("still says nothing at all for a pot that ends the month empty", () => {
    render(<PlanSummary plan={billsPot} />);
    expect(screen.getByText("left over").parentElement).toHaveTextContent("—");
  });

  it("falls back to leftoverMinor when the wire carries no residual", () => {
    const older: AccountPlanDto = { ...sender, residualMinor: undefined };
    render(<PlanSummary plan={older} />);
    expect(screen.getByText("left over").parentElement).toHaveTextContent("£2,625.80");
  });
});

/**
 * **The acceptance this package exists for: one account, three screens, one
 * figure.**
 *
 * The fixture is the savings pot the report opened with — no income of its own,
 * £200 left in it after the month, and `leftoverMinor` of nought because the
 * money that reached it is the sender's surplus and not the pot's. The pot read
 * **£0.00** on the accounts index and on the dashboard while its own page read
 * **£200.00**, which is one account described two ways by three screens.
 *
 * All three now go through `leftOverMinor`, so the only way to break this is to
 * add a fourth surface that does not — and `LeftOverCell` is there so that a
 * fourth surface has nothing to get wrong.
 */
describe("one account's left over, on all three surfaces", () => {
  const ME = { id: "u1", email: "ada@example.com", displayName: "Ada", households: [] };

  /** The pot as `GET /api/accounts` lists it. */
  const POT_ACCOUNT = {
    id: "pot",
    name: "Holiday pot",
    description: null,
    currency: "GBP",
    openingBalanceMinor: 0,
    monthlyBufferMinor: 0,
    owner: true,
    permission: "edit" as const,
    ownerUserId: "u1",
  };

  /** The same pot as `GET /api/overview` summarises it. `leftoverMinor` is
   *  nought and the residual is £200 — the exact divergence that made the two
   *  lists disagree with the account page. */
  const POT_STATE = {
    accountId: "pot",
    name: "Holiday pot",
    householdId: null,
    householdRole: null,
    monthlyIncomeMinor: 0,
    allocatedInflowMinor: 40_000,
    confirmedInflowMinor: 40_000,
    ownerUserId: "u1",
    leftoverMinor: 0,
    residualMinor: 20_000,
    shortfallMinor: 0,
    atRiskCount: 0,
    latestBalanceMinor: 20_000,
    latestBalanceDate: AS_OF,
    reservedMinor: 0,
    unrecordedCount: 0,
    unrecordedTotalMinor: 0,
  };

  /** And as `GET /api/accounts/pot/plan` computes it: the same two fields. */
  const POT_PLAN: AccountPlanDto = {
    ...plan,
    accountId: "pot",
    monthlyIncomeMinor: 0,
    totalRequiredMinor: 20_000,
    totalFundedMinor: 20_000,
    allocatedInflowMinor: 40_000,
    confirmedInflowMinor: 40_000,
    leftoverMinor: 0,
    residualMinor: 20_000,
    lines: [],
  };

  const routes = {
    "GET /api/auth/me": { body: ME },
    "GET /api/accounts": { body: [POT_ACCOUNT] },
    "GET /api/overview": {
      body: {
        asOfDate: AS_OF,
        perCurrency: [
          {
            currency: "GBP",
            monthlyIncomeMinor: 0,
            bufferMinor: 0,
            totalRequiredMinor: 20_000,
            totalFundedMinor: 20_000,
            leftoverMinor: 0,
            shortfallMinor: 0,
            you: { leftoverMinor: 20_000, shortfallMinor: 0, paymentCount: 0 },
            accounts: [POT_STATE],
          },
        ],
      },
    },
    "GET /api/upcoming?days=14": { body: { asOfDate: AS_OF, days: 14, items: [] } },
    "GET /api/me/closes": { body: [] },
    "GET /api/meta": { body: { demoSeedEnabled: false } },
  };

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** The LEFT OVER / MO cell of the pot's row, on whichever page is rendered. */
  async function rowFigure(page: React.ReactElement): Promise<string> {
    stubApiFetch(routes);
    const { container } = render(<MemoryRouter>{page}</MemoryRouter>);
    const row = await waitFor(() => {
      const found = [...container.querySelectorAll("tbody tr")].find((r) =>
        r.textContent?.includes("Holiday pot"),
      );
      expect(found).toBeDefined();
      return found!;
    });
    // Third column on both tables: account, balance, left over / mo.
    return row.querySelectorAll("td")[2]!.textContent ?? "";
  }

  it("reads the same on its own page, the accounts index and the dashboard", async () => {
    render(<PlanSummary plan={POT_PLAN} />);
    const own = screen.getByText("left over").parentElement!.textContent ?? "";
    cleanup();

    const index = await rowFigure(
      <QuickAddProvider>
        <AccountsPage />
      </QuickAddProvider>,
    );
    cleanup();
    vi.unstubAllGlobals();

    const dashboard = await rowFigure(
      <QuickAddProvider>
        <OverviewPage />
      </QuickAddProvider>,
    );

    expect(own).toContain("£200.00");
    expect(index).toBe("£200.00");
    expect(dashboard).toBe("£200.00");
    // And the field the two lists used to print, so this cannot pass by all
    // three quietly reading `leftoverMinor` again.
    expect(index).not.toBe("£0.00");
    expect(dashboard).not.toBe("£0.00");
  });

  it("shows the em dash on all three when the pot never had a surplus", async () => {
    const empty = { ...POT_STATE, residualMinor: 0, allocatedInflowMinor: 0 };
    routes["GET /api/overview"] = {
      body: {
        ...(routes["GET /api/overview"].body as { asOfDate: string; perCurrency: unknown[] }),
        perCurrency: [
          {
            currency: "GBP",
            monthlyIncomeMinor: 0,
            bufferMinor: 0,
            totalRequiredMinor: 0,
            totalFundedMinor: 0,
            leftoverMinor: 0,
            shortfallMinor: 0,
            you: { leftoverMinor: 0, shortfallMinor: 0, paymentCount: 0 },
            accounts: [empty],
          },
        ],
      },
    };

    render(<PlanSummary plan={{ ...POT_PLAN, residualMinor: 0, allocatedInflowMinor: 0 }} />);
    expect(screen.getByText("left over").parentElement).toHaveTextContent("—");
    cleanup();

    const index = await rowFigure(
      <QuickAddProvider>
        <AccountsPage />
      </QuickAddProvider>,
    );
    expect(index).toBe("—");
  });
});
