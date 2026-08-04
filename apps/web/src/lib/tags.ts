import type { HouseholdPlanDto } from "./types.js";

/**
 * Grouping plan lines by their free-text tag — the shape behind both the
 * "where the month goes" treemap and the per-member stacked bars.
 *
 * Tags never drive the maths: they are a label the user puts on a payment, and
 * everything here is a pure re-slicing of numbers the plan already computed.
 */

/** Bucket for lines the user never labelled. Not a real tag — never sent back. */
export const UNTAGGED = "untagged";

/** The ramp lives in the stylesheet (`--tag-1`…`--tag-6`, `--tag-untagged`) so
 *  each theme brings its own. These are the token *references*: a DOM consumer
 *  can drop one straight into a style, and chart code — where an SVG attribute
 *  can't hold a `var()` — resolves it with `resolveToken()`. */
const TAG_SHADES = [
  "var(--tag-1)",
  "var(--tag-2)",
  "var(--tag-3)",
  "var(--tag-4)",
  "var(--tag-5)",
  "var(--tag-6)",
] as const;
const UNTAGGED_SHADE = "var(--tag-untagged)";

export interface TagGroup {
  tag: string;
  /** Sum of the group's required monthly cost, in minor units. */
  valueMinor: number;
  /** How many plan lines landed in the group. */
  count: number;
  /** 0..1 of the total across all groups. */
  share: number;
}

/** The slice of a plan line (account or household) that grouping needs. */
export interface TaggedLine {
  tag?: string | null;
  requiredMonthlyMinor: number;
}

/** Normalise a raw tag: trimmed, or the untagged bucket when empty/absent. */
export function tagKey(tag: string | null | undefined): string {
  return (tag ?? "").trim() || UNTAGGED;
}

/** Stable colour for a tag, by its rank in the group list (biggest = boldest).
 *  The untagged bucket always reads as the quiet one. */
export function tagShade(tag: string, index: number): string {
  if (tag === UNTAGGED) return UNTAGGED_SHADE;
  return TAG_SHADES[index % TAG_SHADES.length]!;
}

/**
 * Plan lines → one bucket per tag, biggest first. Lines costing nothing this
 * month are dropped: a zero-area cell is noise in a treemap, and a zero-width
 * segment is invisible in a bar.
 */
export function groupByTag(lines: readonly TaggedLine[]): TagGroup[] {
  const totals = new Map<string, { valueMinor: number; count: number }>();
  for (const line of lines) {
    if (line.requiredMonthlyMinor <= 0) continue;
    const key = tagKey(line.tag);
    const entry = totals.get(key) ?? { valueMinor: 0, count: 0 };
    entry.valueMinor += line.requiredMonthlyMinor;
    entry.count += 1;
    totals.set(key, entry);
  }

  const total = [...totals.values()].reduce((sum, e) => sum + e.valueMinor, 0);
  return [...totals.entries()]
    .map(([tag, e]) => ({
      tag,
      valueMinor: e.valueMinor,
      count: e.count,
      share: total > 0 ? e.valueMinor / total : 0,
    }))
    .sort((a, b) => b.valueMinor - a.valueMinor || a.tag.localeCompare(b.tag));
}

/** Whether a tag chart says anything. One untagged blob is just the total the
 *  KPI strip already shows, so that case renders nothing at all. */
export function shouldChartTags(groups: readonly TagGroup[]): boolean {
  if (groups.length === 0) return false;
  if (groups.length > 1) return true;
  return groups[0]!.tag !== UNTAGGED;
}

// --- per-member bars --------------------------------------------------------

export interface MemberBarSegment {
  tag: string;
  valueMinor: number;
  /** Percentage of the member's obligation this segment occupies. */
  widthPct: number;
  color: string;
}

export interface MemberBar {
  userId: string;
  displayName: string;
  /** Full width of the bar: everything this member is on the hook for. */
  obligationMinor: number;
  fundedMinor: number;
  /** Obligation their income can't cover — the warn-coloured tail. */
  unfundedMinor: number;
  unfundedPct: number;
  segments: MemberBarSegment[];
}

/**
 * One bar per household member: their funded allocations grouped by the tag of
 * the payment they fund, with whatever is left of their obligation as an
 * unfunded remainder. Widths are percentages of the member's obligation, so the
 * segments plus the remainder always fill the bar exactly.
 */
export function buildMemberBars(plan: HouseholdPlanDto): MemberBar[] {
  return plan.members.map((member) => {
    const byTag = new Map<string, number>();
    for (const line of plan.lines) {
      const allocation = line.allocations.find((a) => a.userId === member.userId);
      if (!allocation || allocation.fundedMinor <= 0) continue;
      const key = tagKey(line.tag);
      byTag.set(key, (byTag.get(key) ?? 0) + allocation.fundedMinor);
    }

    const fundedMinor = [...byTag.values()].reduce((sum, v) => sum + v, 0);
    // Funding can never exceed the obligation, but a plan built by hand might
    // say otherwise — widen the denominator rather than overflow the bar.
    const denominator = Math.max(member.obligationMinor, fundedMinor);
    const segments = [...byTag.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag, valueMinor], i) => ({
        tag,
        valueMinor,
        widthPct: denominator > 0 ? (valueMinor / denominator) * 100 : 0,
        color: tagShade(tag, i),
      }));

    const unfundedMinor = Math.max(0, member.obligationMinor - fundedMinor);
    // Derived from the segments rather than computed independently, so the bar
    // always adds up to exactly 100% however the divisions rounded.
    const segmentsPct = segments.reduce((sum, s) => sum + s.widthPct, 0);
    return {
      userId: member.userId,
      displayName: member.displayName ?? "member",
      obligationMinor: member.obligationMinor,
      fundedMinor,
      unfundedMinor,
      unfundedPct: unfundedMinor > 0 ? Math.max(0, 100 - segmentsPct) : 0,
      segments,
    };
  });
}
