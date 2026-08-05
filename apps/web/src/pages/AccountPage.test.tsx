import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes as RouterRoutes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAddProvider } from "../contexts/QuickAddContext.js";
import { api } from "../lib/api.js";
import type { AccountPlanDto } from "../lib/types.js";
import { stubApiFetch, type Routes } from "../test/apiMock.js";
import { AccountPage } from "./AccountPage.js";

/**
 * The bills pot, end to end — the screen that prompted this piece of work.
 *
 * It used to say REQUIRED £303.20 · SHORTFALL £303.20 with every line red,
 * while the household plan two clicks away said the same bills were covered.
 * Both were computing correctly; one was computing with a missing input. This
 * asserts what it says now that the input is there.
 */

const AS_OF = "2026-08-04";

const line = (
  paymentId: string,
  name: string,
  amountMinor: number,
): AccountPlanDto["lines"][0] => ({
  paymentId,
  name,
  category: "monthly_recurring",
  amountMinor,
  dueDate: "2026-08-01",
  targetDate: "2026-08-01",
  monthsUntilDue: 0,
  requiredMonthlyMinor: amountMinor,
  fundedMonthlyMinor: amountMinor,
  fundedFromOwnMinor: 0,
  fundedFromInflowMinor: amountMinor,
  alreadySavedMinor: 0,
  onTrack: true,
  status: "awaiting_transfer",
});

const plan: AccountPlanDto = {
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
  latestBalance: { asOfDate: AS_OF, balanceMinor: 35_889 },
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
  lines: [line("b1", "Council tax", 15_320), line("b2", "Broadband", 15_000)],
};

function renderAccount(extra?: Routes) {
  stubApiFetch({
    "GET /api/accounts/pot": {
      body: { id: "pot", name: "Bills joint", currency: "GBP", owner: true },
    },
    "GET /api/accounts/pot/plan": { body: plan },
    "GET /api/accounts/pot/incomes": { body: [] },
    "GET /api/accounts/pot/payments": { body: [] },
    "GET /api/accounts/pot/closes": { body: [] },
    "GET /api/accounts/pot/inflows": { body: [] },
    "GET /api/accounts/pot/inflows/outbound": { body: [] },
    "GET /api/accounts": {
      body: [{ id: "pot", name: "Bills joint", currency: "GBP", owner: true }],
    },
    "GET /api/projects": { body: [] },
    "GET /api/accounts/pot/projection?months=12": {
      body: { accountId: "pot", currency: "GBP", asOfDate: AS_OF, months: [] },
    },
    ...extra,
  });

  render(
    <MemoryRouter initialEntries={["/accounts/pot"]}>
      <QuickAddProvider>
        <RouterRoutes>
          <Route path="/accounts/:id" element={<AccountPage />} />
        </RouterRoutes>
      </QuickAddProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.setToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountPage — a pot with no income of its own", () => {
  it("reads honestly across the KPI row", async () => {
    renderAccount();
    await screen.findByText("arriving");

    // No income, said as no income rather than as a zero one.
    expect(screen.getByText("monthly income").parentElement).toHaveTextContent("—");
    // The whole point: nothing on this screen claims the account is short.
    expect(screen.queryByText("shortfall")).toBeNull();
    expect(screen.getByText("left over").parentElement).toHaveTextContent("—");
    // What is arriving, and from whom, without inventing a name.
    expect(screen.getByText("arriving").parentElement).toHaveTextContent("£303.20");
    expect(screen.getByText("none of it moved yet")).toBeInTheDocument();
  });

  it("says where the money is coming from, in words", async () => {
    renderAccount();
    await screen.findByText("arriving");

    expect(document.querySelector(".plan-notes")).toHaveTextContent(
      "no income of its own · £303.20 arriving from Ben this month",
    );
  });

  it("paints nothing red — every line is waiting on a transfer, not short", async () => {
    renderAccount();
    await screen.findByText("arriving");

    expect(document.querySelectorAll(".tag-status.warn")).toHaveLength(0);
    expect(document.querySelectorAll(".kpi.warn")).toHaveLength(0);
    expect(document.querySelectorAll("tr.at-risk")).toHaveLength(0);
    expect(screen.getAllByText("awaiting transfer")).toHaveLength(2);
    expect(document.querySelectorAll("tr.awaiting")).toHaveLength(2);
  });

  /**
   * The capability WP-F through WP-J built and nothing could reach. A pot fed
   * by another account you own could be planned, confirmed and drawn, but there
   * was nowhere in the app to say "move £400 a month out of my current account
   * into this" — the only door was an API call.
   */
  it("offers a way to author a movement, from both ends of one", async () => {
    renderAccount();
    await screen.findByText("movements");

    expect(screen.getByText("arriving here")).toBeInTheDocument();
    expect(screen.getByText("leaving here")).toBeInTheDocument();
    // The income column keeps its own door and says what it is for.
    expect(screen.getByText("[0 active · from outside]")).toBeInTheDocument();
  });
});
