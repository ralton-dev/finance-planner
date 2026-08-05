import { useCallback, useEffect, useState } from "react";

export interface AsyncState<T> {
  data?: T;
  error?: Error;
  /**
   * True only while there is **nothing to show**: the first read, or a read of
   * something else after the deps changed. A page gated on this renders its
   * placeholder exactly when it has no answer, and never again.
   */
  loading: boolean;
  /** True while a `refetch()` is in flight *over* data already on screen. For
   *  the rare caller that wants to say so; most should just keep rendering. */
  refreshing: boolean;
  refetch: () => void;
}

interface Internal<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  refreshing: boolean;
}

/**
 * Minimal data-fetching hook: runs `fn`, tracks loading/error, exposes refetch.
 *
 * ## Why a refetch keeps what it has
 *
 * `refetch()` used to set `{loading: true}`, which dropped `data` — so every
 * page gated on `loading` unmounted its whole subtree on every refresh, and
 * everything those components held in local state went with it. On the Overview
 * that included `Fold`'s `settled` map, which is what an "undo" is: confirming
 * a transfer refetched the page, the fold remounted, and the undo for the thing
 * you had just done vanished the moment it appeared.
 *
 * So a refetch over data that is already on screen is `refreshing`, not
 * `loading`: the last answer stays rendered until the next one replaces it,
 * which is also what makes a refresh not flash.
 *
 * A **deps change** is the other thing entirely and keeps the blank slate. Data
 * fetched for account A must not sit under account B's heading while B loads —
 * that is not a stale render, it is the wrong answer — so the effect-driven run
 * clears, and only the caller-driven `refetch()` holds on.
 *
 * An error still clears: a page that cannot re-read its data should say so
 * rather than keep printing an answer it can no longer stand behind.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<Internal<T>>({ loading: true, refreshing: false });

  const run = useCallback(fn, deps);

  const load = useCallback(
    (keep: boolean) => {
      setState((prev) =>
        keep && prev.data !== undefined
          ? { data: prev.data, loading: false, refreshing: true }
          : { loading: true, refreshing: false },
      );
      run()
        .then((data) => setState({ data, loading: false, refreshing: false }))
        .catch((error: Error) => setState({ error, loading: false, refreshing: false }));
    },
    [run],
  );

  const refetch = useCallback(() => load(true), [load]);

  useEffect(() => {
    load(false);
  }, [load]);

  return { ...state, refetch };
}
