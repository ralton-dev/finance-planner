import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api.js";
import type { NeedsYouInput } from "../lib/needsYou.js";
import type {
  AccountPlanDto,
  HouseholdPlanDto,
  TransferConfirmationDto,
  UpcomingItemDto,
} from "../lib/types.js";
import { stubApiFetch, type FetchStub, type Routes } from "../test/apiMock.js";
import { Fold } from "./Fold.js";

/**
 * The fixture is the design mockup's household: Alex is £40 short, one of the
 * two transfers hasn't moved, a save-up line is part-recorded, and the joint
 * account's balance is twelve days old. Four rows, one of each kind.
 */
const AS_OF = "2026-08-04";

function householdPlan(over: Partial<HouseholdPlanDto> = {}): HouseholdPlanDto {
  return {
    householdId: "hh",
    asOfDate: AS_OF,
    currency: "GBP",
    monthlyIncomeMinor: 630_000,
    totalRequiredMinor: 277_338,
    totalFundedMinor: 273_338,
    leftoverMinor: 332_662,
    shortfallMinor: 4_000,
    members: [
      {
        userId: "ben",
        displayName: "Ben",
        shareBp: 6_000,
        monthlyIncomeMinor: 400_000,
        obligationMinor: 131_400,
        fundedMinor: 131_400,
        leftoverMinor: 154_162,
        shortfallMinor: 0,
      },
      {
        userId: "alex",
        displayName: "Alex",
        shareBp: 4_000,
        monthlyIncomeMinor: 230_000,
        obligationMinor: 87_600,
        fundedMinor: 83_600,
        leftoverMinor: 178_500,
        shortfallMinor: 4_000,
      },
    ],
    accounts: [
      {
        accountId: "ben-current",
        name: "Ben current",
        role: "personal",
        memberUserId: "ben",
        currency: "GBP",
        monthlyIncomeMinor: 400_000,
        requiredOutflowMinor: 0,
        fundedOutflowMinor: 0,
        transferInMinor: 0,
        transferOutMinor: 131_400,
        leftoverMinor: 154_162,
        shortfallMinor: 0,
      },
      {
        accountId: "bills",
        name: "Bills joint",
        role: "shared",
        memberUserId: null,
        currency: "GBP",
        monthlyIncomeMinor: 0,
        requiredOutflowMinor: 219_000,
        fundedOutflowMinor: 215_000,
        transferInMinor: 219_000,
        transferOutMinor: 0,
        leftoverMinor: 10_000,
        shortfallMinor: 0,
      },
    ],
    lines: [
      {
        paymentId: "rent",
        accountId: "bills",
        name: "Rent",
        category: "monthly_recurring",
        scope: "shared",
        amountMinor: 100_000,
        dueDate: "2026-08-01",
        targetDate: "2026-08-01",
        priority: 10,
        requiredMonthlyMinor: 100_000,
        fundedMonthlyMinor: 96_000,
        occurrencesThisMonth: 1,
        onTrack: false,
        tag: "housing",
        allocations: [
          { userId: "ben", requiredMinor: 60_000, fundedMinor: 60_000 },
          { userId: "alex", requiredMinor: 40_000, fundedMinor: 36_000 },
        ],
      },
      {
        paymentId: "gym",
        accountId: "alex-current",
        name: "Gym",
        category: "monthly_recurring",
        scope: "personal",
        amountMinor: 3_000,
        dueDate: "2026-08-01",
        targetDate: "2026-08-01",
        priority: 200,
        requiredMonthlyMinor: 3_000,
        fundedMonthlyMinor: 3_000,
        occurrencesThisMonth: 1,
        onTrack: true,
        tag: "health",
        allocations: [{ userId: "alex", requiredMinor: 3_000, fundedMinor: 3_000 }],
      },
    ],
    transfers: [
      {
        fromAccountId: "ben-current",
        toAccountId: "bills",
        memberUserId: "ben",
        amountMinor: 131_400,
      },
      {
        fromAccountId: "alex-current",
        toAccountId: "bills",
        memberUserId: "alex",
        amountMinor: 87_600,
      },
    ],
    ...over,
  };
}

const benConfirmed: TransferConfirmationDto = {
  id: "conf-ben",
  householdId: "hh",
  month: "2026-08-01",
  fromAccountId: "ben-current",
  toAccountId: "bills",
  memberUserId: "ben",
  amountMinor: 131_400,
  createdAt: "2026-08-01T09:00:00.000Z",
};

function accountPlan(over: Partial<AccountPlanDto> & { accountId: string }): AccountPlanDto {
  return {
    asOfDate: AS_OF,
    currency: "GBP",
    monthlyIncomeMinor: 0,
    bufferMinor: 0,
    totalRequiredMinor: 0,
    totalFundedMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    lines: [],
    contributionsMTD: [],
    latestBalance: { asOfDate: AS_OF, balanceMinor: 318_450 },
    reservedMinor: 0,
    ...over,
  };
}

const energyDue: UpcomingItemDto = {
  paymentId: "energy",
  name: "energy",
  category: "monthly_recurring",
  amountMinor: 14_000,
  dueDate: "2026-08-15",
  daysUntil: 11,
  accountId: "bills",
  accountName: "Bills joint",
  currency: "GBP",
};

function fullInput(over: Partial<NeedsYouInput> = {}): NeedsYouInput {
  return {
    asOfDate: AS_OF,
    // Alex is reading, and Alex is the member who is £40 short — so the
    // headline's figure is Alex's own and its sentence may name Alex. Whose
    // money the figure counts is pinned in `needsYou.test.ts`; these tests are
    // about what the component does with the answer.
    userId: "alex",
    you: { leftoverMinor: 332_662, shortfallMinor: 4_000, paymentCount: 2 },
    households: [{ plan: householdPlan(), confirmations: [benConfirmed] }],
    accounts: [
      {
        name: "Ben current",
        householdId: "hh",
        plan: accountPlan({
          accountId: "ben-current",
          lines: [
            {
              paymentId: "rainy",
              name: "Rainy day",
              category: "fixed_point",
              amountMinor: 0,
              dueDate: "2027-06-01",
              targetDate: "2027-06-01",
              monthsUntilDue: 10,
              requiredMonthlyMinor: 20_000,
              fundedMonthlyMinor: 20_000,
              alreadySavedMinor: 0,
              onTrack: true,
            },
          ],
          contributionsMTD: [{ paymentId: "rainy", amountMinor: 5_000 }],
        }),
      },
      {
        name: "Bills joint",
        householdId: "hh",
        plan: accountPlan({
          accountId: "bills",
          latestBalance: { asOfDate: "2026-07-23", balanceMinor: 146_200 },
        }),
      },
    ],
    upcoming: [energyDue],
    ...over,
  };
}

/** The same household with nobody short and nothing left to do. */
function settledInput(): NeedsYouInput {
  const plan = householdPlan({
    shortfallMinor: 0,
    members: householdPlan().members.map((m) => ({ ...m, shortfallMinor: 0 })),
  });
  return {
    asOfDate: AS_OF,
    userId: "alex",
    you: { leftoverMinor: 332_662, shortfallMinor: 0, paymentCount: 2 },
    households: [
      {
        plan,
        confirmations: [
          benConfirmed,
          { ...benConfirmed, id: "conf-alex", fromAccountId: "alex-current", memberUserId: "alex" },
        ],
      },
    ],
  };
}

let stub: FetchStub;

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderFold(
  routes: Routes = {},
  input: NeedsYouInput = fullInput(),
  props: { loading?: boolean } = {},
) {
  stub = stubApiFetch(routes);
  api.setToken(null);
  const onActioned = vi.fn();
  const { container } = render(
    <MemoryRouter>
      <Fold input={input} onActioned={onActioned} {...props} />
    </MemoryRouter>,
  );
  return { container, onActioned };
}

/** The row an item's label sits in — every assertion is scoped to one row. */
function row(label: string | RegExp): HTMLElement {
  return screen.getByText(label).closest("li") as HTMLElement;
}

describe("Fold · headline", () => {
  it("leads with the shortfall in red, worded as the selector words it", () => {
    const { container } = renderFold();

    expect(container.querySelector(".fold-headline")).toHaveClass("shortfall");
    expect(container.querySelector(".fold-label")).toHaveTextContent("shortfall");
    expect(container.querySelector(".fold-figure")).toHaveTextContent("£40.00");
    expect(container.querySelector(".fold-sentence")).toHaveTextContent(
      "Alex's share of housing is £40.00 short this month.",
    );
  });

  it("leaves no figure outside something privacy mode can blur", () => {
    // Privacy mode blurs `.amount`, `td.num` and `.kpi-value` — elements. A
    // figure baked into a sentence has no element of its own, and for a while
    // the fold said "£40.00 is short this month" in the clear on a screen whose
    // entire job is that nobody behind you can read the numbers.
    const { container } = renderFold();

    for (const prose of container.querySelectorAll(".fold-sentence, .needs-you-meta")) {
      const clone = prose.cloneNode(true) as HTMLElement;
      for (const amount of clone.querySelectorAll(".amount")) amount.remove();
      expect(clone.textContent).not.toMatch(/[£$€]|\d[\d,]*\.\d{2}/);
    }
    // …and the prose really does carry figures, so the check above has teeth.
    expect(container.querySelectorAll(".fold-sentence .amount").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".needs-you-meta .amount").length).toBeGreaterThan(0);
  });

  it("switches to the left-over figure once nothing is missing", () => {
    const { container } = renderFold({}, settledInput());

    expect(container.querySelector(".fold-headline")).toHaveClass("leftover");
    expect(container.querySelector(".fold-label")).toHaveTextContent("left over");
    expect(container.querySelector(".fold-figure")).toHaveTextContent("£3,326.62");
  });

  it("counts what is outstanding, and says so plainly when nothing is", () => {
    const { container } = renderFold();
    expect(container.querySelector(".section-head .meta")).toHaveTextContent("[4]");

    const settled = renderFold({}, settledInput());
    expect(settled.container.querySelector(".section-head .meta")).toHaveTextContent(
      "[0] · nothing outstanding",
    );
    expect(settled.container.querySelector(".needs-you-list")).toBeNull();
  });

  it("says it is still looking while the data is in flight", () => {
    renderFold({}, { asOfDate: AS_OF }, { loading: true });
    expect(screen.getByText(/checking what needs you/)).toBeInTheDocument();
  });
});

describe("Fold · the list", () => {
  it("renders the selector's four kinds, in its order", () => {
    const { container } = renderFold();
    const rows = [...container.querySelectorAll(".needs-you-row")];

    expect(rows.map((r) => r.querySelector(".needs-you-kind")?.textContent)).toEqual([
      "shortfall",
      "transfer",
      "record",
      "check-in",
    ]);
    expect(rows.map((r) => r.querySelector(".name")?.textContent)).toEqual([
      "cover Alex's unfunded housing",
      "Alex → Bills joint",
      "record Rainy day",
      "check in Bills joint balance",
    ]);
  });

  it("shows each row's figure, and a check-in's age instead of money", () => {
    renderFold();
    // Scoped to the figure cell: the meta line under it now carries its own
    // `.amount`s (the remedy names a sum), so the row can hold the same figure
    // twice.
    const figure = (label: string): string =>
      row(label).querySelector(".needs-you-figure")!.textContent!;

    expect(figure("cover Alex's unfunded housing")).toBe("£40.00");
    expect(figure("Alex → Bills joint")).toBe("£876.00");
    // The month's target, not the remainder still missing.
    expect(figure("record Rainy day")).toBe("£200.00");
    expect(figure("check in Bills joint balance")).toBe("12 d");
  });

  it("carries the selector's meta line under each row", () => {
    renderFold();
    expect(row("Alex → Bills joint")).toHaveTextContent(
      "transfer · aug 2026 · 1 of 2 done · waiting on Alex",
    );
    expect(row("check in Bills joint balance")).toHaveTextContent(
      "last confirmed 23 jul · energy £140.00 due in 11d",
    );
    // Every figure in a meta line is its own `.amount`, so privacy mode blurs
    // the money inside the prose as well as the money in the tables.
    expect(
      row("check in Bills joint balance").querySelector(".needs-you-meta .amount"),
    ).toHaveTextContent("£140.00");
  });
});

describe("Fold · shortfall", () => {
  it("has no button — it links to where the split is decided", () => {
    renderFold();
    const link = within(row("cover Alex's unfunded housing")).getByRole("link");
    expect(link).toHaveAttribute("href", "/households/hh");
  });
});

describe("Fold · transfer", () => {
  const confirmed: Routes = {
    "POST /api/households/hh/transfers/confirm": {
      status: 201,
      body: { confirmation: { id: "conf-new" }, contributions: [] },
    },
  };

  it("confirms the transfer the selector says is outstanding", async () => {
    const { onActioned } = renderFold(confirmed);

    fireEvent.click(screen.getByRole("button", { name: "mark done" }));

    await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
    expect(stub.bodyOf("POST /api/households/hh/transfers/confirm")).toEqual({
      fromAccountId: "alex-current",
      toAccountId: "bills",
      memberUserId: "alex",
      month: "2026-08",
    });
  });

  it("ticks the row and keeps the undo within reach", async () => {
    const { container } = renderFold(confirmed);

    fireEvent.click(screen.getByRole("button", { name: "mark done" }));

    expect(await screen.findByText("✓ done")).toBeInTheDocument();
    // Ticked immediately: the count drops before the page has refetched.
    expect(container.querySelector(".section-head .meta")).toHaveTextContent("[3]");
    expect(screen.getByRole("button", { name: "undo" })).toBeInTheDocument();
  });

  it("puts the row back when the undo goes through", async () => {
    const { onActioned } = renderFold({
      ...confirmed,
      "DELETE /api/households/hh/transfers/confirmations/conf-new": { status: 204 },
    });

    fireEvent.click(screen.getByRole("button", { name: "mark done" }));
    fireEvent.click(await screen.findByRole("button", { name: "undo" }));

    await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(2));
    expect(stub.calls("DELETE /api/households/hh/transfers/confirmations/conf-new")).toBe(1);
    expect(screen.getByRole("button", { name: "mark done" })).toBeInTheDocument();
    expect(screen.queryByText("✓ done")).toBeNull();
  });

  it("rolls the tick back and names the error code when the server refuses", async () => {
    const { onActioned } = renderFold({
      "POST /api/households/hh/transfers/confirm": {
        status: 409,
        body: { error: { code: "already_confirmed", message: "already confirmed" } },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "mark done" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already_confirmed");
    expect(screen.queryByText("✓ done")).toBeNull();
    expect(screen.getByRole("button", { name: "mark done" })).toBeInTheDocument();
    expect(onActioned).not.toHaveBeenCalled();
  });
});

/**
 * The same row with no household in it: money the plan moves between two
 * accounts you own. One button, one endpoint scoped to the authored inflow.
 */
describe("Fold · movement", () => {
  const potInput: NeedsYouInput = {
    asOfDate: AS_OF,
    accounts: [
      {
        name: "Holiday pot",
        plan: accountPlan({
          accountId: "holiday",
          allocatedInflowMinor: 30_000,
          inflowArrivals: [{ inflowId: "inf-1", fromAccountId: "current", amountMinor: 30_000 }],
          inflowSources: [
            {
              kind: "account",
              inflowId: "inf-1",
              fromAccountId: "current",
              accountName: "Current account",
              amountMinor: 30_000,
              confirmedMinor: 0,
            },
          ],
        }),
      },
    ],
  };

  const confirmed: Routes = {
    "POST /api/inflows/inf-1/confirm?month=2026-08": {
      status: 201,
      body: { confirmation: { id: "conf-move" }, contributions: [] },
    },
  };

  it("offers one row for the movement, with the transfer chip and a tick", () => {
    const { container } = renderFold(confirmed, potInput);

    expect(container.querySelectorAll(".needs-you-row")).toHaveLength(1);
    expect(screen.getByText("Current account → Holiday pot")).toBeInTheDocument();
    expect(container.querySelector(".needs-you-kind")).toHaveTextContent("transfer");
    expect(screen.getByRole("button", { name: "mark done" })).toBeInTheDocument();
  });

  it("confirms against the inflow, not a household", async () => {
    const { onActioned } = renderFold(confirmed, potInput);

    fireEvent.click(screen.getByRole("button", { name: "mark done" }));

    await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
    expect(stub.calls("POST /api/inflows/inf-1/confirm?month=2026-08")).toBe(1);
    expect(await screen.findByText("✓ done")).toBeInTheDocument();
  });

  it("keeps the undo within reach", async () => {
    const { onActioned } = renderFold(
      { ...confirmed, "DELETE /api/inflows/inf-1/confirmations/conf-move": { status: 204 } },
      potInput,
    );

    fireEvent.click(screen.getByRole("button", { name: "mark done" }));
    fireEvent.click(await screen.findByRole("button", { name: "undo" }));

    await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(2));
    expect(stub.calls("DELETE /api/inflows/inf-1/confirmations/conf-move")).toBe(1);
    expect(screen.getByRole("button", { name: "mark done" })).toBeInTheDocument();
  });

  it("rolls the tick back and names the error code when the server refuses", async () => {
    const { onActioned } = renderFold(
      {
        "POST /api/inflows/inf-1/confirm?month=2026-08": {
          status: 409,
          body: { error: { code: "already_confirmed", message: "already confirmed" } },
        },
      },
      potInput,
    );

    fireEvent.click(screen.getByRole("button", { name: "mark done" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already_confirmed");
    expect(screen.queryByText("✓ done")).toBeNull();
    expect(onActioned).not.toHaveBeenCalled();
  });
});

describe("Fold · record", () => {
  it("prefills what is still missing, not the month's whole target", () => {
    renderFold();
    fireEvent.click(within(row("record Rainy day")).getByRole("button", { name: "record" }));

    expect(screen.getByLabelText("record Rainy day")).toHaveValue("150.00");
  });

  it("records the contribution against the payment and month", async () => {
    const { onActioned } = renderFold({
      "POST /api/payments/rainy/contributions": { status: 201, body: { id: "c1" } },
    });

    fireEvent.click(within(row("record Rainy day")).getByRole("button", { name: "record" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
    expect(stub.bodyOf("POST /api/payments/rainy/contributions")).toEqual({
      amountMinor: 15_000,
      month: "2026-08",
    });
    expect(screen.getByText("✓ done")).toBeInTheDocument();
  });

  it("sends what was typed over the prefill", async () => {
    renderFold({ "POST /api/payments/rainy/contributions": { status: 201, body: { id: "c1" } } });

    fireEvent.click(within(row("record Rainy day")).getByRole("button", { name: "record" }));
    fireEvent.change(screen.getByLabelText("record Rainy day"), { target: { value: "20.00" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() =>
      expect(stub.bodyOf("POST /api/payments/rainy/contributions")).toEqual({
        amountMinor: 2_000,
        month: "2026-08",
      }),
    );
  });

  it("refuses an amount of nothing without asking the server", () => {
    renderFold();

    fireEvent.click(within(row("record Rainy day")).getByRole("button", { name: "record" }));
    fireEvent.change(screen.getByLabelText("record Rainy day"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    expect(screen.getByRole("alert")).toHaveTextContent("amount must be greater than zero");
    expect(stub.calls("POST /api/payments/rainy/contributions")).toBe(0);
  });

  it("rolls the tick back and names the error code when the server refuses", async () => {
    const { onActioned } = renderFold({
      "POST /api/payments/rainy/contributions": {
        status: 403,
        body: { error: { code: "forbidden", message: "no edit access" } },
      },
    });

    fireEvent.click(within(row("record Rainy day")).getByRole("button", { name: "record" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("forbidden");
    expect(screen.queryByText("✓ done")).toBeNull();
    expect(onActioned).not.toHaveBeenCalled();
  });
});

describe("Fold · check-in", () => {
  it("checks the balance in through the account's balance endpoint", async () => {
    const { onActioned } = renderFold({
      "PUT /api/accounts/bills/balance": { body: { id: "b1" } },
    });

    fireEvent.click(
      within(row("check in Bills joint balance")).getByRole("button", { name: "check in" }),
    );
    fireEvent.change(screen.getByLabelText("check in Bills joint balance"), {
      target: { value: "1462.00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
    expect(stub.bodyOf("PUT /api/accounts/bills/balance")).toEqual({ balanceMinor: 146_200 });
    expect(screen.getByText("✓ done")).toBeInTheDocument();
  });

  it("opens empty — a balance is never guessed at", () => {
    renderFold();
    fireEvent.click(
      within(row("check in Bills joint balance")).getByRole("button", { name: "check in" }),
    );

    expect(screen.getByLabelText("check in Bills joint balance")).toHaveValue("");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });

  it("rolls the tick back and names the error code when the server refuses", async () => {
    const { onActioned } = renderFold({
      "PUT /api/accounts/bills/balance": {
        status: 422,
        body: { error: { code: "invalid_balance", message: "nope" } },
      },
    });

    fireEvent.click(
      within(row("check in Bills joint balance")).getByRole("button", { name: "check in" }),
    );
    fireEvent.change(screen.getByLabelText("check in Bills joint balance"), {
      target: { value: "12.00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("invalid_balance");
    expect(screen.queryByText("✓ done")).toBeNull();
    expect(onActioned).not.toHaveBeenCalled();
  });
});
