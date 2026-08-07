import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api.js";
import { stubApiFetch } from "../test/apiMock.js";
import type { FlowDto, HouseholdAccountPlanDto, HouseholdPlanDto } from "../lib/types.js";
import { HouseholdSankey } from "./HouseholdSankey.js";

/**
 * The household plan page's chart, which is the flow endpoint's answer for the
 * plan's own roster.
 *
 * This file used to be mostly `buildGraph(householdFlow(plan))`: a browser-side
 * reshaping of a `HouseholdPlanDto` into a `FlowDto`, asserted ribbon by ribbon.
 * Decision 31 deleted the reshaping — it had no row for an authored movement and
 * drew both of its ends leaving the picture (issue #43) — so what is left to
 * test here is what this component now is: the request it makes, and the four
 * things it can show while making it.
 *
 * The ribbons themselves are `FlowSankey`'s, tested in `FlowSankey.test.tsx`
 * over a `FlowDto` it is handed directly. A Sankey is SVG inside a
 * `ResponsiveContainer`, which measures zero in jsdom, so no ribbon is readable
 * in the DOM at all — which is why the assertions below reach for the units
 * toggle and the empty state rather than for a path.
 */

const AS_OF = "2026-06-01";

function account(
  over: Partial<HouseholdAccountPlanDto> & { accountId: string },
): HouseholdAccountPlanDto {
  return {
    name: over.accountId,
    role: "shared",
    memberUserId: null,
    currency: "GBP",
    monthlyIncomeMinor: 0,
    requiredOutflowMinor: 0,
    fundedOutflowMinor: 0,
    transferInMinor: 0,
    transferOutMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    ...over,
  };
}

function makePlan(accounts: HouseholdAccountPlanDto[]): HouseholdPlanDto {
  return {
    householdId: "hh",
    asOfDate: AS_OF,
    currency: "GBP",
    monthlyIncomeMinor: 0,
    totalRequiredMinor: 0,
    totalFundedMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    members: [],
    accounts,
    lines: [],
    transfers: [],
  };
}

const PLAN = makePlan([
  account({ accountId: "alice-cur", monthlyIncomeMinor: 300_000, leftoverMinor: 180_000 }),
  account({ accountId: "holiday", leftoverMinor: 120_000 }),
]);

/** The picture the server draws for that roster: a movement with both ends
 *  named, which is the whole reason this component asks rather than reshapes. */
const FLOW: FlowDto = {
  asOfDate: AS_OF,
  currency: "GBP",
  accounts: [
    {
      accountId: "alice-cur",
      name: "alice-cur",
      incomeMinor: 300_000,
      spendingMinor: 0,
      leftoverMinor: 180_000,
      shortfallMinor: 0,
    },
    {
      accountId: "holiday",
      name: "holiday",
      incomeMinor: 0,
      spendingMinor: 0,
      leftoverMinor: 120_000,
      shortfallMinor: 0,
    },
  ],
  edges: [
    {
      fromAccountId: "alice-cur",
      toAccountId: "holiday",
      amountMinor: 120_000,
      requestedMinor: 120_000,
      status: "funded",
      inflowId: "sweep",
    },
  ],
  totalInflowMinor: 300_000,
};

const ROSTER_KEY = `GET /api/flow?accounts=alice-cur,holiday&asOf=${AS_OF}`;

describe("HouseholdSankey", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The request, which is the substance of decision 31.
   *
   * The plan's **own** roster and the plan's **own** date: a chart under a plan
   * that reads a different set of accounts, or the same set on a different day,
   * is a second answer to the question the table above it already answered.
   */
  it("asks the flow endpoint for the plan's roster, on the plan's date", async () => {
    const stub = stubApiFetch({ [ROSTER_KEY]: { body: FLOW } });
    api.setToken("t");
    render(<HouseholdSankey plan={PLAN} />);

    await waitFor(() => expect(stub.calls(ROSTER_KEY)).toBe(1));
    // ...and never the plan endpoint it used to reshape.
    expect(stub.mock.mock.calls.some(([url]) => String(url).includes("/plan"))).toBe(false);
  });

  it("reads in pounds by default and flips to shares on demand", async () => {
    stubApiFetch({ [ROSTER_KEY]: { body: FLOW } });
    api.setToken("t");
    render(<HouseholdSankey plan={PLAN} />);

    const pounds = await screen.findByRole("button", { name: "£" });
    const percent = screen.getByRole("button", { name: "%" });
    expect(pounds).toHaveAttribute("aria-pressed", "true");
    expect(percent).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(percent);
    expect(percent).toHaveAttribute("aria-pressed", "true");
    expect(pounds).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(pounds);
    expect(pounds).toHaveAttribute("aria-pressed", "true");
  });

  it("offers no units toggle when there is no flow to chart", async () => {
    const empty = makePlan([account({ accountId: "empty" })]);
    stubApiFetch({
      [`GET /api/flow?accounts=empty&asOf=${AS_OF}`]: {
        body: {
          asOfDate: AS_OF,
          currency: "GBP",
          accounts: [
            {
              accountId: "empty",
              name: "empty",
              incomeMinor: 0,
              spendingMinor: 0,
              leftoverMinor: 0,
              shortfallMinor: 0,
            },
          ],
          edges: [],
          totalInflowMinor: 0,
        } satisfies FlowDto,
      },
    });
    api.setToken("t");
    render(<HouseholdSankey plan={empty} />);

    expect(await screen.findByText(/no money flow to chart yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "flow units" })).toBeNull();
  });

  /**
   * A household with nothing assigned to it asks nothing at all — the endpoint
   * refuses an empty set, and a refusal is not what "you have not put any
   * accounts in this household yet" should look like.
   */
  it("asks nothing for a household with no accounts, and says the picture is empty", async () => {
    const stub = stubApiFetch({});
    api.setToken("t");
    render(<HouseholdSankey plan={makePlan([])} />);

    expect(await screen.findByText(/no money flow to chart yet/i)).toBeInTheDocument();
    expect(stub.mock).not.toHaveBeenCalled();
  });

  /**
   * The two refusals a household can provoke — a roster longer than one diagram
   * covers, and one spanning two currencies — are facts about *this* household,
   * so the reader is told which one it was. The rules themselves live on the
   * server and are not restated here.
   */
  it("says which refusal it was, in the server's words", async () => {
    stubApiFetch({
      [ROSTER_KEY]: {
        status: 422,
        body: {
          error: {
            code: "validation_error",
            message: "a diagram cannot span currencies: EUR, GBP",
          },
        },
      },
    });
    api.setToken("t");
    render(<HouseholdSankey plan={PLAN} />);

    expect(await screen.findByText(/cannot span currencies: EUR, GBP/)).toBeInTheDocument();
  });
});
