import { useMemo } from "react";
import { ResponsiveContainer, Tooltip, Treemap } from "recharts";
import { useTheme } from "../contexts/ThemeContext.js";
import { resolveToken, useChartColors } from "../lib/chartColors.js";
import { formatCompactMinor, formatMinor } from "../lib/money.js";
import { tagShade, type TagGroup } from "../lib/tags.js";

/**
 * Where the month goes: one cell per tag, sized by what it costs each month.
 *
 * Deliberately monochrome-ish — the app already spends green/amber/red on
 * status, so a treemap in five hues would imply meaning the tags don't carry.
 * Size is the message; colour is only there to tell the cells apart.
 */

/** Recharts types treemap data as an open record, so the cell carries an index
 *  signature alongside the fields the tooltip and the cell renderer read. */
interface Cell {
  name: string;
  size: number;
  share: number;
  count: number;
  fill: string;
  [key: string]: string | number;
}

interface CellProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** 0 is the root rectangle covering the whole plot; the tags are at 1. */
  depth?: number;
  index?: number;
  name?: string;
  size?: number;
  fill?: string;
  currency?: string;
}

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

/** Labels only where they fit: a clipped word is worse than no word. */
function TagCell({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  depth = 1,
  name = "",
  size = 0,
  fill = "",
  currency = "GBP",
}: CellProps) {
  const colors = useChartColors();
  // Recharts also hands the content the root rectangle. Drawing it would tint
  // the gaps between the real cells, so it is skipped.
  if (depth === 0) return null;
  const roomForLabel = width > 64 && height > 26;
  const roomForValue = width > 78 && height > 44;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={fill || colors.tags[0]}
        fillOpacity={0.82}
        stroke={colors.ground}
        strokeWidth={2}
      />
      {roomForLabel && (
        <text x={x + 8} y={y + 18} fontSize={11.5} fill={colors.tagInk} fontWeight={600}>
          {name}
        </text>
      )}
      {roomForValue && (
        <text x={x + 8} y={y + 34} fontSize={11} fill={colors.tagInk} fillOpacity={0.72}>
          {formatCompactMinor(size, currency)}
        </text>
      )}
    </g>
  );
}

interface TipEntry {
  payload?: Cell;
}

function TagTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: TipEntry[];
  currency: string;
}) {
  const cell = payload?.[0]?.payload;
  if (!active || !cell) return null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-head">{cell.name}</div>
      <div className="chart-tip-row">
        <i style={{ background: cell.fill }} />
        <span className="chart-tip-label">per month</span>
        <b>{formatMinor(cell.size, currency)}</b>
      </div>
      <div className="chart-tip-row">
        <i style={{ background: "transparent" }} />
        <span className="chart-tip-label">share</span>
        <b>{pct(cell.share)}</b>
      </div>
    </div>
  );
}

export function TagTreemap({ groups, currency }: { groups: TagGroup[]; currency: string }) {
  // `tagShade` hands back a `var(--tag-n)` reference, which is what a DOM
  // consumer wants; an SVG `fill` attribute needs the colour itself — and which
  // colour that is depends on the theme on screen.
  const { resolved } = useTheme();
  const data: Cell[] = useMemo(
    () =>
      groups.map((g, i) => ({
        name: g.tag,
        size: g.valueMinor,
        share: g.share,
        count: g.count,
        fill: resolveToken(tagShade(g.tag, i)),
      })),
    [groups, resolved],
  );

  return (
    <div style={{ width: "100%", height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <Treemap
          data={data}
          dataKey="size"
          nameKey="name"
          isAnimationActive={false}
          content={<TagCell currency={currency} />}
        >
          <Tooltip content={<TagTooltip currency={currency} />} />
        </Treemap>
      </ResponsiveContainer>
    </div>
  );
}
