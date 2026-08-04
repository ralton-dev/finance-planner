import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FALLBACK_CHART_COLORS } from "../lib/chartColors.js";
import { findChartSvg } from "../lib/downloadChart.js";
import { groupByTag, type TagGroup } from "../lib/tags.js";
import { TagBarList } from "./TagBarList.js";

function group(tag: string, valueMinor: number, share: number): TagGroup {
  return { tag, valueMinor, count: 1, share };
}

/** The fill rect inside each row, in the order the rows render. */
function fills(): SVGRectElement[] {
  return [...document.querySelectorAll<SVGRectElement>('[data-bar="fill"]')];
}

describe("TagBarList", () => {
  it("renders nothing when there are no groups", () => {
    const { container } = render(<TagBarList groups={[]} currency="GBP" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("ranks the rows biggest first, whatever order they arrive in", () => {
    render(
      <TagBarList
        groups={[group("car", 10_000, 0.1), group("housing", 90_000, 0.9)]}
        currency="GBP"
      />,
    );

    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "housing£900.00/mo90.0%",
      "car£100.00/mo10.0%",
    ]);
  });

  it("gives the accent to the largest tag and nothing else", () => {
    render(
      <TagBarList
        groups={groupByTag([
          { tag: "housing", requiredMonthlyMinor: 90_000 },
          { tag: "car", requiredMonthlyMinor: 60_000 },
          { tag: "fun", requiredMonthlyMinor: 30_000 },
        ])}
        currency="GBP"
      />,
    );

    const [lead, ...rest] = fills();
    expect(lead).toHaveAttribute("fill", FALLBACK_CHART_COLORS.accent);
    for (const fill of rest) expect(fill).toHaveAttribute("fill", FALLBACK_CHART_COLORS.ink2);
  });

  it("steps the greys down the ranking", () => {
    render(
      <TagBarList
        groups={groupByTag([
          { tag: "housing", requiredMonthlyMinor: 90_000 },
          { tag: "car", requiredMonthlyMinor: 60_000 },
          { tag: "fun", requiredMonthlyMinor: 30_000 },
        ])}
        currency="GBP"
      />,
    );

    expect(fills().map((f) => f.dataset.rank)).toEqual(["0", "1", "2"]);
    // Rank is carried into the export as an opacity, not as a class: the
    // serialized copy has no stylesheet to read a ramp out of. The ramp floors
    // at 0.44 so even the quietest bar clears 3:1 against its track on light.
    expect(fills().map((f) => f.getAttribute("fill-opacity"))).toEqual(["1", "0.72", "0.62"]);
  });

  it("clamps the ramp once the ranking runs past it", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      tag: `t${i}`,
      requiredMonthlyMinor: 10_000 - i * 100,
    }));
    render(<TagBarList groups={groupByTag(many)} currency="GBP" />);

    expect(fills().map((f) => f.dataset.rank)).toEqual(["0", "1", "2", "3", "4", "5", "5", "5"]);
  });

  it("draws each bar against the biggest tag, so the top one fills the row", () => {
    render(
      <TagBarList
        groups={[group("housing", 90_000, 0.75), group("car", 30_000, 0.25)]}
        currency="GBP"
      />,
    );

    // Two decimals: enough to separate near-equal tags.
    expect(fills().map((f) => f.getAttribute("width"))).toEqual(["100.00%", "33.33%"]);
  });

  it("survives a zero-valued group without dividing by nothing", () => {
    render(<TagBarList groups={[group("housing", 0, 0)]} currency="GBP" />);
    expect(fills()[0]!.getAttribute("width")).toBe("0%");
  });

  it("marks every figure for privacy mode to blur", () => {
    render(<TagBarList groups={[group("housing", 90_000, 0.9)]} currency="GBP" />);
    const amount = screen.getByText("£900.00");
    expect(amount).toHaveClass("amount");
    // A <text>, not a <tspan>: CSS `filter` applies to graphics elements, so
    // `.privacy .amount { filter: blur(…) }` would do nothing to a span.
    expect(amount.tagName).toBe("text");
  });

  it("draws itself as an inline svg the chart export can find", () => {
    const { container } = render(
      <TagBarList groups={[group("housing", 90_000, 0.9)]} currency="GBP" />,
    );

    const svg = findChartSvg(container);
    expect(svg).not.toBeNull();
    // Explicit dimensions, or the export falls back to a generic 900×420 box.
    expect(Number(svg!.getAttribute("width"))).toBeGreaterThan(0);
    expect(Number(svg!.getAttribute("height"))).toBeGreaterThan(0);
    // No viewBox on screen — the list draws at natural type size and
    // `serializeChartSvg()` adds one sized to the width attribute.
    expect(svg!.getAttribute("viewBox")).toBeNull();
  });

  it("names itself for a screen reader rather than being a mute graphic", () => {
    render(
      <TagBarList
        groups={[group("housing", 90_000, 0.75), group("car", 30_000, 0.25)]}
        currency="GBP"
      />,
    );

    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(document.querySelector("svg > title")?.textContent).toContain("2 tags");
  });

  it("keeps the colours as attributes, so they survive into the exported png", () => {
    render(<TagBarList groups={[group("housing", 90_000, 0.9)]} currency="GBP" />);

    // Every painted thing names its colour on the element itself; nothing here
    // is inherited from a class or a var().
    const marks = document.querySelectorAll('[role="listitem"] text, [role="listitem"] rect');
    expect(marks).not.toHaveLength(0);
    for (const node of marks) expect(node.getAttribute("fill")).toBeTruthy();
  });
});
