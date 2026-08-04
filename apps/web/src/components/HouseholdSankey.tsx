import { useState } from "react";
import { Layer, Rectangle, ResponsiveContainer, Sankey, Tooltip } from "recharts";
import { type ChartColors, useChartColors } from "../lib/chartColors.js";
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

/** Amounts, or each flow as a share of the household's monthly income. */
export type FlowUnits = "amount" | "share";

/**
 * How a flow is written in labels and tooltips. In share mode everything is
 * measured against the same denominator — total household income — so "38.5%"
 * means the same thing wherever it appears on the diagram.
 */
export function flowLabel(
  valueMinor: number,
  totalMinor: number,
  units: FlowUnits,
  currency: string,
): string {
  if (units === "amount") return formatMinor(valueMinor, currency);
  if (totalMinor <= 0) return "—";
  return `${((valueMinor / totalMinor) * 100).toFixed(1)}%`;
}

/**
 * How solid a ribbon is drawn. Ribbons cross, so they cannot be opaque — but at
 * the 0.35 they used to carry, every colour in the light theme washed out to
 * around 1.6:1 against the page and the diagram stopped saying anything. 0.7 is
 * the lowest value that keeps all four flows over 3:1 in *both* themes.
 */
const LINK_OPACITY = 0.7;

/** What each kind of flow is drawn in. Income arrives, spending leaves, a
 *  transfer is a move you make, and left over is what survives. */
function linkColor(kind: LinkKind, colors: ChartColors): string {
  if (kind === "income") return colors.funded;
  if (kind === "spending") return colors.needsYou;
  if (kind === "leftover") return colors.link;
  return colors.accent;
}

interface SankeyNodeDatum {
  name: string;
  isAccount: boolean;
}
interface SankeyLinkDatum {
  source: number;
  target: number;
  value: number;
  kind: LinkKind;
  /** Self-contained endpoint labels so the tooltip never has to dig into
   *  Recharts' post-layout node objects. */
  fromName: string;
  toName: string;
  /** For transfers: the member whose money moves. */
  note?: string;
}

export function buildGraph(plan: HouseholdPlanDto): {
  nodes: SankeyNodeDatum[];
  links: SankeyLinkDatum[];
} {
  const nodes: SankeyNodeDatum[] = [];
  const links: SankeyLinkDatum[] = [];
  const accountNode = new Map<string, number>();
  const accountName = new Map(plan.accounts.map((a) => [a.accountId, a.name ?? "account"]));
  const memberName = new Map(plan.members.map((m) => [m.userId, m.displayName ?? "member"]));

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
    const name = a.name ?? "account";
    if (a.monthlyIncomeMinor > 0) {
      links.push({
        source: addNode("income", false),
        target: idx,
        value: a.monthlyIncomeMinor,
        kind: "income",
        fromName: "income",
        toName: name,
      });
    }
    if (a.fundedOutflowMinor > 0) {
      links.push({
        source: idx,
        target: addNode("spending", false),
        value: a.fundedOutflowMinor,
        kind: "spending",
        fromName: name,
        toName: "spending",
      });
    }
    if (a.leftoverMinor > 0) {
      links.push({
        source: idx,
        target: addNode("left over", false),
        value: a.leftoverMinor,
        kind: "leftover",
        fromName: name,
        toName: "left over",
      });
    }
  }

  for (const t of plan.transfers) {
    const from = accountNode.get(t.fromAccountId);
    const to = accountNode.get(t.toAccountId);
    if (from === undefined || to === undefined || t.amountMinor <= 0) continue;
    links.push({
      source: from,
      target: to,
      value: t.amountMinor,
      kind: "transfer",
      fromName: accountName.get(t.fromAccountId) ?? "account",
      toName: accountName.get(t.toAccountId) ?? "account",
      note: memberName.get(t.memberUserId),
    });
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
  units?: FlowUnits;
  totalMinor?: number;
}

function FlowNode({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  containerWidth = 0,
  payload,
  currency = "GBP",
  units = "amount",
  totalMinor = 0,
}: NodeProps) {
  const colors = useChartColors();
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
        fill={isAccount ? colors.accent : colors.ink2}
        fillOpacity={isAccount ? 0.85 : 0.7}
      />
      <text
        x={onLeft ? x + width + 8 : x - 8}
        y={y + height / 2}
        textAnchor={onLeft ? "start" : "end"}
        dy="0.32em"
        fontSize={11}
        fill={isAccount ? colors.ink : colors.ink2}
      >
        {label}
        {isAccount && value > 0 ? ` · ${flowLabel(value, totalMinor, units, currency)}` : ""}
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
  const colors = useChartColors();
  const color = linkColor(payload?.kind ?? "transfer", colors);
  return (
    <path
      d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={color}
      strokeWidth={Math.max(1, linkWidth)}
      strokeOpacity={LINK_OPACITY}
    />
  );
}

interface TipDatum {
  name?: string;
  value?: number;
  fromName?: string;
  toName?: string;
  note?: string;
}
interface TipEntry {
  name?: string;
  value?: number;
  payload?: TipDatum;
}

// Recharts clones this with { active, payload } at hover time. A flow (link)
// carries fromName/toName; a node carries just its name.
function FlowTooltip({
  active,
  payload,
  currency = "GBP",
  units = "amount",
  totalMinor = 0,
}: {
  active?: boolean;
  payload?: TipEntry[];
  currency?: string;
  units?: FlowUnits;
  totalMinor?: number;
}) {
  const colors = useChartColors();
  if (!active || !payload?.length) return null;
  const entry = payload[0]!;
  const d = entry.payload ?? {};
  const value = Number(entry.value ?? d.value ?? 0);
  const isFlow = !!(d.fromName && d.toName);
  const label = isFlow ? `${d.fromName} → ${d.toName}` : (d.name ?? entry.name ?? "");
  return (
    <div
      style={{
        background: colors.panel,
        border: `1px solid ${colors.ruleStrong}`,
        borderRadius: 3,
        padding: "6px 9px",
        fontSize: 12,
        lineHeight: 1.5,
        boxShadow: colors.tipShadow,
      }}
    >
      <div style={{ color: colors.ink2, fontSize: 11 }}>{label}</div>
      <div style={{ color: colors.ink, fontWeight: 600 }}>
        {flowLabel(value, totalMinor, units, currency)}
      </div>
      {d.note ? <div style={{ color: colors.ink2, fontSize: 11 }}>via {d.note}</div> : null}
    </div>
  );
}

export function HouseholdSankey({ plan }: { plan: HouseholdPlanDto }) {
  const colors = useChartColors();
  // Local to the chart: which units to read it in is a way of looking at one
  // diagram, not a setting worth persisting or lifting into the page.
  const [units, setUnits] = useState<FlowUnits>("amount");
  const data = buildGraph(plan);
  if (data.links.length === 0) {
    return (
      <p className="muted" style={{ fontSize: "12px" }}>
        no money flow to chart yet — add income and payments to the household's accounts.
      </p>
    );
  }
  const totalMinor = plan.monthlyIncomeMinor;
  return (
    <>
      <div className="chart-toolbar">
        <span className="months-select" role="group" aria-label="flow units">
          <button
            type="button"
            className={`ghost tiny${units === "amount" ? " active" : ""}`}
            aria-pressed={units === "amount"}
            onClick={() => setUnits("amount")}
          >
            £
          </button>
          <button
            type="button"
            className={`ghost tiny${units === "share" ? " active" : ""}`}
            aria-pressed={units === "share"}
            onClick={() => setUnits("share")}
            title="each flow as a share of total household income"
          >
            %
          </button>
        </span>
      </div>
      <div style={{ width: "100%", height: 440 }}>
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={data}
            nodePadding={26}
            nodeWidth={10}
            margin={{ top: 12, right: 120, bottom: 12, left: 120 }}
            node={<FlowNode currency={plan.currency} units={units} totalMinor={totalMinor} />}
            link={<FlowLink />}
          >
            <Tooltip
              content={
                <FlowTooltip currency={plan.currency} units={units} totalMinor={totalMinor} />
              }
              cursor={{ fill: colors.ink, fillOpacity: 0.06 }}
            />
          </Sankey>
        </ResponsiveContainer>
      </div>
    </>
  );
}
