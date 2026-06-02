import { describe, expect, it } from "vitest";
import {
  computeHouseholdPlan,
  type HouseholdAccountInput,
  type HouseholdInput,
  type HouseholdPaymentInput,
  splitByShares,
} from "./household.js";

const AS_OF = "2026-06-01";

// --- factories ---------------------------------------------------------------

function pay(
  over: Partial<HouseholdPaymentInput> & { id: string; amountMinor: number },
): HouseholdPaymentInput {
  return {
    name: over.id,
    category: "monthly_recurring",
    scope: "shared",
    priority: 100,
    ...over,
  };
}

function acc(over: Partial<HouseholdAccountInput> & { accountId: string }): HouseholdAccountInput {
  return {
    name: over.accountId,
    role: "shared",
    currency: "GBP",
    incomes: [],
    payments: [],
    ...over,
  };
}

function income(amountMinor: number) {
  return [{ id: "inc", amountMinor, frequency: "monthly" as const, anchorDate: AS_OF }];
}

function plan(input: Omit<HouseholdInput, "householdId" | "currency">) {
  return computeHouseholdPlan({ householdId: "hh", currency: "GBP", ...input }, AS_OF);
}

function transfer(p: ReturnType<typeof plan>, from: string, to: string): number {
  return p.transfers
    .filter((t) => t.fromAccountId === from && t.toAccountId === to)
    .reduce((s, t) => s + t.amountMinor, 0);
}

const member = (userId: string, shareBp: number, displayName?: string) => ({
  userId,
  shareBp,
  displayName,
});

// --- splitByShares -----------------------------------------------------------

describe("splitByShares", () => {
  it("splits proportionally with whole minor units that sum exactly", () => {
    expect(splitByShares(160_000, [6600, 3400])).toEqual([105_600, 54_400]);
  });

  it("distributes the rounding remainder by largest fractional part", () => {
    // 100 / 3 = 33.33 each → [34, 33, 33], summing to 100.
    const parts = splitByShares(100, [1, 1, 1]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it("falls back to an equal split when total weight is zero", () => {
    expect(splitByShares(100, [0, 0])).toEqual([50, 50]);
  });

  it("handles a single weight and a zero amount", () => {
    expect(splitByShares(500, [42])).toEqual([500]);
    expect(splitByShares(0, [1, 2, 3])).toEqual([0, 0, 0]);
  });

  it("returns an empty array for no members", () => {
    expect(splitByShares(100, [])).toEqual([]);
  });
});

// --- the canonical scenario --------------------------------------------------

describe("computeHouseholdPlan — proportional shared costs", () => {
  const p = plan({
    members: [member("alice", 6600, "Alice"), member("bob", 3400, "Bob")],
    accounts: [
      acc({
        accountId: "alice-cur",
        role: "personal",
        memberUserId: "alice",
        incomes: income(300_000),
      }),
      acc({
        accountId: "bob-cur",
        role: "personal",
        memberUserId: "bob",
        incomes: income(200_000),
      }),
      acc({
        accountId: "bills",
        role: "shared",
        payments: [
          pay({ id: "rent", amountMinor: 100_000 }),
          pay({ id: "council", amountMinor: 20_000 }),
        ],
      }),
      acc({
        accountId: "food",
        role: "shared",
        payments: [pay({ id: "groceries", amountMinor: 40_000 })],
      }),
    ],
  });

  it("splits each shared cost 66/34 and sums obligations per member", () => {
    const alice = p.members.find((m) => m.userId === "alice")!;
    const bob = p.members.find((m) => m.userId === "bob")!;
    expect(alice.obligationMinor).toBe(105_600); // 66000 + 13200 + 26400
    expect(bob.obligationMinor).toBe(54_400); // 34000 + 6800 + 13600
    expect(alice.shareBp).toBe(6600);
    expect(bob.shareBp).toBe(3400);
  });

  it("fully funds everyone and reports discretionary leftover", () => {
    expect(p.shortfallMinor).toBe(0);
    expect(p.totalFundedMinor).toBe(160_000);
    expect(p.members.find((m) => m.userId === "alice")!.leftoverMinor).toBe(194_400);
    expect(p.members.find((m) => m.userId === "bob")!.leftoverMinor).toBe(145_600);
    expect(p.leftoverMinor).toBe(340_000); // 500000 income − 160000 required
  });

  it("derives the transfers each person must make into each pot", () => {
    expect(transfer(p, "alice-cur", "bills")).toBe(79_200); // 66000 + 13200
    expect(transfer(p, "alice-cur", "food")).toBe(26_400);
    expect(transfer(p, "bob-cur", "bills")).toBe(40_800); // 34000 + 6800
    expect(transfer(p, "bob-cur", "food")).toBe(13_600);
    expect(p.transfers).toHaveLength(4);
  });

  it("nets each shared pot to zero (inflow == outflow)", () => {
    const bills = p.accounts.find((a) => a.accountId === "bills")!;
    expect(bills.transferInMinor).toBe(120_000);
    expect(bills.fundedOutflowMinor).toBe(120_000);
    expect(bills.leftoverMinor).toBe(0);
    expect(bills.shortfallMinor).toBe(0);
  });

  it("leaves each member's leftover sitting in their current account", () => {
    const aliceCur = p.accounts.find((a) => a.accountId === "alice-cur")!;
    expect(aliceCur.transferOutMinor).toBe(105_600);
    expect(aliceCur.leftoverMinor).toBe(194_400);
  });
});

// --- personal expenses -------------------------------------------------------

describe("computeHouseholdPlan — personal expenses", () => {
  it("charges a personal expense entirely to the owning member of the account", () => {
    const p = plan({
      members: [member("alice", 5000), member("bob", 5000)],
      accounts: [
        acc({
          accountId: "alice-cur",
          role: "personal",
          memberUserId: "alice",
          incomes: income(300_000),
          payments: [pay({ id: "gym", amountMinor: 5_000, scope: "personal" })],
        }),
        acc({
          accountId: "bob-cur",
          role: "personal",
          memberUserId: "bob",
          incomes: income(200_000),
        }),
      ],
    });
    expect(p.members.find((m) => m.userId === "alice")!.obligationMinor).toBe(5_000);
    expect(p.members.find((m) => m.userId === "bob")!.obligationMinor).toBe(0);
    // Paid from her own account → internal, no transfer.
    expect(p.transfers).toHaveLength(0);
    expect(p.accounts.find((a) => a.accountId === "alice-cur")!.fundedOutflowMinor).toBe(5_000);
  });

  it("transfers a personal bill into a separate personal-bills account", () => {
    const p = plan({
      members: [member("alice", 1), member("bob", 1)],
      accounts: [
        acc({
          accountId: "alice-cur",
          role: "personal",
          memberUserId: "alice",
          incomes: income(300_000),
        }),
        acc({
          accountId: "alice-bills",
          role: "personal",
          memberUserId: "alice",
          payments: [pay({ id: "phone", amountMinor: 4_500, scope: "personal" })],
        }),
        acc({
          accountId: "bob-cur",
          role: "personal",
          memberUserId: "bob",
          incomes: income(200_000),
        }),
      ],
    });
    expect(transfer(p, "alice-cur", "alice-bills")).toBe(4_500);
    expect(p.accounts.find((a) => a.accountId === "alice-bills")!.leftoverMinor).toBe(0);
  });

  it("honours an explicit bearer for a personal expense on a shared account", () => {
    const p = plan({
      members: [member("alice", 5000), member("bob", 5000)],
      accounts: [
        acc({
          accountId: "alice-cur",
          role: "personal",
          memberUserId: "alice",
          incomes: income(300_000),
        }),
        acc({
          accountId: "bob-cur",
          role: "personal",
          memberUserId: "bob",
          incomes: income(200_000),
        }),
        acc({
          accountId: "joint",
          role: "shared",
          payments: [
            pay({ id: "bobs-hobby", amountMinor: 8_000, scope: "personal", bearerUserId: "bob" }),
          ],
        }),
      ],
    });
    expect(p.members.find((m) => m.userId === "bob")!.obligationMinor).toBe(8_000);
    expect(p.members.find((m) => m.userId === "alice")!.obligationMinor).toBe(0);
    expect(transfer(p, "bob-cur", "joint")).toBe(8_000);
  });

  it("falls back to a shared split when a personal expense has no resolvable bearer", () => {
    const p = plan({
      members: [member("alice", 5000), member("bob", 5000)],
      accounts: [
        acc({
          accountId: "alice-cur",
          role: "personal",
          memberUserId: "alice",
          incomes: income(300_000),
        }),
        acc({
          accountId: "bob-cur",
          role: "personal",
          memberUserId: "bob",
          incomes: income(200_000),
        }),
        acc({
          accountId: "joint",
          role: "shared",
          payments: [
            pay({ id: "mystery", amountMinor: 10_000, scope: "personal", bearerUserId: "ghost" }),
          ],
        }),
      ],
    });
    expect(p.members.find((m) => m.userId === "alice")!.obligationMinor).toBe(5_000);
    expect(p.members.find((m) => m.userId === "bob")!.obligationMinor).toBe(5_000);
  });
});

// --- priority + shortfall across accounts -----------------------------------

describe("computeHouseholdPlan — global priority funding", () => {
  const p = plan({
    members: [member("carl", 10_000)],
    accounts: [
      acc({
        accountId: "carl-cur",
        role: "personal",
        memberUserId: "carl",
        incomes: income(50_000),
      }),
      acc({
        accountId: "bills",
        role: "shared",
        payments: [
          pay({ id: "rent", amountMinor: 40_000, priority: 10 }),
          pay({ id: "broadband", amountMinor: 20_000, priority: 20 }),
        ],
      }),
    ],
  });

  it("funds higher-priority payments first when income is short", () => {
    const rent = p.lines.find((l) => l.paymentId === "rent")!;
    const broadband = p.lines.find((l) => l.paymentId === "broadband")!;
    expect(rent.fundedMonthlyMinor).toBe(40_000);
    expect(rent.onTrack).toBe(true);
    expect(broadband.fundedMonthlyMinor).toBe(10_000); // only £100 left after rent
    expect(broadband.onTrack).toBe(false);
  });

  it("surfaces the unfunded gap as member + household + account shortfall", () => {
    expect(p.members[0]!.shortfallMinor).toBe(10_000);
    expect(p.members[0]!.leftoverMinor).toBe(0);
    expect(p.shortfallMinor).toBe(10_000);
    const bills = p.accounts.find((a) => a.accountId === "bills")!;
    expect(bills.requiredOutflowMinor).toBe(60_000);
    expect(bills.fundedOutflowMinor).toBe(50_000);
    expect(bills.shortfallMinor).toBe(10_000);
  });
});

// --- edges -------------------------------------------------------------------

describe("computeHouseholdPlan — edges", () => {
  it("returns an empty-but-valid plan for no members or accounts", () => {
    const p = plan({ members: [], accounts: [] });
    expect(p.monthlyIncomeMinor).toBe(0);
    expect(p.totalRequiredMinor).toBe(0);
    expect(p.members).toEqual([]);
    expect(p.transfers).toEqual([]);
  });

  it("splits equally when no contribution shares are set", () => {
    const p = plan({
      members: [member("a", 0), member("b", 0)],
      accounts: [
        acc({ accountId: "a-cur", role: "personal", memberUserId: "a", incomes: income(100_000) }),
        acc({ accountId: "b-cur", role: "personal", memberUserId: "b", incomes: income(100_000) }),
        acc({
          accountId: "bills",
          role: "shared",
          payments: [pay({ id: "rent", amountMinor: 30_000 })],
        }),
      ],
    });
    expect(p.members.find((m) => m.userId === "a")!.obligationMinor).toBe(15_000);
    expect(p.members.find((m) => m.userId === "b")!.obligationMinor).toBe(15_000);
    expect(p.members[0]!.shareBp).toBe(5000);
  });

  it("flags a member with no income/source as fully short and makes no transfer", () => {
    const p = plan({
      members: [member("dave", 5000), member("eve", 5000)],
      accounts: [
        // dave owns no account; eve funds her half only.
        acc({
          accountId: "eve-cur",
          role: "personal",
          memberUserId: "eve",
          incomes: income(100_000),
        }),
        acc({
          accountId: "bills",
          role: "shared",
          payments: [pay({ id: "rent", amountMinor: 10_000 })],
        }),
      ],
    });
    const dave = p.members.find((m) => m.userId === "dave")!;
    expect(dave.obligationMinor).toBe(5_000);
    expect(dave.fundedMinor).toBe(0);
    expect(dave.shortfallMinor).toBe(5_000);
    expect(transfer(p, "eve-cur", "bills")).toBe(5_000);
    // No transfer originates from dave (he has no source account).
    expect(p.transfers.every((t) => t.fromAccountId === "eve-cur")).toBe(true);
  });

  it("excludes inactive payments", () => {
    const p = plan({
      members: [member("a", 1)],
      accounts: [
        acc({ accountId: "a-cur", role: "personal", memberUserId: "a", incomes: income(100_000) }),
        acc({
          accountId: "bills",
          role: "shared",
          payments: [pay({ id: "old", amountMinor: 9_999, active: false })],
        }),
      ],
    });
    expect(p.totalRequiredMinor).toBe(0);
    expect(p.lines).toHaveLength(0);
  });
});

// --- buffers -----------------------------------------------------------------

describe("computeHouseholdPlan — buffers", () => {
  it("reserves a personal-account buffer off the top of that member's budget", () => {
    const p = plan({
      members: [member("a", 1)],
      accounts: [
        acc({
          accountId: "a-cur",
          role: "personal",
          memberUserId: "a",
          incomes: income(100_000),
          monthlyBufferMinor: 20_000,
        }),
        acc({
          accountId: "bills",
          role: "shared",
          payments: [pay({ id: "rent", amountMinor: 90_000 })],
        }),
      ],
    });
    // Budget = 100000 − 20000 = 80000 < 90000 rent → 10000 short.
    expect(p.members[0]!.shortfallMinor).toBe(10_000);
    expect(p.members[0]!.leftoverMinor).toBe(0);
  });

  it("funds a shared-pot buffer proportionally and leaves it as pot reserve", () => {
    const p = plan({
      members: [member("a", 6000), member("b", 4000)],
      accounts: [
        acc({ accountId: "a-cur", role: "personal", memberUserId: "a", incomes: income(300_000) }),
        acc({ accountId: "b-cur", role: "personal", memberUserId: "b", incomes: income(300_000) }),
        acc({
          accountId: "joint",
          role: "shared",
          monthlyBufferMinor: 10_000,
          payments: [pay({ id: "rent", amountMinor: 50_000 })],
        }),
      ],
    });
    const joint = p.accounts.find((a) => a.accountId === "joint")!;
    // Members transfer in rent (50000) + buffer (10000); rent is paid out, the
    // buffer stays as the pot's leftover reserve.
    expect(joint.transferInMinor).toBe(60_000);
    expect(joint.fundedOutflowMinor).toBe(50_000);
    expect(joint.leftoverMinor).toBe(10_000);
    expect(transfer(p, "a-cur", "joint")).toBe(36_000); // 60% of 60000
    expect(transfer(p, "b-cur", "joint")).toBe(24_000);
  });
});
