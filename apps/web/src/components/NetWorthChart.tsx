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
import { seriesCurrencies, type NetWorthPoint } from "../lib/networth.js";

// Same palette the Sankey uses, so charts across the app read as one system.
const SERIES_COLORS = ["#7be087", "#b89df0", "#7eb3f6", "#f6c66b", "#f47b6b"];
const GRID = "#232321";
const TICK = "#5e5a51";

interface TipEntry {
  dataKey?: string | number;
  value?: number;
  color?: string;
}

function NetWorthTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TipEntry[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: "#181818",
        border: "1px solid #2e2e2c",
        borderRadius: 3,
        padding: "6px 9px",
        fontSize: 12,
        lineHeight: 1.5,
        boxShadow: "0 4px 14px rgba(0, 0, 0, 0.45)",
      }}
    >
      <div style={{ color: "#a09b91", fontSize: 11 }}>{label ? formatMonth(label) : ""}</div>
      {payload.map((entry) => {
        const currency = String(entry.dataKey ?? "");
        return (
          <div key={currency} style={{ color: entry.color ?? "#e8e6e0", fontWeight: 600 }}>
            {formatMinor(Number(entry.value ?? 0), currency)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Net worth over time — one line per currency, never summed across them.
 * Months where an account has no check-in yet leave a gap rather than a zero.
 */
export function NetWorthChart({ points }: { points: NetWorthPoint[] }) {
  const currencies = seriesCurrencies(points);
  if (points.length === 0 || currencies.length === 0) return null;

  const rows = points.map((p) => ({ month: p.month, ...p.totals }));
  const axisCurrency = currencies[0]!;

  return (
    <>
      {currencies.length > 1 && (
        <div className="chart-legend">
          {currencies.map((c, i) => (
            <span key={c}>
              <i style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
              {c}
            </span>
          ))}
        </div>
      )}
      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="month"
              tickFormatter={formatMonthShort}
              tick={{ fill: TICK, fontSize: 11, fontFamily: "inherit" }}
              axisLine={{ stroke: GRID }}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(v: number) => formatCompactMinor(v, axisCurrency)}
              tick={{ fill: TICK, fontSize: 11, fontFamily: "inherit" }}
              axisLine={false}
              tickLine={false}
              width={64}
            />
            <Tooltip content={<NetWorthTooltip />} cursor={{ stroke: GRID }} />
            {currencies.map((c, i) => (
              <Line
                key={c}
                type="monotone"
                dataKey={c}
                stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeWidth={1.5}
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
