import { useMemo } from "react";
import { groupByTag, shouldChartTags, type TaggedLine } from "../lib/tags.js";
import { TagBarList } from "./TagBarList.js";

/**
 * The month's outgoings sliced by tag — a ranked bar list of what each label
 * costs. Shared by the account plan and the household plan; both hand it plan
 * lines that carry a tag and a required monthly cost.
 *
 * Renders nothing at all when there is nothing to say (no lines, or one
 * untagged blob that would only restate the "required / mo" KPI).
 *
 * The bar list replaced a treemap, and with it went the lazy chunk, the chart
 * frame and the PNG export: all three existed for recharts. Plain divs need no
 * code-splitting, and privacy mode already blurs `.amount` wherever it appears,
 * so the figures go soft without a veil over the whole section.
 */
export function TagBreakdown({ lines, currency }: { lines: TaggedLine[]; currency: string }) {
  const groups = useMemo(() => groupByTag(lines), [lines]);

  if (!shouldChartTags(groups)) return null;

  return (
    <>
      <div className="section-head">
        <h2>where the month goes</h2>
        <span className="meta">
          [{groups.length} {groups.length === 1 ? "tag" : "tags"} · required / mo]
        </span>
      </div>

      <TagBarList groups={groups} currency={currency} />
    </>
  );
}
