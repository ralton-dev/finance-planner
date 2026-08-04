import { formatMinor } from "../lib/money.js";
import type { PreviewImpact } from "../lib/planPreview.js";

/**
 * "What would this do?" in three lines: the headroom before and after, the gap
 * before and after, and — the part people actually care about — which goals it
 * knocks off track.
 *
 * Only a worsening is coloured. A payment that improves the plan is unusual
 * enough to notice on its own; painting it green would make every preview look
 * like a verdict.
 */
export function PreviewStrip({ impact }: { impact: PreviewImpact }) {
  const c = impact.currency;
  return (
    <div className="preview-strip" role="status" aria-label="preview impact">
      <Row
        label="left over"
        fromMinor={impact.leftoverFromMinor}
        toMinor={impact.leftoverToMinor}
        currency={c}
        warn={impact.leftoverWorse}
      />
      <Row
        label="shortfall"
        fromMinor={impact.shortfallFromMinor}
        toMinor={impact.shortfallToMinor}
        currency={c}
        warn={impact.shortfallWorse}
      />
      {impact.newlyAtRisk.length > 0 ? (
        <p className="preview-note warn">puts at risk: {impact.newlyAtRisk.join(", ")}</p>
      ) : impact.unchanged ? (
        <p className="preview-note">nothing in the plan moves.</p>
      ) : (
        <p className="preview-note">no goal falls behind.</p>
      )}
    </div>
  );
}

function Row({
  label,
  fromMinor,
  toMinor,
  currency,
  warn,
}: {
  label: string;
  fromMinor: number;
  toMinor: number;
  currency: string;
  warn: boolean;
}) {
  return (
    <div className={warn ? "preview-row warn" : "preview-row"}>
      <span className="preview-label">{label}</span>
      <span className="amount">{formatMinor(fromMinor, currency)}</span>
      <span className="preview-arrow" aria-hidden="true">
        →
      </span>
      <span className="amount preview-to">{formatMinor(toMinor, currency)}</span>
    </div>
  );
}
