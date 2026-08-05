import { useCallback, useEffect, useRef, useState } from "react";

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
 * that is not a stale render, it is the wrong answer — so the deps-driven run
 * clears, and only the caller-driven `refetch()` holds on.
 *
 * ## Why the blanking happens during the render, not in the effect
 *
 * That clearing used to live in the effect, which runs a beat *after* the
 * render that changed the deps — and for one committed render the hook said
 * `loading: false` and handed back the previous deps' answer as though it were
 * this one's. On the Overview that beat was a whole checklist: the household
 * plans are read for `me().households`, so the run before `me` answered was a
 * run for *no* households, and the page rendered its fold off that "you have
 * nothing" the moment `me` arrived. A click landing in the beat — check in,
 * type, save — was thrown away when the real read started and blanked the fold
 * under it. So the deps are compared during render and the answer to the
 * question nobody asked any more is dropped there, before it can be rendered.
 *
 * A resolution from a superseded run is dropped for the same reason: it is the
 * old deps' answer arriving late, and the guard means it cannot land on top of
 * the run that replaced it.
 *
 * An error still clears: a page that cannot re-read its data should say so
 * rather than keep printing an answer it can no longer stand behind.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<Internal<T>>({ loading: true, refreshing: false });

  const run = useCallback(fn, deps);

  // Which `run` the state in hand is an answer to. Held in state rather than a
  // ref so the comparison survives a render React throws away and re-runs.
  // Both function forms are the awkward ones: `useState(() => run)` is a lazy
  // initialiser *returning* run, and `setRanFor(() => run)` an updater doing
  // the same — passing `run` bare would call it and start a read.
  const [ranFor, setRanFor] = useState<() => Promise<T>>(() => run);
  if (ranFor !== run) {
    setRanFor(() => run);
    setState({ loading: true, refreshing: false });
  }

  /** The read whose answer we are still waiting for; anything else is late. */
  const current = useRef<(() => Promise<T>) | null>(null);

  const load = useCallback(
    (keep: boolean) => {
      current.current = run;
      setState((prev) =>
        keep && prev.data !== undefined
          ? { data: prev.data, loading: false, refreshing: true }
          : { loading: true, refreshing: false },
      );
      run()
        .then((data) => {
          if (current.current === run) setState({ data, loading: false, refreshing: false });
        })
        .catch((error: Error) => {
          if (current.current === run) setState({ error, loading: false, refreshing: false });
        });
    },
    [run],
  );

  const refetch = useCallback(() => load(true), [load]);

  useEffect(() => {
    load(false);
  }, [load]);

  return { ...state, refetch };
}
