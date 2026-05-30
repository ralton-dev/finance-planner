import { useCallback, useEffect, useState } from "react";

export interface AsyncState<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  refetch: () => void;
}

/** Minimal data-fetching hook: runs `fn`, tracks loading/error, exposes refetch. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({
    loading: true,
  });

  const run = useCallback(fn, deps);

  const refetch = useCallback(() => {
    setState({ loading: true });
    run()
      .then((data) => setState({ data, loading: false }))
      .catch((error: Error) => setState({ error, loading: false }));
  }, [run]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { ...state, refetch };
}
