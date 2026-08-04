import { Fragment } from "react";
import { formatMinor, type Phrase } from "../lib/money.js";

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

/**
 * A sentence built by a derivation, with every figure in it wrapped so privacy
 * mode can reach it. Renders a fragment, not a block: the caller supplies the
 * `<p>`/`<div>` and the class that positions it.
 *
 * This is why the deriving modules return `Phrase` rather than a finished
 * string — a formatted amount inside a template literal is a number nothing can
 * blur, which quietly undid privacy mode everywhere the app explains itself in
 * words instead of a table cell.
 */
export function Sentence({ phrase }: { phrase: Phrase }) {
  return (
    <>
      {phrase.map((part, i) =>
        typeof part === "string" ? (
          <Fragment key={i}>{part}</Fragment>
        ) : (
          <Amount key={i} minor={part.minor} currency={part.currency} />
        ),
      )}
    </>
  );
}
