import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMonth, formatMonthShort } from "../lib/months.js";
import { formatCompactMinor, formatMinor } from "../lib/money.js";
import type { ProjectionPoint } from "../lib/projection.js";

// The app's chart palette (shared with the Sankey and the net-worth chart), used
// by meaning here: reserved is the plan, balance is real money, shortfall is a
// status colour and only ever means "short".
const RESERVED = "#b89df0";
const BALANCE = "#7be087";
const SHORTFALL = "#f47b6b";
const GRID = "#232321";
const TICK = "#5e5a51";

interface SeriesSpec {
  key: "reserved" | "balance" | "shortfall";
  label: string;
  color: string;
  dashed?: boolean;
}

interface TipEntry {
  dataKey?: string | number;
  value?: number;
  color?: string;
  payload?: ProjectionPoint;
}

function ProjectionTooltip({
  active,
  payload,
  label,
  currency,
  series,
}: {
  active?: boolean;
  payload?: TipEntry[];
  label?: string;
  currency: string;
  series: SeriesSpec[];
}) {
  if (!active || !payload?.length) return null;
  const labels = new Map<string, string>(series.map((s) => [s.key, s.label]));
  // Transfers ride along on the row rather than as a fourth line: it is a
  // "this month you must move £X" fact, not a trajectory worth plotting.
  const transfers = payload[0]?.payload?.transfers ?? null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-head">{label ? formatMonth(label) : ""}</div>
      {payload.map((entry) => (
        <div key={String(entry.dataKey)} className="chart-tip-row">
          <i style={{ background: entry.color ?? TICK }} />
          <span className="chart-tip-label">{labels.get(String(entry.dataKey)) ?? ""}</span>
          <b>{formatMinor(Number(entry.value ?? 0), currency)}</b>
        </div>
      ))}
      {transfers !== null && transfers > 0 && (
        <div className="chart-tip-row">
          <i style={{ background: "transparent" }} />
          <span className="chart-tip-label">to move</span>
          <b>{formatMinor(transfers, currency)}</b>
        </div>
      )}
    </div>
  );
}

/**
 * Where the money lands over the projected months. Reserved is always drawn;
 * the projected balance joins it when the account has a check-in to start from,
 * and shortfall only appears when some month is actually short.
 */
export function ProjectionChart({
  points,
  currency,
  showBalance,
  showShortfall,
}: {
  points: ProjectionPoint[];
  currency: string;
  showBalance: boolean;
  showShortfall: boolean;
}) {
  if (points.length === 0) return null;

  const series: SeriesSpec[] = [{ key: "reserved", label: "reserved", color: RESERVED }];
  if (showBalance) series.push({ key: "balance", label: "balance", color: BALANCE });
  if (showShortfall)
    series.push({ key: "shortfall", label: "shortfall", color: SHORTFALL, dashed: true });

  return (
    <>
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div style={{ width: "100%", height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="month"
              tickFormatter={formatMonthShort}
              tick={{ fill: TICK, fontSize: 11, fontFamily: "inherit" }}
              axisLine={{ stroke: GRID }}
              tickLine={false}
              minTickGap={16}
            />
            <YAxis
              tickFormatter={(v: number) => formatCompactMinor(v, currency)}
              tick={{ fill: TICK, fontSize: 11, fontFamily: "inherit" }}
              axisLine={false}
              tickLine={false}
              width={64}
            />
            <Tooltip
              content={<ProjectionTooltip currency={currency} series={series} />}
              cursor={{ stroke: GRID }}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={s.dashed ? 1 : 1.5}
                strokeDasharray={s.dashed ? "3 3" : undefined}
                dot={false}
                activeDot={{ r: 3 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
