import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { householdFlow } from "../lib/flow.js";
import type { HouseholdAccountPlanDto, HouseholdPlanDto, TransferDto } from "../lib/types.js";
import { buildGraph } from "./FlowSankey.js";
import { HouseholdSankey } from "./HouseholdSankey.js";

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

function makePlan(accounts: HouseholdAccountPlanDto[], transfers: TransferDto[]): HouseholdPlanDto {
  return {
    householdId: "hh",
    asOfDate: "2026-06-01",
    currency: "GBP",
    monthlyIncomeMinor: 0,
    totalRequiredMinor: 0,
    totalFundedMinor: 0,
    leftoverMinor: 0,
    shortfallMinor: 0,
    members: [],
    accounts,
    lines: [],
    transfers,
  };
}

describe("the household preset", () => {
  /**
   * The pin, **deliberately re-pinned once** — ONE-ENGINE.md, WP-T.
   *
   * What it held before: the literal output of the household-only
   * `buildGraph(plan: HouseholdPlanDto)` as it stood before the diagram was
   * generalised, captured verbatim, so that drawing a household through the
   * scope-shaped component produced the same picture node for node.
   *
   * What changed, and why it had to: a household plan had never heard of a
   * movement leaving one of its own accounts, so `leftoverMinor` was the whole
   * residual and drawing it straight was right. One pass funds savings too, and
   * that field now means the residual *before* them (decision 13). Drawn
   * unchanged it would over-draw every sending node by its `committedMinor` and
   * put the household page back to disagreeing with the account page by exactly
   * one movement — which is the defect the whole plan exists to end. So the
   * picture gains the movements, and this capture is taken again on a fixture
   * that has one: Alice sweeps £500 a month into the household's holiday pot.
   *
   * The committed money leaves for `elsewhere` and the same £500 arrives from
   * `elsewhere`, because a household reports its movements as one bucket and
   * never itemises them — the flow page draws them movement by movement. Both
   * halves are true and every node's ribbons meet, which is the property a
   * diagram lives or dies by.
   */
  it("draws the household's committed movements, and every node's ribbons meet", () => {
    const plan: HouseholdPlanDto = {
      householdId: "hh",
      asOfDate: "2026-08-04",
      currency: "GBP",
      monthlyIncomeMinor: 500_000,
      totalRequiredMinor: 220_000,
      totalFundedMinor: 220_000,
      leftoverMinor: 280_000,
      committedMinor: 50_000,
      shortfallMinor: 0,
      members: [
        {
          userId: "alice",
          displayName: "Alice",
          shareBp: 6000,
          monthlyIncomeMinor: 300_000,
          obligationMinor: 132_000,
          fundedMinor: 132_000,
          leftoverMinor: 168_000,
          committedMinor: 50_000,
          shortfallMinor: 0,
        },
        {
          userId: "bob",
          displayName: "Bob",
          shareBp: 4000,
          monthlyIncomeMinor: 200_000,
          obligationMinor: 88_000,
          fundedMinor: 88_000,
          leftoverMinor: 112_000,
          shortfallMinor: 0,
        },
      ],
      accounts: [
        account({
          accountId: "alice-cur",
          name: "alice current",
          role: "personal",
          memberUserId: "alice",
          monthlyIncomeMinor: 300_000,
          transferOutMinor: 132_000,
          // Keeps its meaning to the penny (decision 13): income − transfers
          // out, before the savings movement below.
          leftoverMinor: 168_000,
          committedMinor: 50_000,
        }),
        account({
          accountId: "bob-cur",
          name: "bob current",
          role: "personal",
          memberUserId: "bob",
          monthlyIncomeMinor: 200_000,
          transferOutMinor: 88_000,
          leftoverMinor: 112_000,
        }),
        account({
          accountId: "bills",
          name: "bills",
          requiredOutflowMinor: 220_000,
          fundedOutflowMinor: 220_000,
          transferInMinor: 220_000,
        }),
        // Where the £500 lands. The household plan still has no *row* for a
        // movement — itemising is the flow endpoint's job — but it reports the
        // total that arrived, and the picture reads that rather than inferring
        // it from the left-over being larger than anything else explains.
        account({
          accountId: "holiday",
          name: "holiday",
          movementInMinor: 50_000,
          leftoverMinor: 50_000,
        }),
      ],
      lines: [],
      transfers: [
        {
          fromAccountId: "alice-cur",
          toAccountId: "bills",
          memberUserId: "alice",
          amountMinor: 132_000,
        },
        {
          fromAccountId: "bob-cur",
          toAccountId: "bills",
          memberUserId: "bob",
          amountMinor: 88_000,
        },
      ],
    };

    expect(buildGraph(householdFlow(plan))).toEqual({
      nodes: [
        { name: "alice current", isAccount: true },
        { name: "bob current", isAccount: true },
        { name: "bills", isAccount: true },
        { name: "holiday", isAccount: true },
        { name: "income", isAccount: false },
        { name: "left over", isAccount: false },
        { name: "income", isAccount: false },
        { name: "left over", isAccount: false },
        { name: "spending", isAccount: false },
        { name: "left over", isAccount: false },
        // One node per off-picture end, never shared: two of them here, and
        // merging them would make the graph circular and stop it laying out.
        { name: "elsewhere", isAccount: false },
        { name: "elsewhere", isAccount: false },
      ],
      links: [
        {
          source: 4,
          target: 0,
          value: 300_000,
          kind: "income",
          fromName: "income",
          toName: "alice current",
        },
        {
          // £1,680 left over, less the £500 committed: what actually stays put,
          // and the figure Alice's account page prints as its residual.
          source: 0,
          target: 5,
          value: 118_000,
          kind: "leftover",
          fromName: "alice current",
          toName: "left over",
        },
        {
          source: 6,
          target: 1,
          value: 200_000,
          kind: "income",
          fromName: "income",
          toName: "bob current",
        },
        {
          source: 1,
          target: 7,
          value: 112_000,
          kind: "leftover",
          fromName: "bob current",
          toName: "left over",
        },
        {
          source: 2,
          target: 8,
          value: 220_000,
          kind: "spending",
          fromName: "bills",
          toName: "spending",
        },
        {
          source: 3,
          target: 9,
          value: 50_000,
          kind: "leftover",
          fromName: "holiday",
          toName: "left over",
        },
        {
          source: 0,
          target: 2,
          value: 132_000,
          kind: "transfer",
          fromName: "alice current",
          toName: "bills",
          note: "Alice",
        },
        {
          source: 1,
          target: 2,
          value: 88_000,
          kind: "transfer",
          fromName: "bob current",
          toName: "bills",
          note: "Bob",
        },
        {
          // The committed bucket, leaving. Not itemised: the household plan has
          // no row saying where it went, and the flow page is where that
          // question is answered.
          source: 0,
          target: 10,
          value: 50_000,
          kind: "transfer",
          fromName: "alice current",
          toName: "elsewhere",
        },
        {
          source: 11,
          target: 3,
          value: 50_000,
          kind: "transfer",
          fromName: "elsewhere",
          toName: "holiday",
        },
      ],
    });

    // Every node's ribbons meet, which is the property the picture lives on.
    const { nodes, links } = buildGraph(householdFlow(plan));
    for (const [index, node] of nodes.entries()) {
      if (!node.isAccount) continue;
      const inMinor = links.filter((l) => l.target === index).reduce((s, l) => s + l.value, 0);
      const outMinor = links.filter((l) => l.source === index).reduce((s, l) => s + l.value, 0);
      expect([node.name, inMinor]).toEqual([node.name, outMinor]);
    }

    // ...and the household's own denominator is unchanged: total income.
    expect(householdFlow(plan).totalInflowMinor).toBe(500_000);
  });

  it("derives income, transfer, spending and leftover links", () => {
    const plan = makePlan(
      [
        account({
          accountId: "alice-cur",
          role: "personal",
          monthlyIncomeMinor: 300_000,
          transferOutMinor: 105_600,
          leftoverMinor: 194_400,
        }),
        account({
          accountId: "bills",
          role: "shared",
          transferInMinor: 120_000,
          fundedOutflowMinor: 120_000,
          leftoverMinor: 0,
        }),
      ],
      [
        {
          fromAccountId: "alice-cur",
          toAccountId: "bills",
          memberUserId: "alice",
          amountMinor: 120_000,
        },
      ],
    );
    const { nodes, links } = buildGraph(householdFlow(plan));

    const aliceIdx = nodes.findIndex((n) => n.name === "alice-cur");
    const billsIdx = nodes.findIndex((n) => n.name === "bills");
    expect(aliceIdx).toBeGreaterThanOrEqual(0);
    expect(billsIdx).toBeGreaterThanOrEqual(0);

    const income = links.find((l) => l.kind === "income" && l.target === aliceIdx);
    expect(income?.value).toBe(300_000);

    const transfer = links.find((l) => l.kind === "transfer");
    expect(transfer).toMatchObject({ source: aliceIdx, target: billsIdx, value: 120_000 });

    const spending = links.find((l) => l.kind === "spending" && l.source === billsIdx);
    expect(spending?.value).toBe(120_000);

    const leftover = links.find((l) => l.kind === "leftover" && l.source === aliceIdx);
    expect(leftover?.value).toBe(194_400);
  });

  it("omits zero-value flows and reports an empty graph when nothing moves", () => {
    const { links } = buildGraph(householdFlow(makePlan([account({ accountId: "empty" })], [])));
    expect(links).toHaveLength(0);
  });
});

describe("HouseholdSankey", () => {
  const plan = makePlan(
    [
      account({
        accountId: "alice-cur",
        monthlyIncomeMinor: 300_000,
        fundedOutflowMinor: 120_000,
        leftoverMinor: 180_000,
      }),
    ],
    [],
  );

  it("reads in pounds by default and flips to shares on demand", () => {
    render(<HouseholdSankey plan={{ ...plan, monthlyIncomeMinor: 300_000 }} />);

    const pounds = screen.getByRole("button", { name: "£" });
    const percent = screen.getByRole("button", { name: "%" });
    expect(pounds).toHaveAttribute("aria-pressed", "true");
    expect(percent).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(percent);
    expect(percent).toHaveAttribute("aria-pressed", "true");
    expect(pounds).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(pounds);
    expect(pounds).toHaveAttribute("aria-pressed", "true");
  });

  it("offers no units toggle when there is no flow to chart", () => {
    render(<HouseholdSankey plan={makePlan([account({ accountId: "empty" })], [])} />);
    expect(screen.queryByRole("group", { name: "flow units" })).toBeNull();
    expect(screen.getByText(/no money flow to chart yet/i)).toBeInTheDocument();
  });
});
