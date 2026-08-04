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
