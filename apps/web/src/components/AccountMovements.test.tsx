import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../lib/api.js";
import type { AccountDto, AccountPlanDto, InflowDto } from "../lib/types.js";
import { stubApiFetch, type FetchStub, type Routes } from "../test/apiMock.js";
import { AccountMovements, outboundNote } from "./AccountMovements.js";
import { movementError } from "./MovementDrawer.js";

/**
 * The screen WP-K exists for: authoring, changing and calling off a movement
 * between two accounts you own, from either end of it.
 *
 * The two access rules are the interesting part and they are deliberately not
 * the same. Creating one takes `edit` on both accounts, because it commits the
 * sending account's surplus every month from then on. Removing one takes `edit`
 * on either, because releasing that claim can harm neither end — and the
 * symmetric rule would trap an owner whose account was shared, drained and then
 * un-shared. Both are asserted here as *buttons*, since that is where a user
 * meets them.
 */

const account = (over: Partial<AccountDto> & { id: string; name: string }): AccountDto => ({
  currency: "GBP",
  openingBalanceMinor: 0,
  monthlyBufferMinor: 0,
  owner: true,
  ...over,
});

const CURRENT = account({ id: "current", name: "Current account" });
const POT = account({ id: "pot", name: "Holiday pot" });
const SHARED_VIEW = account({
  id: "theirs",
  name: "Their account",
  owner: false,
  permission: "view",
});
const DOLLARS = account({ id: "usd", name: "Dollar pot", currency: "USD" });

const movement = (over: Partial<InflowDto> & { id: string; accountId: string }): InflowDto => ({
  name: "Monthly top-up",
  source: "account",
  sourceAccountId: "current",
  amountMinor: 40_000,
  frequency: "monthly",
  recurrence: null,
  anchorDate: "2026-08-01",
  priority: 100,
  active: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

let stub: FetchStub;

function renderFor(
  target: AccountDto,
  routes: Routes = {},
  extra: { plan?: AccountPlanDto; canEdit?: boolean } = {},
): void {
  stub = stubApiFetch({
    "GET /api/accounts": { body: [CURRENT, POT, SHARED_VIEW, DOLLARS] },
    [`GET /api/accounts/${target.id}/inflows`]: { body: [] },
    [`GET /api/accounts/${target.id}/inflows/outbound`]: { body: [] },
    ...routes,
  });
  render(
    <AccountMovements
      account={target}
      plan={extra.plan}
      canEdit={extra.canEdit ?? true}
      onChanged={() => {}}
    />,
  );
}

beforeEach(() => {
  api.setToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountMovements — the two faces of one row", () => {
  it("shows what arrives and what leaves, and names the far account", async () => {
    renderFor(POT, {
      "GET /api/accounts/pot/inflows": {
        body: [
          movement({ id: "in-1", accountId: "pot", sourceAccountId: "current" }),
          // The income door's rows are not movements and do not belong here.
          movement({
            id: "salary",
            accountId: "pot",
            source: "external",
            sourceAccountId: null,
            name: "Salary",
          }),
        ],
      },
      "GET /api/accounts/pot/inflows/outbound": {
        body: [movement({ id: "out-1", accountId: "usd", sourceAccountId: "pot", name: "Sweep" })],
      },
    });

    const arriving = (await screen.findByText("arriving here")).closest("div")!.parentElement!;
    expect(within(arriving).getByText("Current account →")).toBeInTheDocument();
    expect(within(arriving).queryByText("Salary")).toBeNull();

    const leaving = screen.getByText("leaving here").closest("div")!.parentElement!;
    expect(within(leaving).getByText("→ Dollar pot")).toBeInTheDocument();
  });

  it("calls an account it cannot see 'another account', whatever the reason", async () => {
    // An account that does not exist and one that is simply not shared with you
    // answer identically at the API, on purpose. This must not be the screen
    // that tells them apart.
    renderFor(POT, {
      "GET /api/accounts/pot/inflows": {
        body: [movement({ id: "in-1", accountId: "pot", sourceAccountId: "somebody-elses" })],
      },
    });
    expect(await screen.findByText("another account →")).toBeInTheDocument();
  });

  it("offers remove on a row it may not edit — the rules differ and so do the buttons", async () => {
    renderFor(POT, {
      "GET /api/accounts/pot/inflows": {
        body: [
          movement({ id: "mine", accountId: "pot", sourceAccountId: "current" }),
          movement({
            id: "theirs",
            accountId: "pot",
            sourceAccountId: "theirs",
            name: "Their gift",
          }),
        ],
      },
      "DELETE /api/inflows/theirs": { status: 204 },
    });

    const rows = await screen.findAllByRole("listitem");
    const [mine, theirs] = rows.map((row) => within(row));
    expect(mine!.getByRole("button", { name: "edit" })).toBeEnabled();
    // Edit access on the far end is what changing it takes; removing it is not.
    expect(theirs!.getByRole("button", { name: "edit" })).toBeDisabled();

    fireEvent.click(theirs!.getByRole("button", { name: "✕" }));
    await waitFor(() => expect(stub.calls("DELETE /api/inflows/theirs")).toBe(1));
  });

  it("shows nothing at all to somebody who can only look, and has nothing to look at", () => {
    renderFor(POT, {}, { canEdit: false });
    expect(screen.queryByText("movements")).toBeNull();
  });
});

describe("AccountMovements — authoring", () => {
  /** Opens the drawer from one side or the other. */
  async function openDrawer(target: AccountDto, label: string, routes: Routes = {}) {
    renderFor(target, routes);
    fireEvent.click((await screen.findAllByRole("button", { name: `${label} →` }))[0]!);
    return screen.getByTestId("drawer");
  }

  it("offers only accounts you can edit, in this account's currency, never itself", async () => {
    await openDrawer(POT, "+ money in");
    const options = screen
      .getAllByRole("combobox")[0]!
      .querySelectorAll<HTMLOptionElement>("option");
    expect([...options].map((o) => o.textContent)).toEqual([
      "select an account…",
      "Current account · GBP",
    ]);
    // Their account is view-only, the dollar pot cannot be moved to without a
    // rate nothing in the estate holds, and an account cannot fund itself.
    expect(screen.queryByText(/Their account/)).toBeNull();
    expect(screen.queryByText(/Dollar pot/)).toBeNull();
    expect(screen.queryByText(/Holiday pot ·/)).toBeNull();
  });

  it("authors on the receiving account when money comes in", async () => {
    await openDrawer(POT, "+ money in", {
      "POST /api/accounts/pot/inflows": { status: 201, body: {} },
    });

    fireEvent.change(screen.getByPlaceholderText("e.g. monthly sweep to bills"), {
      target: { value: "Bills sweep" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "400" } });
    fireEvent.click(screen.getByRole("button", { name: "add movement" }));

    await waitFor(() => expect(stub.calls("POST /api/accounts/pot/inflows")).toBe(1));
    expect(stub.bodyOf("POST /api/accounts/pot/inflows")).toMatchObject({
      name: "Bills sweep",
      amountMinor: 40_000,
      source: "account",
      sourceAccountId: "current",
      frequency: "monthly",
      // Meaningful only on an account-sourced row, which is all this drawer
      // ever authors — the API 422s it on an external one.
      priority: 100,
    });
  });

  it("authors on the far account when money goes out, so one row still serves both ends", async () => {
    await openDrawer(CURRENT, "+ money out", {
      "GET /api/accounts/current/inflows": { body: [] },
      "GET /api/accounts/current/inflows/outbound": { body: [] },
      "POST /api/accounts/pot/inflows": { status: 201, body: {} },
    });

    fireEvent.change(screen.getByPlaceholderText("e.g. monthly sweep to bills"), {
      target: { value: "Holiday sweep" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "add movement" }));

    await waitFor(() => expect(stub.calls("POST /api/accounts/pot/inflows")).toBe(1));
    expect(stub.bodyOf("POST /api/accounts/pot/inflows")).toMatchObject({
      sourceAccountId: "current",
      amountMinor: 15_000,
    });
  });

  it("never sends an end in a PATCH, and says why the ends are locked", async () => {
    renderFor(POT, {
      "GET /api/accounts/pot/inflows": {
        body: [movement({ id: "in-1", accountId: "pot", sourceAccountId: "current" })],
      },
      "PATCH /api/inflows/in-1": { body: {} },
    });
    fireEvent.click((await screen.findAllByRole("button", { name: "edit" }))[0]!);

    expect(screen.getAllByRole("combobox")[0]!).toBeDisabled();
    expect(
      screen.getByText(/which two accounts a movement runs between cannot be changed/),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(stub.calls("PATCH /api/inflows/in-1")).toBe(1));
    const body = stub.bodyOf("PATCH /api/inflows/in-1")!;
    expect(body.amountMinor).toBe(50_000);
    // Re-pointing an end is authoring a new claim against an account the
    // request never names, and the API answers 422 rather than ignoring it.
    for (const key of ["accountId", "source", "sourceAccountId"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("says a 404 the same way however the account came to be missing", async () => {
    await openDrawer(POT, "+ money in", {
      "POST /api/accounts/pot/inflows": {
        status: 404,
        body: { error: { code: "not_found", message: "Account not found" } },
      },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. monthly sweep to bills"), {
      target: { value: "Bills sweep" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "400" } });
    fireEvent.click(screen.getByRole("button", { name: "add movement" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "that account is not available — it may have been deleted, or it may not be shared with you.",
    );
  });
});

describe("outboundNote", () => {
  it("puts LEFT OVER on the far side of the movement, not the near one", () => {
    // The note used to say `leftover − outbound` out loud, which is the right
    // answer only for an account nothing arrives at: money arriving is not in
    // LEFT OVER at all. The KPI now prints `residualMinor`, which has the
    // movement in it, so the note says which side of it that figure is on and
    // quotes nothing it would only restate.
    expect(
      outboundNote(
        { outboundInflowMinor: 55_000, residualMinor: 12_000 } as AccountPlanDto,
        CURRENT,
      ),
    ).toEqual([
      { minor: 55_000, currency: "GBP" },
      " a month is already committed to leave.",
      " left over above is what stays once it has.",
    ]);
    expect(outboundNote({ outboundInflowMinor: 0 } as AccountPlanDto, CURRENT)).toBeNull();
    expect(outboundNote(undefined, CURRENT)).toBeNull();
  });

  it("names the consolidation a negative residual means, rather than hiding it", () => {
    // Decision 11: more is committed to leave this account than reaches it,
    // which happens when a member holds income somewhere other than the account
    // their transfers leave. Flooring it would hide the thing to do.
    expect(
      outboundNote(
        { outboundInflowMinor: 90_000, residualMinor: -20_000 } as AccountPlanDto,
        CURRENT,
      ),
    ).toEqual([
      { minor: 90_000, currency: "GBP" },
      " a month is already committed to leave.",
      " that is ",
      { minor: 20_000, currency: "GBP" },
      " more than reaches this account — consolidate your income here first, or the month cannot happen.",
    ]);
  });

  it("says the old sentence when the wire is too old to carry a residual", () => {
    expect(outboundNote({ outboundInflowMinor: 55_000 } as AccountPlanDto, CURRENT)).toEqual([
      { minor: 55_000, currency: "GBP" },
      " a month is already committed to leave.",
      " left over above is what this account has before any of it moves on, not after.",
    ]);
  });
});

describe("AccountMovements — a loop you have just closed", () => {
  it("names the accounts in the order money would travel", async () => {
    const plan = {
      accountId: "pot",
      fundingCycleAccountIds: ["current", "pot"],
    } as AccountPlanDto;
    renderFor(POT, {}, { plan });

    // Not "3 accounts feed each other" — which ones, and back to the start,
    // because the hop back is the one the plan drops.
    expect(
      await screen.findByText(/Current account → Holiday pot → Current account/),
    ).toBeInTheDocument();
    expect(screen.getByText(/remove one of these movements/)).toBeInTheDocument();
  });

  it("says nothing when there is no loop", async () => {
    renderFor(POT, {}, { plan: { accountId: "pot" } as AccountPlanDto });
    await screen.findByText("movements");
    expect(screen.queryByText(/funding loop/)).toBeNull();
  });
});

/**
 * WP-J made four failures loud on purpose. None of them may be swallowed, and
 * the 404 must stay one answer to two questions.
 */
describe("movementError", () => {
  const err = (status: number, message: string) =>
    new ApiError(status, "validation_error", message);

  it("says each of the API's deliberate refusals in the app's own words", () => {
    expect(
      movementError(err(422, "An inflow cannot be sourced from the account it arrives in")),
    ).toBe("an account cannot send money to itself. pick a different account.");
    expect(
      movementError(err(422, "accountId cannot be changed; delete the inflow and author it again")),
    ).toBe(
      "which two accounts a movement runs between cannot be changed — remove this movement and author a new one.",
    );
    expect(
      movementError(err(422, "priority is meaningful only for an account-sourced inflow")),
    ).toBe("priority only means something for money moving between your own accounts.");
  });

  it("answers a missing account and an unseeable one identically", () => {
    const missing = movementError(new ApiError(404, "not_found", "Account not found"));
    const unseeable = movementError(new ApiError(404, "not_found", "Account not found"));
    expect(missing).toBe(unseeable);
    expect(missing).toMatch(/it may have been deleted, or it may not be shared with you/);
  });

  it("does not put a serialised schema error in front of a person", () => {
    expect(movementError(err(422, '[{"code":"too_small","path":["name"]}]'))).toBe(
      "that movement was refused as invalid.",
    );
  });

  it("names the access rule on a 403", () => {
    expect(movementError(new ApiError(403, "forbidden", "edit access required"))).toBe(
      "moving money between two accounts needs edit access to both of them.",
    );
  });
});

/**
 * Decision 9: an account with bills and no income of its own is fed by a
 * transfer the *pass* derives, with nobody authoring anything. `listInflows`
 * only ever knew about authored rows, so a pot funded entirely that way read
 * "nothing moves into this account" while three hundred pounds a month arrived.
 */
describe("AccountMovements — the movements nobody authored", () => {
  const derivedPlan = (over: Partial<AccountPlanDto> = {}): AccountPlanDto =>
    ({
      accountId: "pot",
      currency: "GBP",
      monthlyIncomeMinor: 0,
      totalRequiredMinor: 30_320,
      totalFundedMinor: 30_320,
      allocatedInflowMinor: 30_320,
      confirmedInflowMinor: 0,
      outboundInflowMinor: 0,
      residualMinor: 0,
      inflowArrivals: [],
      inflowSources: [
        {
          kind: "member",
          memberUserId: "me",
          displayName: "Ben",
          fromAccountId: "current",
          amountMinor: 30_320,
          confirmedMinor: 0,
        },
      ],
      ...over,
    }) as AccountPlanDto;

  it("lists the derived feed arriving, with no edit or remove on it", async () => {
    // Nobody authored it, so there is no row to change and none to delete. The
    // one thing there *is* to do about it — say you moved it — needs to know who
    // is asking, and this render stubs no `/auth/me`.
    renderFor(POT, {}, { plan: derivedPlan() });

    const row = await screen.findByText("derived transfer");
    const item = row.closest("li")!;
    expect(item).toHaveTextContent("£303.20");
    expect(item).toHaveTextContent("Ben →");
    expect(within(item).queryByRole("button", { name: "edit" })).toBeNull();
    expect(within(item).queryByRole("button", { name: "✕" })).toBeNull();
    expect(screen.getByText(/the plan derives this for the bills here/)).toBeInTheDocument();
  });

  /**
   * Defect 1: the transfer with no client that could reach it.
   *
   * `POST /accounts/:id/transfers/confirm` is scoped by the two accounts, the
   * month and the member — and the account plan's `inflowSources` named the
   * member without ever saying which account they send from, so the one screen
   * that draws the row had nothing to post. The wire carries `fromAccountId`
   * now, and this is the button.
   */
  describe("saying you moved one, and taking it back", () => {
    const MONTH = new Date().toISOString().slice(0, 7);
    const CONFIRMATION = {
      id: "conf-1",
      householdId: null,
      inflowId: null,
      month: `${MONTH}-01`,
      fromAccountId: "current",
      toAccountId: "pot",
      memberUserId: "me",
      amountMinor: 30_320,
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const mine = {
      "GET /api/auth/me": { body: { id: "me", email: "b@example.com", displayName: "Ben" } },
      [`GET /api/accounts/pot/transfers/confirmations?month=${MONTH}`]: { body: [] },
    };

    it("posts the confirmation the endpoint is keyed on", async () => {
      renderFor(
        POT,
        {
          ...mine,
          [`POST /api/accounts/pot/transfers/confirm?month=${MONTH}`]: {
            status: 201,
            body: { confirmation: CONFIRMATION, contributions: [] },
          },
        },
        { plan: derivedPlan() },
      );

      fireEvent.click(await screen.findByRole("button", { name: "moved" }));
      await waitFor(() =>
        expect(stub.calls(`POST /api/accounts/pot/transfers/confirm?month=${MONTH}`)).toBe(1),
      );
      expect(stub.bodyOf(`POST /api/accounts/pot/transfers/confirm?month=${MONTH}`)).toEqual({
        fromAccountId: "current",
        toAccountId: "pot",
        memberUserId: "me",
      });
    });

    it("offers the undo once one is recorded, and drops it", async () => {
      renderFor(
        POT,
        {
          ...mine,
          [`GET /api/accounts/pot/transfers/confirmations?month=${MONTH}`]: {
            body: [CONFIRMATION],
          },
          "DELETE /api/accounts/pot/transfers/confirmations/conf-1": { status: 204 },
        },
        { plan: derivedPlan({ confirmedInflowMinor: 30_320 }) },
      );

      fireEvent.click(await screen.findByRole("button", { name: "undo" }));
      await waitFor(() =>
        expect(stub.calls("DELETE /api/accounts/pot/transfers/confirmations/conf-1")).toBe(1),
      );
    });

    it("offers nothing on somebody else's transfer", async () => {
      // A household's transfers are ticked on the household's own checklist,
      // which knows who may tick for whom; this endpoint refuses anyone else's.
      renderFor(
        POT,
        {
          ...mine,
          "GET /api/auth/me": {
            body: { id: "someone-else", email: "a@example.com", displayName: "Alex" },
          },
        },
        { plan: derivedPlan() },
      );

      await screen.findByText("derived transfer");
      expect(screen.queryByRole("button", { name: "moved" })).toBeNull();
    });
  });

  it("stops claiming nothing moves in, and says the narrower true thing instead", async () => {
    renderFor(POT, {}, { plan: derivedPlan() });
    await screen.findByText("derived transfer");
    expect(screen.queryByText(/nothing moves into this account/)).toBeNull();
    expect(screen.getByText(/nothing you authored/)).toBeInTheDocument();
  });

  it("says the derived transfers leaving a member's own account, which left over already lost", async () => {
    // £1,000 in, £220 of it derived away to the household's bills pot, £780
    // actually staying. Nothing authored anywhere. The £220 is read off
    // `transferOutMinor`, not inferred from the residual — the other figures
    // still balance it, and the row no longer depends on their doing so.
    renderFor(
      CURRENT,
      {},
      {
        plan: derivedPlan({
          accountId: "current",
          monthlyIncomeMinor: 100_000,
          totalRequiredMinor: 0,
          totalFundedMinor: 0,
          allocatedInflowMinor: 0,
          outboundInflowMinor: 0,
          transferOutMinor: 22_000,
          residualMinor: 78_000,
          inflowSources: [],
        }),
      },
    );

    const row = await screen.findByText("derived transfer");
    const item = row.closest("li")!;
    expect(item).toHaveTextContent("£220.00");
    expect(item).toHaveTextContent("→ your bills");
    expect(screen.getByText(/already taken out of left over above/)).toBeInTheDocument();
  });
});

/**
 * Decision 12, as the screen says it. A £400 bill in a pot with a £400 authored
 * movement into it is neither short nor double-funded: the pass derives £400 to
 * cover the bill and lands the movement on top as savings, so £800 arrives and
 * £400 stays. The flag offers deletion of the redundant row — it never warns of
 * a shortfall, because there is not one.
 */
describe("AccountMovements — a movement that duplicates the derived feed", () => {
  const bothPlan = {
    accountId: "pot",
    currency: "GBP",
    monthlyIncomeMinor: 0,
    totalRequiredMinor: 40_000,
    totalFundedMinor: 40_000,
    // £400 derived for the bill, £400 the user authored on top.
    allocatedInflowMinor: 80_000,
    confirmedInflowMinor: 0,
    outboundInflowMinor: 0,
    residualMinor: 40_000,
    inflowArrivals: [{ inflowId: "inf-1", fromAccountId: "current", amountMinor: 40_000 }],
    inflowSources: [
      {
        kind: "member",
        memberUserId: "me",
        displayName: "Ben",
        amountMinor: 40_000,
        confirmedMinor: 0,
      },
    ],
  } as AccountPlanDto;

  it("names the derived half and offers deletion of the authored one", async () => {
    renderFor(
      POT,
      { "GET /api/accounts/pot/inflows": { body: [movement({ id: "inf-1", accountId: "pot" })] } },
      { plan: bothPlan },
    );

    expect(
      await screen.findByText(
        /a month already arrives here as a transfer the plan derives for these bills/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/if it was meant to cover the bills, delete it/)).toBeInTheDocument();
    // The action it offers is the remove button already on the authored row.
    const authored = screen.getByText("Monthly top-up").closest("li")!;
    expect(within(authored).getByRole("button", { name: "✕" })).toBeInTheDocument();
  });

  it("says nothing about a shortfall, because the plan funds both", async () => {
    renderFor(
      POT,
      { "GET /api/accounts/pot/inflows": { body: [movement({ id: "inf-1", accountId: "pot" })] } },
      { plan: bothPlan },
    );
    await screen.findByText(/a month already arrives here/);
    expect(screen.queryByText(/short/i)).toBeNull();
  });

  it("stays quiet when only one of the two feeds an account", async () => {
    // Derived only.
    renderFor(POT, {}, { plan: { ...bothPlan, allocatedInflowMinor: 40_000, inflowArrivals: [] } });
    await screen.findByText("derived transfer");
    expect(screen.queryByText(/a month already arrives here/)).toBeNull();
  });
});
