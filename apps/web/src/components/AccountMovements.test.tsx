import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/**
 * Everything the section fetches on mount, arrived and rendered.
 *
 * Five requests go out when it mounts — the account list, the rows arriving,
 * the rows leaving, who you are, and this month's confirmations — and a
 * synchronous test body ends before a single one of them lands. React reported
 * all five state updates as unwrapped by `act`, which is how a permanent
 * warning came to sit in the suite; and worse, an assertion made before them is
 * an assertion about the loading state, where "there is nothing on screen"
 * holds whatever the rule underneath it says. Draining them inside `act` is
 * what makes the assertion after it one about the section *with its data* —
 * which is the only version of it worth making.
 *
 * A timer rather than a microtask: each of those five is a fetch, then a body
 * read, then a set-state, so there is a chain to drain and not a tick.
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

    // "arriving here" is a heading the section always draws, so finding it says
    // nothing about the rows underneath it having landed — and "Salary is not in
    // this list" is true of a list with nothing in it.
    await mounted();
    const arriving = screen.getByText("arriving here").closest("div")!.parentElement!;
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
      // Answering as the server would — the row is gone once it has been
      // deleted — so the assertion below can be the row leaving rather than the
      // request being sent. A request has gone out well before the refetch
      // behind it has come back, and waiting on the count settles for the first
      // of those and leaves the second to land after the test.
      "GET /api/accounts/pot/inflows": () => ({
        body: [
          movement({ id: "mine", accountId: "pot", sourceAccountId: "current" }),
          ...(stub.calls("DELETE /api/inflows/theirs") > 0
            ? []
            : [
                movement({
                  id: "theirs",
                  accountId: "pot",
                  sourceAccountId: "theirs",
                  name: "Their gift",
                }),
              ]),
        ],
      }),
      "DELETE /api/inflows/theirs": { status: 204 },
    });

    const rows = await screen.findAllByRole("listitem");
    const [mine, theirs] = rows.map((row) => within(row));
    expect(mine!.getByRole("button", { name: "edit" })).toBeEnabled();
    // Edit access on the far end is what changing it takes; removing it is not.
    expect(theirs!.getByRole("button", { name: "edit" })).toBeDisabled();

    fireEvent.click(theirs!.getByRole("button", { name: "✕" }));
    await waitFor(() => expect(screen.queryByText("Their gift")).toBeNull());
    expect(stub.calls("DELETE /api/inflows/theirs")).toBe(1);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("shows nothing at all to somebody who can only look, and has nothing to look at", async () => {
    renderFor(POT, {}, { canEdit: false });
    // The rule is about what the lists say once they have arrived. Asserted
    // before they do, it was a claim about an empty first paint.
    await mounted();
    expect(screen.queryByText("movements")).toBeNull();
  });

  it("shows the same viewer the section the moment there is one thing in it", async () => {
    // The other half of the rule, and what proves the lists above really had
    // landed: nothing is hidden from a viewer except an empty section.
    renderFor(
      POT,
      { "GET /api/accounts/pot/inflows": { body: [movement({ id: "in-1", accountId: "pot" })] } },
      { canEdit: false },
    );
    expect(await screen.findByText("movements")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "edit" })).toBeNull();
  });
});

describe("AccountMovements — authoring", () => {
  /** Opens the drawer from one side or the other. */
  async function openDrawer(target: AccountDto, label: string, routes: Routes = {}) {
    renderFor(target, routes);
    // The drawer's account picker is the accounts fetch's product. Opening it
    // before that lands gives a select with nothing in it but the placeholder,
    // which is a different screen from the one these tests mean to assert on.
    await mounted();
    fireEvent.click(screen.getAllByRole("button", { name: `${label} →` })[0]!);
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

  it("asks the owner to consolidate, never the reader, on an account that is not theirs", () => {
    // The same diagnosis, and a different person being asked to act on it. This
    // page renders on an account a co-member shared to you, where "consolidate
    // your income here first" is an instruction about somebody else's money in
    // a place this reader may not even edit (decision 20).
    expect(
      outboundNote(
        { outboundInflowMinor: 90_000, residualMinor: -20_000 } as AccountPlanDto,
        SHARED_VIEW,
      ),
    ).toEqual([
      { minor: 90_000, currency: "GBP" },
      " a month is already committed to leave.",
      " that is ",
      { minor: 20_000, currency: "GBP" },
      " more than reaches this account — its owner has to consolidate their income here first, or the month cannot happen.",
    ]);
    // Ownership, never access: an account shared to you with `edit` is still not
    // yours, and an absent `owner` cannot say that it is.
    expect(
      outboundNote({ outboundInflowMinor: 90_000, residualMinor: -20_000 } as AccountPlanDto, {
        ...SHARED_VIEW,
        permission: "edit",
      }),
    ).toContainEqual(
      " more than reaches this account — its owner has to consolidate their income here first, or the month cannot happen.",
    );
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
    // "movements" is the section's own heading, up from the first paint. The
    // loop note is not: it names its accounts out of the accounts fetch, so
    // before that answers there is no loop note to find whatever the plan says.
    await mounted();
    expect(screen.getByText("movements")).toBeInTheDocument();
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
    ).toBe(
      "priority only means something for money sourced from an account — an inflow from outside has no sending account to rank it against.",
    );
  });

  /**
   * **The sentence was wrong about behaviour, not only about words.**
   *
   * It read "priority only means something for money moving between your own
   * accounts". The API's rule is `inflow.source !== "account"` — where the money
   * comes from, never who owns the two ends. A movement out of a co-member's
   * account you hold `edit` on is account-sourced like any other and its
   * priority genuinely ranks it among everything else leaving that account, so
   * the old copy told a person a real ordering was inert. Ownership must not
   * come back into it.
   */
  it("does not tell you priority is inert for a movement crossing an owner", () => {
    const said = movementError(
      err(422, "priority is meaningful only for an account-sourced inflow"),
    );
    expect(said).not.toMatch(/your own|yours|own accounts/i);
    expect(said).toMatch(/sourced from an account/i);
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

    await mounted();
    const item = screen.getByText("derived transfer").closest("li")!;
    expect(item).toHaveTextContent("£303.20");
    expect(item).toHaveTextContent("Ben →");
    expect(within(item).queryByRole("button", { name: "edit" })).toBeNull();
    expect(within(item).queryByRole("button", { name: "✕" })).toBeNull();
    expect(screen.getByText(/the plan derives this for the bills here/)).toBeInTheDocument();
  });

  /**
   * The row that told the reader who they were, and got it wrong.
   *
   * Decision 42 stopped the server publishing a name for somebody no household
   * in the scope rosters — and an outsider whose current account feeds a pot
   * they can see is precisely that, so their *own* feed arrived here with no
   * name on it and the fallback called them "a household member". The client
   * has held their name since login; the row is compared against the same
   * `/api/auth/me` the tick button is already keyed on.
   */
  describe("naming the reader to themselves", () => {
    const unnamed = derivedPlan({
      inflowSources: [
        {
          kind: "member",
          memberUserId: "outsider",
          fromAccountId: "current",
          amountMinor: 30_320,
          confirmedMinor: 0,
        },
      ],
    });

    it("says 'you' when the unnamed feed is the reader's own", async () => {
      renderFor(
        POT,
        {
          "GET /api/auth/me": {
            body: { id: "outsider", email: "o@example.com", displayName: "Olive" },
          },
        },
        { plan: unnamed },
      );

      await mounted();
      const item = screen.getByText("derived transfer").closest("li")!;
      expect(item).toHaveTextContent("you →");
      expect(item).not.toHaveTextContent("a household member");
    });

    it("still anonymises that same feed for anybody else — decision 41", async () => {
      renderFor(
        POT,
        {
          "GET /api/auth/me": { body: { id: "me", email: "b@example.com", displayName: "Ben" } },
        },
        { plan: unnamed },
      );

      await mounted();
      const item = screen.getByText("derived transfer").closest("li")!;
      expect(item).toHaveTextContent("a household member →");
      // Never the id, and never a name the server declined to send.
      expect(item).not.toHaveTextContent("outsider");
      expect(item).not.toHaveTextContent("Olive");
    });
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

    /**
     * The month's confirmations, answering as the server would: whatever the
     * ticking and un-ticking so far has left. So the assertion each of these
     * tests waits on is the button changing what it offers, which is the whole
     * path — the request, the refetch behind it, and the row coming out of its
     * busy state. Waiting on the request count instead settles the moment it is
     * *sent*, and everything after that lands once the test is over.
     */
    it("posts the confirmation the endpoint is keyed on", async () => {
      renderFor(
        POT,
        {
          ...mine,
          [`GET /api/accounts/pot/transfers/confirmations?month=${MONTH}`]: () => ({
            body:
              stub.calls(`POST /api/accounts/pot/transfers/confirm?month=${MONTH}`) > 0
                ? [CONFIRMATION]
                : [],
          }),
          [`POST /api/accounts/pot/transfers/confirm?month=${MONTH}`]: {
            status: 201,
            body: { confirmation: CONFIRMATION, contributions: [] },
          },
        },
        { plan: derivedPlan() },
      );

      fireEvent.click(await screen.findByRole("button", { name: "moved" }));
      // Ticked, and now offering to un-tick it.
      expect(await screen.findByRole("button", { name: "undo" })).toBeEnabled();
      expect(stub.calls(`POST /api/accounts/pot/transfers/confirm?month=${MONTH}`)).toBe(1);
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
          [`GET /api/accounts/pot/transfers/confirmations?month=${MONTH}`]: () => ({
            body: stub.calls("DELETE /api/accounts/pot/transfers/confirmations/conf-1")
              ? []
              : [CONFIRMATION],
          }),
          "DELETE /api/accounts/pot/transfers/confirmations/conf-1": { status: 204 },
        },
        { plan: derivedPlan({ confirmedInflowMinor: 30_320 }) },
      );

      fireEvent.click(await screen.findByRole("button", { name: "undo" }));
      // Un-ticked, and back to asking whether you moved it.
      expect(await screen.findByRole("button", { name: "moved" })).toBeEnabled();
      expect(stub.calls("DELETE /api/accounts/pot/transfers/confirmations/conf-1")).toBe(1);
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

      // The button is drawn only for the member the row belongs to, which is a
      // comparison against `GET /api/auth/me`. "derived transfer" is up before
      // that answers, so the old anchor here was satisfied by the plan and the
      // fetch was drained only by accident — `findBy*` polls, and the poll
      // happened to outlast the request. Measured, not assumed: point this stub
      // at *me* and the old form does fail, so it was incidental rather than
      // broken. Draining on purpose is what stops it depending on that.
      await mounted();
      expect(screen.getByText("derived transfer")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "moved" })).toBeNull();
      // …and says so. A row with no control and no account of why is the thing
      // this section was reported for.
      expect(screen.getByText(/to record/)).toBeInTheDocument();
    });
  });

  /**
   * Defect 2: the row an owner could act on everywhere but here.
   *
   * A household pot's account page drew its co-member's derived transfer with no
   * button and no sentence — while the household's own checklist offered exactly
   * that action, and `POST /households/:id/transfers/confirm` granted it. The
   * gate here had one rule for two endpoints: `POST /accounts/:id/transfers/
   * confirm` really does refuse anybody else's, because a scope with no
   * household in it has no roster to make anyone an admin — but a **household**
   * transfer is ticked through the household, which keeps decision 28's other
   * half: the member themselves, **or an owner or admin of that household**.
   *
   * Which household is the part the account plan never says. `AccountPlanDto`
   * carries no household id and neither does `AccountDto`; what the wire does
   * carry is the reader's own membership list, and a `member` source naming
   * somebody *else* — which `planInflowSources` publishes only to a member of
   * the household the account is planned in. So the roster that holds that
   * member is the household, and `yourRole` arrives on the same read.
   */
  describe("a co-member's transfer, and who may tick it", () => {
    const MONTH = new Date().toISOString().slice(0, 7);
    const HH = "hh-1";

    /** The pot two members feed: the reader's own transfer and their mate's. */
    const shared = derivedPlan({
      inflowSources: [
        {
          kind: "member",
          memberUserId: "me",
          displayName: "Ben",
          fromAccountId: "current",
          amountMinor: 9_000,
          confirmedMinor: 0,
        },
        {
          kind: "member",
          memberUserId: "mate",
          displayName: "Mate",
          fromAccountId: "theirs",
          amountMinor: 9_000,
          confirmedMinor: 0,
        },
      ],
    });

    const HOUSEHOLD_CONFIRMATION = {
      id: "hh-conf-1",
      householdId: HH,
      inflowId: null,
      month: `${MONTH}-01`,
      fromAccountId: "theirs",
      toAccountId: "pot",
      memberUserId: "mate",
      amountMinor: 9_000,
      createdAt: "2026-08-01T00:00:00.000Z",
    };

    /** Who is asking, and the one household they are in. */
    const asMe = (role: "owner" | "admin" | "member") => ({
      "GET /api/auth/me": {
        body: {
          id: "me",
          email: "b@example.com",
          displayName: "Ben",
          households: [{ id: HH, name: "Ledger House" }],
        },
      },
      [`GET /api/auth/households/${HH}`]: {
        body: {
          id: HH,
          name: "Ledger House",
          createdAt: "2026-08-01T00:00:00.000Z",
          yourRole: role,
          members: [
            {
              membershipId: "m1",
              userId: "me",
              role,
              shareBp: 5000,
              displayName: "Ben",
              email: "b@example.com",
              isSelf: true,
            },
            {
              membershipId: "m2",
              userId: "mate",
              role: "member",
              shareBp: 5000,
              displayName: "Mate",
              email: "m@example.com",
              isSelf: false,
            },
          ],
          shares: [],
        },
      },
      [`GET /api/accounts/pot/transfers/confirmations?month=${MONTH}`]: { body: [] },
      [`GET /api/households/${HH}/transfers/confirmations?month=${MONTH}`]: { body: [] },
    });

    /** The mate's row, found by the name the arrow prints. */
    const mateRow = (): HTMLElement => screen.getByText("Mate →").closest("li")!;

    it("lets an owner say a co-member's transfer moved, through the household that derives it", async () => {
      renderFor(
        POT,
        {
          ...asMe("owner"),
          [`GET /api/households/${HH}/transfers/confirmations?month=${MONTH}`]: () => ({
            body:
              stub.calls(`POST /api/households/${HH}/transfers/confirm`) > 0
                ? [HOUSEHOLD_CONFIRMATION]
                : [],
          }),
          [`POST /api/households/${HH}/transfers/confirm`]: {
            status: 201,
            body: { confirmation: HOUSEHOLD_CONFIRMATION, contributions: [] },
          },
        },
        { plan: shared },
      );

      await mounted();
      fireEvent.click(within(mateRow()).getByRole("button", { name: "moved" }));
      // Recorded, and now offering to take it back.
      await waitFor(() =>
        expect(within(mateRow()).getByRole("button", { name: "undo" })).toBeEnabled(),
      );
      expect(stub.calls(`POST /api/households/${HH}/transfers/confirm`)).toBe(1);
      expect(stub.bodyOf(`POST /api/households/${HH}/transfers/confirm`)).toEqual({
        fromAccountId: "theirs",
        toAccountId: "pot",
        memberUserId: "mate",
        month: MONTH,
      });
      // Never the account route, which would refuse it — and refuse it with a
      // 403 the row could do nothing about.
      expect(stub.calls(`POST /api/accounts/pot/transfers/confirm?month=${MONTH}`)).toBe(0);
    });

    it("and take it back again — decision 28, the same people either way", async () => {
      renderFor(
        POT,
        {
          ...asMe("admin"),
          [`GET /api/households/${HH}/transfers/confirmations?month=${MONTH}`]: () => ({
            body: stub.calls(`DELETE /api/households/${HH}/transfers/confirmations/hh-conf-1`)
              ? []
              : [HOUSEHOLD_CONFIRMATION],
          }),
          [`DELETE /api/households/${HH}/transfers/confirmations/hh-conf-1`]: { status: 204 },
        },
        { plan: shared },
      );

      await mounted();
      fireEvent.click(within(mateRow()).getByRole("button", { name: "undo" }));
      await waitFor(() =>
        expect(within(mateRow()).getByRole("button", { name: "moved" })).toBeEnabled(),
      );
      expect(stub.calls(`DELETE /api/households/${HH}/transfers/confirmations/hh-conf-1`)).toBe(1);
    });

    it("offers a plain member nothing on a co-member's row, and says whose it is", async () => {
      renderFor(POT, { ...asMe("member") }, { plan: shared });

      await mounted();
      const row = mateRow();
      expect(within(row).queryByRole("button", { name: "moved" })).toBeNull();
      expect(within(row).queryByRole("button", { name: "undo" })).toBeNull();
      expect(row).toHaveTextContent(/Mate's to record/);
      // A member who may not act for anybody is never charged for the list they
      // could not act on.
      expect(stub.calls(`GET /api/households/${HH}/transfers/confirmations?month=${MONTH}`)).toBe(
        0,
      );
    });

    it("will not re-record a transfer the member already ticked on their own", async () => {
      // Their own account page files it with no household on it, and that route
      // un-ticks only for the member who made it. Offering "moved" here would
      // post a second confirmation and book the month's contributions twice.
      renderFor(
        POT,
        {
          ...asMe("owner"),
          [`GET /api/accounts/pot/transfers/confirmations?month=${MONTH}`]: {
            body: [
              {
                id: "solo-conf-1",
                householdId: null,
                inflowId: null,
                month: `${MONTH}-01`,
                fromAccountId: "theirs",
                toAccountId: "pot",
                memberUserId: "mate",
                amountMinor: 9_000,
                createdAt: "2026-08-01T00:00:00.000Z",
              },
            ],
          },
        },
        { plan: shared },
      );

      await mounted();
      const row = mateRow();
      expect(within(row).queryByRole("button", { name: "moved" })).toBeNull();
      expect(row).toHaveTextContent(/only they can undo it/);
    });

    it("leaves the reader's own row on the route with no household in it", async () => {
      renderFor(
        POT,
        {
          ...asMe("owner"),
          [`POST /api/accounts/pot/transfers/confirm?month=${MONTH}`]: {
            status: 201,
            body: { confirmation: { id: "solo" }, contributions: [] },
          },
        },
        { plan: shared },
      );

      await mounted();
      const mine = screen.getByText("Ben →").closest("li")!;
      fireEvent.click(within(mine).getByRole("button", { name: "moved" }));
      await waitFor(() =>
        expect(stub.calls(`POST /api/accounts/pot/transfers/confirm?month=${MONTH}`)).toBe(1),
      );
      expect(stub.calls(`POST /api/households/${HH}/transfers/confirm`)).toBe(0);
    });
  });

  it("stops claiming nothing moves in, and says the narrower true thing instead", async () => {
    renderFor(POT, {}, { plan: derivedPlan() });
    // Which of the two sentences the arriving list shows turns on whether it has
    // any authored rows, and that is the fetch's answer — asserted before it
    // lands, both sentences are being read off a list that is merely empty.
    await mounted();
    expect(screen.getByText("derived transfer")).toBeInTheDocument();
    expect(screen.queryByText(/nothing moves into this account/)).toBeNull();
    expect(screen.getByText(/nothing you authored/)).toBeInTheDocument();
  });

  it("says the derived transfers leaving a member's own account, which left over already lost", async () => {
    // £1,000 in, £220 of it derived away to the household's bills pot, £780
    // actually staying. Nothing authored anywhere. The £220 is read off
    // `transferDepartures`, not inferred from the residual — the other figures
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
          transferDepartures: [
            {
              toAccountId: "pot",
              memberUserId: "me",
              amountMinor: 22_000,
              confirmedMinor: 0,
              toAccountName: "Holiday pot",
            },
          ],
          residualMinor: 78_000,
          inflowSources: [],
        }),
      },
    );

    await mounted();
    const item = screen.getByText("derived transfer").closest("li")!;
    expect(item).toHaveTextContent("£220.00");
    expect(item).toHaveTextContent("→ Holiday pot");
    expect(screen.getByText(/already taken out of left over above/)).toBeInTheDocument();
  });
});

/**
 * The defect the repo owner found on the deployed build.
 *
 * "leaving here [1] · derived transfer — £2,585.84 / monthly → your bills" was
 * three transfers — a bills pot and two shared pots — summed into one row, with
 * a label invented for a far end that was a *set* of accounts and a settled
 * state hardcoded to `false`. It passed five audits and every test because no
 * fixture had more than one destination.
 *
 * So this one has three, of three different amounts, in three different states:
 * moved, part-moved, and untouched.
 */
describe("AccountMovements — one row per destination, not one row for the lot", () => {
  const THREE: AccountPlanDto = {
    accountId: "current",
    asOfDate: "2026-08-05",
    currency: "GBP",
    monthlyIncomeMinor: 400_000,
    bufferMinor: 0,
    totalRequiredMinor: 0,
    totalFundedMinor: 0,
    shortfallMinor: 0,
    lines: [],
    contributionsMTD: [],
    latestBalance: null,
    reservedMinor: 0,
    allocatedInflowMinor: 0,
    confirmedInflowMinor: 0,
    outboundInflowMinor: 0,
    leftoverMinor: 141_416,
    residualMinor: 141_416,
    inflowArrivals: [],
    inflowSources: [],
    transferOutMinor: 258_584,
    transferDepartures: [
      {
        toAccountId: "bills",
        memberUserId: "me",
        amountMinor: 158_584,
        confirmedMinor: 158_584,
        toAccountName: "Joint bills",
      },
      {
        toAccountId: "shared-1",
        memberUserId: "me",
        amountMinor: 70_000,
        confirmedMinor: 20_000,
        toAccountName: "House fund",
      },
      {
        toAccountId: "shared-2",
        memberUserId: "me",
        amountMinor: 30_000,
        confirmedMinor: 0,
        toAccountName: "Car pot",
      },
    ],
  };

  const rows = (): HTMLElement[] => {
    const leaving = screen.getByText("leaving here").closest("div")!.parentElement!;
    return within(leaving)
      .getAllByText("derived transfer")
      .map((n) => n.closest("li")!);
  };

  it("names each destination and gives it its own amount", async () => {
    renderFor(CURRENT, {}, { plan: THREE });
    await mounted();

    const items = rows();
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("£1,585.84");
    expect(items[0]).toHaveTextContent("→ Joint bills");
    expect(items[1]).toHaveTextContent("£700.00");
    expect(items[1]).toHaveTextContent("→ House fund");
    expect(items[2]).toHaveTextContent("£300.00");
    expect(items[2]).toHaveTextContent("→ Car pot");
    // The count in the heading counts them, so the list and its label agree.
    const leaving = screen.getByText("leaving here").closest("div")!;
    expect(within(leaving).getByText("[3]")).toBeInTheDocument();
  });

  it("reads each one's own settled state, and never a hardcoded one", async () => {
    renderFor(CURRENT, {}, { plan: THREE });
    await mounted();
    // Fully confirmed reads moved; part-confirmed and unconfirmed do not. The
    // old row said "derived" for every destination whatever anyone had ticked,
    // because a scalar has no confirmation of its own.
    expect(rows().map((li) => within(li).getByText(/^(moved|derived)$/).textContent)).toEqual([
      "moved",
      "derived",
      "derived",
    ]);
  });

  it("reflects the tick and does not offer it", async () => {
    // Confirming is nested under the *receiving* account and takes edit there.
    // This page's `canEdit` is about the account being shown, so a button here
    // would be a control whose authorisation the page cannot evaluate — and for
    // a household pot, a roster-blind second route to a fact the household
    // checklist governs.
    renderFor(
      CURRENT,
      { "GET /api/auth/me": { body: { id: "me", email: "b@example.com", displayName: "Ben" } } },
      { plan: THREE, canEdit: true },
    );
    // This render stubs `/api/auth/me` as the member every one of the three rows
    // belongs to, which is the only way "no button" says anything: before that
    // answers, no row anywhere has a settle button to offer.
    await mounted();
    for (const li of rows()) {
      expect(within(li).queryByRole("button", { name: "moved" })).toBeNull();
      expect(within(li).queryByRole("button", { name: "undo" })).toBeNull();
    }
  });

  it("calls a destination it cannot see 'another account', and still prints the amount", async () => {
    // The gate is on names and only on names: the amount is a fact about an
    // account the caller is already looking at.
    renderFor(
      CURRENT,
      {},
      {
        plan: {
          ...THREE,
          transferDepartures: [
            { toAccountId: "hidden", memberUserId: "me", amountMinor: 70_000, confirmedMinor: 0 },
          ],
        },
      },
    );
    // Not the fetch, as it turns out. A derived *departure* is named by
    // `toAccountName` off the plan (`derivedDepartures`), never through the
    // accounts list — so unlike the arriving side, which resolves its far end
    // through `GET /api/accounts`, nothing here is gated on a fetch at all and
    // this test never raced one. Draining anyway, so the row is asserted on a
    // settled screen and the two sides of this file read the same way.
    await mounted();
    const item = screen.getByText("derived transfer").closest("li")!;
    expect(item).toHaveTextContent("→ another account");
    expect(item).toHaveTextContent("£700.00");
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

    // The note is a function of the plan prop and is on screen from the first
    // paint, so waiting on it waits for nothing. The authored row it talks about
    // arrives from `GET …/inflows`, which is what has to have landed.
    await mounted();
    expect(screen.getByText("Monthly top-up")).toBeInTheDocument();

    expect(
      screen.getByText(
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
    // "Nothing says short" is true of a screen with nothing on it, so the
    // authored row has to be up before it means anything.
    await mounted();
    expect(screen.getByText("Monthly top-up")).toBeInTheDocument();
    expect(screen.getByText(/a month already arrives here/)).toBeInTheDocument();
    expect(screen.queryByText(/short/i)).toBeNull();
  });

  /**
   * The note claimed an author it never knew, and offered an action that was
   * not on the page.
   *
   * An inflow belongs to a pair of accounts and carries no author; authoring one
   * takes `edit` on both ends. So on a pot a co-member shared to you, "a
   * movement **you** authored" may be describing their movement out of their
   * account — and "delete it" points at a ✕ that `MovementList` does not draw
   * for a reader who cannot edit this account.
   */
  it("claims no author and offers no deletion on an account you may only look at", async () => {
    renderFor(
      SHARED_VIEW,
      {
        "GET /api/accounts/theirs/inflows": {
          body: [movement({ id: "inf-1", accountId: "theirs" })],
        },
      },
      { plan: { ...bothPlan, accountId: "theirs" }, canEdit: false },
    );

    // Both halves of this test are about the authored row — what the note says
    // about it, and the button that is not next to it — so both wait on the
    // fetch that brings it, never on the plan-rendered note.
    await mounted();
    expect(screen.getByText("Monthly top-up")).toBeInTheDocument();

    const note = screen.getByText(/a month already arrives here/);
    expect(note).toHaveTextContent(
      /an authored movement lands on top of it as savings, not instead of it\./,
    );
    expect(note).not.toHaveTextContent(/you authored/);
    expect(note).not.toHaveTextContent(/delete it/);
    // And the reason: there is nothing here to delete it with.
    const authored = screen.getByText("Monthly top-up").closest("li")!;
    expect(within(authored).queryByRole("button", { name: "✕" })).toBeNull();
  });

  /**
   * Both halves of "only one of the two", because an absence is the assertion
   * this file gets wrong most easily.
   *
   * The old version of this test waited on "derived transfer" — a row the `plan`
   * prop renders synchronously — and then asserted the note was absent. Every
   * term in it was a fact about the props, so it held at the first paint and
   * would have gone on holding it if `GET …/inflows` had never answered at all.
   * The authored-only half below is the one that can be nailed to the fetch: its
   * anchor is the row the fetch brings, so withholding that row fails it.
   */
  it("stays quiet when only the derived feed arrives", async () => {
    renderFor(POT, {}, { plan: { ...bothPlan, allocatedInflowMinor: 40_000, inflowArrivals: [] } });
    // Nothing the fetch returns is on screen in this direction — it returns no
    // rows — so draining it is the only way to tell "the authored list is empty"
    // from "the authored list has not answered yet".
    await mounted();
    expect(screen.getByText("derived transfer")).toBeInTheDocument();
    expect(screen.queryByText(/a month already arrives here/)).toBeNull();
  });

  it("stays quiet when only the authored movement arrives", async () => {
    renderFor(
      POT,
      { "GET /api/accounts/pot/inflows": { body: [movement({ id: "inf-1", accountId: "pot" })] } },
      { plan: { ...bothPlan, allocatedInflowMinor: 40_000, inflowSources: [] } },
    );
    // The row is on screen only once `GET …/inflows` has answered, so the
    // absence below is read off the settled screen rather than the empty one.
    expect(await screen.findByText("Monthly top-up")).toBeInTheDocument();
    expect(screen.queryByText(/a month already arrives here/)).toBeNull();
  });
});
