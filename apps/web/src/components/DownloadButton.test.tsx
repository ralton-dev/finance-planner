import { render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRIVACY_CLASS, PRIVACY_STORAGE_KEY, PrivacyProvider } from "../contexts/PrivacyContext.js";
import { DownloadButton } from "./DownloadButton.js";

/** A container whose chart arrives after mount, the way a lazy chunk does. */
function Host({ chart, late = false }: { chart: boolean; late?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(!late);
  useEffect(() => {
    if (late) setReady(true);
  }, [late]);
  return (
    <>
      <DownloadButton targetRef={ref} name="money flow" />
      <div ref={ref}>{chart && ready ? <svg data-testid="chart" /> : <p>loading chart…</p>}</div>
    </>
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove(PRIVACY_CLASS);
});

describe("DownloadButton", () => {
  it("stays hidden while the container holds no chart", () => {
    render(<Host chart={false} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("appears once a chart is there", async () => {
    render(<Host chart />);
    expect(await screen.findByRole("button", { name: "png ↓" })).toBeInTheDocument();
  });

  it("catches a chart that only arrives after the first paint", async () => {
    render(<Host chart late />);
    await waitFor(() => expect(screen.getByRole("button", { name: "png ↓" })).toBeInTheDocument());
  });

  it("keeps out of the way in privacy mode — hidden amounts don't get exported", async () => {
    localStorage.setItem(PRIVACY_STORAGE_KEY, "1");
    render(
      <PrivacyProvider>
        <Host chart />
      </PrivacyProvider>,
    );
    await screen.findByTestId("chart");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
