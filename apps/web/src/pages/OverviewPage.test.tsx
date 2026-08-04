import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAddProvider } from "../contexts/QuickAddContext.js";
import { api } from "../lib/api.js";
import { phraseText } from "../lib/money.js";
import type {
  AccountDto,
  HouseholdPlanDto,
  OverviewAccountDto,
  TransferConfirmationDto,
} from "../lib/types.js";
import { stubApiFetch, type FetchStub, type Routes } from "../test/apiMock.js";
import { householdChips, netWorthSentence, netWorthTotals, OverviewPage } from "./OverviewPage.js";

const ME = { id: "u1", email: "ada@example.com", displayName: "Ada", households: [] };

/** Accounts the stubbed API currently holds — seeding pushes into this. */
let accounts: AccountDto[];
let stub: FetchStub;

beforeEach(() => {
  accounts = [];
  api.setToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderOverview(routes: Routes = {}): ReturnType<typeof render> {
  stub = stubApiFetch({
    "GET /api/auth/me": { body: ME },
    // Re-read on every call, so a refetch sees what the seed created.
    "GET /api/accounts": () => ({ body: accounts }),
    "GET /api/overview": () => ({
      body: {
        asOfDate: "2026-08-04",
        perCurrency: accounts.length
          ? [
              {
                currency: "GBP",
                monthlyIncomeMinor: 250000,
                bufferMinor: 0,
                totalRequiredMinor: 0,
                totalFundedMinor: 0,
                leftoverMinor: 250000,
                shortfallMinor: 0,
                accounts: accounts.map((a) =>
                  state({ accountId: a.id, name: a.name, leftoverMinor: 250000 }),
                ),
              },
            ]
          : [],
      },
    }),
    "GET /api/upcoming?days=14": { body: { asOfDate: "2026-08-04", days: 14, items: [] } },
    ...routes,
  });

  return render(
    <MemoryRouter>
      <QuickAddProvider>
        <OverviewPage />
      </QuickAddProvider>
    </MemoryRouter>,
  );
}

const SEEDED: AccountDto = {
  id: "a1",
  name: "Everyday Account",
  currency: "GBP",
  openingBalanceMinor: 250000,
  monthlyBufferMinor: 0,
};

describe("OverviewPage — demo seed", () => {
  it("offers the demo data when the deployment has it switched on", async () => {
    renderOverview({ "GET /api/meta": { body: { demoSeedEnabled: true } } });

    expect(await screen.findByText(/no accounts yet/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /load demo data/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\+ create account/i })).toBeInTheDocument();
  });

  it("keeps the button hidden when the deployment has it off", async () => {
    renderOverview({ "GET /api/meta": { body: { demoSeedEnabled: false } } });

    expect(await screen.findByText(/no accounts yet/i)).toBeInTheDocument();
    await waitFor(() => expect(stub.calls("GET /api/meta")).toBe(1));
    expect(screen.queryByRole("button", { name: /load demo data/i })).toBeNull();
  });

  it("keeps the button hidden when the meta probe fails", async () => {
    renderOverview({ "GET /api/meta": { status: 500, body: {} } });

    expect(await screen.findByText(/no accounts yet/i)).toBeInTheDocument();
    await waitFor(() => expect(stub.calls("GET /api/meta")).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /load demo data/i })).toBeNull();
  });

  it("seeds and re-reads the page", async () => {
    renderOverview({
      "GET /api/meta": { body: { demoSeedEnabled: true } },
      "POST /api/demo/seed": () => {
        accounts = [SEEDED];
        return {
          status: 201,
          body: { accounts: 1, incomes: 1, payments: 4, contributions: 1, balanceSnapshots: 1 },
        };
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: /load demo data/i }));

    expect(await screen.findByText("Everyday Account")).toBeInTheDocument();
    expect(screen.queryByText(/no accounts yet/i)).toBeNull();
    expect(stub.calls("POST /api/demo/seed")).toBe(1);
    // The empty state's fetches ran again rather than the page guessing.
    expect(stub.calls("GET /api/accounts")).toBe(2);
    expect(stub.calls("GET /api/overview")).toBe(2);
  });

  it("treats demo_not_empty as 'the data is already there' and just re-reads", async () => {
    renderOverview({
      "GET /api/meta": { body: { demoSeedEnabled: true } },
      "POST /api/demo/seed": () => {
        accounts = [SEEDED];
        return {
          status: 409,
          body: { error: { code: "demo_not_empty", message: "not empty" } },
        };
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: /load demo data/i }));

    expect(await screen.findByText("Everyday Account")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// --- the doorways ------------------------------------------------------------
// One household (two accounts) plus one account planned alone, which is the
// arrangement every rule on this page has an opinion about.

const AS_OF = "2026-08-04";

function state(over: Partial<OverviewAccountDto> & { accountId: string }): OverviewAccountDto {
  return {
    name: over.accountId,
    householdId: null,
    householdRole: null,
    monthlyIncomeMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    atRiskCount: 0,
    latestBalanceMinor: null,
    latestBalanceDate: null,
    reservedMinor: 0,
    unrecordedCount: 0,
    unrecordedTotalMinor: 0,
    planSummary: { unrecorded: [], lineCount: 0, lastFundedName: null },
    ...over,
  };
}

function account(id: string, name: string): AccountDto {
  return {
    id,
    name,
    currency: "GBP",
    openingBalanceMinor: 0,
    monthlyBufferMinor: 0,
    owner: true,
    permission: "edit",
  };
}

const HOUSEHOLD_PLAN: HouseholdPlanDto = {
  householdId: "hh",
  asOfDate: AS_OF,
  currency: "GBP",
  monthlyIncomeMinor: 630_000,
  totalRequiredMinor: 219_000,
  totalFundedMinor: 215_000,
  leftoverMinor: 411_000,
  shortfallMinor: 4_000,
  members: [
    {
      userId: "u1",
      displayName: "Ada",
      shareBp: 6_000,
      monthlyIncomeMinor: 400_000,
      obligationMinor: 131_400,
      fundedMinor: 131_400,
      leftoverMinor: 268_600,
      shortfallMinor: 0,
    },
    {
      userId: "u2",
      displayName: "Alex",
      shareBp: 4_000,
      monthlyIncomeMinor: 230_000,
      obligationMinor: 87_600,
      fundedMinor: 83_600,
      leftoverMinor: 142_400,
      shortfallMinor: 4_000,
    },
  ],
  accounts: [
    {
      accountId: "ada",
      name: "Ada current",
      role: "personal",
      memberUserId: "u1",
      currency: "GBP",
      monthlyIncomeMinor: 400_000,
      requiredOutflowMinor: 0,
      fundedOutflowMinor: 0,
      transferInMinor: 0,
      transferOutMinor: 131_400,
      leftoverMinor: 268_600,
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
      leftoverMinor: 0,
      shortfallMinor: 0,
    },
  ],
  lines: [
    {
      paymentId: "rent",
      accountId: "bills",
      name: "Council flat rent",
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
        { userId: "u1", requiredMinor: 60_000, fundedMinor: 60_000 },
        { userId: "u2", requiredMinor: 40_000, fundedMinor: 36_000 },
      ],
    },
  ],
  transfers: [
    { fromAccountId: "ada", toAccountId: "bills", memberUserId: "u1", amountMinor: 131_400 },
    { fromAccountId: "bills", toAccountId: "ada", memberUserId: "u2", amountMinor: 87_600 },
  ],
};

const PLANNED_ME = { ...ME, households: [{ id: "hh", name: "Chestnut Road" }] };

const PLANNED_ACCOUNTS = [
  account("ada", "Ada current"),
  account("bills", "Bills joint"),
  account("side", "Side hustle"),
];

/**
 * The overview's own read of those three accounts — which is now the *only*
 * read the checklist's account rows come from. Ada's balance is two months old
 * (a check-in row), the side account has a part-recorded save-up (a record
 * row), and the joint account is settled.
 */
const PLANNED_STATE = [
  state({
    accountId: "ada",
    name: "Ada current",
    householdId: "hh",
    householdRole: "personal",
    latestBalanceMinor: 0,
    latestBalanceDate: "2026-06-01",
  }),
  state({
    accountId: "bills",
    name: "Bills joint",
    householdId: "hh",
    householdRole: "shared",
    latestBalanceMinor: 0,
    latestBalanceDate: AS_OF,
  }),
  state({
    accountId: "side",
    name: "Side hustle",
    leftoverMinor: 12_500,
    latestBalanceMinor: 90_000,
    latestBalanceDate: AS_OF,
    reservedMinor: 30_000,
    unrecordedCount: 1,
    unrecordedTotalMinor: 15_000,
    planSummary: {
      unrecorded: [
        {
          paymentId: "holiday",
          name: "Holiday",
          fundedMonthlyMinor: 20_000,
          remainderMinor: 15_000,
        },
      ],
      lineCount: 1,
      lastFundedName: "Holiday",
    },
  }),
];

function renderPlanned(routes: Routes = {}): ReturnType<typeof render> {
  stub = stubApiFetch({
    "GET /api/auth/me": { body: PLANNED_ME },
    "GET /api/accounts": { body: PLANNED_ACCOUNTS },
    "GET /api/overview": {
      body: {
        asOfDate: AS_OF,
        perCurrency: [
          {
            currency: "GBP",
            monthlyIncomeMinor: 630_000,
            bufferMinor: 0,
            totalRequiredMinor: 219_000,
            totalFundedMinor: 215_000,
            leftoverMinor: 411_000,
            shortfallMinor: 4_000,
            accounts: PLANNED_STATE,
          },
        ],
      },
    },
    "GET /api/upcoming?days=14": { body: { asOfDate: AS_OF, days: 14, items: [] } },
    "GET /api/households/hh/plan": { body: HOUSEHOLD_PLAN },
    "GET /api/households/hh/transfers/confirmations": { body: [] },
    "GET /api/accounts/ada/balances": { body: [] },
    "GET /api/accounts/bills/balances": { body: [] },
    "GET /api/accounts/side/balances": { body: [] },
    ...routes,
  });

  return render(
    <MemoryRouter>
      <QuickAddProvider>
        <OverviewPage />
      </QuickAddProvider>
    </MemoryRouter>,
  );
}

describe("OverviewPage — fold + doorways", () => {
  it("leads with the aggregate headline the checklist derives", async () => {
    const { container } = renderPlanned();

    // The sentence is assembled from parts (every figure is its own `.amount`
    // so privacy mode can blur it), so it is read off the element, not matched
    // as one text node.
    await waitFor(() =>
      expect(container.querySelector(".fold-sentence")).toHaveTextContent(
        /Alex's share of housing is £40\.00 short this month/,
      ),
    );
    // Both of the household's transfers are outstanding, so the fold asks.
    expect(screen.getByText("Ada → Bills joint")).toBeInTheDocument();
  });

  it("gives each household a card that opens its own plan", async () => {
    renderPlanned();

    const card = await screen.findByRole("link", { name: /Chestnut Road/ });
    expect(card).toHaveAttribute("href", "/households/hh/plan");
    expect(card).toHaveTextContent("2 members · 2 accounts");
    expect(card).toHaveTextContent("£6,300.00 in");
    expect(card).toHaveTextContent("£2,190.00 required");
    expect(card).toHaveTextContent("unfunded · £40.00");
    expect(card).toHaveTextContent("2 transfers to make");
  });

  it("tables only the accounts no household plans, in the index's own columns", async () => {
    renderPlanned();

    const table = await screen.findByRole("table");
    expect(table).toHaveTextContent("Side hustle");
    expect(table).not.toHaveTextContent("Bills joint");
    // WP-4's cells, verbatim: the balance and how long ago anyone said so.
    expect(table).toHaveTextContent("£900.00");
    expect(table).toHaveTextContent("checked in today");
  });

  it("says what you hold and how much of it the plan has already claimed", async () => {
    const { container } = renderPlanned();

    await waitFor(() =>
      expect(container.querySelector(".networth-sentence")).toHaveTextContent(
        "£300.00 of it is already set aside by the plan, leaving £600.00 genuinely free.",
      ),
    );
    // The trend is a disclosure now, not the section's headline.
    expect(screen.getByText("net worth over time").tagName).toBe("SUMMARY");
  });

  it("does not render the household plan a second time", async () => {
    renderPlanned();
    await screen.findByRole("link", { name: /Chestnut Road/ });

    // The plan page owns all of this: the Sankey, the reconciliation tables,
    // and every line the plan is made of.
    expect(screen.queryByText("money flow")).toBeNull();
    expect(screen.queryByText("per account")).toBeNull();
    expect(screen.queryByText("per person")).toBeNull();
    expect(screen.queryByText("Council flat rent")).toBeNull();
    // One table on the page, and it is the standalone accounts'.
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  it("reads each household plan once, for the fold and the card that quotes it", async () => {
    renderPlanned();
    await screen.findByRole("link", { name: /Chestnut Road/ });

    await waitFor(() => expect(stub.calls("GET /api/households/hh/plan")).toBe(1));
  });

  it("builds the record row off the overview alone, and it still actions", async () => {
    renderPlanned({ "POST /api/payments/holiday/contributions": { status: 201, body: {} } });

    fireEvent.click(await screen.findByRole("button", { name: "record" }));
    // The row asks for the month's target; the box prefills what is missing.
    expect(screen.getByLabelText("record Holiday")).toHaveValue("150.00");

    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(stub.calls("POST /api/payments/holiday/contributions")).toBe(1));
    expect(stub.bodyOf("POST /api/payments/holiday/contributions")).toEqual({
      amountMinor: 15_000,
      month: "2026-08",
    });
    // …and no account plan was read to get there.
    expect(stub.calls("GET /api/accounts/side/plan")).toBe(0);
  });

  it("builds the check-in row off the overview alone, and it still actions", async () => {
    renderPlanned({ "PUT /api/accounts/ada/balance": { body: {} } });

    fireEvent.click(await screen.findByRole("button", { name: "check in" }));
    fireEvent.change(screen.getByLabelText("check in Ada current balance"), {
      target: { value: "1234.50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(stub.calls("PUT /api/accounts/ada/balance")).toBe(1));
    expect(stub.bodyOf("PUT /api/accounts/ada/balance")).toEqual({ balanceMinor: 123_450 });
  });

  it("leaves the balance history until the trend disclosure asks for it", async () => {
    renderPlanned();
    await screen.findByRole("link", { name: /Chestnut Road/ });

    // Three accounts on the page, no balance read for any of them.
    expect(stub.calls("GET /api/accounts/side/balances")).toBe(0);

    fireEvent.click(screen.getByText("net worth over time"));
    await waitFor(() => expect(stub.calls("GET /api/accounts/side/balances")).toBe(1));
  });

  it("sends an empty household to the screen that can fill it", async () => {
    renderPlanned({
      "GET /api/households/hh/plan": {
        body: { ...HOUSEHOLD_PLAN, accounts: [], transfers: [], lines: [] },
      },
    });

    const card = await screen.findByRole("link", { name: /Chestnut Road/ });
    expect(card).toHaveAttribute("href", "/households/hh");
    expect(card).toHaveTextContent("no accounts yet");
  });
});

/**
 * The regression this file exists to hold: the Overview used to read a balance
 * list *and* an account plan per account, so an estate of ten accounts cost
 * twenty requests nobody asked for. Everything the checklist needs now comes
 * down with the overview itself, so the cost is flat.
 */
describe("OverviewPage — request cost", () => {
  /** Mounts the page over `count` standalone accounts, each with a row to
   *  action, and reports how many requests that took. */
  async function requestsFor(count: number): Promise<number> {
    const list = Array.from({ length: count }, (_, i) => account(`a${i}`, `Account ${i}`));
    stub = stubApiFetch({
      "GET /api/auth/me": { body: ME },
      "GET /api/accounts": { body: list },
      "GET /api/overview": {
        body: {
          asOfDate: AS_OF,
          perCurrency: [
            {
              currency: "GBP",
              monthlyIncomeMinor: 0,
              bufferMinor: 0,
              totalRequiredMinor: 0,
              totalFundedMinor: 0,
              leftoverMinor: 0,
              shortfallMinor: 0,
              accounts: list.map((a) =>
                state({
                  accountId: a.id,
                  name: a.name,
                  planSummary: {
                    unrecorded: [
                      {
                        paymentId: `p-${a.id}`,
                        name: "Holiday",
                        fundedMonthlyMinor: 20_000,
                        remainderMinor: 15_000,
                      },
                    ],
                    lineCount: 1,
                    lastFundedName: "Holiday",
                  },
                }),
              ),
            },
          ],
        },
      },
      "GET /api/upcoming?days=14": { body: { asOfDate: AS_OF, days: 14, items: [] } },
    });

    render(
      <MemoryRouter>
        <QuickAddProvider>
          <OverviewPage />
        </QuickAddProvider>
      </MemoryRouter>,
    );
    // Every account's row is on screen, so nothing is still in flight.
    expect(await screen.findAllByText("record Holiday")).toHaveLength(count);

    const total = stub.mock.mock.calls.length;
    cleanup();
    vi.unstubAllGlobals();
    return total;
  }

  it("costs the same whether you have three accounts or five", async () => {
    // me, accounts, overview, upcoming — and nothing per row.
    expect(await requestsFor(3)).toBe(4);
    expect(await requestsFor(5)).toBe(4);
  });
});

describe("householdChips", () => {
  const entry = (confirmations: TransferConfirmationDto[] = []) => ({
    household: { id: "hh", name: "Chestnut Road" },
    plan: HOUSEHOLD_PLAN,
    confirmations,
  });

  it("leads with money the plan cannot cover, then money nobody has moved", () => {
    expect(householdChips(entry(), AS_OF)).toEqual([
      { tone: "alert", label: "unfunded", amountMinor: 4_000 },
      { tone: "needs-you", label: "2 transfers to make" },
    ]);
  });

  it("counts down as transfers are confirmed, and uses the singular", () => {
    const confirmed: TransferConfirmationDto[] = [
      {
        id: "c1",
        householdId: "hh",
        month: "2026-08-01",
        fromAccountId: "ada",
        toAccountId: "bills",
        memberUserId: "u1",
        amountMinor: 131_400,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ];
    expect(householdChips(entry(confirmed), AS_OF)[1]).toEqual({
      tone: "needs-you",
      label: "1 transfer to make",
    });
  });

  it("says so plainly when neither applies", () => {
    const settled = { ...entry(), plan: { ...HOUSEHOLD_PLAN, shortfallMinor: 0, transfers: [] } };
    expect(householdChips(settled, AS_OF)).toEqual([{ tone: "funded", label: "on track" }]);
  });

  it("calls an unstarted household unstarted rather than on track", () => {
    const empty = { ...entry(), plan: { ...HOUSEHOLD_PLAN, accounts: [], transfers: [] } };
    expect(householdChips(empty, AS_OF)).toEqual([{ tone: "neutral", label: "no accounts yet" }]);
  });
});

describe("net worth", () => {
  it("sums the check-ins, and what the plan has set aside against them", () => {
    expect(
      netWorthTotals([
        state({ accountId: "a", latestBalanceMinor: 250_000, reservedMinor: 90_000 }),
        state({ accountId: "b", latestBalanceMinor: 50_000, reservedMinor: 10_000 }),
      ]),
    ).toEqual({ cashMinor: 300_000, reservedMinor: 100_000, freeMinor: 200_000, checkedIn: 2 });
  });

  it("leaves an unchecked account out of the cash, not out of the reserve", () => {
    expect(
      netWorthTotals([
        state({ accountId: "a", latestBalanceMinor: 250_000, reservedMinor: 90_000 }),
        state({ accountId: "b", latestBalanceMinor: null, reservedMinor: 10_000 }),
      ]),
    ).toEqual({ cashMinor: 250_000, reservedMinor: 100_000, freeMinor: 150_000, checkedIn: 1 });
  });

  it("words the gap between cash and reserved", () => {
    const phrase = netWorthSentence(
      { cashMinor: 300_000, reservedMinor: 100_000, freeMinor: 200_000, checkedIn: 2 },
      "GBP",
    );
    expect(phraseText(phrase)).toBe(
      "£1,000.00 of it is already set aside by the plan, leaving £2,000.00 genuinely free.",
    );
    // Both figures come out as parts, so privacy mode has something to blur.
    expect(phrase.filter((part) => typeof part !== "string")).toEqual([
      { minor: 100_000, currency: "GBP" },
      { minor: 200_000, currency: "GBP" },
    ]);
  });

  it("says which way round it is when the plan claims more than you hold", () => {
    expect(
      phraseText(
        netWorthSentence(
          { cashMinor: 100_000, reservedMinor: 140_000, freeMinor: -40_000, checkedIn: 1 },
          "GBP",
        ),
      ),
    ).toBe("The plan has £1,400.00 set aside — £400.00 more than these accounts hold.");
  });

  it("refuses to pretend when nothing has been checked in", () => {
    expect(
      phraseText(
        netWorthSentence({ cashMinor: 0, reservedMinor: 0, freeMinor: 0, checkedIn: 0 }, "GBP"),
      ),
    ).toBe("No balances checked in yet — record one and this becomes real.");
  });
});
