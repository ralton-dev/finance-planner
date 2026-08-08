import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
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

const WITHHELD_ID = "withheld";

/**
 * The same household with one more account on its roster — one this reader may
 * not see.
 *
 * Two server behaviours, both correct, and the pair is the whole case: the
 * roster row arrives with its figures and **no `name` key at all** (decision
 * 41 — being on the roster entitles a member to the money, not to the name),
 * and the account's own plan is refused for the same reason. The absent name
 * is therefore not a gap in the data. It is the reason the read was refused,
 * and the only signal this page needs to tell a boundary from a breakage.
 */
function withWithheldAccount(): ApiRoutes {
  return {
    "GET /api/households/hh/plan": {
      body: {
        ...PLAN,
        accounts: [
          ...PLAN.accounts,
          {
            accountId: WITHHELD_ID,
            role: "personal",
            memberUserId: null,
            currency: "GBP",
            monthlyIncomeMinor: 0,
            requiredOutflowMinor: 0,
            fundedOutflowMinor: 0,
            transferInMinor: 0,
            transferOutMinor: 0,
            leftoverMinor: 12_000,
            shortfallMinor: 0,
          },
        ],
      } satisfies HouseholdPlanDto,
    },
    [`GET /api/accounts/${WITHHELD_ID}/plan`]: {
      status: 404,
      body: { error: { code: "not_found", message: "no such account" } },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(routes: ApiRoutes = {}) {
  api.setToken(null);
  const stub = stubApiFetch({
    // The fold headline is the caller's own figure even on this screen
    // (decisions 19, 20, 24), so the page has to know who is looking. Alex is
    // the caller here and Alex is the member who is short.
    "GET /api/auth/me": {
      body: { id: "alex", email: "alex@example.com", displayName: "Alex", households: [] },
    },
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

  it("says the same thing as the stat row's shortfall cell, when the gap is yours", async () => {
    const { container } = renderPage();

    const figure = await waitFor(() => {
      const el = container.querySelector(".fold-figure");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    const shortfallKpi = [...container.querySelectorAll(".kpi")].find(
      (kpi) => kpi.querySelector(".kpi-label")?.textContent === "shortfall",
    );
    // The KPI is the household's gap and the headline is the caller's; here
    // they are the same £40 because Alex is the only member short and Alex is
    // reading. On a household of two they part company, and that is the point
    // of decision 24 rather than a disagreement.
    expect(shortfallKpi?.querySelector(".kpi-value")).toHaveTextContent("£40.00");
    expect(figure).toHaveTextContent("£40.00");
    expect(container.querySelector(".fold-headline")).toHaveClass("shortfall");
  });

  /**
   * A household is an attribution layer, not a calculation boundary
   * (`ONE-ENGINE.md`), so it has no month of its own to freeze. The close it
   * used to offer wrote `monthlyIncomeMinor` alone — £0 for a household whose
   * bills pot is fed entirely by transfers, against a contributed figure made
   * of nothing else. The scorecard now asks the person instead.
   *
   * The fetch assertion is the load-bearing half: `/households/:id/closes` no
   * longer exists, so a leftover read is a 404 in the console every time this
   * page loads, and a mocked route would hide it.
   */
  it("neither offers a close nor asks anything about one", async () => {
    const { container, stub } = renderPage();
    await screen.findByText("cost breakdown");

    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "reopen" })).toBeNull();
    const headings = [...container.querySelectorAll(".section-head h2")].map((h) => h.textContent);
    expect(headings).not.toContain("months");

    const asked = stub.mock.mock.calls.map(([url]) => String(url));
    expect(asked.filter((url) => url.includes("close"))).toEqual([]);
  });
});

/**
 * The failures this page used to eat.
 *
 * Every one of these reads feeds the fold, and the fold's contract is that
 * every row on it is something waiting on a human. A read that fails and is
 * read back as an empty list therefore does not produce a gap — it produces a
 * checklist that says *you have nothing to do about this*, which is a different
 * sentence from "we could not find out" and the more dangerous one.
 *
 * The account plans were the loudest case: `.catch(() => null)` dropped the
 * account and nothing anywhere on the page said so.
 */
describe("HouseholdPlanPage · a read that fails", () => {
  it("names the account whose plan it could not read", async () => {
    renderPage({
      "GET /api/accounts/bills/plan": {
        status: 404,
        body: { error: { code: "not_found", message: "gone" } },
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not read the plan for Bills joint/,
    );
  });

  /**
   * The half that separates this page from the Overview's fix (WP-BA). There
   * the loop is over households and a user has at most one (WP-W), so letting
   * one failure reject the batch costs nothing. Here the loop is over the
   * accounts *inside* one household — the demo seeds four — and a batch that
   * rejects takes every healthy account's check-in and record rows off the
   * checklist because one 404d. The failure has to be visible, not fatal.
   */
  it("keeps the rows of the accounts it could read", async () => {
    renderPage({
      "GET /api/accounts/bills/plan": {
        status: 404,
        body: { error: { code: "not_found", message: "gone" } },
      },
    });

    // Alex's account read fine, and its unrecorded save-up is still listed.
    expect(await screen.findByText("record Rainy day")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("says nothing when every account reads", async () => {
    renderPage();
    await screen.findByText("cost breakdown");

    expect(screen.queryByRole("alert")).toBeNull();
  });

  /**
   * Quieter and worse: the transfer checklist renders either way, and a
   * confirmation list read back as empty is the page stating that nobody has
   * moved this money yet — about money that may well have moved.
   */
  it("says so when it could not read which transfers have been made", async () => {
    renderPage({
      [`GET /api/households/hh/transfers/confirmations?month=${currentMonth()}`]: {
        status: 500,
        body: { error: { code: "server_error", message: "boom" } },
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not read which transfers have already been made/,
    );
  });
});

/**
 * The other half, and the one that looks identical from inside the `catch`.
 *
 * A 404 on an account the reader was never allowed to open is not a failed
 * read. It is the access boundary doing its job, and the page had been dressing
 * it as a breakage — an error strip, in red, naming the account "account"
 * because withholding the name is exactly what made the read fail. Two correct
 * behaviours rendered as a fault.
 *
 * So the roster row's absent name is not a nuisance to paper over with a
 * placeholder; it is the discriminator. Unreadable **and** unnamed is a
 * boundary and belongs nowhere near the error strip. Unreadable **and** named
 * is a genuine failure and must still be shouted, by name — that is the fix
 * above and these tests are also here to keep it.
 */
describe("HouseholdPlanPage · an account the reader may not see", () => {
  it("does not dress a refused read as a failed one", async () => {
    renderPage(withWithheldAccount());
    // The batch has to have settled before "no strip" means anything — this row
    // comes off an account plan, so it only appears once the reads are back.
    await screen.findByText("record Rainy day");

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never prints a nameless account as though 'account' were its name", async () => {
    const { container } = renderPage(withWithheldAccount());
    await screen.findByText("record Rainy day");

    expect(container.textContent).not.toMatch(/the plan for account\b/);
  });

  /**
   * Silence would be wrong here in a way it would not be on a single-account
   * screen: this page's headline claim is a *pooled* one, and a reader who
   * counts the names finds one fewer than the subhead promises. The note says
   * why, in the register of a fact rather than a fault.
   */
  it("says why the totals cover more accounts than it can name", async () => {
    renderPage(withWithheldAccount());

    const note = await screen.findByText(/this household holds an account you may not see/);
    // A fact, in the muted register — not the red strip wearing softer words.
    expect(note).toHaveClass("muted");
    expect(note).not.toHaveClass("error");
    expect(note).not.toHaveAttribute("role", "alert");
  });

  it("still names a genuine failure standing beside it", async () => {
    renderPage({
      ...withWithheldAccount(),
      "GET /api/accounts/bills/plan": {
        status: 500,
        body: { error: { code: "server_error", message: "boom" } },
      },
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not read the plan for Bills joint/);
    // And *only* that one. The refused read is not folded into the sentence
    // under a placeholder, which would tell the reader two things broke.
    expect(alert.textContent).not.toMatch(/Bills joint and\b/);
    expect(alert).not.toHaveTextContent(/other account/);
  });
});
