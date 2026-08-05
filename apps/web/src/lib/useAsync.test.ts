import { act, renderHook, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { useAsync } from "./useAsync.js";

/**
 * The hook every page reads its data through, and the one property none of the
 * component tests can see.
 *
 * `refetch()` used to set `{loading: true}`, which dropped `data` — so any page
 * gated on `loading` unmounted its whole subtree on every refresh, taking with
 * it everything those components held in local state. On the Overview that
 * included `Fold`'s `settled` map, which *is* the undo: confirming a transfer
 * refetched the page, the fold remounted, and the undo for the thing you had
 * just done vanished the moment it appeared.
 *
 * The component tests cannot catch it because their stubs answer in the same
 * task the refetch starts in: React coalesces `{loading:true}` and the answer
 * into one render and the blank never commits. Only a read you can hold open —
 * which is every real one — shows it. Hence a hook test, with the promise in
 * the test's hand.
 */

/** A promise the test decides when to settle. */
function deferred<T>() {
  let settle!: (value: T) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

describe("useAsync", () => {
  it("is loading, not refreshing, until the first answer arrives", async () => {
    const first = deferred<string>();
    const { result } = renderHook(() => useAsync(() => first.promise, []));

    expect(result.current.loading).toBe(true);
    expect(result.current.refreshing).toBe(false);
    expect(result.current.data).toBeUndefined();

    await act(async () => first.settle("one"));
    expect(result.current).toMatchObject({ loading: false, refreshing: false, data: "one" });
  });

  it("keeps the last answer on screen while a refetch is in flight", async () => {
    let pending = deferred<string>();
    const { result } = renderHook(() => useAsync(() => pending.promise, []));
    await act(async () => pending.settle("one"));

    pending = deferred<string>();
    act(() => result.current.refetch());

    // The whole point: something to render, all the way through.
    expect(result.current.data).toBe("one");
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);

    await act(async () => pending.settle("two"));
    expect(result.current).toMatchObject({ data: "two", loading: false, refreshing: false });
  });

  it("blanks when the deps change, because that is a different question", async () => {
    // Account A's plan must never sit under account B's heading while B loads.
    // Stale is one thing; the wrong answer is another.
    const answers: Record<string, ReturnType<typeof deferred<string>>> = {
      a: deferred<string>(),
      b: deferred<string>(),
    };
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useAsync(() => answers[id]!.promise, [id]),
      { initialProps: { id: "a" } },
    );
    await act(async () => answers.a!.settle("A's plan"));
    expect(result.current.data).toBe("A's plan");

    rerender({ id: "b" });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);

    await act(async () => answers.b!.settle("B's plan"));
    expect(result.current.data).toBe("B's plan");
  });

  /**
   * The one above only looks once the effects have run, which is a beat after
   * the render that changed the deps — and the whole defect lived in that beat.
   * This one records what actually *committed*, so a single render carrying a's
   * answer under b's heading is caught even though it is immediately replaced.
   *
   * That render is not cosmetic. The Overview reads its household plans for
   * `me().households`, so the run before `me` answers is a run for no
   * households; the one render that published its empty answer as settled was
   * enough for the page to build its whole checklist off "you have nothing",
   * and the real read landing a beat later blanked the fold — with whatever the
   * person had opened and typed into it.
   */
  it("never commits the old deps' answer under the new ones, not for one render", async () => {
    const answers: Record<string, ReturnType<typeof deferred<string>>> = {
      a: deferred<string>(),
      b: deferred<string>(),
    };
    const committed: { id: string; data?: string; loading: boolean }[] = [];
    const { rerender } = renderHook(
      ({ id }: { id: string }) => {
        const state = useAsync(() => answers[id]!.promise, [id]);
        useEffect(() => {
          committed.push({ id, data: state.data, loading: state.loading });
        });
        return state;
      },
      { initialProps: { id: "a" } },
    );
    await act(async () => answers.a!.settle("A's plan"));
    expect(committed.at(-1)).toEqual({ id: "a", data: "A's plan", loading: false });

    rerender({ id: "b" });

    expect(committed.filter((c) => c.id === "b" && c.data !== undefined)).toEqual([]);
    await act(async () => answers.b!.settle("B's plan"));
    expect(committed.at(-1)).toEqual({ id: "b", data: "B's plan", loading: false });
  });

  it("ignores a run the deps have already moved past, however late it answers", async () => {
    const answers: Record<string, ReturnType<typeof deferred<string>>> = {
      a: deferred<string>(),
      b: deferred<string>(),
    };
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useAsync(() => answers[id]!.promise, [id]),
      { initialProps: { id: "a" } },
    );

    // a is still in flight when the question changes, and answers afterwards.
    rerender({ id: "b" });
    await act(async () => answers.a!.settle("A's plan"));
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);

    await act(async () => answers.b!.settle("B's plan"));
    expect(result.current.data).toBe("B's plan");
  });

  it("drops what it had when a refetch fails, rather than standing behind it", async () => {
    let pending = deferred<string>();
    const { result } = renderHook(() => useAsync(() => pending.promise, []));
    await act(async () => pending.settle("one"));

    pending = deferred<string>();
    act(() => result.current.refetch());
    pending.promise.catch(() => {
      /* the hook is the one that handles it; this only keeps node quiet */
    });
    await act(async () => {
      pending.fail(new Error("gone"));
    });
    await waitFor(() => expect(result.current.error).toBeDefined());

    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(false);
  });
});
