import { useEffect, useRef } from "react";

/**
 * Map of leader key → second key → action, compared case-insensitively.
 * e.g. `{ g: { h: goHome }, n: { p: newPayment } }` wires up the "g h" / "n p"
 * chords shown next to the sidebar items.
 */
export type ChordMap = Record<string, Record<string, () => void>>;

/** Window (ms) to press the second key after a leader before the chord resets. */
const CHORD_TIMEOUT_MS = 1200;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

/**
 * Global two-key "leader" keyboard shortcuts (Gmail / Linear style): press a
 * leader key (e.g. `g`), then a second key (e.g. `h`) within a short window to
 * fire its action.
 *
 * Deliberately stays inert when it shouldn't interrupt the user: a modifier is
 * held (so ⌘K and browser shortcuts win), focus is in a form field, or a modal
 * dialog ([aria-modal]) — the command palette or a quick-add drawer — is open.
 */
export function useChordShortcuts(chords: ChordMap): void {
  // Latest map kept in a ref so the listener mounts once yet always sees the
  // current actions, even though callers pass a fresh object every render.
  const chordsRef = useRef(chords);
  chordsRef.current = chords;

  useEffect(() => {
    let leader: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function reset(): void {
      leader = null;
      if (timer) clearTimeout(timer);
      timer = undefined;
    }

    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isEditableTarget(e.target)) return;
      // A modal (command palette, quick-add drawer) owns the keyboard — don't
      // navigate the page sitting underneath it.
      if (document.querySelector('[aria-modal="true"]')) return;

      const key = e.key.toLowerCase();
      const map = chordsRef.current;

      if (leader) {
        const action = map[leader]?.[key];
        reset();
        if (action) {
          e.preventDefault();
          action();
          return;
        }
        // Unknown pairing — fall through so this key can start a fresh chord.
      }

      if (map[key]) {
        leader = key;
        timer = setTimeout(reset, CHORD_TIMEOUT_MS);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
