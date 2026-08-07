import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../contexts/PrivacyContext.js";
import { api } from "../lib/api.js";
import { SCOPES_STORAGE_KEY } from "../lib/scopes.js";
import { stubApiFetch } from "../test/apiMock.js";
import type { AccountDto, FlowDto, UserDto } from "../lib/types.js";
import { FlowPage } from "./FlowPage.js";

const AS_OF = "2026-08-04";

/** Two households' accounts and a standalone pot, in one picture. */
const FLOW: FlowDto = {
  asOfDate: AS_OF,
  currency: "GBP",
  accounts: [
    {
      accountId: "current",
      name: "current",
      incomeMinor: 400_000,
      spendingMinor: 0,
      leftoverMinor: 240_000,
      shortfallMinor: 0,
    },
    {
      accountId: "home-bills",
      name: "home bills",
      incomeMinor: 0,
      spendingMinor: 100_000,
      leftoverMinor: 0,
      shortfallMinor: 0,
    },
    {
      accountId: "flat-bills",
      name: "flat bills",
      incomeMinor: 0,
      spendingMinor: 40_000,
      leftoverMinor: 0,
      shortfallMinor: 0,
    },
    {
      accountId: "isa",
      name: "isa",
      incomeMinor: 0,
      spendingMinor: 0,
      leftoverMinor: 60_000,
      shortfallMinor: 0,
    },
  ],
  edges: [
    {
      fromAccountId: "current",
      toAccountId: "isa",
      amountMinor: 60_000,
      requestedMinor: 60_000,
      status: "funded",
      inflowId: "monthly-saving",
    },
    {
      fromAccountId: "current",
      toAccountId: "home-bills",
      amountMinor: 100_000,
      requestedMinor: 100_000,
      status: "funded",
      memberUserId: "alice",
      memberName: "Alice",
    },
    {
      fromAccountId: null,
      toAccountId: "flat-bills",
      amountMinor: 40_000,
      requestedMinor: 40_000,
      status: "funded",
      memberUserId: "alice",
      memberName: "Alice",
    },
  ],
  totalInflowMinor: 440_000,
};

// Every account of this fixture is one Alice can see, so every one of them has
// a name; a flow node's name is optional because an account on a household's
// roster she may not see arrives without one (decision 36).
const ACCOUNTS: AccountDto[] = FLOW.accounts.map((a) => ({
  id: a.accountId,
  name: a.name ?? a.accountId,
  description: null,
  currency: "GBP",
  openingBalanceMinor: 0,
  monthlyBufferMinor: 0,
  owner: true,
  permission: "edit",
}));

/** A co-member's account, shared into the household and visible here. Theirs,
 *  whoever can see it (decision 20). */
const BOBS: AccountDto = {
  id: "bob-current",
  name: "bob current",
  description: null,
  currency: "GBP",
  openingBalanceMinor: 0,
  monthlyBufferMinor: 0,
  owner: false,
  permission: "view",
};

const ME: UserDto = {
  id: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  households: [{ id: "home", name: "Home" }],
};

const SCOPE = "current,home-bills,flat-bills,isa";

function routes() {
  return {
    "GET /api/accounts": { body: ACCOUNTS },
    "GET /api/auth/me": { body: ME },
    [`GET /api/flow?accounts=${SCOPE}`]: { body: FLOW },
  };
}

function renderAt(search: string) {
  return render(
    <PrivacyProvider>
      <MemoryRouter initialEntries={[`/flow${search}`]}>
        <FlowPage />
      </MemoryRouter>
    </PrivacyProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  api.setToken("t");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("FlowPage", () => {
  it("draws a scope spanning two households and a standalone pot", async () => {
    stubApiFetch(routes());
    renderAt(`?accounts=${SCOPE}`);

    expect(await screen.findByText(/4 of 4 drawn/)).toBeInTheDocument();
    // Every account in the set is listed, whatever household it belongs to.
    for (const name of ["current", "home bills", "flat bills", "isa"]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/£4,400.00 in from outside/)).toBeInTheDocument();
  });

  /**
   * Decision 36 on the page. A member of a household holding an account shared
   * with nobody is sent that account's figures and not its name, and the row
   * prints the absence — it is not left blank, and the row is certainly not
   * dropped, because the totals above it are counted over it.
   */
  it("draws an account it may not name, with its money", async () => {
    const anonymous: FlowDto = {
      ...FLOW,
      accounts: FLOW.accounts.map((a) =>
        a.accountId === "flat-bills" ? { ...a, name: undefined } : a,
      ),
    };
    stubApiFetch({
      ...routes(),
      // A reader who cannot see the account is not offered it as a chip either:
      // `/api/accounts` lists what they can see, and the diagram is drawn over
      // what the household holds. The two lists differ, and that is the case.
      "GET /api/accounts": { body: ACCOUNTS.filter((a) => a.id !== "flat-bills") },
      [`GET /api/flow?accounts=${SCOPE}`]: { body: anonymous },
    });
    renderAt(`?accounts=${SCOPE}`);

    expect(await screen.findByText(/4 of 4 drawn/)).toBeInTheDocument();
    expect(screen.getAllByText("other account").length).toBeGreaterThan(0);
    expect(screen.queryByText("flat bills")).not.toBeInTheDocument();
    // Same denominator as the named picture: nothing was dropped to hide a name.
    expect(screen.getByText(/£4,400.00 in from outside/)).toBeInTheDocument();
    // And the row is a row like any other — it can be taken out of the picture,
    // by the label the reader can actually see.
    expect(screen.getByRole("button", { name: "hide other account" })).toBeInTheDocument();
  });

  /**
   * The excludability proof the acceptance asks for. Hiding an account is a way
   * of looking at the diagram: the request that produced these figures is never
   * re-issued, and the flow the page holds is byte-for-byte what it was.
   */
  it("hiding an account changes the picture and provably not one figure", async () => {
    const stub = stubApiFetch(routes());
    renderAt(`?accounts=${SCOPE}`);
    await screen.findByText(/4 of 4 drawn/);

    const key = `GET /api/flow?accounts=${SCOPE}`;
    const requestsBefore = stub.calls(key);
    // The plan snapshot: every figure the page is drawing from, as it stands.
    const snapshot = JSON.stringify([...screen.getAllByRole("row")].map((row) => row.textContent));

    fireEvent.click(screen.getByRole("button", { name: "hide isa" }));
    await screen.findByText(/3 of 4 drawn/);

    // Nothing was asked of the server: the scope did not change, only the view.
    expect(stub.calls(key)).toBe(requestsBefore);
    expect(stub.mock.mock.calls.some(([url]) => String(url).includes("hide"))).toBe(false);

    // The ISA is still in scope and still carries its own figures — it is out
    // of the picture, not out of the plan.
    fireEvent.click(screen.getByRole("button", { name: "show isa" }));
    await screen.findByText(/4 of 4 drawn/);
    expect(JSON.stringify([...screen.getAllByRole("row")].map((r) => r.textContent))).toBe(
      snapshot,
    );
    expect(stub.calls(key)).toBe(requestsBefore);
  });

  it("re-measures shares against what is left in the picture", async () => {
    stubApiFetch(routes());
    renderAt(`?accounts=${SCOPE}&hide=current`);
    // Without the current account's salary, the money entering the picture is
    // what now crosses its edge: £600 to the ISA, £1,000 to home bills, £400
    // to flat bills.
    expect(await screen.findByText(/£2,000.00 in from outside/)).toBeInTheDocument();
    expect(screen.getByText(/3 of 4 drawn/)).toBeInTheDocument();
  });

  it("adds an account to the scope by asking the server again", async () => {
    const stub = stubApiFetch({
      ...routes(),
      "GET /api/flow?accounts=current": {
        body: { ...FLOW, accounts: [FLOW.accounts[0]], edges: [], totalInflowMinor: 400_000 },
      },
    });
    renderAt("?accounts=current");
    await screen.findByText(/1 of 1 drawn/);

    // Widening the scope *is* a different question, and is asked as one.
    fireEvent.click(screen.getByRole("button", { name: "isa" }));
    await waitFor(() =>
      expect(stub.calls("GET /api/flow?accounts=current,isa")).toBeGreaterThan(0),
    );
  });

  /**
   * A household is a set of accounts somebody else chose, and is drawn by the
   * same request as a set the user chose by hand.
   *
   * This used to assert the opposite — that the page asked for the household
   * *plan* and reshaped it, `expect(stub.calls("GET /api/flow"))` deliberately
   * false. That reshaping had no row for an authored movement and drew both of
   * its ends leaving the picture (issue #43, `flow-elsewhere.pin.test.tsx`), so
   * decision 31 deleted it. The roster resolves the preset; the flow endpoint
   * draws it.
   */
  it("draws a household as one preset over the same picture", async () => {
    const stub = stubApiFetch({
      ...routes(),
      "GET /api/households/home/accounts": {
        body: [
          {
            accountId: "current",
            accountName: "current",
            currency: "GBP",
            role: "personal",
            memberUserId: "alice",
          },
          {
            accountId: "home-bills",
            accountName: "home bills",
            currency: "GBP",
            role: "shared",
            memberUserId: null,
          },
        ],
      },
      "GET /api/flow?accounts=current,home-bills": {
        body: {
          ...FLOW,
          accounts: FLOW.accounts.filter((a) => ["current", "home-bills"].includes(a.accountId)),
          edges: FLOW.edges.filter(
            (e) => e.fromAccountId === "current" && e.toAccountId === "home-bills",
          ),
        } satisfies FlowDto,
      },
    });
    renderAt("?household=home");

    expect(await screen.findByText(/2 of 2 drawn/)).toBeInTheDocument();
    // The roster names the set; the one funding pass draws it. The household
    // plan is never asked for, because a second derivation of the same money is
    // the thing ONE-ENGINE.md exists to end.
    expect(stub.calls("GET /api/households/home/accounts")).toBe(1);
    expect(stub.calls("GET /api/flow?accounts=current,home-bills")).toBe(1);
    expect(
      stub.mock.mock.calls.some(([url]) => String(url).includes("/households/home/plan")),
    ).toBe(false);
    expect(screen.getByRole("heading", { name: /money flow \/ Home/ })).toBeInTheDocument();
  });

  it("saves a picture under a name and reopens it", async () => {
    stubApiFetch(routes());
    renderAt(`?accounts=${SCOPE}&hide=isa`);
    await screen.findByText(/3 of 4 drawn/);

    fireEvent.change(screen.getByLabelText("name this picture"), {
      target: { value: "the flat" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    expect(JSON.parse(localStorage.getItem(SCOPES_STORAGE_KEY)!)).toEqual([
      {
        name: "the flat",
        accountIds: ["current", "home-bills", "flat-bills", "isa"],
        hiddenAccountIds: ["isa"],
      },
    ]);
    // ...and it is offered back, with the hidden account still hidden.
    fireEvent.click(screen.getByRole("button", { name: "the flat" }));
    expect(await screen.findByText(/3 of 4 drawn/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "forget the flat" }));
    expect(JSON.parse(localStorage.getItem(SCOPES_STORAGE_KEY)!)).toEqual([]);
  });

  it("asks for nothing until there is something to draw", async () => {
    const stub = stubApiFetch(routes());
    renderAt("");
    expect(await screen.findByText(/pick some accounts above/)).toBeInTheDocument();
    expect(stub.mock.mock.calls.some(([url]) => String(url).includes("/api/flow"))).toBe(false);
  });

  /**
   * A negative residual is the one reading this figure must never be green for.
   *
   * WP-Q stopped flooring residuals precisely so a negative one would be visible
   * and actionable: it says a member is holding income in a personal account
   * other than the one their transfers leave (decision 11) and has to consolidate
   * before the month works. `FlowSankey` and the household table both read the
   * sign; this column hardcoded `ok` and rendered the minus in the funded colour,
   * which reads as surplus and defeats the decision.
   */
  it("does not print a negative left over in the funded colour", async () => {
    stubApiFetch({
      ...routes(),
      [`GET /api/flow?accounts=${SCOPE}`]: {
        body: {
          ...FLOW,
          accounts: FLOW.accounts.map((a) =>
            a.accountId === "current" ? { ...a, leftoverMinor: -24_400 } : a,
          ),
        },
      },
    });
    renderAt(`?accounts=${SCOPE}`);

    const short = await screen.findByText("-£244.00");
    expect(short).toHaveClass("num", "warn");
    expect(short).not.toHaveClass("ok");
    // The accounts that are fine keep the colour that says so.
    expect(screen.getByText("£600.00")).toHaveClass("num", "ok");
  });

  /**
   * The preset says "everything you own", so it must not select an account
   * somebody else owns.
   *
   * Bob's current account is shared into the household and appears in
   * `GET /api/accounts` like any other. Before the filter, the preset mapped
   * that whole list to ids, and every aggregate on the page — the money in from
   * outside, each row of the per-account table — was then computed over a set
   * containing a co-member's account, under a button that had just claimed the
   * lot was the caller's (decision 20).
   */
  it("scopes the preset to accounts you own, not accounts you can see", async () => {
    const stub = stubApiFetch({
      ...routes(),
      "GET /api/accounts": { body: [...ACCOUNTS, BOBS] },
    });
    renderAt("");
    // The chip for Bob's account is there — it can be added by hand, and the
    // preset is the only thing being narrowed.
    expect(await screen.findByRole("button", { name: "bob current" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "everything you own" }));

    await waitFor(() => expect(stub.calls(`GET /api/flow?accounts=${SCOPE}`)).toBe(1));
    expect(stub.mock.mock.calls.some(([url]) => String(url).includes("bob-current"))).toBe(false);
  });

  /** With nothing of your own to draw, the preset has nothing to offer — and
   *  must not fall through to clearing the scope. */
  it("offers no preset when every account you can see is somebody else's", async () => {
    stubApiFetch({ ...routes(), "GET /api/accounts": { body: [BOBS] } });
    renderAt("");
    await screen.findByRole("button", { name: "bob current" });
    expect(screen.getByRole("button", { name: "everything you own" })).toBeDisabled();
  });

  it("says so when a scope cannot be drawn", async () => {
    stubApiFetch({
      ...routes(),
      "GET /api/flow?accounts=nope": {
        status: 422,
        body: { error: { code: "validation_error", message: "no" } },
      },
    });
    renderAt("?accounts=nope");
    expect(await screen.findByText(/could not draw this scope/)).toBeInTheDocument();
  });
});
