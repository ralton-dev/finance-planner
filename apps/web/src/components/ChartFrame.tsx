import type { ReactNode, Ref } from "react";
import { usePrivacy } from "../contexts/PrivacyContext.js";

/**
 * Wrapper every chart sits in. Two jobs: give the download button a container
 * to serialize, and give privacy mode something to blur.
 *
 * Charts draw their values inside the SVG (axis ticks, node labels, tooltips),
 * so there is no `.num` to hide — the whole surface goes soft instead, with a
 * note saying so. Honest, and it can't leak a figure through a tooltip.
 */
export function ChartFrame({ ref, children }: { ref?: Ref<HTMLDivElement>; children: ReactNode }) {
  const { hidden } = usePrivacy();
  return (
    <div className="chart-frame" ref={ref}>
      {hidden && (
        <p className="chart-privacy-note" role="status">
          amounts hidden while privacy mode is on
        </p>
      )}
      <div className={hidden ? "chart-surface veiled" : "chart-surface"}>{children}</div>
    </div>
  );
}
