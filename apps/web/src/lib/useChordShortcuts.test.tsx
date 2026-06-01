import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChordShortcuts, type ChordMap } from "./useChordShortcuts.js";

function Harness({ chords, withModal = false }: { chords: ChordMap; withModal?: boolean }) {
  useChordShortcuts(chords);
  return (
    <>
      <input aria-label="field" />
      {withModal && <div role="dialog" aria-modal="true" data-testid="modal" />}
    </>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useChordShortcuts", () => {
  it("fires the action when the leader and second key are pressed in sequence", () => {
    const go = vi.fn();
    render(<Harness chords={{ g: { h: go } }} />);

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "h" });

    expect(go).toHaveBeenCalledTimes(1);
  });

  it("matches keys case-insensitively", () => {
    const go = vi.fn();
    render(<Harness chords={{ g: { h: go } }} />);

    fireEvent.keyDown(document, { key: "G" });
    fireEvent.keyDown(document, { key: "H" });

    expect(go).toHaveBeenCalledTimes(1);
  });

  it("routes each second key to its own action under the same leader", () => {
    const today = vi.fn();
    const accounts = vi.fn();
    render(<Harness chords={{ g: { h: today, a: accounts } }} />);

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "a" });

    expect(accounts).toHaveBeenCalledTimes(1);
    expect(today).not.toHaveBeenCalled();
  });

  it("does nothing for a leader key on its own", () => {
    const go = vi.fn();
    render(<Harness chords={{ g: { h: go } }} />);

    fireEvent.keyDown(document, { key: "g" });

    expect(go).not.toHaveBeenCalled();
  });

  it("ignores keystrokes typed into a form field", () => {
    const go = vi.fn();
    render(<Harness chords={{ g: { h: go } }} />);
    const input = screen.getByLabelText("field");

    fireEvent.keyDown(input, { key: "g" });
    fireEvent.keyDown(input, { key: "h" });

    expect(go).not.toHaveBeenCalled();
  });

  it("ignores chords while a modal dialog is open", () => {
    const go = vi.fn();
    render(<Harness chords={{ g: { h: go } }} withModal />);

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "h" });

    expect(go).not.toHaveBeenCalled();
  });

  it("ignores the leader when a modifier is held (so ⌘K etc. still win)", () => {
    const go = vi.fn();
    render(<Harness chords={{ g: { h: go } }} />);

    fireEvent.keyDown(document, { key: "g", ctrlKey: true });
    fireEvent.keyDown(document, { key: "h" });

    expect(go).not.toHaveBeenCalled();
  });

  it("resets on an unknown second key, but a fresh chord still fires", () => {
    const go = vi.fn();
    render(<Harness chords={{ g: { h: go } }} />);

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "x" }); // unknown pairing → reset
    expect(go).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "h" });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("forgets the leader after the chord window elapses", () => {
    const go = vi.fn();
    render(<Harness chords={{ g: { h: go } }} />);

    vi.useFakeTimers();
    fireEvent.keyDown(document, { key: "g" });
    vi.advanceTimersByTime(1300); // past the 1200ms window
    fireEvent.keyDown(document, { key: "h" });

    expect(go).not.toHaveBeenCalled();
  });
});
