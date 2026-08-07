import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAddProvider } from "../contexts/QuickAddContext.js";
import { api } from "../lib/api.js";
import { currentMonth } from "../lib/months.js";
import type {
  AccountDto,
  HouseholdPlanDto,
  MonthCloseDto,
  OverviewAccountDto,
  OverviewDto,
  PlanInflowSourceDto,
  TransferConfirmationDto,
} from "../lib/types.js";
import { stubApiFetch, type FetchStub, type Routes } from "../test/apiMock.js";
import { householdChips, OverviewPage } from "./OverviewPage.js";

const ME = { id: "u1", email: "ada@example.com", displayName: "Ada", households: [] };

/** Accounts the stubbed API currently holds — seeding pushes into this. */
let accounts: AccountDto[];
/** The caller's frozen months, re-read on every call so a close can move them. */
let closes: MonthCloseDto[];
let stub: FetchStub;

beforeEach(() => {
  accounts = [];
  closes = [];
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
                you: { leftoverMinor: 250000, shortfallMinor: 0, paymentCount: 0 },
                accounts: accounts.map((a) =>
                  state({ accountId: a.id, name: a.name, leftoverMinor: 250000 }),
                ),
              },
            ]
          : [],
      },
    }),
    "GET /api/upcoming?days=14": { body: { asOfDate: "2026-08-04", days: 14, items: [] } },
    // The scorecard's one producer. Self-scoped: no id in the path, because a
    // close is the caller's own (`MONTH-CLOSE.md` decision 14).
    "GET /api/me/closes": () => ({ body: closes }),
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

// --- a failed read is not an empty account list ------------------------------
// Both directions, together, because the two halves break in opposite ways: a
// page that shows the first run after a failed read is lying about the money,
// and a page that shows an error to somebody who genuinely has no accounts has
// taken the front door away from every new user.

describe("OverviewPage — a failed account list", () => {
  it("says the list could not be read rather than that it is empty", async () => {
    renderOverview({
      "GET /api/accounts": { status: 500, body: { error: { code: "internal" } } },
      "GET /api/meta": { body: { demoSeedEnabled: true } },
    });

    expect(await screen.findByText(/could not read your accounts/i)).toBeInTheDocument();
    expect(screen.queryByText(/no accounts yet/i)).toBeNull();
    // The one that matters: no offer to plant a worked example over a profile
    // whose real contents we did not manage to read.
    expect(screen.queryByRole("button", { name: /load demo data/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /\+ create account/i })).toBeNull();
  });

  it("still greets a genuinely empty profile with the first run", async () => {
    renderOverview({ "GET /api/meta": { body: { demoSeedEnabled: true } } });

    expect(await screen.findByText(/no accounts yet/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /load demo data/i })).toBeInTheDocument();
    expect(screen.queryByText(/could not read your accounts/i)).toBeNull();
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
    ownerUserId: "u1",
    name: "Ada current",
    householdId: "hh",
    householdRole: "personal",
    latestBalanceMinor: 0,
    latestBalanceDate: "2026-06-01",
  }),
  state({
    accountId: "bills",
    ownerUserId: "u1",
    name: "Bills joint",
    householdId: "hh",
    householdRole: "shared",
    latestBalanceMinor: 0,
    latestBalanceDate: AS_OF,
  }),
  state({
    accountId: "side",
    ownerUserId: "u1",
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

/**
 * `meLast` makes `GET /api/auth/me` answer a macrotask behind everything else,
 * which is the order a loaded machine hands out and the one the CI failure
 * below was caught in: the page learns its accounts and its overview first, and
 * only then which household to read a plan for.
 */
function renderPlanned(routes: Routes = {}, meLast = false): ReturnType<typeof render> {
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
            // Ada is the caller and is short of nothing. Alex is £40 short and
            // that is a row on the checklist, never a figure in her headline.
            you: { leftoverMinor: 268_600, shortfallMinor: 0, paymentCount: 2 },
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

  if (meLast) {
    const stubbed = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      const response = await stubbed(url, init);
      if (String(url).includes("/api/auth/me")) await new Promise((r) => setTimeout(r, 0));
      return response;
    });
  }

  return render(
    <MemoryRouter>
      <QuickAddProvider>
        <OverviewPage />
      </QuickAddProvider>
    </MemoryRouter>,
  );
}

describe("OverviewPage — fold + doorways", () => {
  it("leads with the caller's own figure, and leaves the co-member to the list", async () => {
    const { container } = renderPlanned();

    // Decision 24. Ada is short of nothing, so her headline is her left over —
    // £2,686.00, the figure the pass summed over the accounts she owns. It used
    // to lead "Alex's share of housing is £40.00 short this month", which is a
    // sentence about somebody else's money above a figure claiming to be hers.
    await waitFor(() =>
      expect(container.querySelector(".fold-figure")).toHaveTextContent("£2,686.00"),
    );
    expect(container.querySelector(".fold-sentence")).not.toHaveTextContent(/Alex/);

    // The fact moves rather than being lost: it is a row on the checklist
    // directly beneath, which says whose money is missing and links to it.
    expect(await screen.findByText(/cover Alex's unfunded housing/)).toBeInTheDocument();
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

  /**
   * The third instance of the assumption this work hunts, found in the heading
   * above the table rather than in any figure.
   *
   * The list is every account the caller can *see* that no household plan
   * speaks for — so a co-member's account, shared into the household and never
   * given a plan role, is on it. Its own row says "shared with you"; the
   * heading above it said "your other accounts". The row is right and stays;
   * the heading stops claiming what the row denies (decisions 20 and 25).
   */
  it("says 'your' over that table only when the accounts really are yours", async () => {
    renderPlanned();
    expect(await screen.findByRole("heading", { name: "your other accounts" })).toBeInTheDocument();
  });

  it("drops the 'your' when a co-member's account is in the list", async () => {
    renderPlanned({
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
              you: { leftoverMinor: 268_600, shortfallMinor: 0, paymentCount: 2 },
              accounts: [
                ...PLANNED_STATE.filter((s) => s.accountId !== "side"),
                // Alex shared it in; nobody gave it a role in the plan.
                state({
                  accountId: "side",
                  ownerUserId: "u2",
                  name: "Side hustle",
                  leftoverMinor: 12_500,
                }),
              ],
            },
          ],
        },
      },
    });

    expect(await screen.findByRole("heading", { name: "other accounts" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "your other accounts" })).toBeNull();
    // The row itself is untouched — a legitimate account to be shown.
    expect(await screen.findByText("Side hustle")).toBeInTheDocument();
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
    // This went red once in CI under the load of the whole workspace, with the
    // row's box gone and "reading your plans…" in its place — the fold torn
    // down between the click and the next line.
    //
    // The cause was `useAsync` blanking on a deps change in its *effect*, a beat
    // after the render that changed them. The household plans are read for
    // `me().households`, so the run before `me` answered was a run for no
    // households, and for one committed render the hook offered that empty
    // answer as settled. The page built this checklist off it — the check-in row
    // is derived from the overview alone, which is why the button was there to
    // click — and then the real read started, blanked the fold, and took the
    // opened row with it. A person catching the Overview mid-load lost what they
    // had typed the same way. Fixed in the hook, which now blanks during render.
    //
    // Do NOT settle this by waiting for the row again — the row is the thing
    // under test, and a wait would pass whether or not it survived the click.
    fireEvent.change(screen.getByLabelText("check in Ada current balance"), {
      target: { value: "1234.50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(stub.calls("PUT /api/accounts/ada/balance")).toBe(1));
    expect(stub.bodyOf("PUT /api/accounts/ada/balance")).toEqual({ balanceMinor: 123_450 });
  });

  /**
   * The same row, in the order that broke it. The household plans are read for
   * `me().households`, so until `me` answers there is a read in hand for *no*
   * households — and it used to be offered as a settled answer for the one
   * render between `me` arriving and the real read starting. The fold was built
   * off it, the check-in row with it, and the read landing a beat later blanked
   * the lot: the box you had just opened, and anything typed into it.
   */
  it("keeps the check-in row you opened while the household read starts behind it", async () => {
    renderPlanned({ "PUT /api/accounts/ada/balance": { body: {} } }, true);

    fireEvent.click(await screen.findByRole("button", { name: "check in" }));
    fireEvent.change(screen.getByLabelText("check in Ada current balance"), {
      target: { value: "1234.50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(stub.calls("PUT /api/accounts/ada/balance")).toBe(1));
    expect(stub.bodyOf("PUT /api/accounts/ada/balance")).toEqual({ balanceMinor: 123_450 });
  });

  it("reads no balance history at all — the trend that needed it is gone", () => {
    renderPlanned();
    // Net worth was the last per-account read on this page (decision 21). The
    // Overview now costs a fixed number of requests whatever the estate holds.
    expect(stub.calls("GET /api/accounts/side/balances")).toBe(0);
  });

  /**
   * The failure this page used to eat. `1409e5f` deleted routes the client
   * still called and CI stayed green; on this page a 404 from the household
   * plan was invisible to a *person* too, because the read was caught and the
   * household section simply was not rendered. "Nothing to show" and "could not
   * read it" looked identical.
   */
  it("says so when the household plan cannot be read, rather than going quiet", async () => {
    renderPlanned({
      "GET /api/households/hh/plan": {
        status: 404,
        body: { error: { code: "not_found", message: "gone" } },
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not read your household plan/,
    );
    expect(screen.queryByRole("link", { name: /Chestnut Road/ })).not.toBeInTheDocument();
  });

  it("says so when the confirmations behind the card cannot be read", async () => {
    // Quieter than the plan failing and worse: the card renders, and only the
    // "transfers to make" chip is missing — which reads as nothing to do.
    renderPlanned({
      "GET /api/households/hh/transfers/confirmations": {
        status: 500,
        body: { error: { code: "server_error", message: "boom" } },
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not read your household plan/,
    );
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
 * An estate with no household in it: a current account feeding a holiday pot.
 * The pot's plan is funded out of the arriving money, so it is short of nothing
 * — and until the checklist could name the movement, that left an
 * `awaiting_transfer` line with no prompt anywhere on the page.
 */
const ESTATE_OVERVIEW: OverviewDto = {
  asOfDate: AS_OF,
  perCurrency: [
    {
      currency: "GBP",
      monthlyIncomeMinor: 100_000,
      bufferMinor: 0,
      totalRequiredMinor: 30_000,
      totalFundedMinor: 30_000,
      // A plain sum of the rows now: one pass counts the pound that moved in the
      // sender's surplus and nowhere else, so there is nothing left to net
      // (ONE-ENGINE.md).
      leftoverMinor: 100_000,
      shortfallMinor: 0,
      you: { leftoverMinor: 100_000, shortfallMinor: 0, paymentCount: 1 },
      accounts: [
        state({
          accountId: "current",
          name: "Current account",
          leftoverMinor: 100_000,
          latestBalanceMinor: 100_000,
          latestBalanceDate: AS_OF,
        }),
        state({
          accountId: "pot",
          name: "Holiday pot",
          leftoverMinor: 0,
          allocatedInflowMinor: 30_000,
          confirmedInflowMinor: 0,
          // The itemisation, straight off the index: the authored inflow's id
          // and what it delivered. The sender's *name* rides beside it in
          // `inflowSources`, which the API gates — the page used to look it up
          // in the account list itself, which could name an authored movement's
          // sender and could say nothing at all about a transfer the plan
          // derived, because nobody authored one to itemise.
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
          latestBalanceMinor: 0,
          latestBalanceDate: AS_OF,
        }),
      ],
    },
  ],
};

describe("OverviewPage — money moving between your own accounts", () => {
  /** The estate's overview body with the pot fed by `sources` instead. Arrivals
   *  itemise the authored ones only, because nothing authors a derived one. */
  function withPotSources(sources: PlanInflowSourceDto[]): OverviewDto {
    const arrivals = sources
      .filter((s) => s.kind === "account")
      .map((s) => ({
        inflowId: s.inflowId,
        fromAccountId: s.fromAccountId,
        amountMinor: s.amountMinor,
      }));
    const bucket = ESTATE_OVERVIEW.perCurrency[0]!;
    return {
      ...ESTATE_OVERVIEW,
      perCurrency: [
        {
          ...bucket,
          accounts: bucket.accounts.map((a) =>
            a.accountId === "pot"
              ? {
                  ...a,
                  inflowSources: sources,
                  ...(arrivals.length > 0 ? { inflowArrivals: arrivals } : { inflowArrivals: [] }),
                }
              : a,
          ),
        },
      ],
    };
  }

  function renderEstate(routes: Routes = {}): ReturnType<typeof render> {
    stub = stubApiFetch({
      "GET /api/auth/me": { body: ME },
      "GET /api/accounts": {
        body: [account("current", "Current account"), account("pot", "Holiday pot")],
      },
      "GET /api/overview": { body: ESTATE_OVERVIEW },
      "GET /api/upcoming?days=14": { body: { asOfDate: AS_OF, days: 14, items: [] } },
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

  it("asks once for the movement, and confirms it against the inflow", async () => {
    renderEstate({
      "POST /api/inflows/inf-1/confirm?month=2026-08": {
        status: 201,
        body: { confirmation: { id: "conf-move" }, contributions: [] },
      },
    });

    expect(await screen.findByText("Current account → Holiday pot")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "mark done" }));
    await waitFor(() =>
      expect(stub.calls("POST /api/inflows/inf-1/confirm?month=2026-08")).toBe(1),
    );
  });

  it("reads no account plan at all to draw the row", async () => {
    renderEstate();
    await screen.findByText("Current account → Holiday pot");

    expect(stub.calls("GET /api/accounts/pot/plan")).toBe(0);
    expect(stub.calls("GET /api/accounts/current/plan")).toBe(0);
  });

  it("says only 'another account' when the sender is not one it can see", async () => {
    // The API withholds a sending account's name from a caller who cannot see
    // it, and sends the id regardless. An absent name is rendered as an absence,
    // never as an id and never as a guess.
    renderEstate({
      "GET /api/overview": {
        body: withPotSources([
          {
            kind: "account",
            inflowId: "inf-1",
            fromAccountId: "current",
            amountMinor: 30_000,
            confirmedMinor: 0,
          },
        ]),
      },
    });

    expect(await screen.findByText("another account → Holiday pot")).toBeInTheDocument();
  });

  /**
   * Defect 1, end to end on the one screen a solo user has.
   *
   * A transfer the plan **derives** has no authored row, so there is no arrival
   * to itemise and the checklist can only learn of it from the member rows of
   * `inflowSources`. The Overview never sent those, so the row was never drawn —
   * and the endpoint WP-S shipped for confirming one had no client that could
   * reach it. Both halves are here: the row, and the button doing what it says.
   */
  it("ticks a transfer the plan derived, and unticks it", async () => {
    renderEstate({
      "GET /api/overview": {
        body: withPotSources([
          {
            kind: "member",
            memberUserId: "u1",
            displayName: "Ben",
            fromAccountId: "current",
            amountMinor: 30_000,
            confirmedMinor: 0,
          },
        ]),
      },
      "POST /api/accounts/pot/transfers/confirm?month=2026-08": {
        status: 201,
        body: { confirmation: { id: "conf-derived" }, contributions: [] },
      },
      "DELETE /api/accounts/pot/transfers/confirmations/conf-derived": { status: 204 },
    });

    expect(await screen.findByText("Ben → Holiday pot")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "mark done" }));
    await waitFor(() =>
      expect(stub.calls("POST /api/accounts/pot/transfers/confirm?month=2026-08")).toBe(1),
    );
    expect(stub.bodyOf("POST /api/accounts/pot/transfers/confirm?month=2026-08")).toEqual({
      fromAccountId: "current",
      toAccountId: "pot",
      memberUserId: "u1",
    });

    fireEvent.click(await screen.findByRole("button", { name: "undo" }));
    await waitFor(() =>
      expect(stub.calls("DELETE /api/accounts/pot/transfers/confirmations/conf-derived")).toBe(1),
    );
  });

  it("counts the pound that moved once, with no term to net out of the headline", async () => {
    // £1,000 earned; £300 of it moved into the pot and spent there. The pot
    // reports no surplus of its own — the money that reached it is the current
    // account's, counted there — so the headline is the estate's own £1,000,
    // and it agrees with `GET /overview`'s `leftoverMinor` by being the same
    // sum rather than by subtracting a correction from it.
    const { container } = renderEstate();

    await waitFor(() =>
      expect(container.querySelector(".fold-figure")).toHaveTextContent("£1,000.00"),
    );
  });
});

/**
 * The regression this file exists to hold: the Overview used to read a balance
 * list *and* an account plan per account, so an estate of ten accounts cost
 * twenty requests nobody asked for. Everything the checklist needs now comes
 * down with the overview itself, so the cost is flat.
 *
 * The flat cost then sprang a leak and has been re-sealed. A movement between
 * two accounts you own has to be confirmed against the *authored inflow*, and
 * the index sent inflow totals without itemising them — so the page bought one
 * whole account plan per account with money in transit to recover the ids. On
 * a payday, with every pot fed and nothing yet ticked, that is a plan per pot.
 * `inflowArrivals` now rides down with the index and the second case below
 * costs exactly what the first does.
 */
describe("OverviewPage — request cost", () => {
  /** Mounts the page over `count` standalone accounts, each with a row to
   *  action, and reports how many requests that took. `inTransit` gives every
   *  one of them money arriving that nobody has said moved. */
  async function requestsFor(count: number, inTransit = false): Promise<number> {
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
              you: { leftoverMinor: 0, shortfallMinor: 0, paymentCount: 0 },
              accounts: list.map((a) =>
                state({
                  accountId: a.id,
                  name: a.name,
                  ...(inTransit
                    ? {
                        allocatedInflowMinor: 30_000,
                        confirmedInflowMinor: 0,
                        inflowArrivals: [
                          { inflowId: `inf-${a.id}`, fromAccountId: "src", amountMinor: 30_000 },
                        ],
                      }
                    : {}),
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
      "GET /api/me/closes": { body: [] },
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
    if (inTransit) expect(await screen.findAllByText(/→ Account /)).toHaveLength(count);

    const total = stub.mock.mock.calls.length;
    cleanup();
    vi.unstubAllGlobals();
    return total;
  }

  it("costs the same whether you have three accounts or five", async () => {
    // me, accounts, overview, upcoming, my closes — and nothing per row. The
    // scorecard's read is self-scoped, so it is one request however many
    // accounts, households or currencies are behind it.
    expect(await requestsFor(3)).toBe(5);
    expect(await requestsFor(5)).toBe(5);
  });

  it("costs the same again when every account has money in transit", async () => {
    // Was 4 + one account plan per row: 7 and 9. The ids the confirm rows are
    // keyed on come down with the index now.
    expect(await requestsFor(3, true)).toBe(5);
    expect(await requestsFor(5, true)).toBe(5);
  });
});

// --- the scorecard, where the person is --------------------------------------

describe("OverviewPage — the month scorecard", () => {
  const close = (
    over: Partial<MonthCloseDto> & { id: string; currency: string },
  ): MonthCloseDto => ({
    userId: "u1",
    month: "2026-07-01",
    incomeMinor: 320_000,
    plannedMinor: 90_900,
    contributedMinor: 90_900,
    closedBy: "u1",
    closedAt: "2026-08-01T10:00:00.000Z",
    ...over,
  });

  /** The estate's shape: a GBP partition with money in it, and a EUR one. */
  const ESTATE = [
    close({
      id: "c-eur",
      currency: "EUR",
      incomeMinor: 90_000,
      plannedMinor: 30_000,
      contributedMinor: 12_000,
    }),
    close({ id: "c-gbp", currency: "GBP" }),
  ];

  function renderSeeded(routes: Routes = {}): ReturnType<typeof render> {
    accounts = [SEEDED];
    return renderOverview(routes);
  }

  it("shows one card per currency, from the caller's own closes", async () => {
    closes = ESTATE;
    renderSeeded();

    await screen.findByText("months");
    await waitFor(() => expect(document.querySelectorAll(".scorecard-card")).toHaveLength(2));
    expect(screen.getByText("EUR")).toBeInTheDocument();
    expect(screen.getByText("GBP")).toBeInTheDocument();
    expect(screen.getByText("€900.00")).toBeInTheDocument();
    expect(screen.getByText("£3,200.00")).toBeInTheDocument();
  });

  it("asks for closes once, with no scope in the path", async () => {
    renderSeeded();

    await screen.findByText("months");
    await waitFor(() => expect(stub.calls("GET /api/me/closes")).toBe(1));
  });

  it("closes the month and re-reads what that froze", async () => {
    renderSeeded({
      "POST /api/me/closes": () => {
        closes = ESTATE;
        return { status: 201, body: ESTATE };
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: /^close / }));

    // Two rows out of one action: the month is the unit, the currency is the
    // partition, and both cards appear together or not at all.
    await waitFor(() => expect(document.querySelectorAll(".scorecard-card")).toHaveLength(2));
    expect(stub.bodyOf("POST /api/me/closes")).toEqual({ month: currentMonth() });
    expect(stub.calls("GET /api/me/closes")).toBe(2);
  });

  it("re-opens one row and leaves the other frozen", async () => {
    closes = ESTATE;
    renderSeeded({
      "DELETE /api/me/closes/c-eur": () => {
        closes = [ESTATE[1]!];
        return { status: 204 };
      },
    });

    await waitFor(() => expect(document.querySelectorAll(".scorecard-card")).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: "reopen" })[0]!);

    await waitFor(() => expect(document.querySelectorAll(".scorecard-card")).toHaveLength(1));
    expect(screen.getByText("GBP")).toBeInTheDocument();
    expect(screen.queryByText("EUR")).toBeNull();
  });

  it("says so when the month is already closed, and changes nothing", async () => {
    closes = ESTATE;
    renderSeeded({
      "POST /api/me/closes": {
        status: 409,
        body: { error: { code: "already_closed", message: "Month already closed" } },
      },
    });

    await waitFor(() => expect(document.querySelectorAll(".scorecard-card")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /^close / }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already_closed");
    // The server wrote nothing, so nothing was re-read and nothing moved.
    expect(document.querySelectorAll(".scorecard-card")).toHaveLength(2);
    expect(stub.calls("GET /api/me/closes")).toBe(1);
  });

  it("keeps a currency the caller holds no money in, and says why", async () => {
    closes = [
      close({ id: "c-eur", currency: "EUR", incomeMinor: 0, plannedMinor: 0, contributedMinor: 0 }),
      close({ id: "c-gbp", currency: "GBP" }),
    ];
    renderSeeded();

    await waitFor(() => expect(document.querySelectorAll(".scorecard-card")).toHaveLength(2));
    expect(screen.getByText(/none of this money is yours/i)).toBeInTheDocument();
  });

  it("has nothing to show, and no card, before the first close", async () => {
    renderSeeded();

    expect(await screen.findByText(/no months closed yet/i)).toBeInTheDocument();
    expect(document.querySelectorAll(".scorecard-card")).toHaveLength(0);
  });

  it("stays off the first-run screen — there is nothing to close yet", async () => {
    renderOverview({ "GET /api/meta": { body: { demoSeedEnabled: false } } });

    expect(await screen.findByText(/no accounts yet/i)).toBeInTheDocument();
    expect(screen.queryByText("months")).toBeNull();
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
