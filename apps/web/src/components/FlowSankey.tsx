import { type RefObject, useEffect, useRef, useState } from "react";
import { Layer, Rectangle, ResponsiveContainer, Sankey, Tooltip } from "recharts";
import { type ChartColors, useChartColors } from "../lib/chartColors.js";
import { formatMinor } from "../lib/money.js";
import type { FlowDto, FlowEdgeDto } from "../lib/types.js";

/**
 * Money-flow Sankey for **any** scope. Derived entirely from the flow model's
 * per-account aggregates + edges, so the diagram always balances:
 *
 *   income ─▶ account ─▶ (movements) ─▶ account ─▶ spending
 *                     └▶ left over
 *
 * Recharts computes node depth from the link graph, giving a natural
 * left-to-right flow: incomes, then current accounts, then pots, then outflows.
 *
 * It used to take a `HouseholdPlanDto`, which is why the picture could only ever
 * be of one household. It now takes a `FlowDto`, and a household plan is one of
 * the two things that project into one — see `lib/flow.ts`.
 */

type LinkKind = "income" | "transfer" | "spending" | "leftover";

/** Amounts, or each flow as a share of the money entering the picture. */
export type FlowUnits = "amount" | "share";

/**
 * How a flow is written in labels and tooltips. In share mode everything is
 * measured against the same denominator — the money entering this picture from
 * outside it — so "38.5%" means the same thing wherever it appears. For a single
 * household that denominator is exactly total household income, which is what it
 * has always been.
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

/**
 * The phone breakpoint, and the one place in the app that has to know it in
 * JavaScript rather than in CSS.
 *
 * A Sankey's side margins are the room its labels are written in, and they are
 * an SVG layout number the chart is handed before it draws — CSS cannot reach
 * them. At 390px the 120px-a-side gutters this diagram was built with leave
 * about 150px of actual drawing, and the labels run off the left edge into each
 * other: something no jsdom test can see and only a browser will tell you.
 * `--` the same 560px the tables fold at, so the diagram and the table beside it
 * change shape together.
 */
const PHONE = "(max-width: 560px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(PHONE).matches === true,
  );
  useEffect(() => {
    const query = window.matchMedia?.(PHONE);
    if (!query) return undefined;
    const update = (): void => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

/**
 * How wide the chart actually is, measured.
 *
 * Recharts documents a `containerWidth` prop on a custom node and does not
 * supply one here, so every label has always been anchored the same way and got
 * away with it inside 120px gutters. With the gutters gone on a phone it stops
 * getting away with it: a label anchored right-to-left at x = 10 is a label with
 * one letter on screen. Measuring is the only way to know which side of the
 * diagram a node is on, so it is measured.
 */
function useMeasuredWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = (): void => setWidth(node.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** What an account outside the picture is called at either end of a ribbon.
 *  Never a name: an account the scope leaves out may be one the caller cannot
 *  see at all, and the amount is the part that is theirs to know. */
const OFF_PICTURE = "elsewhere";

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
  /** For transfers: the member whose money moves, or why an edge fell short. */
  note?: string;
}

/**
 * The second line of an edge's tooltip: who is moving it, or — when the plan
 * could not do what the row asked — what it asked for. A member's name wins,
 * because a household transfer that got here is one the plan funded.
 */
function edgeNote(edge: FlowEdgeDto, currency: string): string | undefined {
  if (edge.memberUserId !== undefined) return edge.memberName ?? "member";
  if (edge.status === "short" || edge.status === "unfunded") {
    return `asked for ${formatMinor(edge.requestedMinor, currency)}`;
  }
  if (edge.status === "unknown_source") return "sent from outside this picture";
  return undefined;
}

export function buildGraph(flow: FlowDto): {
  nodes: SankeyNodeDatum[];
  links: SankeyLinkDatum[];
} {
  const nodes: SankeyNodeDatum[] = [];
  const links: SankeyLinkDatum[] = [];
  const accountNode = new Map<string, number>();
  const accountName = new Map(flow.accounts.map((a) => [a.accountId, a.name]));

  const addNode = (name: string, isAccount: boolean): number => {
    nodes.push({ name, isAccount });
    return nodes.length - 1;
  };

  // Account nodes first so edges can reference them by index.
  for (const a of flow.accounts) {
    accountNode.set(a.accountId, addNode(a.name, true));
  }

  for (const a of flow.accounts) {
    const idx = accountNode.get(a.accountId)!;
    if (a.incomeMinor > 0) {
      links.push({
        source: addNode("income", false),
        target: idx,
        value: a.incomeMinor,
        kind: "income",
        fromName: "income",
        toName: a.name,
      });
    }
    if (a.spendingMinor > 0) {
      links.push({
        source: idx,
        target: addNode("spending", false),
        value: a.spendingMinor,
        kind: "spending",
        fromName: a.name,
        toName: "spending",
      });
    }
    if (a.leftoverMinor > 0) {
      links.push({
        source: idx,
        target: addNode("left over", false),
        value: a.leftoverMinor,
        kind: "leftover",
        fromName: a.name,
        toName: "left over",
      });
    }
  }

  for (const e of flow.edges) {
    // A movement that moved nothing has no width. It is still worth saying, and
    // the page says it below the chart rather than drawing a ribbon of nothing.
    if (e.amountMinor <= 0) continue;
    // An end outside the picture gets its own node each time, so two unrelated
    // off-picture accounts never merge into one — and so "elsewhere" as a source
    // and "elsewhere" as a sink can never be the same node, which would make the
    // graph circular and stop it laying out at all.
    const from =
      e.fromAccountId === null
        ? addNode(OFF_PICTURE, false)
        : (accountNode.get(e.fromAccountId) ?? -1);
    const to =
      e.toAccountId === null ? addNode(OFF_PICTURE, false) : (accountNode.get(e.toAccountId) ?? -1);
    if (from < 0 || to < 0) continue;
    const note = edgeNote(e, flow.currency);
    links.push({
      source: from,
      target: to,
      value: e.amountMinor,
      kind: "transfer",
      fromName: e.fromAccountId === null ? OFF_PICTURE : (accountName.get(e.fromAccountId) ?? ""),
      toName: e.toAccountId === null ? OFF_PICTURE : (accountName.get(e.toAccountId) ?? ""),
      ...(note !== undefined ? { note } : {}),
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
  /** On a phone: no gutters to write in, so the label sits over the diagram and
   *  gives up its figure. See `useNarrow`. */
  narrow?: boolean;
  /** The measured chart width — which side of the diagram a node is on. Only
   *  consulted on a phone, so the desktop diagram is untouched. */
  chartWidth?: number;
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
  narrow = false,
  chartWidth = 0,
}: NodeProps) {
  const colors = useChartColors();
  // The measured width wins on a phone and is deliberately ignored otherwise:
  // the desktop diagram has written its labels leftwards since it was a
  // household feature, and this is not the change that alters it.
  const half = (narrow && chartWidth > 0 ? chartWidth : containerWidth) / 2;
  const onLeft = x < half;
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
        x={onLeft ? x + width + 6 : x - 6}
        // Above the node rather than beside it on a phone: at 390px a label
        // beside a node is a label over the next node's ribbons, and two of
        // them at the same depth read as one run-on word.
        y={narrow ? y - 5 : y + height / 2}
        textAnchor={onLeft ? "start" : "end"}
        dy={narrow ? undefined : "0.32em"}
        fontSize={narrow ? 10 : 11}
        fill={isAccount ? colors.ink : colors.ink2}
      >
        {label}
        {/* The figure is in the table below on a phone; here it would only
            crowd the name out. */}
        {isAccount && value > 0 && !narrow
          ? ` · ${flowLabel(value, totalMinor, units, currency)}`
          : ""}
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

export function FlowSankey({ flow }: { flow: FlowDto }) {
  const colors = useChartColors();
  const narrow = useNarrow();
  const chartRef = useRef<HTMLDivElement>(null);
  const chartWidth = useMeasuredWidth(chartRef);
  // Local to the chart: which units to read it in is a way of looking at one
  // diagram, not a setting worth persisting or lifting into the page.
  const [units, setUnits] = useState<FlowUnits>("amount");
  const data = buildGraph(flow);
  // A movement the ordered pass ignored to break a funding loop moves nothing,
  // so it has no ribbon — and would otherwise vanish silently, which is the one
  // thing a detected loop must not do.
  const brokenLoop = flow.edges.some((e) => e.status === "broken_cycle");
  if (data.links.length === 0) {
    return (
      <p className="muted" style={{ fontSize: "12px" }}>
        no money flow to chart yet — add income and payments to these accounts.
      </p>
    );
  }
  const totalMinor = flow.totalInflowMinor;
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
            title="each flow as a share of the money entering this picture"
          >
            %
          </button>
        </span>
      </div>
      {/* Taller on a phone, because the labels now sit above their nodes and
          need the room the gutters used to take sideways. */}
      <div ref={chartRef} style={{ width: "100%", height: narrow ? 520 : 440 }}>
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={data}
            nodePadding={narrow ? 32 : 26}
            nodeWidth={10}
            margin={
              narrow
                ? { top: 16, right: 10, bottom: 12, left: 10 }
                : { top: 12, right: 120, bottom: 12, left: 120 }
            }
            node={
              <FlowNode
                currency={flow.currency}
                units={units}
                totalMinor={totalMinor}
                narrow={narrow}
                chartWidth={chartWidth}
              />
            }
            link={<FlowLink />}
          >
            <Tooltip
              content={
                <FlowTooltip currency={flow.currency} units={units} totalMinor={totalMinor} />
              }
              cursor={{ fill: colors.ink, fillOpacity: 0.06 }}
            />
          </Sankey>
        </ResponsiveContainer>
      </div>
      {brokenLoop && (
        <p className="muted" style={{ fontSize: "12px" }}>
          one movement is not drawn: it closes a funding loop, so the plan ignores it and it moves
          nothing.
        </p>
      )}
    </>
  );
}
