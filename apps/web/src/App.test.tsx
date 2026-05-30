import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("App routing", () => {
  it("redirects unauthenticated users to the login screen", async () => {
    // tryRefresh() -> 401, so the session cannot be restored.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /log in/i })).toBeInTheDocument(),
    );
  });
});
