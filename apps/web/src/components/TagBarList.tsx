import { useId, useMemo } from "react";
import { readToken, useChartColors } from "../lib/chartColors.js";
import { formatMinor } from "../lib/money.js";
import type { TagGroup } from "../lib/tags.js";

/**
 * Where the month goes, as a ranked list: one row per tag, biggest first, with
 * a bar as long as the tag is expensive.
 *
 * A bar list rather than a treemap because the question is an ordering — "what
 * costs me most?" — and a list answers it in one downward read, with the
 * figures on the same line as the shape instead of in a legend underneath.
 *
 * Colour carries rank, not identity: the biggest tag takes the accent and
 * everything below it steps down through greys. The hue must not imply a state,
 * since the app spends green/amber/red on exactly that.
 *
 * Drawn as one inline SVG rather than divs, for two reasons:
 *
 *  - the chart export (`lib/downloadChart.ts`) works by finding an inline
 *    `<svg>` in the section's container, serializing it and painting it to a
 *    canvas. A div-based list is invisible to it, which is how this section
 *    quietly dropped out of "png ↓" when the treemap went.
 *  - the serialized clone carries no stylesheet, so anything a bar got from a
 *    CSS class or a `var()` would be missing from the PNG. Every colour here is
 *    therefore a resolved presentation attribute from `useChartColors()`, which
 *    re-reads the tokens when the theme changes — so a light-theme export comes
 *    out light.
 *
 * Still no chart library, and still one element per figure: `.amount` stays on
 * the money `<text>` nodes so privacy mode blurs them (a `<text>` and not a
 * `<tspan>` — CSS `filter` applies to graphics elements, not to text spans).
 *
 * Geometry is in percentages against the SVG viewport, so the list fills its
 * column on screen at natural type size (no `viewBox`, so nothing scales), and
 * the same percentages re-resolve against the fixed `EXPORT_WIDTH` that
 * `chartSize()` reads off the width attribute when the PNG is made.
 */

/** How many steps the grey ramp has; past that rows share the quietest one. */
const RANKS = 6;
/** Opacity of `--ink-2` per rank below the lead, as an attribute the export can
 *  carry. Index 0 is unused: rank 0 is the accent.
 *
 *  Floored at 0.44 rather than the 0.22 it started at: on the light theme the
 *  bottom of the old ramp reached 1.29:1 against the track and the bar simply
 *  wasn't there. Still a descending ramp — and the share is printed as text on
 *  the same line, so length and colour never have to carry the ranking alone. */
const RANK_INK: readonly number[] = [1, 0.72, 0.62, 0.54, 0.48, 0.44];

/** Logical width the PNG is drawn at. On screen the SVG is stretched to its
 *  column by an inline width, which leaves this as the export's own size —
 *  every x is a percentage, so the two agree. */
const EXPORT_WIDTH = 720;
const FONT = 11.5;
/** Baseline of the row's text, then the bar under it. */
const TEXT_Y = 11;
const TRACK_Y = 16;
const TRACK_H = 8;
const ROW_GAP = 9;
const ROW_H = TRACK_Y + TRACK_H + ROW_GAP;
/** Right edge of the amount column, and where "/mo" picks up after it. The
 *  share sits hard right, so the two never meet. */
const AMOUNT_X = "72%";
const PER_MONTH_X = "73%";
/** SVG text does not ellipsize, so an over-long tag is cut here instead. */
const NAME_MAX = 26;
/** …and clipped here as well, because the cap is in characters while the row
 *  is in percentages: on a narrow column 26 characters would reach the amount.
 *  The clip is generous enough that it only ever bites on a phone. */
const NAME_CLIP = "50%";

const TABULAR = { fontVariantNumeric: "tabular-nums" } as const;

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

const clip = (tag: string): string =>
  tag.length > NAME_MAX ? `${tag.slice(0, NAME_MAX - 1)}…` : tag;

interface TagBarListProps {
  /** One bucket per tag. Ranked here regardless of the order they arrive in. */
  groups: readonly TagGroup[];
  currency: string;
}

export function TagBarList({ groups, currency }: TagBarListProps) {
  const colors = useChartColors();
  // `useId()` spells ids with colons, which a `url(#…)` reference is better off
  // without; the clip travels into the exported document with the rest.
  const nameClip = `tag-name-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // The bar's own ground. Not in `ChartColors` — read straight off the token,
  // falling back to the panel colour rather than to a literal.
  const track = useMemo(() => readToken("--ground-2", colors.panel), [colors]);
  // `groupByTag()` already sorts biggest-first, but the ranking *is* this
  // component's message — so it does not take that on trust.
  const ranked = useMemo(() => [...groups].sort((a, b) => b.valueMinor - a.valueMinor), [groups]);
  if (ranked.length === 0) return null;

  // Bars are drawn against the biggest tag, not against the total: the top bar
  // fills the row and the rest read as fractions of it. The share of the total
  // is printed on the line, where it can't be misread off a length.
  const widest = ranked[0]!.valueMinor;
  const height = ranked.length * ROW_H - ROW_GAP;

  return (
    <svg
      className="tag-bar-chart"
      // A list, because that is what it is: the rows carry the figures as real
      // text, so a screen reader gets the ranking rather than "graphic".
      role="list"
      width={EXPORT_WIDTH}
      height={height}
      style={{ display: "block", width: "100%", margin: "0.75rem 0 1.75rem" }}
    >
      <title>
        {`${ranked.length} ${ranked.length === 1 ? "tag" : "tags"} ranked by required monthly cost, biggest first`}
      </title>
      <defs>
        {/* User space, so the percentage is of the row's width whatever the
            column is doing — the one thing a character count cannot know. */}
        <clipPath id={nameClip} clipPathUnits="userSpaceOnUse">
          <rect x="0" y="0" width={NAME_CLIP} height="100%" />
        </clipPath>
      </defs>
      {ranked.map((g, i) => {
        const rank = Math.min(i, RANKS - 1);
        return (
          <g key={g.tag} role="listitem" transform={`translate(0 ${i * ROW_H})`}>
            <text x="0" y={TEXT_Y} fontSize={FONT} fill={colors.ink} clipPath={`url(#${nameClip})`}>
              {clip(g.tag)}
            </text>
            <text
              className="amount"
              x={AMOUNT_X}
              y={TEXT_Y}
              textAnchor="end"
              fontSize={FONT}
              fontWeight={600}
              fill={colors.ink}
              style={TABULAR}
            >
              {formatMinor(g.valueMinor, currency)}
            </text>
            <text x={PER_MONTH_X} y={TEXT_Y} fontSize={FONT} fill={colors.ink3}>
              /mo
            </text>
            <text
              x="100%"
              y={TEXT_Y}
              textAnchor="end"
              fontSize={FONT}
              fill={colors.ink3}
              style={TABULAR}
            >
              {pct(g.share)}
            </text>
            <rect
              data-bar="track"
              x="0"
              y={TRACK_Y}
              width="100%"
              height={TRACK_H}
              rx="1"
              fill={track}
              aria-hidden="true"
            />
            <rect
              data-bar="fill"
              data-rank={rank}
              x="0"
              y={TRACK_Y}
              width={widest > 0 ? `${((g.valueMinor / widest) * 100).toFixed(2)}%` : "0%"}
              height={TRACK_H}
              rx="1"
              fill={i === 0 ? colors.accent : colors.ink2}
              fillOpacity={RANK_INK[rank]}
              aria-hidden="true"
            />
          </g>
        );
      })}
    </svg>
  );
}
