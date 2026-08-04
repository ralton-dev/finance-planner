import { useMemo } from "react";
import { useTheme } from "../contexts/ThemeContext.js";

/**
 * Chart colours, read from the stylesheet's design tokens.
 *
 * Everything else in the app says `var(--funded)` and is done. Charts can't:
 * Recharts writes colours into SVG presentation attributes (`fill`, `stroke`,
 * `stop-color`), and a presentation attribute is not a CSS declaration — it
 * cannot hold a `var()`. So the tokens are resolved off the document root here
 * and handed over as plain strings, and `useChartColors()` resolves them again
 * whenever the theme changes.
 *
 * This module is the one place in the app allowed to name a colour literally:
 * `FALLBACK_CHART_COLORS` is what a chart draws with when no stylesheet has
 * loaded (jsdom, a component test), and it is the dark palette verbatim.
 */

export interface ChartColors {
  /** The page behind the chart — cell gaps, knockouts. */
  ground: string;
  /** Raised surface: tooltips. */
  panel: string;
  /** Hairlines: gridlines and axes. */
  rule: string;
  /** The stronger hairline: tooltip borders, inert nodes. */
  ruleStrong: string;
  ink: string;
  ink2: string;
  ink3: string;
  funded: string;
  needsYou: string;
  alert: string;
  link: string;
  accent: string;
  /** Tag ramp, boldest first — the resolved twin of `tagShade()`'s `var()`s. */
  tags: string[];
  untagged: string;
  /** Ink for anything drawn *on* a tag colour. */
  tagInk: string;
  /** One colour per series where the series carry no meaning of their own
   *  (net worth: one line per currency). Drawn from the status palette so the
   *  charts read as one system. */
  series: string[];
  /** Ready-made `box-shadow` for a chart tooltip, matching `.chart-tip`. */
  tipShadow: string;
}

/** The dark palette, verbatim from `styles.css`. */
export const FALLBACK_CHART_COLORS: ChartColors = {
  ground: "#0c0c0c",
  panel: "#181818",
  rule: "#232321",
  ruleStrong: "#2e2e2c",
  ink: "#e8e6e0",
  ink2: "#a09b91",
  ink3: "#5e5a51",
  funded: "#7be087",
  needsYou: "#f6c66b",
  alert: "#f47b6b",
  link: "#7eb3f6",
  accent: "#b89df0",
  tags: ["#b89df0", "#9c84cf", "#816cae", "#67558e", "#4e3f6d", "#37294e"],
  untagged: "#4a463f",
  tagInk: "#0c0c0c",
  series: ["#7be087", "#b89df0", "#7eb3f6", "#f6c66b", "#f47b6b"],
  tipShadow: "0 4px 14px rgba(0, 0, 0, 0.45)",
};

const root = (): Element | null =>
  typeof document === "undefined" ? null : document.documentElement;

/** One token's value, or `fallback` when nothing has it (no stylesheet, an
 *  environment without `getComputedStyle`, a name that doesn't exist). */
export function readToken(name: string, fallback: string, from?: Element | null): string {
  const element = from ?? root();
  if (!element) return fallback;
  try {
    return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
}

/** `"var(--tag-1)"` → `"#b89df0"`. Anything that isn't a lone `var()` is already
 *  a colour and comes back untouched. */
export function resolveToken(value: string, from?: Element | null): string {
  const match = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
  return match ? readToken(match[1]!, value, from) : value;
}

/** Read the whole palette once. Prefer `useChartColors()` inside components —
 *  it re-reads on a theme change; this is for one-off callers. */
export function readChartColors(from?: Element | null): ChartColors {
  const element = from ?? root();
  const token = (name: string, fallback: string): string => readToken(name, fallback, element);
  const fb = FALLBACK_CHART_COLORS;

  const funded = token("--funded", fb.funded);
  const needsYou = token("--needs-you", fb.needsYou);
  const alert = token("--alert", fb.alert);
  const link = token("--link", fb.link);
  const accent = token("--accent", fb.accent);

  return {
    ground: token("--ground", fb.ground),
    panel: token("--panel", fb.panel),
    rule: token("--rule", fb.rule),
    ruleStrong: token("--rule-2", fb.ruleStrong),
    ink: token("--ink", fb.ink),
    ink2: token("--ink-2", fb.ink2),
    ink3: token("--ink-3", fb.ink3),
    funded,
    needsYou,
    alert,
    link,
    accent,
    tags: fb.tags.map((value, i) => token(`--tag-${i + 1}`, value)),
    untagged: token("--tag-untagged", fb.untagged),
    tagInk: token("--tag-ink", fb.tagInk),
    // Deliberately built from the status colours rather than a sixth token set:
    // the net-worth lines mean "a currency", not "a state", and reusing the
    // palette keeps every chart in the app looking like the same chart.
    series: [funded, accent, link, needsYou, alert],
    tipShadow: token("--shadow-tip", fb.tipShadow),
  };
}

/** The palette for the theme currently on screen, re-resolved when it changes. */
export function useChartColors(): ChartColors {
  const { resolved } = useTheme();
  return useMemo(() => {
    // `resolved` is the trigger, not an input: the values live in the DOM and
    // only move when the theme does.
    void resolved;
    return readChartColors();
  }, [resolved]);
}
