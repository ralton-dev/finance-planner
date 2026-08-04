import { formatMinor } from "../lib/money.js";
import { buildMemberBars } from "../lib/tags.js";
import type { HouseholdPlanDto } from "../lib/types.js";

/**
 * One bar per member: what they are actually funding, split by tag, against the
 * full width of what they owe. A warn-coloured tail is the part their income
 * doesn't reach.
 *
 * Pure CSS — a stacked bar is four divs and a percentage, and this way it works
 * in print, in a screenshot, and without pulling a chart library into the page.
 */
export function MemberTagBars({ plan }: { plan: HouseholdPlanDto }) {
  const bars = buildMemberBars(plan);
  const c = plan.currency;
  if (bars.length === 0) return null;

  return (
    <>
      <div className="section-head">
        <h2>who carries what</h2>
        <span className="meta">[funded by tag · full width = their obligation]</span>
      </div>
      <div className="member-bars">
        {bars.map((bar) => (
          <div className="member-bar" key={bar.userId} data-testid={`member-bar-${bar.userId}`}>
            <div className="member-bar-head">
              <span className="name">{bar.displayName}</span>
              <span className="spacer" />
              <span className="amount">{formatMinor(bar.obligationMinor, c)}</span>
              <span className="dim"> / mo</span>
            </div>

            {bar.obligationMinor === 0 ? (
              <p className="muted" style={{ fontSize: "11.5px" }}>
                nothing owed this month
              </p>
            ) : (
              <>
                <div
                  className="member-bar-track"
                  role="img"
                  aria-label={`${bar.displayName}: ${formatMinor(bar.fundedMinor, c)} funded of ${formatMinor(bar.obligationMinor, c)}`}
                >
                  {bar.segments.map((s) => (
                    <span
                      key={s.tag}
                      className="member-bar-seg"
                      data-tag={s.tag}
                      style={{ width: `${s.widthPct.toFixed(3)}%`, background: s.color }}
                      title={`${s.tag} · ${formatMinor(s.valueMinor, c)}`}
                    />
                  ))}
                  {/* Costs this household's lines do not account for, funded on
                      an account outside it. Quiet, and before the red: it is
                      money that is there. */}
                  {bar.elsewhereMinor > 0 && (
                    <span
                      className="member-bar-seg elsewhere"
                      data-tag="elsewhere"
                      style={{ width: `${bar.elsewherePct.toFixed(3)}%` }}
                      title={`elsewhere in your plan · ${formatMinor(bar.elsewhereMinor, c)}`}
                    />
                  )}
                  {bar.unfundedMinor > 0 && (
                    <span
                      className="member-bar-seg unfunded"
                      data-tag="unfunded"
                      style={{ width: `${bar.unfundedPct.toFixed(3)}%` }}
                      title={`unfunded · ${formatMinor(bar.unfundedMinor, c)}`}
                    />
                  )}
                </div>

                <ul className="member-bar-legend">
                  {bar.segments.map((s) => (
                    <li key={s.tag}>
                      <i style={{ background: s.color }} />
                      {s.tag} <span className="amount">{formatMinor(s.valueMinor, c)}</span>
                    </li>
                  ))}
                  {bar.elsewhereMinor > 0 && (
                    <li className="dim">
                      <i className="elsewhere" />
                      elsewhere in your plan{" "}
                      <span className="amount">{formatMinor(bar.elsewhereMinor, c)}</span>
                    </li>
                  )}
                  {bar.unfundedMinor > 0 && (
                    <li className="warn">
                      <i className="unfunded" />
                      unfunded <span className="amount">{formatMinor(bar.unfundedMinor, c)}</span>
                    </li>
                  )}
                </ul>
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
