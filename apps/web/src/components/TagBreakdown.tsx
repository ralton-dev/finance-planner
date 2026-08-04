import { useMemo, useRef } from "react";
import { groupByTag, shouldChartTags, type TaggedLine } from "../lib/tags.js";
import { DownloadButton } from "./DownloadButton.js";
import { TagBarList } from "./TagBarList.js";

/**
 * The month's outgoings sliced by tag — a ranked bar list of what each label
 * costs. Shared by the account plan and the household plan; both hand it plan
 * lines that carry a tag and a required monthly cost.
 *
 * Renders nothing at all when there is nothing to say (no lines, or one
 * untagged blob that would only restate the "required / mo" KPI).
 *
 * The bar list replaced a treemap, and with it went the lazy chunk: the list is
 * hand-drawn SVG, so there is no chart library to code-split. The export came
 * back with it — `DownloadButton` serializes the first `<svg>` inside the
 * container below, which is the list itself.
 *
 * No `ChartFrame`, deliberately. Its job is to veil a whole chart because a
 * recharts SVG writes its figures where privacy mode can't reach them; this one
 * marks each amount with `.amount`, so the money goes soft while the tags and
 * the ranking stay readable. Nothing leaks through the export either — the
 * download button hides itself while privacy mode is on.
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

      {/* Plain wrapper: all the export needs is an element to look inside. */}
      <div ref={chartRef}>
        <TagBarList groups={groups} currency={currency} />
      </div>
    </>
  );
}
