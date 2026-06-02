import { describe, expect, it } from "vitest";
import type { HouseholdAccountPlanDto, HouseholdPlanDto, TransferDto } from "../lib/types.js";
import { buildGraph } from "./HouseholdSankey.js";

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

describe("buildGraph", () => {
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
    const { nodes, links } = buildGraph(plan);

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
    const plan = makePlan([account({ accountId: "empty" })], []);
    const { links } = buildGraph(plan);
    expect(links).toHaveLength(0);
  });
});
