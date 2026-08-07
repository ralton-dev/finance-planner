import { describe, expect, it } from "vitest";
import { accountLabel, parseAccountIds, totalInflowMinor, visibleFlow } from "./flow.js";
import type { FlowDto } from "./types.js";

/** current ─▶ pot ─▶ isa, plus a household's rent arriving from off-scope. */
const flow: FlowDto = {
  asOfDate: "2026-08-04",
  currency: "GBP",
  accounts: [
    {
      accountId: "current",
      name: "current",
      incomeMinor: 400_000,
      spendingMinor: 100_000,
      leftoverMinor: 200_000,
      shortfallMinor: 0,
    },
    {
      accountId: "pot",
      name: "pot",
      incomeMinor: 0,
      spendingMinor: 60_000,
      leftoverMinor: 80_000,
      shortfallMinor: 0,
    },
    {
      accountId: "isa",
      name: "isa",
      incomeMinor: 0,
      spendingMinor: 0,
      leftoverMinor: 40_000,
      shortfallMinor: 0,
    },
  ],
  edges: [
    {
      fromAccountId: "current",
      toAccountId: "pot",
      amountMinor: 100_000,
      requestedMinor: 100_000,
      status: "funded",
      inflowId: "to-pot",
    },
    {
      fromAccountId: "pot",
      toAccountId: "isa",
      amountMinor: 40_000,
      requestedMinor: 40_000,
      status: "funded",
      inflowId: "to-isa",
    },
    {
      fromAccountId: null,
      toAccountId: "pot",
      amountMinor: 80_000,
      requestedMinor: 80_000,
      status: "funded",
      memberUserId: "bob",
    },
  ],
  totalInflowMinor: 480_000,
};

describe("visibleFlow", () => {
  /**
   * The promise excludability rests on. Hiding an account is a way of looking at
   * a diagram, not a way of narrowing the plan — so every account still drawn
   * keeps every figure it arrived with, to the penny, and the snapshot either
   * side of a toggle is byte-identical.
   */
  it("changes only the picture, and provably not one figure", () => {
    const before = JSON.stringify(flow);

    const hidden = visibleFlow(flow, new Set(["pot"]));
    // The picture changed.
    expect(hidden.accounts.map((a) => a.accountId)).toEqual(["current", "isa"]);
    // ...and unhiding gets back exactly what was there.
    expect(visibleFlow(hidden, new Set())).toEqual(hidden);
    expect(JSON.stringify(visibleFlow(flow, new Set()))).toBe(before);

    // No figure moved: the remaining nodes are the very same objects.
    expect(hidden.accounts[0]).toBe(flow.accounts[0]);
    expect(hidden.accounts[1]).toBe(flow.accounts[2]);
    // ...and the flow that was passed in was not touched.
    expect(JSON.stringify(flow)).toBe(before);
  });

  it("keeps money crossing into the picture when its other end is hidden", () => {
    const hidden = visibleFlow(flow, new Set(["pot"]));
    // The money still leaves the current account and still reaches the ISA;
    // both now cross the edge of what is drawn, exactly as an account outside
    // the scope's would. Hiding the middle of a chain must not make either end
    // look richer than it is.
    expect(hidden.edges).toEqual([
      expect.objectContaining({
        fromAccountId: "current",
        toAccountId: null,
        amountMinor: 100_000,
      }),
      expect.objectContaining({ fromAccountId: null, toAccountId: "isa", amountMinor: 40_000 }),
    ]);
    // The household's £800 into the hidden pot has nothing to say about this
    // picture at all: neither end of it is drawn.
    expect(hidden.edges.some((e) => e.memberUserId === "bob")).toBe(false);
  });

  it("measures shares against the money entering what is drawn", () => {
    expect(visibleFlow(flow, new Set(["current"])).totalInflowMinor).toBe(
      // The pot's £1,000 from the current account and £800 from the household,
      // both now arriving from off-picture. No income of their own.
      180_000,
    );
    expect(visibleFlow(flow, new Set()).totalInflowMinor).toBe(480_000);
  });

  it("hides everything without dividing by nothing", () => {
    const empty = visibleFlow(flow, new Set(["current", "pot", "isa"]));
    expect(empty).toMatchObject({ accounts: [], edges: [], totalInflowMinor: 0 });
  });
});

describe("totalInflowMinor", () => {
  it("counts own income and everything crossing the edge, and nothing else", () => {
    expect(totalInflowMinor(flow.accounts, flow.edges)).toBe(480_000);
  });
});

describe("accountLabel", () => {
  it("names an account the caller can see and says 'other account' for one they cannot", () => {
    expect(accountLabel({ name: "current" })).toBe("current");
    // The endpoint sends no `name` at all for an account on the household's
    // roster that this reader may not see (decision 36); the absence is what is
    // read, never a placeholder the server invented.
    expect(accountLabel({})).toBe("other account");
    expect(accountLabel({ name: undefined })).toBe("other account");
  });

  it("leaves an account genuinely called that alone", () => {
    // Which is the reason the wire carries an absence rather than the phrase: a
    // name that happens to read like the fallback is still the caller's to see.
    expect(accountLabel({ name: "other account" })).toBe("other account");
  });
});

describe("visibleFlow with an unnamed node", () => {
  it("keeps the money of an account it cannot name, and its ribbons", () => {
    // Anonymised, never omitted — hiding is the user's act and has its own
    // parameter; not being allowed the name is not a reason to drop the node,
    // because dropping it unbalances every account it sends money to.
    const anonymous: FlowDto = {
      ...flow,
      accounts: flow.accounts.map((a) => (a.accountId === "pot" ? { ...a, name: undefined } : a)),
    };
    const drawn = visibleFlow(anonymous, new Set(["isa"]));
    expect(drawn.accounts.map((a) => a.name)).toEqual(["current", undefined]);
    expect(drawn.accounts.map((a) => a.leftoverMinor)).toEqual(
      visibleFlow(flow, new Set(["isa"])).accounts.map((a) => a.leftoverMinor),
    );
    expect(drawn.totalInflowMinor).toBe(visibleFlow(flow, new Set(["isa"])).totalInflowMinor);
  });
});

describe("parseAccountIds", () => {
  it("keeps the user's order, drops the blanks, and takes a repeat once", () => {
    expect(parseAccountIds("b, a ,,b,")).toEqual(["b", "a"]);
    expect(parseAccountIds(null)).toEqual([]);
  });
});
