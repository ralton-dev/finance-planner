import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { THEME_ATTRIBUTE, ThemeProvider, useTheme } from "../contexts/ThemeContext.js";
import {
  FALLBACK_CHART_COLORS,
  readChartColors,
  readToken,
  resolveToken,
  useChartColors,
} from "./chartColors.js";

/** The tokens under test, injected as a real stylesheet: jsdom resolves custom
 *  properties, but it has never seen the app's styles.css. */
function styleTokens(css: string): void {
  const style = document.createElement("style");
  style.dataset.testTokens = "";
  style.textContent = css;
  document.head.append(style);
}

afterEach(() => {
  for (const node of document.querySelectorAll("style[data-test-tokens]")) node.remove();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  localStorage.clear();
});

describe("readToken", () => {
  it("reads a custom property off the document root", () => {
    styleTokens(":root { --funded: #123456; }");
    expect(readToken("--funded", "#000000")).toBe("#123456");
  });

  it("falls back when nothing declares the token", () => {
    expect(readToken("--nothing-declares-this", "#abcdef")).toBe("#abcdef");
  });
});

describe("resolveToken", () => {
  it("resolves a lone var() reference", () => {
    styleTokens(":root { --tag-1: #b89df0; }");
    expect(resolveToken("var(--tag-1)")).toBe("#b89df0");
    expect(resolveToken("  var( --tag-1 )  ")).toBe("#b89df0");
  });

  it("leaves a plain colour alone", () => {
    expect(resolveToken("#123456")).toBe("#123456");
  });

  it("hands back the reference when the token is undeclared, rather than nothing", () => {
    expect(resolveToken("var(--never-declared)")).toBe("var(--never-declared)");
  });
});

describe("readChartColors", () => {
  it("falls back to the dark palette when no stylesheet has loaded", () => {
    expect(readChartColors()).toEqual(FALLBACK_CHART_COLORS);
  });

  it("reads every colour from the tokens", () => {
    styleTokens(`
      :root {
        --ground: #010101; --panel: #020202; --rule: #030303; --rule-2: #040404;
        --ink: #050505; --ink-2: #060606; --ink-3: #070707;
        --funded: #080808; --needs-you: #090909; --alert: #0a0a0a;
        --link: #0b0b0b; --accent: #0d0d0d;
        --tag-1: #111111; --tag-2: #222222; --tag-3: #333333;
        --tag-4: #444444; --tag-5: #555555; --tag-6: #666666;
        --tag-untagged: #777777; --tag-ink: #888888;
        --shadow-tip: 0 4px 14px #999999;
      }
    `);
    const colors = readChartColors();
    expect(colors.ground).toBe("#010101");
    expect(colors.panel).toBe("#020202");
    expect(colors.rule).toBe("#030303");
    expect(colors.ruleStrong).toBe("#040404");
    expect(colors.ink).toBe("#050505");
    expect(colors.ink2).toBe("#060606");
    expect(colors.ink3).toBe("#070707");
    expect(colors.tags).toEqual(["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"]);
    expect(colors.untagged).toBe("#777777");
    expect(colors.tagInk).toBe("#888888");
    expect(colors.tipShadow).toBe("0 4px 14px #999999");
    // The series ramp is built from the status colours, not a set of its own:
    // funded, accent, link, needs-you, alert.
    expect(colors.series).toEqual(["#080808", "#0d0d0d", "#0b0b0b", "#090909", "#0a0a0a"]);
  });

  it("takes each token on its own, so a partial theme still draws", () => {
    styleTokens(":root { --alert: #ff0000; }");
    const colors = readChartColors();
    expect(colors.alert).toBe("#ff0000");
    expect(colors.funded).toBe(FALLBACK_CHART_COLORS.funded);
  });
});

describe("useChartColors", () => {
  function Probe() {
    const { funded, tags } = useChartColors();
    const { cycle } = useTheme();
    return (
      <>
        <output>
          {funded} {tags[0]}
        </output>
        <button type="button" onClick={cycle}>
          next theme
        </button>
      </>
    );
  }

  it("re-resolves when the theme changes", () => {
    styleTokens(`
      :root, :root[data-theme="dark"] { --funded: #7be087; --tag-1: #b89df0; }
      :root[data-theme="light"] { --funded: #1e7a5a; --tag-1: #6d4ca8; }
    `);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("#7be087 #b89df0");

    fireEvent.click(screen.getByRole("button", { name: "next theme" }));
    expect(screen.getByRole("status")).toHaveTextContent("#1e7a5a #6d4ca8");

    // …and back again: dark → light → system (no attribute) → dark.
    fireEvent.click(screen.getByRole("button", { name: "next theme" }));
    fireEvent.click(screen.getByRole("button", { name: "next theme" }));
    expect(screen.getByRole("status")).toHaveTextContent("#7be087 #b89df0");
  });
});

/**
 * Colours belong to the token set, not to a component. Charts were the only
 * place that ever needed a literal — an SVG presentation attribute cannot hold
 * a `var()` — and that need is now met once, in `chartColors.ts`, behind a
 * documented fallback palette. Nothing else in `src/` may name a colour.
 */
describe("no colour literals outside the token set", () => {
  /** Vitest runs from the package root, so this is `apps/web/src`. */
  const SRC = join(process.cwd(), "src");
  /** The one file allowed to spell colours out: the fallback palette itself. */
  const ALLOWED = ["lib/chartColors.ts"];
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/;

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
      return [path];
    });
  }

  it("finds none", () => {
    const offenders = sources(SRC)
      .filter((path) => !ALLOWED.includes(relative(SRC, path)))
      .flatMap((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .map((text, i) => ({ file: relative(SRC, path), line: i + 1, text: text.trim() }))
          .filter(({ text }) => LITERAL.test(text)),
      );
    expect(offenders).toEqual([]);
  });

  it("would catch one coming back", () => {
    expect(LITERAL.test('const RESERVED = "#b89df0";')).toBe(true);
    expect(LITERAL.test("boxShadow: '0 4px 14px rgba(0, 0, 0, 0.45)'")).toBe(true);
    expect(LITERAL.test('color: colors.accent, fill: "var(--tag-1)"')).toBe(false);
  });
});
