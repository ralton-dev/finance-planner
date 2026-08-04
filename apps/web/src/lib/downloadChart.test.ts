import { afterEach, describe, expect, it } from "vitest";
import { chartFileName, chartSize, findChartSvg, serializeChartSvg } from "./downloadChart.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function container(withSvg: boolean, attrs: Record<string, string> = {}): HTMLDivElement {
  const div = document.createElement("div");
  if (withSvg) {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    const text = document.createElementNS(SVG_NS, "text");
    text.textContent = "£1,200.00";
    svg.appendChild(text);
    div.appendChild(svg);
  }
  document.body.appendChild(div);
  return div;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findChartSvg", () => {
  it("finds the chart's svg inside its container", () => {
    const node = container(true);
    expect(findChartSvg(node)?.tagName).toBe("svg");
  });

  it("returns null when the chart has not rendered (or is an empty state)", () => {
    expect(findChartSvg(container(false))).toBeNull();
    expect(findChartSvg(null)).toBeNull();
    expect(findChartSvg(undefined)).toBeNull();
  });
});

describe("chartSize", () => {
  it("prefers the svg's own width/height attributes", () => {
    const svg = findChartSvg(container(true, { width: "640", height: "220" }))!;
    expect(chartSize(svg)).toEqual({ width: 640, height: 220 });
  });

  it("falls back to a sane size when nothing has been laid out", () => {
    const svg = findChartSvg(container(true))!;
    expect(chartSize(svg)).toEqual({ width: 900, height: 420 });
  });
});

describe("serializeChartSvg", () => {
  it("produces a standalone document: namespace, size, viewBox, font", () => {
    const svg = findChartSvg(container(true, { width: "640", height: "220" }))!;
    const markup = serializeChartSvg(svg);

    expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(markup).toContain('width="640"');
    expect(markup).toContain('height="220"');
    expect(markup).toContain('viewBox="0 0 640 220"');
    expect(markup).toContain("JetBrains Mono");
    // The chart's own content survives the round trip.
    expect(markup).toContain("£1,200.00");
  });

  it("keeps an existing viewBox rather than inventing one", () => {
    const svg = findChartSvg(
      container(true, { width: "100", height: "50", viewBox: "0 0 200 100" }),
    )!;
    expect(serializeChartSvg(svg)).toContain('viewBox="0 0 200 100"');
  });

  it("does not mutate the on-screen chart", () => {
    const svg = findChartSvg(container(true))!;
    serializeChartSvg(svg);
    expect(svg.getAttribute("width")).toBeNull();
    expect(svg.getAttribute("font-family")).toBeNull();
  });
});

describe("chartFileName", () => {
  it("slugifies the chart name", () => {
    expect(chartFileName("money flow")).toBe("money-flow.png");
    expect(chartFileName("  Net Worth  ")).toBe("net-worth.png");
    expect(chartFileName("where the month goes (£)")).toBe("where-the-month-goes.png");
  });

  it("falls back when the name has nothing usable in it", () => {
    expect(chartFileName("///")).toBe("chart.png");
    expect(chartFileName("")).toBe("chart.png");
  });
});
