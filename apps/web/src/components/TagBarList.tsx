import { useMemo } from "react";
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
 * Pure DOM — no chart library, so it prints, screenshots and survives a page
 * with no JavaScript chunk left to load.
 */

/** How many steps the stylesheet's grey ramp has; past that rows share the
 *  quietest one. Six matches the `--tag-1…--tag-6` ramp's depth. */
const RANKS = 6;

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

interface TagBarListProps {
  /** One bucket per tag. Ranked here regardless of the order they arrive in. */
  groups: readonly TagGroup[];
  currency: string;
}

export function TagBarList({ groups, currency }: TagBarListProps) {
  // `groupByTag()` already sorts biggest-first, but the ranking *is* this
  // component's message — so it does not take that on trust.
  const ranked = useMemo(() => [...groups].sort((a, b) => b.valueMinor - a.valueMinor), [groups]);
  if (ranked.length === 0) return null;

  // Bars are drawn against the biggest tag, not against the total: the top bar
  // fills the row and the rest read as fractions of it. The share of the total
  // is printed on the line, where it can't be misread off a length.
  const widest = ranked[0]!.valueMinor;

  return (
    <ul className="tag-bars">
      {ranked.map((g, i) => (
        <li key={g.tag} className="tag-bar">
          <span className="tag-bar-head">
            <span className="tag-bar-name">{g.tag}</span>
            <span className="amount">{formatMinor(g.valueMinor, currency)}</span>
            <span className="dim">/mo</span>
            <span className="tag-bar-share">{pct(g.share)}</span>
          </span>
          <span className="tag-bar-track" aria-hidden="true">
            <span
              className={`tag-bar-fill${i === 0 ? " lead" : ""}`}
              data-rank={Math.min(i, RANKS - 1)}
              style={{ width: `${widest > 0 ? ((g.valueMinor / widest) * 100).toFixed(2) : 0}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}
