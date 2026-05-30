import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAddProvider } from "../contexts/QuickAddContext.js";
import { CommandPalette } from "./CommandPalette.js";

function Harness() {
  return (
    <MemoryRouter>
      <QuickAddProvider>
        <CommandPalette />
      </QuickAddProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  // Stub fetch — palette tries to load accounts + /me on open.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => [],
    })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CommandPalette", () => {
  it("is hidden by default and opens on Cmd+K", async () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/search · jump · run command/)).toBeInTheDocument();
  });

  it("Ctrl+K also opens (non-mac keybinding)", async () => {
    render(<Harness />);
    fireEvent.keyDown(document, { key: "K", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  });

  it("Esc closes the palette", async () => {
    render(<Harness />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("backdrop click closes the palette", async () => {
    render(<Harness />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("palette-backdrop"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("typing filters commands and shows the no-match state when nothing matches", async () => {
    render(<Harness />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    // Initially shows the static nav + add commands.
    expect(screen.getByText("go to accounts")).toBeInTheDocument();
    expect(screen.getByText("new payment")).toBeInTheDocument();

    const input = screen.getByLabelText(/command palette input/i);
    fireEvent.change(input, { target: { value: "accounts" } });
    expect(screen.getByText("go to accounts")).toBeInTheDocument();
    // "new payment" no longer matches "accounts".
    expect(screen.queryByText("new payment")).toBeNull();

    fireEvent.change(input, { target: { value: "zzzzz" } });
    expect(screen.getByText(/no commands match/i)).toBeInTheDocument();
  });
});
