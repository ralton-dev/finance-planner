import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "../lib/chartColors.js";
import { formatMonth, formatMonthShort } from "../lib/months.js";
import { formatCompactMinor, formatMinor } from "../lib/money.js";
import { seriesCurrencies, type NetWorthPoint } from "../lib/networth.js";

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
  const colors = useChartColors();
  if (!active || !payload?.length) return null;
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
      <div style={{ color: colors.ink2, fontSize: 11 }}>{label ? formatMonth(label) : ""}</div>
      {payload.map((entry) => {
        const currency = String(entry.dataKey ?? "");
        return (
          <div key={currency} style={{ color: entry.color ?? colors.ink, fontWeight: 600 }}>
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
  const colors = useChartColors();
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
              <i style={{ background: colors.series[i % colors.series.length] }} />
              {c}
            </span>
          ))}
        </div>
      )}
      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid stroke={colors.grid} strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="month"
              tickFormatter={formatMonthShort}
              tick={{ fill: colors.ink3, fontSize: 11, fontFamily: "inherit" }}
              axisLine={{ stroke: colors.rule }}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(v: number) => formatCompactMinor(v, axisCurrency)}
              tick={{ fill: colors.ink3, fontSize: 11, fontFamily: "inherit" }}
              axisLine={false}
              tickLine={false}
              width={64}
            />
            <Tooltip content={<NetWorthTooltip />} cursor={{ stroke: colors.rule }} />
            {currencies.map((c, i) => (
              <Line
                key={c}
                type="monotone"
                dataKey={c}
                stroke={colors.series[i % colors.series.length]}
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
