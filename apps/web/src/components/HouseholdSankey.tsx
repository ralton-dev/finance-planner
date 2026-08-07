import { api } from "../lib/api.js";
import { useAsync } from "../lib/useAsync.js";
import type { FlowDto, HouseholdPlanDto } from "../lib/types.js";
import { FlowSankey } from "./FlowSankey.js";

/**
 * The money-flow Sankey for a household plan.
 *
 * There is nothing household-shaped in it: a household is one preset over a set
 * of accounts, so this asks `GET /api/flow` for **the plan's own roster, on the
 * plan's own date** and hands the answer to the diagram every other scope is
 * drawn by. Same component, same picture — which is the point.
 *
 * ## Why it asks rather than reshaping the plan it was handed
 *
 * It used to reshape: `householdFlow(plan)` turned the `HouseholdPlanDto` this
 * component already holds into a `FlowDto` without a request. That was one
 * request cheaper and one picture wrong. A household plan reports its accounts'
 * authored movements as a single bucket at each end — `committedMinor` leaving,
 * `movementInMinor` arriving — so the reshaping had no row to draw a ribbon
 * from and sent both ends to `elsewhere`, telling a reader whose two accounts
 * were both on the screen that the money had left the picture (issue #43). The
 * flow endpoint itemises movement by movement and names both ends, because it
 * is reading the funding pass rather than a summary of it. Decision 31: the
 * second derivation is deleted, not patched.
 *
 * The extra request is only ever paid by a household that has a plan on screen,
 * and this component is already lazy — a solo user with no household never loads
 * it, let alone fetches for it.
 */
export function HouseholdSankey({ plan }: { plan: HouseholdPlanDto }) {
  // The roster as a string, so the read is re-run when the household's accounts
  // change and not when React hands back a new array of the same ones.
  const scope = plan.accounts.map((a) => a.accountId).join(",");

  const source = useAsync<FlowDto | null>(
    () => (scope ? api.flow(scope.split(","), plan.asOfDate) : Promise.resolve(null)),
    [scope, plan.asOfDate],
  );

  if (source.loading) {
    return (
      <p className="muted" style={{ fontSize: "12px" }}>
        loading chart…
      </p>
    );
  }
  // What the server refused, in the server's words. The two it has for this
  // scope — more accounts than a diagram covers, and a scope spanning two
  // currencies with no honest ribbon width — are both facts about *this*
  // household that a reader can act on, and neither is re-derived here.
  if (source.error) {
    return <p className="error">{source.error.message || "could not draw this household."}</p>;
  }

  // A household with no accounts assigned has nothing to ask about; the diagram
  // says so itself rather than this component owning a second empty state.
  const flow: FlowDto = source.data ?? {
    asOfDate: plan.asOfDate,
    currency: plan.currency,
    accounts: [],
    edges: [],
    totalInflowMinor: 0,
  };
  return <FlowSankey flow={flow} />;
}
