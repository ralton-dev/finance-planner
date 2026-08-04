import { vi } from "vitest";

export interface Reply {
  /** Defaults to 200. Use 204 for the empty-body endpoints. */
  status?: number;
  body?: unknown;
  /** Response headers, lower-cased keys. Only the download endpoints read any. */
  headers?: Record<string, string>;
}

/** Keyed `"METHOD /path"`. A function is re-evaluated per call, so a route can
 *  answer differently once something else has happened (e.g. /me after a
 *  two-factor change). */
export type Routes = Record<string, Reply | (() => Reply)>;

export interface FetchStub {
  mock: ReturnType<typeof vi.fn>;
  /** Add or replace routes mid-test. */
  set: (routes: Routes) => void;
  /** Parsed JSON body of the first matching request. */
  bodyOf: (key: string) => Record<string, unknown> | undefined;
  /** How many times a route was hit. */
  calls: (key: string) => number;
}

/**
 * Stubs global fetch with a tiny router, for tests that drive the real
 * ApiClient. Unmatched requests 404 with the standard `{error:{code}}` body,
 * so a missing stub fails loudly instead of hanging.
 *
 * Pair with `vi.unstubAllGlobals()` in afterEach, as the other tests do.
 */
export function stubApiFetch(initial: Routes): FetchStub {
  let routes: Routes = { ...initial };
  const seen: { key: string; body?: string }[] = [];

  const mock = vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
    const key = `${init?.method ?? "GET"} ${String(url)}`;
    seen.push({ key, body: init?.body });

    const entry = routes[key];
    const reply: Reply =
      entry === undefined
        ? { status: 404, body: { error: { code: "not_stubbed", message: `no stub for ${key}` } } }
        : typeof entry === "function"
          ? entry()
          : entry;
    const status = reply.status ?? 200;

    const headers = reply.headers ?? {};

    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      json: async () => reply.body,
      // Enough Response for the endpoints served as a file rather than as JSON.
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      blob: async () =>
        new Blob([JSON.stringify(reply.body ?? null)], { type: "application/json" }),
    };
  });

  vi.stubGlobal("fetch", mock);

  return {
    mock,
    set(next) {
      routes = { ...routes, ...next };
    },
    bodyOf(key) {
      const hit = seen.find((c) => c.key === key);
      return hit?.body ? (JSON.parse(hit.body) as Record<string, unknown>) : undefined;
    },
    calls(key) {
      return seen.filter((c) => c.key === key).length;
    },
  };
}
