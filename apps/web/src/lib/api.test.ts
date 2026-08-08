import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api.js";

/** One recorded call: enough to tell a refresh from a data request. */
interface Call {
  url: string;
  authorization: string | null;
}

/** A fetch stand-in driven by per-path handlers, recording what it was asked. */
function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = { url: String(input), authorization: headers.authorization ?? null };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, refreshes: () => calls.filter((c) => c.url.endsWith("/api/auth/refresh")) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A token shaped like the one auth issues — HS256 header, `exp` in the payload,
 *  a signature nobody here verifies — expiring `inSeconds` from now. */
function jwt(inSeconds: number): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  const exp = Math.floor(Date.now() / 1000) + inSeconds;
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u1", exp })}.signature`;
}

describe("ApiClient.tryRefresh", () => {
  let client: ApiClient;
  beforeEach(() => {
    client = new ApiClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collapses concurrent refreshes into a single request", async () => {
    const stub = stubFetch(() => json({ accessToken: "fresh" }));

    const results = await Promise.all([
      client.tryRefresh(),
      client.tryRefresh(),
      client.tryRefresh(),
    ]);

    // The whole point: the server rotates the cookie, so a second refresh in
    // flight would look like token theft and log the user out everywhere.
    expect(stub.refreshes()).toHaveLength(1);
    expect(results).toEqual([true, true, true]);
    expect(client.getToken()).toBe("fresh");
  });

  it("releases the guard, so a later refresh still runs", async () => {
    let issued = 0;
    const stub = stubFetch(() => json({ accessToken: `token-${++issued}` }));

    expect(await client.tryRefresh()).toBe(true);
    expect(await client.tryRefresh()).toBe(true);

    expect(stub.refreshes()).toHaveLength(2);
    expect(client.getToken()).toBe("token-2");
  });

  it("does not let a failed refresh poison the next one", async () => {
    let attempt = 0;
    const stub = stubFetch(() =>
      ++attempt === 1
        ? json({ error: { code: "unauthorized", message: "no" } }, 401)
        : json({ accessToken: "recovered" }),
    );

    const failed = await Promise.all([client.tryRefresh(), client.tryRefresh()]);
    expect(failed).toEqual([false, false]);
    expect(stub.refreshes()).toHaveLength(1);
    expect(client.getToken()).toBeNull();

    expect(await client.tryRefresh()).toBe(true);
    expect(client.getToken()).toBe("recovered");
  });

  it("survives a refresh that throws", async () => {
    let attempt = 0;
    stubFetch(() => {
      if (++attempt === 1) throw new Error("network down");
      return json({ accessToken: "back" });
    });

    expect(await client.tryRefresh()).toBe(false);
    expect(await client.tryRefresh()).toBe(true);
  });

  it("refreshes once when several requests 401 together", async () => {
    // The production trigger: the access token expires, every request a page
    // has in flight 401s at the same moment, and each one retries.
    client.setToken("expired");
    const stub = stubFetch(({ url, authorization }) => {
      if (url.endsWith("/api/auth/refresh")) return json({ accessToken: "fresh" });
      return authorization === "Bearer fresh"
        ? json([])
        : json({ error: { code: "unauthorized", message: "expired" } }, 401);
    });

    await Promise.all([client.listAccounts(), client.listProjects(), client.overview()]);

    expect(stub.refreshes()).toHaveLength(1);
    expect(client.getToken()).toBe("fresh");
  });
});

/**
 * The burst WP-BA measured. A page mounts six or seven reads in one tick; if
 * the access token has expired while the tab sat idle, every one of them 401s,
 * one refresh runs, and every one of them is sent again. Counted in a browser
 * against a real expired token: the account page sent **19** requests where it
 * normally sends 12, and six of the nineteen were 401s.
 *
 * The token says when it expires. Reading that before sending turns 2N+1 into
 * N+1 — and the 401 path stays exactly where it was, because a clock is not
 * evidence and only the server can say a token is dead.
 */
describe("ApiClient · a token it can see has expired", () => {
  let client: ApiClient;
  beforeEach(() => {
    client = new ApiClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes before sending, so a wave of reads costs no 401s at all", async () => {
    client.setToken(jwt(-60));
    const stub = stubFetch(({ url, authorization }) => {
      if (url.endsWith("/api/auth/refresh")) return json({ accessToken: jwt(900) });
      return authorization === "Bearer expired-token"
        ? json({ error: { code: "unauthorized", message: "expired" } }, 401)
        : json([]);
    });

    await Promise.all([client.listAccounts(), client.listProjects(), client.overview()]);

    // One refresh for the wave, and one request each — never two.
    expect(stub.refreshes()).toHaveLength(1);
    expect(stub.calls).toHaveLength(4);
  });

  it("still sends when the refresh fails, and does not then refresh again", async () => {
    // A dead refresh cookie. The server is the authority on the token, so the
    // request goes anyway — but the retry has been spent, so the 401 is final
    // and the client does not sit there refreshing per read.
    client.setToken(jwt(-60));
    const stub = stubFetch(({ url }) =>
      url.endsWith("/api/auth/refresh")
        ? json({ error: { code: "unauthorized", message: "no cookie" } }, 401)
        : json({ error: { code: "unauthorized", message: "expired" } }, 401),
    );

    await expect(client.listAccounts()).rejects.toMatchObject({ status: 401 });

    expect(stub.refreshes()).toHaveLength(1);
    expect(stub.calls).toHaveLength(2);
  });

  it("leaves a token that is still good alone", async () => {
    client.setToken(jwt(900));
    const stub = stubFetch(() => json([]));

    await client.listAccounts();

    expect(stub.refreshes()).toHaveLength(0);
    expect(stub.calls).toHaveLength(1);
  });

  it("says nothing about a token it cannot read, and takes the 401 path", async () => {
    // An opaque token — a test double, or an issuer that stops using JWTs. The
    // expiry is unknown, so nothing is pre-empted and the behaviour is the one
    // this client always had.
    client.setToken("not-a-jwt");
    const stub = stubFetch(({ url, authorization }) =>
      url.endsWith("/api/auth/refresh")
        ? json({ accessToken: "fresh" })
        : authorization === "Bearer fresh"
          ? json([])
          : json({ error: { code: "unauthorized", message: "expired" } }, 401),
    );

    await client.listAccounts();

    expect(stub.calls.map((c) => c.url)).toEqual([
      "/api/accounts",
      "/api/auth/refresh",
      "/api/accounts",
    ]);
  });
});

/**
 * "I moved the money" for a transfer the plan **derived** — one call, from
 * every surface.
 *
 * There used to be two: `confirmTransfer(householdId, …)` for a transfer a
 * household derived and `confirmDerivedTransfer(accountId, …)` for one no
 * household applied to. They wrote two differently-shaped rows for one event,
 * and each surface could read back only its own — so the household plan and the
 * member's account page disagreed about whether a movement had happened. A
 * derived transfer is located by its two accounts, its month and the member who
 * moves it, and that needs no parent id at all.
 *
 * An **authored** movement keeps its own route and its own rule. That split is
 * real: somebody wrote that one down.
 */
describe("ApiClient · confirming a derived transfer", () => {
  let client: ApiClient;
  beforeEach(() => {
    client = new ApiClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to one route with no parent id, naming both accounts and the member", async () => {
    const { calls } = stubFetch(() => json({ confirmation: { id: "conf-1" }, contributions: [] }));
    const result = await client.confirmTransfer({
      fromAccountId: "current",
      toAccountId: "pot",
      memberUserId: "ben",
      month: "2026-08",
    });

    expect(calls[0]!.url).toContain("/api/transfers/confirm");
    // Neither a household nor an account in the path: what the caller was
    // looking at cannot decide what gets written.
    expect(calls[0]!.url).not.toContain("/api/households/");
    expect(calls[0]!.url).not.toContain("/api/accounts/");
    expect(result.confirmation.id).toBe("conf-1");
  });

  it("un-confirms by the confirmation's own id, under neither a household nor an account", async () => {
    const { calls } = stubFetch(() => new Response(null, { status: 204 }));
    await client.unconfirmTransfer("conf-1");
    expect(calls[0]!.url).toContain("/api/transfers/confirmations/conf-1");
    expect(calls[0]!.url).not.toContain("/api/households/");
    expect(calls[0]!.url).not.toContain("/api/accounts/");
  });
});
