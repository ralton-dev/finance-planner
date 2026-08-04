import { lineStatus, type AccountPlanDto } from "./types.js";

/**
 * The difference a drafted payment would make, reduced to the things worth
 * saying before you commit to it: what happens to the headroom, what happens to
 * the gap, whose goals it puts at risk, and whose it pushes onto money that has
 * not moved yet.
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
  /**
   * Existing lines the plan still covers, but now only because money somebody
   * has yet to move is paying for them.
   *
   * `onTrack` cannot see this: a line degrading `funded → awaiting_transfer` is
   * on track either side of the change, so the preview used to report "no goal
   * falls behind" while quietly making a goal depend on a transfer. A smaller
   * claim than `newlyAtRisk` and never coloured red — the remedy is to move
   * money, not to cut something.
   */
  newlyAwaiting: string[];
  /** True when nothing moves at all — worth saying plainly. */
  unchanged: boolean;
}

/** Compare a plan with its what-if overlay. Pure: both come from one preview. */
export function summarizePreview(base: AccountPlanDto, preview: AccountPlanDto): PreviewImpact {
  const before = new Map(base.lines.map((l) => [l.paymentId, lineStatus(l)]));
  // Only lines that already existed can be *newly* anything; the drafted payment
  // itself is a new line, and "the thing you just added is short" is obvious.
  const newlyAtRisk = preview.lines
    .filter((l) => !l.onTrack && before.get(l.paymentId) === "funded")
    .map((l) => l.name);
  const newlyAwaiting = preview.lines
    .filter((l) => lineStatus(l) === "awaiting_transfer" && before.get(l.paymentId) === "funded")
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
    newlyAwaiting,
    unchanged:
      base.leftoverMinor === preview.leftoverMinor &&
      base.shortfallMinor === preview.shortfallMinor &&
      newlyAtRisk.length === 0 &&
      newlyAwaiting.length === 0,
  };
}
