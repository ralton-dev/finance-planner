import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAddProvider } from "../contexts/QuickAddContext.js";
import { api } from "../lib/api.js";
import type { AccountDto } from "../lib/types.js";
import { stubApiFetch, type FetchStub, type Routes } from "../test/apiMock.js";
import { OverviewPage } from "./OverviewPage.js";

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

function renderOverview(routes: Routes = {}): void {
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
                accounts: accounts.map((a) => ({
                  accountId: a.id,
                  leftoverMinor: 250000,
                  shortfallMinor: 0,
                  atRiskCount: 0,
                })),
              },
            ]
          : [],
      },
    }),
    "GET /api/upcoming?days=14": { body: { asOfDate: "2026-08-04", days: 14, items: [] } },
    ...routes,
  });

  render(
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
