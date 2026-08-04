import { lazy, Suspense, useMemo, useRef } from "react";
import { formatMinor } from "../lib/money.js";
import { groupByTag, shouldChartTags, tagShade, type TaggedLine } from "../lib/tags.js";
import { ChartFrame } from "./ChartFrame.js";
import { DownloadButton } from "./DownloadButton.js";

// Keeps recharts out of the page chunk, as the Sankey and projection do.
const TagTreemap = lazy(() => import("./TagTreemap.js").then((m) => ({ default: m.TagTreemap })));

/**
 * The month's outgoings sliced by tag — a treemap plus a legend of the numbers
 * behind it. Shared by the account plan and the household plan; both hand it
 * plan lines that carry a tag and a required monthly cost.
 *
 * Renders nothing at all when there is nothing to say (no lines, or one
 * untagged blob that would only restate the "required / mo" KPI).
 */
export function TagBreakdown({ lines, currency }: { lines: TaggedLine[]; currency: string }) {
  const groups = useMemo(() => groupByTag(lines), [lines]);
  const chartRef = useRef<HTMLDivElement>(null);

  if (!shouldChartTags(groups)) return null;

  return (
    <>
      <div className="section-head">
        <h2>where the month goes</h2>
        <span className="meta">
          [{groups.length} {groups.length === 1 ? "tag" : "tags"} · required / mo]
        </span>
        <span className="spacer" />
        <DownloadButton targetRef={chartRef} name="where-the-month-goes" />
      </div>

      <ChartFrame ref={chartRef}>
        <Suspense
          fallback={
            <p className="muted" style={{ fontSize: "12px" }}>
              loading chart…
            </p>
          }
        >
          <TagTreemap groups={groups} currency={currency} />
        </Suspense>
      </ChartFrame>

      <ul className="tag-legend">
        {groups.map((g, i) => (
          <li key={g.tag}>
            <i style={{ background: tagShade(g.tag, i) }} />
            <span className="tag-legend-name">{g.tag}</span>
            <span className="amount">{formatMinor(g.valueMinor, currency)}</span>
            <span className="tag-legend-share">{(g.share * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </>
  );
}
