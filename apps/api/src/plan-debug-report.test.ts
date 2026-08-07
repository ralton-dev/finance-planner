import {
  explainScopePlan,
  type ScopeAccountInput,
  type ScopeInput,
  type ScopePaymentInput,
} from "@finance-planner/domain";
import { describe, expect, it } from "vitest";
import { renderScopeDebugReport } from "./plan-debug-report.js";

const ASOF = "2026-01-01";

function pay(
  over: Partial<ScopePaymentInput> & { id: string; amountMinor: number },
): ScopePaymentInput {
  return { name: over.id, category: "monthly_recurring", scope: "shared", priority: 100, ...over };
}

function acc(over: Partial<ScopeAccountInput> & { accountId: string }): ScopeAccountInput {
  return {
    name: over.accountId,
    role: "shared",
    ownerUserId: over.memberUserId ?? "owner",
    currency: "GBP",
    incomes: [],
    payments: [],
    ...over,
  };
}

/** The scope `scope.test.ts` explains: one member, income in the current
 *  account, a bill on another, and an authored sweep into a third. */
function scope(): ScopeInput {
  return {
    scopeId: "scope",
    members: [{ userId: "owner", shareBp: 10_000 }],
    accounts: [
      acc({
        accountId: "current",
        role: "personal",
        memberUserId: "owner",
        incomes: [{ id: "inc", amountMinor: 100_000, frequency: "monthly", anchorDate: ASOF }],
        outboundInflows: [
          {
            id: "sweep",
            name: "Savings sweep",
            toAccountId: "savings",
            amountMinor: 30_000,
            frequency: "monthly",
            anchorDate: ASOF,
            priority: 20,
          },
        ],
      }),
      acc({
        accountId: "bills",
        role: "personal",
        memberUserId: "owner",
        payments: [pay({ id: "rent", amountMinor: 40_000, scope: "personal" })],
      }),
      acc({ accountId: "savings", role: "personal", memberUserId: "owner" }),
    ],
  };
}

function report(): string {
  const debug = explainScopePlan(scope(), ASOF);
  return renderScopeDebugReport(scope(), debug.plan, debug.currencies);
}

describe("renderScopeDebugReport", () => {
  it("lays the pass out phase by phase", () => {
    const text = report();
    expect(text).toContain("Phase 2 - global funding queue by rank");
    expect(text).toContain("Per account final breakdown");
    expect(text).toContain("Per user final breakdown");
  });

  it("names the funding rank, the derived transfer and the authored movement", () => {
    const text = report();
    expect(text).toContain("#1 rent on bills for user");
    expect(text).toContain("current -> bills");
    expect(text).toContain("movement Savings sweep");
  });

  it("prints the user rollup on the available-leftover basis", () => {
    const text = report();
    expect(text).toContain("available left over across owned accounts GBP 30000 minor");
    expect(text).toContain(
      "funding budget leftover before authored savings GBP 60000 minor; authored savings committed GBP 30000 minor",
    );
  });

  it("says so plainly when a phase has nothing in it", () => {
    const bare: ScopeInput = {
      scopeId: "scope",
      members: [{ userId: "owner", shareBp: 10_000 }],
      accounts: [acc({ accountId: "current", role: "personal", memberUserId: "owner" })],
    };
    const debug = explainScopePlan(bare, ASOF);
    const text = renderScopeDebugReport(bare, debug.plan, debug.currencies);
    expect(text).toContain("- no active payments in this currency");
    expect(text).toContain("- no obligations queued");
    expect(text).toContain("- no funded obligation needed transport");
    expect(text).toContain("incomes: none");
  });
});
