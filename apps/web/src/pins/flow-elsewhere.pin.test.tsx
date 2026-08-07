import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../contexts/PrivacyContext.js";
import { api } from "../lib/api.js";
import type { AccountDto, FlowDto, HouseholdPlanDto, UserDto } from "../lib/types.js";
import { FlowPage } from "../pages/FlowPage.js";

/**
 * **Red pin — issue #43. Flipped by WP-AS.**
 *
 * > The household diagram draws money leaving one of its own accounts for
 * > nowhere, and the same money arriving at another of them from nowhere.
 *
 * `FlowPage.tsx:57` answers `?household=` with
 * `api.householdPlan(householdId).then(householdFlow)` — the page reshapes a
 * plan it already has instead of asking the server the question the server
 * already answers movement by movement. `householdFlow`
 * (`apps/web/src/lib/flow.ts:68`) has no row for an authored movement, only the
 * per-account `committedMinor` and `movementInMinor` buckets, so it puts both
 * ends into `elsewhere`: the leaving half at `flow.ts:104-114` and the arriving
 * half at `flow.ts:117-127`. `FlowSankey` names that end `OFF_PICTURE =
 * "elsewhere"`.
 *
 * The module comment says so on purpose (`flow.ts:35-44`):
 *
 * > *"So the money committed to savings leaves for `elsewhere`, and the money
 * > authored movements delivered arrives from `elsewhere`, both with no far end
 * > named. […] both halves are true and the node balances, which is the
 * > property that matters."*
 *
 * Both halves are true and the picture is still wrong. The reader is looking at
 * a household whose two accounts are both on the screen, and being told the
 * money went somewhere else. Decision 31 settles it: `householdFlow` is
 * **deleted**, not patched — the two-engine split is what `ONE-ENGINE.md` exists
 * to end, and a second derivation documented as deliberate is still a second
 * derivation.
 *
 * The plan's standing assumption, drawn:
 *
 * > **that writing a record and the event it records are the same fact.**
 *
 * A household plan records what each account *committed* and what each account
 * *received*. The page reads those two records back as two events — a departure
 * and an arrival, off opposite edges of the picture — when they are one
 * movement with both ends already on screen.
 *
 * ## Where this pin reaches, and why there
 *
 * A Sankey is SVG inside a `ResponsiveContainer`, which measures zero in jsdom,
 * so no ribbon is readable in the DOM — `HouseholdSankey.test.tsx` asserts on
 * the units toggle and nothing else for exactly that reason. So the picture is
 * captured where it is handed over: the `FlowDto` the page gives `FlowSankey`.
 *
 * That is deliberately **not** `householdFlow`, which WP-AS deletes. This pin
 * has to survive the change that flips it, so it asks the page for a household
 * and reads what the page decided to draw — true before the refactor and after
 * it. The fetch stub below is prefix-matched rather than keyed on exact URLs,
 * so whichever endpoint WP-AS decides the page should ask, it is answered from
 * this one household and the assertion is untouched.
 *
 * ## The shape this fixture refuses to avoid
 *
 * **An authored movement between two accounts that are both in the picture.**
 * Every household fixture in the tree feeds its pot by a *derived* transfer,
 * which `HouseholdPlan.transfers` itemises and `householdFlow` therefore draws
 * as a real ribbon — the one case where the code is right. The defect needs the
 * other kind: money the user authored themselves, which a household plan
 * reports only as one anonymous bucket at each end. A second current account
 * that has nothing to do with any of it is there for the same reason it is on
 * Ben's screen: to make it obvious that both far ends were available to name.
 *
 * ## Observed on `76ee2f2`
 *
 * Alice sweeps £500.00 a month into the household's holiday pot. What the page
 * handed the diagram:
 *
 * | ribbon                        | minor    | GBP        |
 * | ----------------------------- | -------- | ---------- |
 * | `alice-cur → (elsewhere)`      | 50_000   | £500.00    |
 * | `(elsewhere) → holiday`        | 50_000   | £500.00    |
 * | `alice-cur → holiday`          | —        | **absent** |
 *
 * Two ribbons off the edge of a picture that contained both their ends.
 */

const AS_OF = "2026-08-04";
const HOUSEHOLD = "hh";

/** Alice's monthly sweep into the pot: the movement whose ends go missing. */
const SWEEP_MINOR = 50_000;

const ALICE_CUR = "alice-cur";
const BOB_CUR = "bob-cur";
const HOLIDAY = "holiday";

/**
 * The picture the page hands the diagram, captured as it is handed over.
 *
 * `vi.hoisted` because `vi.mock` factories are lifted above the imports, so the
 * array has to exist before the module graph does. The stand-in renders
 * nothing: this pin is about the model, and the real component's SVG is
 * unreadable in jsdom anyway.
 */
const { drawn } = vi.hoisted(() => ({ drawn: [] as unknown[] }));

vi.mock("../components/FlowSankey.js", () => ({
  FlowSankey: ({ flow }: { flow: unknown }) => {
    drawn.push(flow);
    return <div data-testid="the-diagram" />;
  },
}));

const ME: UserDto = {
  id: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  households: [{ id: HOUSEHOLD, name: "Home" }],
};

const ACCOUNTS: AccountDto[] = [
  { id: ALICE_CUR, name: "alice current" },
  { id: BOB_CUR, name: "bob current" },
  { id: HOLIDAY, name: "holiday" },
].map((a) => ({
  ...a,
  description: null,
  currency: "GBP",
  openingBalanceMinor: 0,
  monthlyBufferMinor: 0,
  owner: true,
  permission: "edit" as const,
}));

/**
 * Two current accounts and a pot, fed by an authored movement out of one of
 * them.
 *
 * No bills anywhere, so the pass derives no transfers at all and `transfers` is
 * empty: the £500 is the only money crossing an account boundary, and it is a
 * movement rather than a transfer. Alice's `leftoverMinor` is the residual
 * *before* the sweep (decision 13), which is why it reads £3,000 against a
 * `committedMinor` of £500.
 */
const HOUSEHOLD_PLAN: HouseholdPlanDto = {
  householdId: HOUSEHOLD,
  asOfDate: AS_OF,
  currency: "GBP",
  monthlyIncomeMinor: 500_000,
  totalRequiredMinor: 0,
  totalFundedMinor: 0,
  leftoverMinor: 500_000,
  committedMinor: SWEEP_MINOR,
  shortfallMinor: 0,
  members: [
    {
      userId: "alice",
      displayName: "Alice",
      shareBp: 6_000,
      monthlyIncomeMinor: 300_000,
      obligationMinor: 0,
      fundedMinor: 0,
      leftoverMinor: 300_000,
      committedMinor: SWEEP_MINOR,
      shortfallMinor: 0,
    },
    {
      userId: "bob",
      displayName: "Bob",
      shareBp: 4_000,
      monthlyIncomeMinor: 200_000,
      obligationMinor: 0,
      fundedMinor: 0,
      leftoverMinor: 200_000,
      shortfallMinor: 0,
    },
  ],
  accounts: [
    {
      accountId: ALICE_CUR,
      name: "alice current",
      role: "personal",
      memberUserId: "alice",
      currency: "GBP",
      monthlyIncomeMinor: 300_000,
      requiredOutflowMinor: 0,
      fundedOutflowMinor: 0,
      transferInMinor: 0,
      transferOutMinor: 0,
      leftoverMinor: 300_000,
      committedMinor: SWEEP_MINOR,
      shortfallMinor: 0,
    },
    {
      accountId: BOB_CUR,
      name: "bob current",
      role: "personal",
      memberUserId: "bob",
      currency: "GBP",
      monthlyIncomeMinor: 200_000,
      requiredOutflowMinor: 0,
      fundedOutflowMinor: 0,
      transferInMinor: 0,
      transferOutMinor: 0,
      leftoverMinor: 200_000,
      shortfallMinor: 0,
    },
    {
      accountId: HOLIDAY,
      name: "holiday",
      role: "shared",
      memberUserId: null,
      currency: "GBP",
      monthlyIncomeMinor: 0,
      requiredOutflowMinor: 0,
      fundedOutflowMinor: 0,
      transferInMinor: 0,
      transferOutMinor: 0,
      movementInMinor: SWEEP_MINOR,
      leftoverMinor: SWEEP_MINOR,
      shortfallMinor: 0,
    },
  ],
  lines: [],
  transfers: [],
};

/**
 * The same household, as `GET /api/flow` already answers it.
 *
 * `api.flow()` itemises movement by movement — `FlowPage.test.tsx:169` carries
 * exactly this shape, an edge with an `inflowId` and both ends named — which is
 * decision 31's whole argument: the answer this page needs already exists on
 * the server and the browser is re-deriving a worse one.
 */
const FLOW: FlowDto = {
  asOfDate: AS_OF,
  currency: "GBP",
  accounts: [
    {
      accountId: ALICE_CUR,
      name: "alice current",
      incomeMinor: 300_000,
      spendingMinor: 0,
      leftoverMinor: 250_000,
      shortfallMinor: 0,
    },
    {
      accountId: BOB_CUR,
      name: "bob current",
      incomeMinor: 200_000,
      spendingMinor: 0,
      leftoverMinor: 200_000,
      shortfallMinor: 0,
    },
    {
      accountId: HOLIDAY,
      name: "holiday",
      incomeMinor: 0,
      spendingMinor: 0,
      leftoverMinor: SWEEP_MINOR,
      shortfallMinor: 0,
    },
  ],
  edges: [
    {
      fromAccountId: ALICE_CUR,
      toAccountId: HOLIDAY,
      amountMinor: SWEEP_MINOR,
      requestedMinor: SWEEP_MINOR,
      status: "funded",
      inflowId: "monthly-sweep",
    },
  ],
  totalInflowMinor: 500_000,
};

/**
 * A prefix-matched fetch stub, on purpose.
 *
 * `src/test/apiMock.ts` keys on the exact `"METHOD /path?query"`, which would
 * pin this file to the endpoint the page asks *today* — and the package that
 * flips it changes exactly that. Matching on prefix means the same household
 * answers whichever question the page decides to ask, so WP-AS can flip the
 * assertion without rewriting the fixture under it.
 */
function stubFetch(): void {
  const routes: [string, unknown][] = [
    ["/api/auth/me", ME],
    ["/api/accounts", ACCOUNTS],
    [`/api/households/${HOUSEHOLD}/plan`, HOUSEHOLD_PLAN],
    ["/api/flow", FLOW],
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const path = String(url);
      // Longest prefix wins, so `/api/accounts` never swallows a longer path.
      const hit = [...routes]
        .sort((a, b) => b[0].length - a[0].length)
        .find(([prefix]) => path.startsWith(prefix));
      return {
        ok: hit !== undefined,
        status: hit ? 200 : 404,
        statusText: "",
        json: async () =>
          hit ? hit[1] : { error: { code: "not_stubbed", message: `no stub for ${path}` } },
        headers: { get: () => null },
      };
    }),
  );
}

/** Every ribbon the page handed the diagram, from the last render. */
function ribbons(): { fromAccountId: string | null; toAccountId: string | null }[] {
  const last = drawn.at(-1) as FlowDto | undefined;
  expect(last, "the page never handed the diagram anything").toBeDefined();
  return last!.edges;
}

describe("a household's own movement, drawn", () => {
  beforeEach(() => {
    drawn.length = 0;
    stubFetch();
    api.setToken("t");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderHousehold() {
    render(
      <PrivacyProvider>
        <MemoryRouter initialEntries={[`/flow?household=${HOUSEHOLD}`]}>
          <FlowPage />
        </MemoryRouter>
      </PrivacyProvider>,
    );
    await screen.findByTestId("the-diagram");
  }

  /**
   * The fixture's precondition, and **a plain `it` on purpose**.
   *
   * The pin says nothing unless all three accounts are actually in the picture:
   * a ribbon may only run between two nodes the diagram holds, so an `elsewhere`
   * end is *correct* for an account that is off-screen. Kept out of the
   * `it.fails` so that a fixture which loses an account turns the build red
   * rather than joining the expected failures.
   */
  it("draws both current accounts and the pot in one picture", async () => {
    await renderHousehold();
    const last = drawn.at(-1) as FlowDto;
    expect(last.accounts.map((a) => a.accountId).sort()).toEqual([ALICE_CUR, BOB_CUR, HOLIDAY]);
    expect(screen.getByText(/3 of 3 drawn/)).toBeInTheDocument();
  });

  /**
   * **The pin.** Both ends of the sweep are on the screen, so the ribbon has to
   * join them.
   */
  it.fails("runs the sweep from the account it left, not from elsewhere", async () => {
    await renderHousehold();
    const edges = ribbons();

    // The positive claim: one ribbon, alice's account to the pot.
    expect(
      edges.filter((e) => e.fromAccountId === ALICE_CUR && e.toAccountId === HOLIDAY),
    ).toHaveLength(1);
    // ...and neither half of it goes off the edge of a picture that holds both
    // its ends.
    expect(edges.filter((e) => e.fromAccountId === null && e.toAccountId === HOLIDAY)).toEqual([]);
    expect(edges.filter((e) => e.fromAccountId === ALICE_CUR && e.toAccountId === null)).toEqual(
      [],
    );
  });
});
