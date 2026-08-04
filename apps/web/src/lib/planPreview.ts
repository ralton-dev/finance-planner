import type { AccountPlanDto } from "./types.js";

/**
 * The difference a drafted payment would make, reduced to the three things
 * worth saying before you commit to it: what happens to the headroom, what
 * happens to the gap, and whose goals it puts at risk.
 */
export interface PreviewImpact {
  currency: string;
  leftoverFromMinor: number;
  leftoverToMinor: number;
  shortfallFromMinor: number;
  shortfallToMinor: number;
  /** Less headroom than before. */
  leftoverWorse: boolean;
  /** A bigger gap than before. */
  shortfallWorse: boolean;
  /** Existing lines that were on track and no longer are, by name. */
  newlyAtRisk: string[];
  /** True when nothing moves at all — worth saying plainly. */
  unchanged: boolean;
}

/** Compare a plan with its what-if overlay. Pure: both come from one preview. */
export function summarizePreview(base: AccountPlanDto, preview: AccountPlanDto): PreviewImpact {
  const wasOnTrack = new Map(base.lines.map((l) => [l.paymentId, l.onTrack]));
  // Only lines that already existed can be *newly* at risk; the drafted payment
  // itself is a new line, and "the thing you just added is short" is obvious.
  const newlyAtRisk = preview.lines
    .filter((l) => !l.onTrack && wasOnTrack.get(l.paymentId) === true)
    .map((l) => l.name);

  const leftoverWorse = preview.leftoverMinor < base.leftoverMinor;
  const shortfallWorse = preview.shortfallMinor > base.shortfallMinor;

  return {
    currency: preview.currency || base.currency,
    leftoverFromMinor: base.leftoverMinor,
    leftoverToMinor: preview.leftoverMinor,
    shortfallFromMinor: base.shortfallMinor,
    shortfallToMinor: preview.shortfallMinor,
    leftoverWorse,
    shortfallWorse,
    newlyAtRisk,
    unchanged:
      base.leftoverMinor === preview.leftoverMinor &&
      base.shortfallMinor === preview.shortfallMinor &&
      newlyAtRisk.length === 0,
  };
}
