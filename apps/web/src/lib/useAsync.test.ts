import { act, renderHook, waitFor } from "@testing-library/react";
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
