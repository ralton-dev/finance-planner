import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes as RouterRoutes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api.js";
import type {
  AccountDto,
  HouseholdAccountAssignmentDto,
  HouseholdDetailDto,
  HouseholdPlanDto,
  HouseholdShareDto,
  OverviewAccountDto,
} from "../lib/types.js";
import { stubApiFetch, type Routes } from "../test/apiMock.js";
import { HouseholdDetailPage } from "./HouseholdDetailPage.js";

const AS_OF = "2026-08-04";

// --- fixtures ---------------------------------------------------------------
// Ben owns the joint pot and his own current account and has shared the pot
// with the household; Alex's current account is shared back with Ben.

const ACCOUNTS: AccountDto[] = [
  {
    id: "a1",
    name: "Bills joint",
    currency: "GBP",
    openingBalanceMinor: 0,
    monthlyBufferMinor: 0,
    owner: true,
  },
  {
    id: "a2",
    name: "Ben current",
    currency: "GBP",
    openingBalanceMinor: 0,
    monthlyBufferMinor: 0,
    owner: true,
  },
  {
    id: "a3",
    name: "Alex current",
    currency: "GBP",
    openingBalanceMinor: 0,
    monthlyBufferMinor: 0,
    owner: false,
    permission: "edit",
  },
];

const ROSTER: HouseholdAccountAssignmentDto[] = [
  {
    accountId: "a1",
    accountName: "Bills joint",
    currency: "GBP",
    role: "shared",
    memberUserId: null,
  },
  {
    accountId: "a2",
    accountName: "Ben current",
    currency: "GBP",
    role: "personal",
    memberUserId: "u1",
  },
  {
    accountId: "a3",
    accountName: "Alex current",
    currency: "GBP",
    role: "personal",
    memberUserId: "u2",
  },
];

const SHARES: HouseholdShareDto[] = [
  {
    shareId: "s1",
    accountId: "a1",
    accountName: "Bills joint",
    currency: "GBP",
    permission: "edit",
  },
];

function household(benBp = 6000, alexBp = 4000): HouseholdDetailDto {
  return {
    id: "h1",
    name: "Ralton",
    createdAt: "2026-01-01T00:00:00.000Z",
    yourRole: "owner",
    members: [
      {
        membershipId: "m1",
        userId: "u1",
        role: "owner",
        shareBp: benBp,
        displayName: "Ben",
        email: "ben@example.com",
        isSelf: true,
      },
      {
        membershipId: "m2",
        userId: "u2",
        role: "member",
        shareBp: alexBp,
        displayName: "Alex",
        email: "alex@example.com",
        isSelf: false,
      },
    ],
    shares: SHARES,
  };
}

function summary(partial: Partial<OverviewAccountDto> & { accountId: string }): OverviewAccountDto {
  return {
    name: "account",
    householdId: "h1",
    householdRole: null,
    monthlyIncomeMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    atRiskCount: 0,
    latestBalanceMinor: 318450,
    latestBalanceDate: AS_OF,
    reservedMinor: 0,
    unrecordedCount: 0,
    unrecordedTotalMinor: 0,
    ...partial,
  };
}

/**
 * A plan whose shared costs are `billsMinor`, one line each, all in the joint
 * pot. The lines are what the consequence line splits — the engine splits every
 * bill on its own, so the page must be given them individually.
 */
function plan(...billsMinor: number[]): HouseholdPlanDto {
  const sharedRequiredMinor = billsMinor.reduce((s, b) => s + b, 0);
  const personal = (accountId: string, name: string, memberUserId: string) => ({
    accountId,
    name,
    role: "personal" as const,
    memberUserId,
    currency: "GBP",
    monthlyIncomeMinor: 300000,
    requiredOutflowMinor: 0,
    fundedOutflowMinor: 0,
    transferInMinor: 0,
    transferOutMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
  });

  return {
    householdId: "h1",
    asOfDate: AS_OF,
    currency: "GBP",
    monthlyIncomeMinor: 600000,
    totalRequiredMinor: sharedRequiredMinor,
    totalFundedMinor: sharedRequiredMinor,
    leftoverMinor: 0,
    shortfallMinor: 0,
    members: [],
    accounts: [
      {
        accountId: "a1",
        name: "Bills joint",
        role: "shared",
        memberUserId: null,
        currency: "GBP",
        monthlyIncomeMinor: 0,
        requiredOutflowMinor: sharedRequiredMinor,
        fundedOutflowMinor: sharedRequiredMinor,
        transferInMinor: sharedRequiredMinor,
        transferOutMinor: 0,
        leftoverMinor: 0,
        shortfallMinor: 0,
      },
      personal("a2", "Ben current", "u1"),
      personal("a3", "Alex current", "u2"),
    ],
    lines: billsMinor.map((amountMinor, i) => ({
      paymentId: `p${i}`,
      accountId: "a1",
      name: `bill ${i}`,
      category: "monthly_recurring",
      scope: "shared",
      amountMinor,
      dueDate: AS_OF,
      targetDate: AS_OF,
      priority: 100,
      requiredMonthlyMinor: amountMinor,
      fundedMonthlyMinor: amountMinor,
      occurrencesThisMonth: 1,
      onTrack: true,
      allocations: [],
    })),
    transfers: [],
  };
}

function renderPage(extra?: Routes) {
  const stub = stubApiFetch({
    "GET /api/auth/households/h1": { body: household() },
    "GET /api/accounts": { body: ACCOUNTS },
    "GET /api/households/h1/accounts": { body: ROSTER },
    "GET /api/households/h1/plan": { body: plan(120000) },
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
            accounts: [
              summary({ accountId: "a1", latestBalanceMinor: 318450 }),
              summary({ accountId: "a2", latestBalanceMinor: 92000, monthlyIncomeMinor: 300000 }),
              summary({ accountId: "a3", latestBalanceMinor: 41000 }),
            ],
          },
        ],
      },
    },
    ...extra,
  });

  const view = render(
    <MemoryRouter initialEntries={["/households/h1"]}>
      <RouterRoutes>
        <Route path="/households/:id" element={<HouseholdDetailPage />} />
      </RouterRoutes>
    </MemoryRouter>,
  );
  return { ...view, stub };
}

/** The table row a named account sits in, once the table has rendered. */
async function rowFor(name: string): Promise<HTMLElement> {
  const link = await screen.findByRole("link", { name });
  const row = link.closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** An element's whole text, whitespace flattened — the sentences here are built
 *  from several nodes. */
function flat(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  api.setToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HouseholdDetailPage — one account table", () => {
  it("merges the two old tables into one row per account", async () => {
    const { container } = renderPage();
    await rowFor("Bills joint");

    // Members and accounts — the second account table is gone.
    expect(container.querySelectorAll("table")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "shared accounts" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "plan accounts" })).toBeNull();

    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent)
      .filter(Boolean);
    expect(headers).toContain("role in plan");
    expect(headers).toContain("your access");
    expect(headers).toContain("balance");
    expect(headers).not.toContain("permission");

    // One row for the pot, carrying both what it does and who may read it.
    const pot = await rowFor("Bills joint");
    expect(within(pot).getByText("shared pot")).toBeInTheDocument();
    expect(within(pot).getByText("owner")).toBeInTheDocument();
    expect(within(pot).getByText("the household can edit it")).toBeInTheDocument();
    expect(within(pot).getByText("£3,184.50")).toBeInTheDocument();
  });

  /**
   * Decision 41. Assigning an account to the plan and sharing it with the
   * household are two controls on this page, and a member who has used only the
   * first gets a roster row with figures and **no `accountName`** — the same
   * absence `/api/flow` sends for a node it may not name. The row still has to
   * be there: it is on the roster, it carries a role, and it is what the plan's
   * arithmetic is over.
   */
  it("prints the diagram's word for a roster account it was sent no name for", async () => {
    renderPage({
      "GET /api/households/h1/accounts": {
        body: [
          ROSTER[0],
          ROSTER[1],
          // Alex's account: assigned, never shared, so the wire carries no name.
          { accountId: "a3", currency: "GBP", role: "personal", memberUserId: "u2" },
        ],
      },
    });

    const theirs = await rowFor("other account");
    expect(within(theirs).getByText("personal · Alex")).toBeInTheDocument();
    // Nothing invented, and nothing else lost: the named rows are untouched.
    expect(screen.queryByText("Alex current")).toBeNull();
    expect(await rowFor("Bills joint")).toBeInTheDocument();
  });

  it("drops both old chip vocabularies", async () => {
    const { container } = renderPage();
    await rowFor("Bills joint");

    const chips = [...container.querySelectorAll(".tag-status")].map((c) => flat(c));
    // The access grant is no longer a chip at all…
    expect(chips).not.toContain("view");
    expect(chips).not.toContain("edit");
    // …and the plan role's chip says what the role means, not its enum value.
    expect(chips).not.toContain("shared");
    expect(chips).not.toContain("personal");
    expect(chips).toContain("shared pot");
    expect(chips).toContain("personal · Ben");
  });

  it("states your access as a plain phrase", async () => {
    renderPage();
    const theirs = await rowFor("Alex current");
    expect(within(theirs).getByText("shared with you · can edit")).toBeInTheDocument();
    expect(within(theirs).getByText("personal · Alex")).toBeInTheDocument();
  });

  it("keeps the assignment PUT behind a row action", async () => {
    const user = userEvent.setup();
    const { stub } = renderPage({
      "PUT /api/households/h1/accounts/a2": { body: ROSTER[1] },
    });
    const row = await rowFor("Ben current");

    await user.click(within(row).getByRole("button", { name: "manage Ben current" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "role in plan for Ben current" }),
      "shared",
    );
    await user.click(screen.getByRole("button", { name: "save role" }));

    expect(stub.bodyOf("PUT /api/households/h1/accounts/a2")).toEqual({
      role: "shared",
      memberUserId: null,
    });
  });

  it("keeps the share endpoints behind the same row menu", async () => {
    const user = userEvent.setup();
    const { stub } = renderPage({ "POST /api/accounts/a2/shares": { body: { id: "s2" } } });
    const row = await rowFor("Ben current");

    await user.click(within(row).getByRole("button", { name: "manage Ben current" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "household access for Ben current" }),
      "edit",
    );
    await user.click(screen.getByRole("button", { name: "share with household" }));

    expect(stub.bodyOf("POST /api/accounts/a2/shares")).toEqual({
      householdId: "h1",
      permission: "edit",
    });
  });
});

// What jsdom can see of the narrow layout. Whether the document stops scrolling
// sideways at 390px is a measurement, not an assertion.
describe("HouseholdDetailPage — the tables on a phone", () => {
  it("scrolls both tables inside a wrapper, first column pinned", async () => {
    const { container } = renderPage();
    await rowFor("Bills joint");

    for (const table of container.querySelectorAll("table")) {
      expect(table.parentElement).toHaveClass("table-scroll");
      expect(table.querySelector("thead th")).toHaveClass("sticky-col");
      for (const row of table.querySelectorAll("tbody tr")) {
        expect(row.firstElementChild).toHaveClass("sticky-col");
      }
    }
  });

  it("folds the member's email under their name, and drops nothing else", async () => {
    const { container } = renderPage();
    await rowFor("Bills joint");

    const [members, accounts] = [...container.querySelectorAll("table")];
    const dropped = [...members!.querySelectorAll("thead th.wide-only")];
    expect(dropped.map((th) => th.textContent)).toEqual(["email"]);
    expect([...members!.querySelectorAll("tbody .row-sub")].map((s) => s.textContent)).toEqual([
      "ben@example.com",
      "alex@example.com",
    ]);
    for (const row of members!.querySelectorAll("tbody tr")) {
      expect(row.querySelectorAll("td.wide-only")).toHaveLength(1);
    }

    // The account rows already carry their currency and grant in sub-lines, so
    // the wrapper alone is enough for them.
    expect(accounts!.querySelectorAll(".wide-only")).toHaveLength(0);
  });
});

describe("HouseholdDetailPage — the shares block", () => {
  it("spells out what the split does with the plan's shared costs", async () => {
    renderPage();
    const line = await screen.findByText(/splits shared costs/);

    // £1,200.00 of shared cost, split 60/40 → £720.00 and £480.00.
    expect(flat(line)).toBe(
      "splits shared costs 60.0/40.0 — £1,200.00 a month lands as Ben £720.00 and Alex £480.00 into Bills joint.",
    );
  });

  it("splits each bill on its own and rounds every share up", async () => {
    // £1,000.01 and £200.03. Per bill: Ben 60001 + 12002, Alex 40001 + 8002 —
    // splitting the £1,200.04 total in one go would ask Alex for £480.02, a
    // penny less than the engine will. Every share rounds up, so the pot takes
    // in 2p more than the bills cost.
    renderPage({ "GET /api/households/h1/plan": { body: plan(100_001, 20_003) } });

    expect(flat(await screen.findByText(/splits shared costs/))).toBe(
      "splits shared costs 60.0/40.0 — £1,200.04 a month lands as Ben £720.03 and Alex £480.03 into Bills joint. every share is rounded up, so the pot ends the month £0.02 over rather than a penny short.",
    );
  });

  it("leaves a personal bill parked in the pot out of the split", async () => {
    // The engine charges it wholly to its bearer, so the shares never touch it
    // — and the sentence is built from the lines, not the pot's outflow total.
    const p = plan(100_000);
    p.lines.push({ ...p.lines[0]!, paymentId: "p9", name: "Ben's bike", scope: "personal" });
    p.accounts[0]!.requiredOutflowMinor = 200_000;
    renderPage({ "GET /api/households/h1/plan": { body: p } });

    expect(flat(await screen.findByText(/splits shared costs/))).toBe(
      "splits shared costs 60.0/40.0 — £1,000.00 a month lands as Ben £600.00 and Alex £400.00 into Bills joint.",
    );
  });

  it("follows the inputs before anything is saved", async () => {
    const user = userEvent.setup();
    renderPage();
    const ben = await screen.findByLabelText("Ben's share of shared costs, percent");

    await user.clear(ben);
    await user.type(ben, "70");
    await user.clear(screen.getByLabelText("Alex's share of shared costs, percent"));
    await user.type(screen.getByLabelText("Alex's share of shared costs, percent"), "30");

    expect(flat(screen.getByText(/splits shared costs/))).toBe(
      "splits shared costs 70.0/30.0 — £1,200.00 a month lands as Ben £840.00 and Alex £360.00 into Bills joint.",
    );
  });

  it("notes that the shares are normalised to 100%", async () => {
    const user = userEvent.setup();
    renderPage();
    const ben = await screen.findByLabelText("Ben's share of shared costs, percent");
    await user.clear(ben);
    await user.type(ben, "70");

    const note = screen.getByText(/shares must total 100%/);
    expect(flat(note)).toContain("these total 110.0%");
    // Weights, not percentages: 70/40 still splits 63.6/36.4.
    expect(flat(screen.getByText(/splits shared costs/))).toContain(
      "splits shared costs 63.6/36.4",
    );
  });

  it("saves on demand, confirms it, and re-reads the plan the split applies to", async () => {
    const user = userEvent.setup();
    let saves = 0;
    const { stub } = renderPage({
      "PATCH /api/auth/households/h1/members/u1/share": () => {
        saves++;
        return { body: { id: "m1", contributionShareBp: 7000 } };
      },
      "PATCH /api/auth/households/h1/members/u2/share": () => {
        saves++;
        return { body: { id: "m2", contributionShareBp: 3000 } };
      },
      // Once the shares change, the household and its plan answer differently.
      "GET /api/auth/households/h1": () => ({
        body: household(saves ? 7000 : 6000, saves ? 3000 : 4000),
      }),
      "GET /api/households/h1/plan": () => ({ body: plan(saves ? 200000 : 120000) }),
    });

    const ben = await screen.findByLabelText("Ben's share of shared costs, percent");
    // Nothing has moved yet, so there is nothing to save.
    expect(screen.getByRole("button", { name: "save shares" })).toBeDisabled();

    await user.clear(ben);
    await user.type(ben, "70");
    await user.clear(screen.getByLabelText("Alex's share of shared costs, percent"));
    await user.type(screen.getByLabelText("Alex's share of shared costs, percent"), "30");
    await user.click(screen.getByRole("button", { name: "save shares" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "✓ saved — plan, transfers and the money flow recalculated",
    );
    expect(stub.bodyOf("PATCH /api/auth/households/h1/members/u1/share")).toEqual({
      shareBp: 7000,
    });
    expect(stub.bodyOf("PATCH /api/auth/households/h1/members/u2/share")).toEqual({
      shareBp: 3000,
    });

    // The consequence line moved with the refetched plan, not with the inputs.
    expect(flat(await screen.findByText(/splits shared costs/))).toBe(
      "splits shared costs 70.0/30.0 — £2,000.00 a month lands as Ben £1,400.00 and Alex £600.00 into Bills joint.",
    );
  });
});

/**
 * Leaving is the only way into a different household, so it has to work and it
 * has to be honest about what it costs (WP-W). The dissolution itself is the
 * Store's — shares, plan roles and the movements that only existed inside the
 * household — so what is pinned here is that the page says so before it asks,
 * and that it takes you somewhere that still exists afterwards.
 */
describe("HouseholdDetailPage — leaving", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Ben as a plain member rather than the founder: only then is there a way
   *  out that is not "delete the whole household". */
  function asMember(): HouseholdDetailDto {
    const base = household();
    return {
      ...base,
      yourRole: "member",
      members: base.members.map((m) => ({
        ...m,
        role: m.isSelf ? ("member" as const) : ("owner" as const),
      })),
    };
  }

  function renderAsMember(extra?: Routes) {
    const stub = stubApiFetch({
      "GET /api/auth/households/h1": { body: asMember() },
      "GET /api/accounts": { body: ACCOUNTS },
      "GET /api/households/h1/accounts": { body: ROSTER },
      "GET /api/households/h1/plan": { body: plan(120000) },
      "GET /api/overview": { body: { asOfDate: AS_OF, perCurrency: [] } },
      "DELETE /api/auth/households/h1/members/u1": { status: 204 },
      ...extra,
    });
    render(
      <MemoryRouter initialEntries={["/households/h1"]}>
        <RouterRoutes>
          <Route path="/households/:id" element={<HouseholdDetailPage />} />
          <Route path="/households" element={<p>no household</p>} />
        </RouterRoutes>
      </MemoryRouter>,
    );
    return stub;
  }

  it("names what leaving dissolves, and what it keeps, before asking", async () => {
    const confirmed = vi.fn<(message?: string) => boolean>(() => false);
    vi.stubGlobal("confirm", confirmed);
    const stub = renderAsMember();

    await userEvent.click(await screen.findByRole("button", { name: "leave" }));

    const asked = String(confirmed.mock.calls[0]?.[0] ?? "");
    expect(asked).toMatch(/stop being shared/);
    expect(asked).toMatch(/roles in its plan are removed/);
    expect(asked).toMatch(/stops/);
    expect(asked).toMatch(/already been recorded — transfers marked done, contributions/);
    // Refused at the prompt: nothing was sent.
    expect(stub.calls("DELETE /api/auth/households/h1/members/u1")).toBe(0);
  });

  it("takes you out of a household you can no longer see", async () => {
    vi.stubGlobal("confirm", () => true);
    const stub = renderAsMember();

    await userEvent.click(await screen.findByRole("button", { name: "leave" }));

    expect(stub.calls("DELETE /api/auth/households/h1/members/u1")).toBe(1);
    // Not a refetch — that would 404, because the household is no longer yours.
    expect(await screen.findByText("no household")).toBeTruthy();
  });
});

describe("HouseholdDetailPage — the danger zone", () => {
  it("sits collapsed at the very bottom", async () => {
    const { container } = renderPage();
    const heading = await screen.findByText("danger zone");
    const details = heading.closest("details");

    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(container.querySelector("section")?.lastElementChild).toBe(details);
  });

  it("takes the household's name before it will delete anything", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("danger zone");

    const del = screen.getByRole("button", { name: "delete household" });
    expect(del).toBeDisabled();

    await user.type(screen.getByLabelText("type household name to confirm deletion"), "Ralton");
    expect(del).toBeEnabled();
  });
});
