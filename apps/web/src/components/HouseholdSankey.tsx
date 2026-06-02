import { Layer, Rectangle, ResponsiveContainer, Sankey, Tooltip } from "recharts";
import { formatMinor } from "../lib/money.js";
import type { HouseholdPlanDto } from "../lib/types.js";

/**
 * Money-flow Sankey for a household plan. Derived entirely from the plan's
 * per-account aggregates + transfers, so the diagram always balances:
 *
 *   income ─▶ account ─▶ (transfers) ─▶ account ─▶ spending
 *                     └▶ left over
 *
 * Recharts computes node depth from the link graph, giving a natural
 * left-to-right flow: incomes, then current accounts, then pots, then outflows.
 */

type LinkKind = "income" | "transfer" | "spending" | "leftover";

const LINK_COLORS: Record<LinkKind, string> = {
  income: "#7be087", // --good
  transfer: "#b89df0", // --accent
  spending: "#f6c66b", // --warn-amber
  leftover: "#7eb3f6", // --link
};

interface SankeyNodeDatum {
  name: string;
  isAccount: boolean;
}
interface SankeyLinkDatum {
  source: number;
  target: number;
  value: number;
  kind: LinkKind;
}

export function buildGraph(plan: HouseholdPlanDto): {
  nodes: SankeyNodeDatum[];
  links: SankeyLinkDatum[];
} {
  const nodes: SankeyNodeDatum[] = [];
  const links: SankeyLinkDatum[] = [];
  const accountNode = new Map<string, number>();

  const addNode = (name: string, isAccount: boolean): number => {
    nodes.push({ name, isAccount });
    return nodes.length - 1;
  };

  // Account nodes first so transfers can reference them by index.
  for (const a of plan.accounts) {
    accountNode.set(a.accountId, addNode(a.name ?? "account", true));
  }

  for (const a of plan.accounts) {
    const idx = accountNode.get(a.accountId)!;
    if (a.monthlyIncomeMinor > 0) {
      links.push({
        source: addNode("income", false),
        target: idx,
        value: a.monthlyIncomeMinor,
        kind: "income",
      });
    }
    if (a.fundedOutflowMinor > 0) {
      links.push({
        source: idx,
        target: addNode("spending", false),
        value: a.fundedOutflowMinor,
        kind: "spending",
      });
    }
    if (a.leftoverMinor > 0) {
      links.push({
        source: idx,
        target: addNode("left over", false),
        value: a.leftoverMinor,
        kind: "leftover",
      });
    }
  }

  for (const t of plan.transfers) {
    const from = accountNode.get(t.fromAccountId);
    const to = accountNode.get(t.toAccountId);
    if (from === undefined || to === undefined || t.amountMinor <= 0) continue;
    links.push({ source: from, target: to, value: t.amountMinor, kind: "transfer" });
  }

  return { nodes, links };
}

// Recharts injects geometry props at render time, so they're optional here.
interface NodeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  index?: number;
  containerWidth?: number;
  payload?: SankeyNodeDatum & { value?: number };
  currency?: string;
}

function FlowNode({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  containerWidth = 0,
  payload,
  currency = "GBP",
}: NodeProps) {
  const onLeft = x < containerWidth / 2;
  const isAccount = payload?.isAccount ?? false;
  const label = payload?.name ?? "";
  const value = payload?.value ?? 0;
  return (
    <Layer>
      <Rectangle
        x={x}
        y={y}
        width={width}
        height={Math.max(height, 1)}
        fill={isAccount ? "#b89df0" : "#2e2e2c"}
        fillOpacity={isAccount ? 0.85 : 0.6}
      />
      <text
        x={onLeft ? x + width + 8 : x - 8}
        y={y + height / 2}
        textAnchor={onLeft ? "start" : "end"}
        dy="0.32em"
        fontSize={11}
        fill={isAccount ? "#e8e6e0" : "#a09b91"}
      >
        {label}
        {isAccount && value > 0 ? ` · ${formatMinor(value, currency)}` : ""}
      </text>
    </Layer>
  );
}

interface LinkProps {
  sourceX?: number;
  targetX?: number;
  sourceY?: number;
  targetY?: number;
  sourceControlX?: number;
  targetControlX?: number;
  linkWidth?: number;
  payload?: SankeyLinkDatum;
}

function FlowLink({
  sourceX = 0,
  targetX = 0,
  sourceY = 0,
  targetY = 0,
  sourceControlX = 0,
  targetControlX = 0,
  linkWidth = 0,
  payload,
}: LinkProps) {
  const color = LINK_COLORS[payload?.kind ?? "transfer"];
  return (
    <path
      d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={color}
      strokeWidth={Math.max(1, linkWidth)}
      strokeOpacity={0.35}
    />
  );
}

export function HouseholdSankey({ plan }: { plan: HouseholdPlanDto }) {
  const data = buildGraph(plan);
  if (data.links.length === 0) {
    return (
      <p className="muted" style={{ fontSize: "12px" }}>
        no money flow to chart yet — add income and payments to the household's accounts.
      </p>
    );
  }
  return (
    <div style={{ width: "100%", height: 440 }}>
      <ResponsiveContainer width="100%" height="100%">
        <Sankey
          data={data}
          nodePadding={26}
          nodeWidth={10}
          margin={{ top: 12, right: 120, bottom: 12, left: 120 }}
          node={<FlowNode currency={plan.currency} />}
          link={<FlowLink />}
        >
          <Tooltip
            formatter={(value) => formatMinor(Number(value), plan.currency)}
            contentStyle={{
              background: "#181818",
              border: "1px solid #2e2e2c",
              borderRadius: 3,
              fontSize: 12,
            }}
          />
        </Sankey>
      </ResponsiveContainer>
    </div>
  );
}
