import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes as RouterRoutes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAddProvider } from "../contexts/QuickAddContext.js";
import { api } from "../lib/api.js";
import type { AccountPlanDto, ContributionDto } from "../lib/types.js";
import { stubApiFetch, type FetchStub, type Routes } from "../test/apiMock.js";
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
  // Only a non-monthly line is offered a record box: a monthly bill is paid,
  // not saved toward (`PlanTable.tsx`).
  category: AccountPlanDto["lines"][0]["category"] = "monthly_recurring",
): AccountPlanDto["lines"][0] => ({
  paymentId,
  name,
  category,
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

const contribution = (over: Partial<ContributionDto> = {}): ContributionDto => ({
  id: "c1",
  paymentId: "b1",
  accountId: "pot",
  userId: "u1",
  month: "2026-08-01",
  amountMinor: 5_000,
  note: null,
  transferConfirmationId: null,
  createdAt: `${AS_OF}T09:00:00.000Z`,
  ...over,
});

function renderAccount(extra?: Routes): FetchStub {
  const stub = stubApiFetch({
    "GET /api/accounts/pot": {
      body: { id: "pot", name: "Bills joint", currency: "GBP", owner: true },
    },
    "GET /api/accounts/pot/plan": { body: plan },
    "GET /api/accounts/pot/incomes": { body: [] },
    "GET /api/accounts/pot/payments": { body: [] },
    "GET /api/accounts/pot/contributions": { body: [] },
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
  return stub;
}

/**
 * Everything the page fetches on mount, arrived and rendered.
 *
 * Six reads go out — the account, its plan, its incomes, its payments, its
 * ledger, and the project labels — and the sections underneath fetch more of
 * their own. Every test here used to anchor on `findByText` instead, and one
 * of them anchored on "movements", a heading `AccountMovements` always draws
 * whatever it knows; the assertion under it then read `[0 active · from
 * outside]`, which was the loading state's own words. WP-AU proved it by
 * withholding the incomes route entirely and watching the test still pass.
 *
 * So the anchors are gone and the drain is the anchor. A timer rather than a
 * microtask: each read is a fetch, then a body read, then a set-state, so
 * there is a chain to drain and not a tick.
 */
const mounted = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  api.setToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountPage — a pot with no income of its own", () => {
  it("reads honestly across the KPI row", async () => {
    renderAccount();
    await mounted();

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
    await mounted();

    expect(document.querySelector(".plan-notes")).toHaveTextContent(
      "no income of its own · £303.20 arriving from Ben this month",
    );
  });

  it("paints nothing red — every line is waiting on a transfer, not short", async () => {
    renderAccount();
    await mounted();

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
    await mounted();

    expect(screen.getByText("arriving here")).toBeInTheDocument();
    expect(screen.getByText("leaving here")).toBeInTheDocument();
    // The income column keeps its own door and says what it is for.
    expect(screen.getByText("[0 active · from outside]")).toBeInTheDocument();
  });

  /**
   * A scorecard is a question about a person, so it is asked once, on the
   * Overview (`MONTH-CLOSE.md` decision 14). This screen used to ask it of a
   * place, and had to redefine "income" as "what arrived here" to get an answer
   * — which is the defect that ended the location close.
   *
   * The fetch assertion is the load-bearing half: the routes behind it no
   * longer exist, so a leftover read here is a 404 in the console of every
   * account page, and a component test that mocked it would never say so.
   */
  it("neither offers a close nor asks anything about one", async () => {
    const stub = renderAccount();
    await mounted();

    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "reopen" })).toBeNull();
    expect(screen.queryByText("months")).toBeNull();

    const asked = stub.mock.mock.calls.map(([url]) => String(url));
    expect(asked.filter((url) => url.includes("close"))).toEqual([]);
  });

  it("keeps the check-in where it is — a balance really is a fact about a place", async () => {
    renderAccount();
    await mounted();

    expect(document.querySelector(".reality-strip")).not.toBeNull();
  });

  /**
   * The defect WP-AU found here, fixed at the source rather than in the test.
   *
   * `[{incomes.data?.length ?? 0} active]` printed the same sentence before the
   * answer arrived as it printed when the answer was none, so a section nobody
   * could read told the reader the account had no income. Withholding the route
   * is the cheapest way to hold the page in that state for as long as an
   * assertion needs.
   */
  it("does not answer 'none' for a count it could not read", async () => {
    renderAccount({
      "GET /api/accounts/pot/incomes": {
        status: 500,
        body: { error: { code: "boom", message: "no" } },
      },
    });
    await mounted();

    expect(screen.queryByText("[0 active · from outside]")).toBeNull();
    expect(screen.getByText("[… active · from outside]")).toBeInTheDocument();
  });
});

/**
 * The ledger the page grew: what was recorded, where it was recorded.
 *
 * The page-level half of it — that the section is wired to the real route, that
 * correcting a row asks the plan again, and that recording one from the plan
 * table asks the ledger again. The component's own rules live in
 * `ContributionLedger.test.tsx`.
 */
describe("AccountPage — the contribution ledger", () => {
  it("lists what was recorded, with its amount and its month", async () => {
    renderAccount({
      "GET /api/accounts/pot/payments": {
        body: [
          {
            id: "b1",
            name: "Council tax",
            amountMinor: 15_320,
            priority: 1,
            category: "monthly_recurring",
          },
        ],
      },
      "GET /api/accounts/pot/contributions": {
        body: [contribution({ amountMinor: 12_500, note: "from the rebate" })],
      },
    });
    await mounted();

    const ledger = document.querySelector(".ledger-section")!;
    expect(within(ledger as HTMLElement).getByText("Council tax")).toBeInTheDocument();
    expect(ledger).toHaveTextContent("£125.00");
    expect(ledger).toHaveTextContent("aug 2026");
    expect(ledger).toHaveTextContent("from the rebate");
  });

  it("asks the plan again when a row is corrected, so the screen moves with it", async () => {
    const stub = renderAccount({
      "GET /api/accounts/pot/payments": {
        body: [
          {
            id: "b1",
            name: "Council tax",
            amountMinor: 15_320,
            priority: 1,
            category: "monthly_recurring",
          },
        ],
      },
      "GET /api/accounts/pot/contributions": { body: [contribution({ amountMinor: 12_500 })] },
      "PATCH /api/contributions/c1": { body: contribution({ amountMinor: 22_500 }) },
    });
    await mounted();

    // Scoped: the payments column offers an "edit" of its own, and this is not
    // that one.
    const ledger = within(document.querySelector(".ledger-section") as HTMLElement);
    fireEvent.click(ledger.getByTitle("edit"));
    fireEvent.change(screen.getByLabelText("amount recorded for Council tax"), {
      target: { value: "225.00" },
    });
    fireEvent.click(ledger.getByRole("button", { name: "save" }));
    await mounted();

    expect(stub.bodyOf("PATCH /api/contributions/c1")).toEqual({
      amountMinor: 22_500,
      month: "2026-08",
      note: null,
    });
    // Both reads, because a corrected figure changes what the plan says as well
    // as what the ledger says — the acceptance is "see the plan move".
    expect(stub.calls("GET /api/accounts/pot/plan")).toBe(2);
    expect(stub.calls("GET /api/accounts/pot/contributions")).toBe(2);
  });

  it("re-reads the ledger when the plan table records into it", async () => {
    const stub = renderAccount({
      // A savings goal rather than a monthly bill, because only a goal is
      // offered somewhere to record money set aside toward it.
      "GET /api/accounts/pot/plan": {
        body: { ...plan, lines: [line("b1", "Council tax", 15_320, "fixed_point")] },
      },
      "POST /api/payments/b1/contributions": { status: 201, body: contribution() },
    });
    await mounted();

    // The plan table's own record box — the surface the ledger sits under.
    fireEvent.click(screen.getByRole("button", { name: "record" }));
    fireEvent.change(screen.getByLabelText("amount to record for Council tax"), {
      target: { value: "50.00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await mounted();

    expect(stub.calls("POST /api/payments/b1/contributions")).toBe(1);
    expect(stub.calls("GET /api/accounts/pot/contributions")).toBe(2);
  });
});
