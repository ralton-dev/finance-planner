import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("renders the application heading", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    render(<App />);
    expect(screen.getByRole("heading", { name: /finance planner/i })).toBeInTheDocument();
    // Let the async health probe settle so the state update is flushed.
    await screen.findByText("reachable");
  });

  it("shows the API as reachable when the health check succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    render(<App />);
    await waitFor(() => expect(screen.getByText("reachable")).toBeInTheDocument());
  });

  it("shows the API as unreachable when the health check fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<App />);
    await waitFor(() => expect(screen.getByText("unreachable")).toBeInTheDocument());
  });
});
