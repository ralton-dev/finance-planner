import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAddProvider } from "../contexts/QuickAddContext.js";
import { api } from "../lib/api.js";
import type { AccountDto, OverviewAccountDto } from "../lib/types.js";
import { stubApiFetch, type Routes } from "../test/apiMock.js";
import { AccountsPage } from "./AccountsPage.js";

const AS_OF = "2026-08-04";

/** An account with nothing to say, so each test states only what it is about. */
function account(partial: Partial<AccountDto> & { id: string; name: string }): AccountDto {
  return {
    currency: "GBP",
    openingBalanceMinor: 999999,
    monthlyBufferMinor: 0,
    owner: true,
    ...partial,
  };
}

/** A settled account: checked in today, funded, nothing outstanding. */
function summary(partial: Partial<OverviewAccountDto> & { accountId: string }): OverviewAccountDto {
  return {
    name: "account",
    householdId: null,
    householdRole: null,
    monthlyIncomeMinor: 0,
    leftoverMinor: 100000,
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

function renderAccounts(accounts: AccountDto[], summaries: OverviewAccountDto[], extra?: Routes) {
  stubApiFetch({
    "GET /api/accounts": { body: accounts },
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
            accounts: summaries,
          },
        ],
      },
    },
    ...extra,
  });

  render(
    <MemoryRouter>
      <QuickAddProvider>
        <AccountsPage />
      </QuickAddProvider>
    </MemoryRouter>,
  );
}

/** The row a named account sits in, once the table has rendered. */
async function rowFor(name: string): Promise<HTMLElement> {
  const link = await screen.findByRole("link", { name });
  const row = link.closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

beforeEach(() => {
  api.setToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountsPage — attention chips", () => {
  it("asks for the money that has not been recorded", async () => {
    renderAccounts(
      [account({ id: "a1", name: "Ben current" })],
      [summary({ accountId: "a1", unrecordedCount: 2, unrecordedTotalMinor: 20000 })],
    );

    const row = await rowFor("Ben current");
    expect(within(row).getByText(/record 2/)).toBeInTheDocument();
    expect(within(row).getByText("£200.00")).toBeInTheDocument();
    expect(within(row).queryByText("funded")).toBeNull();
  });

  it("calls out a shortfall as unfunded money", async () => {
    renderAccounts(
      [account({ id: "a1", name: "Ben current" })],
      [summary({ accountId: "a1", shortfallMinor: 4000 })],
    );

    const row = await rowFor("Ben current");
    expect(within(row).getByText(/unfunded/)).toBeInTheDocument();
    expect(within(row).getByText("£40.00")).toBeInTheDocument();
  });

  it("flags a balance nobody has confirmed lately", async () => {
    renderAccounts(
      [account({ id: "a1", name: "Alex current" })],
      [summary({ accountId: "a1", latestBalanceDate: "2026-07-12" })],
    );

    const row = await rowFor("Alex current");
    expect(within(row).getByText("stale 23 d")).toBeInTheDocument();
    expect(within(row).getByText("checked in 23 d ago")).toBeInTheDocument();
  });

  it("leaves a balance inside the threshold alone", async () => {
    renderAccounts(
      [account({ id: "a1", name: "Alex current" })],
      [summary({ accountId: "a1", latestBalanceDate: "2026-07-28" })],
    );

    const row = await rowFor("Alex current");
    expect(within(row).queryByText(/stale/)).toBeNull();
    expect(within(row).getByText("funded")).toBeInTheDocument();
  });

  it("says funded only when nothing else is outstanding", async () => {
    renderAccounts([account({ id: "a1", name: "Bills joint" })], [summary({ accountId: "a1" })]);

    const row = await rowFor("Bills joint");
    expect(within(row).getByText("funded")).toBeInTheDocument();
    expect(within(row).getByText("checked in today")).toBeInTheDocument();
  });

  it("stacks every outstanding chip, and drops funded when it does", async () => {
    renderAccounts(
      [account({ id: "a1", name: "Ben current" })],
      [
        summary({
          accountId: "a1",
          unrecordedCount: 1,
          unrecordedTotalMinor: 20000,
          shortfallMinor: 4000,
          latestBalanceDate: "2026-06-04",
        }),
      ],
    );

    const row = await rowFor("Ben current");
    expect(within(row).getByText(/record 1/)).toBeInTheDocument();
    expect(within(row).getByText(/unfunded/)).toBeInTheDocument();
    expect(within(row).getByText("stale 61 d")).toBeInTheDocument();
    expect(within(row).queryByText("funded")).toBeNull();
  });

  it("asks for a transfer in amber, never in red", async () => {
    // The bills pot: £303.20 planned in, nothing moved. The plan covers it, so
    // there is no shortfall — the outstanding thing is a transfer, and a
    // transfer is your move, not a hole in the plan.
    renderAccounts(
      [account({ id: "a1", name: "Bills joint" })],
      [summary({ accountId: "a1", allocatedInflowMinor: 30_320, confirmedInflowMinor: 0 })],
    );

    const row = await rowFor("Bills joint");
    const chip = within(row).getByText(/awaiting transfer/);
    expect(chip).toHaveClass("tag-status", "needs-you");
    expect(chip).not.toHaveClass("alert");
    expect(within(row).getByText("£303.20")).toBeInTheDocument();
    // No red chip anywhere on the row, and no claim that it is funded either.
    expect(row.querySelectorAll(".tag-status.alert")).toHaveLength(0);
    expect(within(row).queryByText("unfunded")).toBeNull();
    expect(within(row).queryByText("funded")).toBeNull();
  });

  it("stops asking once the money has moved", async () => {
    renderAccounts(
      [account({ id: "a1", name: "Bills joint" })],
      [summary({ accountId: "a1", allocatedInflowMinor: 30_320, confirmedInflowMinor: 30_320 })],
    );

    const row = await rowFor("Bills joint");
    expect(within(row).queryByText(/awaiting/)).toBeNull();
    expect(within(row).getByText("funded")).toBeInTheDocument();
  });

  it("counts only the part still to move", async () => {
    renderAccounts(
      [account({ id: "a1", name: "Bills joint" })],
      [summary({ accountId: "a1", allocatedInflowMinor: 30_320, confirmedInflowMinor: 20_000 })],
    );

    const row = await rowFor("Bills joint");
    expect(within(row).getByText("£103.20")).toBeInTheDocument();
  });

  it("treats an account nobody has ever checked in as needing one", async () => {
    renderAccounts(
      [account({ id: "a1", name: "Rainy day" })],
      [summary({ accountId: "a1", latestBalanceMinor: null, latestBalanceDate: null })],
    );

    const row = await rowFor("Rainy day");
    expect(within(row).getByText("never checked in")).toBeInTheDocument();
    expect(within(row).getByText("no check-in yet")).toBeInTheDocument();
    expect(within(row).getByText("—")).toBeInTheDocument();
  });
});

describe("AccountsPage — ownership", () => {
  it("states ownership as a phrase, not an access grant", async () => {
    renderAccounts(
      [
        account({ id: "a1", name: "Ben current", owner: true, monthlyBufferMinor: 0 }),
        account({ id: "a2", name: "Alex current", owner: false, permission: "edit" }),
        account({ id: "a3", name: "Nan's pot", owner: false, permission: "view" }),
      ],
      [
        summary({ accountId: "a1", monthlyIncomeMinor: 300000 }),
        summary({ accountId: "a2" }),
        summary({ accountId: "a3" }),
      ],
    );

    expect(
      within(await rowFor("Ben current")).getByText("owner · salary lands here"),
    ).toBeVisible();
    expect(
      within(await rowFor("Alex current")).getByText("shared with you · can edit"),
    ).toBeVisible();
    expect(within(await rowFor("Nan's pot")).getByText("shared with you · can view")).toBeVisible();
    // The old access vocabulary is gone from the page entirely.
    expect(screen.queryByText("shared")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "access" })).toBeNull();
  });

  it("names a household's shared pot", async () => {
    renderAccounts(
      [account({ id: "a1", name: "Bills joint" })],
      [summary({ accountId: "a1", householdId: "h1", householdRole: "shared" })],
    );

    expect(within(await rowFor("Bills joint")).getByText("owner · shared pot")).toBeVisible();
  });

  it("says where a pot with no income of its own gets its money", async () => {
    // No household role and no salary: this row used to read as an account with
    // no funding source at all, when in fact money arrives every month.
    renderAccounts(
      [account({ id: "a1", name: "Rainy day" })],
      [summary({ accountId: "a1", monthlyIncomeMinor: 0, allocatedInflowMinor: 30_320 })],
    );

    const sub = within(await rowFor("Rainy day")).getByText("owner · fed from elsewhere");
    expect(sub).toBeVisible();
    // Nothing implies a household — the sender may be another account you own.
    expect(sub).not.toHaveTextContent(/household|shared/);
  });
});

describe("AccountsPage — the two headline numbers", () => {
  it("prints the balance the account page's reality strip prints", async () => {
    // Both screens read one field. The opening balance the account was
    // configured with is not a balance and never appears on the index.
    renderAccounts(
      [account({ id: "a1", name: "Ben current", openingBalanceMinor: 250000 })],
      [summary({ accountId: "a1", latestBalanceMinor: 318450, latestBalanceDate: "2026-08-04" })],
    );

    const row = await rowFor("Ben current");
    expect(within(row).getByText("£3,184.50")).toBeInTheDocument();
    expect(within(row).queryByText("£2,500.00")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /opening balance/ })).toBeNull();
  });
});

describe("AccountsPage — the table", () => {
  it("states the row count once and makes the whole row a doorway", async () => {
    renderAccounts(
      [account({ id: "a1", name: "Ben current" }), account({ id: "a2", name: "Bills joint" })],
      [summary({ accountId: "a1" }), summary({ accountId: "a2" })],
    );

    await rowFor("Ben current");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("accounts / 2");
    expect(screen.queryByText("[2 rows]")).toBeNull();
    expect(screen.getByRole("link", { name: "open Ben current" })).toHaveAttribute(
      "href",
      "/accounts/a1",
    );
    expect(screen.getByText(/as of 2026-08-04/)).toBeInTheDocument();
  });

  // What jsdom can see of the narrow layout. Whether the document stops
  // scrolling sideways at 390px is a measurement, not an assertion.
  it("scrolls inside a wrapper, with the account pinned and nothing dropped", async () => {
    renderAccounts([account({ id: "a1", name: "Ben current" })], [summary({ accountId: "a1" })]);

    const row = await rowFor("Ben current");
    const table = row.closest("table");
    expect(table?.parentElement).toHaveClass("table-scroll");
    expect(table?.querySelector("thead th")).toHaveClass("sticky-col");
    expect(row.firstElementChild).toHaveClass("sticky-col");
    // All four questions the page answers stay on screen at every width; the
    // row's own sub-line was already carrying what this table dropped.
    expect(table?.querySelectorAll(".wide-only")).toHaveLength(0);
  });
});

// Both directions, together, because the two halves break in opposite ways: a
// page that shows the first run after a failed read is lying about the money,
// and a page that shows an error to somebody who genuinely has no accounts has
// taken the front door away from every new user.
describe("AccountsPage — a failed account list", () => {
  it("says the list could not be read rather than that it is empty", async () => {
    renderAccounts([], [], {
      "GET /api/accounts": { status: 500, body: { error: { code: "internal" } } },
    });

    expect(await screen.findByText(/could not read your accounts/i)).toBeInTheDocument();
    expect(screen.queryByText(/no accounts yet/i)).toBeNull();
    // Nothing to act on either: a create flow offered under a count of zero we
    // never read is the same claim in button form.
    expect(screen.queryByRole("button", { name: /new account/i })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("still greets a genuinely empty profile with the first run", async () => {
    renderAccounts([], []);

    expect(await screen.findByText(/no accounts yet/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("accounts / 0");
    expect(screen.getAllByRole("button", { name: /new account/i }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/could not read your accounts/i)).toBeNull();
  });
});
