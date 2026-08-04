import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickAddProvider } from "../contexts/QuickAddContext.js";
import { api } from "../lib/api.js";
import { currentMonth } from "../lib/months.js";
import type { AccountPlanDto, HouseholdPlanDto } from "../lib/types.js";
import { stubApiFetch, type Routes as ApiRoutes } from "../test/apiMock.js";
import { HouseholdPlanPage } from "./HouseholdPlanPage.js";

const AS_OF = "2026-08-04";

/** Alex is £40 short and hasn't moved their transfer yet. */
const PLAN: HouseholdPlanDto = {
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
      accountId: "alex-current",
      name: "Alex current",
      role: "personal",
      memberUserId: "alex",
      currency: "GBP",
      monthlyIncomeMinor: 230_000,
      requiredOutflowMinor: 0,
      fundedOutflowMinor: 0,
      transferInMinor: 0,
      transferOutMinor: 87_600,
      leftoverMinor: 178_500,
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
      allocations: [{ userId: "alex", requiredMinor: 40_000, fundedMinor: 36_000 }],
    },
  ],
  transfers: [
    {
      fromAccountId: "alex-current",
      toAccountId: "bills",
      memberUserId: "alex",
      amountMinor: 87_600,
    },
  ],
};

function accountPlan(over: Partial<AccountPlanDto> & { accountId: string }): AccountPlanDto {
  return {
    currency: "GBP",
    monthlyIncomeMinor: 0,
    bufferMinor: 0,
    totalRequiredMinor: 0,
    totalFundedMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    lines: [],
    contributionsMTD: [],
    latestBalance: { asOfDate: AS_OF, balanceMinor: 100_000 },
    reservedMinor: 0,
    ...over,
  };
}

/** Alex's own account has a save-up line nobody has set money aside for. */
const ALEX_PLAN = accountPlan({
  accountId: "alex-current",
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(routes: ApiRoutes = {}) {
  api.setToken(null);
  const stub = stubApiFetch({
    "GET /api/households/hh/plan": { body: PLAN },
    "GET /api/auth/households/hh": {
      body: {
        id: "hh",
        name: "Home",
        createdAt: AS_OF,
        yourRole: "owner",
        members: [],
        shares: [],
      },
    },
    [`GET /api/households/hh/transfers/confirmations?month=${currentMonth()}`]: { body: [] },
    "GET /api/households/hh/closes": { body: [] },
    "GET /api/accounts/alex-current/plan": { body: ALEX_PLAN },
    "GET /api/accounts/bills/plan": { body: accountPlan({ accountId: "bills" }) },
    "GET /api/upcoming?days=14": { body: { asOfDate: AS_OF, days: 14, items: [] } },
    "GET /api/households/hh/projection?months=12": {
      body: { householdId: "hh", currency: "GBP", asOfDate: AS_OF, months: [] },
    },
    ...routes,
  });

  const { container } = render(
    <MemoryRouter initialEntries={["/households/hh/plan"]}>
      <QuickAddProvider>
        <Routes>
          <Route path="/households/:id/plan" element={<HouseholdPlanPage />} />
        </Routes>
      </QuickAddProvider>
    </MemoryRouter>,
  );
  return { container, stub };
}

/** True when `first` comes before `second` in document order. */
function precedes(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("HouseholdPlanPage · the fold", () => {
  it("renders before every section on the page", async () => {
    const { container } = renderPage();

    const fold = await waitFor(() => {
      const el = container.querySelector(".fold");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    // The stat row, and every section heading that isn't the fold's own.
    const after = [...container.querySelectorAll(".kpis, .section-head h2, table")].filter(
      (el) => !fold.contains(el),
    );
    expect(after.length).toBeGreaterThan(3);
    for (const el of after) expect(precedes(fold, el)).toBe(true);
  });

  it("builds the checklist from the household plan and its accounts", async () => {
    renderPage();

    expect(await screen.findByText("cover Alex's unfunded housing")).toBeInTheDocument();
    expect(screen.getByText("Alex → Bills joint")).toBeInTheDocument();
    // Only the account plans carry contributions, so this row proves they were
    // fetched and folded into the derivation.
    expect(await screen.findByText("record Rainy day")).toBeInTheDocument();
  });

  it("says the same thing as the stat row's shortfall cell", async () => {
    const { container } = renderPage();

    const figure = await waitFor(() => {
      const el = container.querySelector(".fold-figure");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    const shortfallKpi = [...container.querySelectorAll(".kpi")].find(
      (kpi) => kpi.querySelector(".kpi-label")?.textContent === "shortfall",
    );
    expect(shortfallKpi?.querySelector(".kpi-value")).toHaveTextContent("£40.00");
    expect(figure).toHaveTextContent("£40.00");
    expect(container.querySelector(".fold-headline")).toHaveClass("shortfall");
  });
});
