import { type RefObject, useEffect, useState } from "react";
import { usePrivacy } from "../contexts/PrivacyContext.js";
import { downloadChartPng } from "../lib/downloadChart.js";

/** Watches a container for a chart SVG appearing (lazy chunks arrive late) so
 *  the action only shows once there is something to export. */
function useHasChart(ref: RefObject<HTMLElement | null>): boolean {
  const [has, setHas] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const check = (): void => setHas(!!node.querySelector("svg"));
    check();
    if (typeof MutationObserver === "undefined") return undefined;
    const observer = new MutationObserver(check);
    observer.observe(node, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [ref]);

  return has;
}

/**
 * "png ↓" in a section head: saves the chart in `targetRef` as an image.
 * Hidden when there is no chart to save, and while privacy mode is on — the
 * point of privacy mode is that the figures don't leave the screen.
 */
export function DownloadButton({
  targetRef,
  name,
  label = "png ↓",
}: {
  targetRef: RefObject<HTMLElement | null>;
  /** Base filename, slugified into "<name>.png". */
  name: string;
  label?: string;
}) {
  const { hidden } = usePrivacy();
  const hasChart = useHasChart(targetRef);
  const [busy, setBusy] = useState(false);

  if (hidden || !hasChart) return null;

  return (
    <button
      type="button"
      className="action"
      title={`download ${name} as a png`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await downloadChartPng(targetRef.current, name);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "saving…" : label}
    </button>
  );
}
