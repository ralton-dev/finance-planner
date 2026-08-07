import { useId } from "react";

type ProductLogoProps = {
  className?: string;
  decorative?: boolean;
};

/**
 * The product mark: ledger rows with a channel cut through them, and the
 * accent path riding in the channel.
 *
 * Drawn inline rather than loaded as two hand-coloured files so it inherits
 * `currentColor` for the bars and `--brand` for the accent, and themes without
 * a second asset. Geometry is stroke 9 on a pitch of 18, so gaps equal strokes;
 * the channel is 27 — one row plus both its gaps — which is why it consumes a
 * row cleanly instead of clipping into its neighbours.
 *
 * The channel is a mask, not an overpainted background colour, so the mark is
 * transparent where the channel runs and sits on any surface.
 */
export function ProductLogo({ className, decorative = false }: ProductLogoProps) {
  // Rendered more than once per page (mobile bar, sidebar), so the mask needs
  // an id unique to the instance.
  const maskId = useId();

  return (
    <span
      className={className ? `product-logo ${className}` : "product-logo"}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "Finance Planner"}
      aria-hidden={decorative ? true : undefined}
    >
      <svg
        className="product-logo-mark"
        viewBox="4.5 9.5 55 45"
        aria-hidden="true"
        focusable="false"
      >
        {/*
          `white` and `black` here are mask luminance, not palette: they mean
          "keep" and "cut", they can never be themed, and changing either
          breaks the carve rather than restyling it. Hence keywords rather than
          hexes — a colour literal in a component would be claiming something
          this isn't.
        */}
        <mask id={maskId} maskUnits="userSpaceOnUse" x="4.5" y="9.5" width="55" height="45">
          <rect x="4.5" y="9.5" width="55" height="45" fill="white" />
          <path
            d="M-6 50 H15 C29 50 28 32 42 32 H70"
            stroke="black"
            strokeWidth="27"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </mask>
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          <g mask={`url(#${maskId})`} stroke="currentColor" strokeWidth="9">
            <path d="M9 14 H44" />
            <path d="M9 32 H55" />
            <path d="M9 50 H55" />
          </g>
          <path d="M9 50 H15 C29 50 28 32 42 32 H55" stroke="var(--brand)" strokeWidth="9" />
        </g>
      </svg>
    </span>
  );
}
