import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FlowDto, FlowEdgeDto } from "../lib/types.js";
import { buildGraph, FlowSankey, flowLabel } from "./FlowSankey.js";

const flow = (over: Partial<FlowDto> = {}): FlowDto => ({
  asOfDate: "2026-08-04",
  currency: "GBP",
  accounts: [],
  edges: [],
  totalInflowMinor: 0,
  ...over,
});

const node = (accountId: string, over: Partial<FlowDto["accounts"][number]> = {}) => ({
  accountId,
  name: accountId,
  incomeMinor: 0,
  spendingMinor: 0,
  leftoverMinor: 0,
  shortfallMinor: 0,
  ...over,
});

const edge = (over: Partial<FlowEdgeDto> = {}): FlowEdgeDto => ({
  fromAccountId: null,
  toAccountId: null,
  amountMinor: 0,
  requestedMinor: 0,
  status: "funded",
  ...over,
});

describe("buildGraph", () => {
  it("draws a movement between two accounts of one estate, with no household in it", () => {
    const { nodes, links } = buildGraph(
      flow({
        accounts: [
          node("current", { incomeMinor: 300_000, leftoverMinor: 200_000 }),
          node("isa", { leftoverMinor: 100_000 }),
        ],
        edges: [
          edge({
            fromAccountId: "current",
            toAccountId: "isa",
            amountMinor: 100_000,
            requestedMinor: 100_000,
            inflowId: "monthly-saving",
          }),
        ],
        totalInflowMinor: 300_000,
      }),
    );
    const currentIdx = nodes.findIndex((n) => n.name === "current");
    const isaIdx = nodes.findIndex((n) => n.name === "isa");
    expect(links.find((l) => l.kind === "transfer")).toMatchObject({
      source: currentIdx,
      target: isaIdx,
      value: 100_000,
    });
    // Nobody is moving it on anyone's behalf, so the tooltip has no via-line.
    expect(links.find((l) => l.kind === "transfer")).not.toHaveProperty("note");
  });

  /**
   * The scope has an edge and money crosses it. Dropping either direction would
   * make the picture balance by hiding the very thing it exists to show.
   */
  it("draws both ends of the scope's edge, and never merges two of them", () => {
    const { nodes, links } = buildGraph(
      flow({
        accounts: [node("pot", { spendingMinor: 20_000 })],
        edges: [
          edge({ toAccountId: "pot", amountMinor: 100_000, requestedMinor: 100_000 }),
          edge({ fromAccountId: "pot", amountMinor: 80_000, requestedMinor: 80_000 }),
        ],
        totalInflowMinor: 100_000,
      }),
    );
    const offPicture = nodes.filter((n) => n.name === "elsewhere");
    // Two nodes, not one: a single "elsewhere" would be both a source and a
    // sink, which is a cycle, and a Sankey with a cycle does not lay out.
    expect(offPicture).toHaveLength(2);
    const arriving = links.find((l) => l.toName === "pot" && l.kind === "transfer");
    const leaving = links.find((l) => l.fromName === "pot" && l.kind === "transfer");
    expect(arriving?.fromName).toBe("elsewhere");
    expect(leaving?.toName).toBe("elsewhere");
    expect(arriving?.source).not.toBe(leaving?.target);
  });

  it("names the member on a household transfer and says what a short one asked for", () => {
    const { links } = buildGraph(
      flow({
        accounts: [node("bills"), node("pot")],
        edges: [
          edge({
            toAccountId: "bills",
            amountMinor: 100_000,
            requestedMinor: 100_000,
            memberUserId: "bob",
            memberName: "Bob",
          }),
          edge({
            toAccountId: "pot",
            amountMinor: 60_000,
            requestedMinor: 90_000,
            status: "short",
            inflowId: "top-up",
          }),
          edge({
            toAccountId: "pot",
            amountMinor: 1,
            requestedMinor: 1,
            status: "unknown_source",
            inflowId: "from-nowhere",
          }),
        ],
        totalInflowMinor: 160_001,
      }),
    );
    expect(links.map((l) => l.note)).toEqual([
      "Bob",
      "asked for £900.00",
      "sent from outside this picture",
    ]);
  });

  it("falls back to 'member' when a household transfer carries no name", () => {
    const { links } = buildGraph(
      flow({
        accounts: [node("bills")],
        edges: [edge({ toAccountId: "bills", amountMinor: 10, memberUserId: "bob" })],
      }),
    );
    expect(links[0]!.note).toBe("member");
  });

  it("draws no ribbon for a movement that moves nothing", () => {
    const { links } = buildGraph(
      flow({
        accounts: [node("a"), node("b")],
        edges: [
          edge({
            fromAccountId: "a",
            toAccountId: "b",
            amountMinor: 0,
            requestedMinor: 50_000,
            status: "broken_cycle",
            inflowId: "loops-back",
          }),
        ],
      }),
    );
    expect(links).toHaveLength(0);
  });

  it("ignores an edge naming an account that is not in the picture", () => {
    const { links } = buildGraph(
      flow({
        accounts: [node("a")],
        edges: [edge({ fromAccountId: "a", toAccountId: "ghost", amountMinor: 10 })],
      }),
    );
    expect(links).toHaveLength(0);
  });
});

describe("flowLabel", () => {
  it("writes amounts in the flow's currency", () => {
    expect(flowLabel(120_000, 300_000, "amount", "GBP")).toBe("£1,200.00");
  });

  it("writes shares of the money entering the picture to one decimal", () => {
    expect(flowLabel(120_000, 300_000, "share", "GBP")).toBe("40.0%");
    expect(flowLabel(105_600, 300_000, "share", "GBP")).toBe("35.2%");
  });

  it("declines to divide by nothing", () => {
    expect(flowLabel(120_000, 0, "share", "GBP")).toBe("—");
  });
});

describe("FlowSankey", () => {
  it("says a loop was broken rather than letting the movement vanish", () => {
    render(
      <FlowSankey
        flow={flow({
          accounts: [node("a", { incomeMinor: 100_000, leftoverMinor: 100_000 }), node("b")],
          edges: [
            edge({
              fromAccountId: "b",
              toAccountId: "a",
              amountMinor: 0,
              requestedMinor: 50_000,
              status: "broken_cycle",
              inflowId: "loops-back",
            }),
          ],
          totalInflowMinor: 100_000,
        })}
      />,
    );
    expect(screen.getByText(/closes a funding loop/i)).toBeInTheDocument();
  });

  it("says so when there is nothing to draw", () => {
    render(<FlowSankey flow={flow({ accounts: [node("empty")] })} />);
    expect(screen.getByText(/no money flow to chart yet/i)).toBeInTheDocument();
  });
});

/**
 * The residual the pass stopped flooring, and the picture stopped omitting.
 *
 * WP-Q deliberately made `ScopeAccountPlan.leftoverMinor` signed: negative means
 * more is committed to leave an account than reaches it, which happens exactly
 * when a member holds income in a personal account other than the one their
 * transfers leave (decision 11) and has to consolidate before the month works.
 * `if (leftoverMinor > 0)` drew nothing for that account at all, so the one node
 * worth reading twice was the one node with no ribbon on it.
 */
describe("buildGraph — an account that has to be consolidated into", () => {
  it("draws the gap as money still to arrive, rather than omitting it", () => {
    const { nodes, links } = buildGraph(
      flow({
        accounts: [node("cur", { incomeMinor: 100_000, leftoverMinor: -20_000 })],
        edges: [
          edge({
            fromAccountId: "cur",
            toAccountId: null,
            amountMinor: 120_000,
            requestedMinor: 120_000,
          }),
        ],
      }),
    );

    const gap = links.find((l) => l.kind === "consolidate");
    expect(gap).toMatchObject({
      value: 20_000,
      target: 0,
      fromName: "to consolidate",
      toName: "cur",
      note: "more is committed to leave here than reaches it",
    });
    expect(nodes[gap!.source]).toEqual({ name: "to consolidate", isAccount: false });

    // ...and with it drawn, the node's ribbons meet: £1,000 in and £200 to
    // find against £1,200 committed out.
    const inMinor = links.filter((l) => l.target === 0).reduce((s, l) => s + l.value, 0);
    const outMinor = links.filter((l) => l.source === 0).reduce((s, l) => s + l.value, 0);
    expect(inMinor).toBe(outMinor);
  });

  it("draws neither ribbon for an account that ends the month at exactly zero", () => {
    const { links } = buildGraph(
      flow({ accounts: [node("pot", { incomeMinor: 0, spendingMinor: 0, leftoverMinor: 0 })] }),
    );
    expect(links).toEqual([]);
  });
});
