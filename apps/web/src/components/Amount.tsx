import { formatMinor } from "../lib/money.js";

/**
 * Money rendered outside a `.num` table cell or a KPI value — inline in a
 * sentence, a list row, a bar legend. The `amount` class is what privacy mode
 * blurs, so every figure on screen is covered by one of the three.
 */
export function Amount({
  minor,
  currency,
  className,
}: {
  minor: number;
  currency: string;
  className?: string;
}) {
  return (
    <span className={className ? `amount ${className}` : "amount"}>
      {formatMinor(minor, currency)}
    </span>
  );
}
