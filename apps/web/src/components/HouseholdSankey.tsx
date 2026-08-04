import { householdFlow } from "../lib/flow.js";
import type { HouseholdPlanDto } from "../lib/types.js";
import { FlowSankey } from "./FlowSankey.js";

/**
 * The money-flow Sankey for a household plan.
 *
 * There is nothing household-shaped left in it: a household is one preset over
 * a set of accounts, so this reads the plan as a flow (`householdFlow`) and
 * hands it to the diagram every other scope is drawn by. Same component, same
 * numbers, same picture — which is the point. The household plan's own figures
 * travel through untouched, so this draws exactly what it drew when the diagram
 * was a household feature.
 */
export function HouseholdSankey({ plan }: { plan: HouseholdPlanDto }) {
  return <FlowSankey flow={householdFlow(plan)} />;
}
