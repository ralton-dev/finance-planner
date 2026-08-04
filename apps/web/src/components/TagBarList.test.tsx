import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { groupByTag, type TagGroup } from "../lib/tags.js";
import { TagBarList } from "./TagBarList.js";

function group(tag: string, valueMinor: number, share: number): TagGroup {
  return { tag, valueMinor, count: 1, share };
}

/** The fill span inside each row, in the order the rows render. */
function fills(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".tag-bar-fill")];
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
    expect(lead).toHaveClass("lead");
    for (const fill of rest) expect(fill).not.toHaveClass("lead");
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

    // Two decimals: enough to separate near-equal tags, and the CSSOM drops
    // the trailing zeros of a round one anyway.
    expect(fills().map((f) => f.style.width)).toEqual(["100%", "33.33%"]);
  });

  it("survives a zero-valued group without dividing by nothing", () => {
    render(<TagBarList groups={[group("housing", 0, 0)]} currency="GBP" />);
    expect(fills()[0]!.style.width).toBe("0%");
  });

  it("marks every figure for privacy mode to blur", () => {
    render(<TagBarList groups={[group("housing", 90_000, 0.9)]} currency="GBP" />);
    expect(screen.getByText("£900.00")).toHaveClass("amount");
  });
});
