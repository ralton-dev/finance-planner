import { MemoryStore } from "@finance-planner/data";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "../env.js";
import { buildServer } from "../server.js";

/**
 * **Red pin — issue #73. Flipped by WP-BS.**
 *
 * > A request that crosses a process boundary is still one request, and every
 * > process here is certain it is the only one.
 *
 * `apps/api` is the single public entrypoint and forwards `/api/auth/*` into
 * `apps/auth` through `@fastify/http-proxy` (`apps/api/src/server.ts:650-655`).
 * Two processes, one request, and **nothing sent on the wire says they are the
 * same request.**
 *
 * ## Observed on `56ffc61`, 2026-08-08
 *
 * Booting auth (pid 44049, port 4991) and api (pid 44067, port 4990) as two
 * separate processes with `registerAuthProxy` at its default of on, and issuing
 * one `POST /api/auth/login` that api forwarded to auth. These are the captured
 * lines, not a reconstruction.
 *
 * **api said:**
 *
 * ```json
 * {"level":30,"time":1786220145709,"pid":44067,"reqId":"req-4","req":{"method":"POST","url":"/api/auth/login",…},"msg":"incoming request"}
 * {"level":30,"time":1786220145709,"pid":44067,"reqId":"req-4","source":"/auth/login","msg":"fetching from remote server"}
 * {"level":30,"time":1786220145754,"pid":44067,"reqId":"req-4","res":{"statusCode":200},"responseTime":45.399,"msg":"request completed"}
 * ```
 *
 * **auth said, for the same request:**
 *
 * ```json
 * {"level":30,"time":1786220145711,"pid":44049,"reqId":"req-2","req":{"method":"POST","url":"/auth/login",…},"msg":"incoming request"}
 * {"level":30,"time":1786220145753,"pid":44049,"reqId":"req-2","res":{"statusCode":200},"responseTime":41.978,"msg":"request completed"}
 * ```
 *
 * | field          | api               | auth          |
 * | -------------- | ----------------- | ------------- |
 * | `reqId`        | **`req-4`**       | **`req-2`**   |
 * | `url`          | `/api/auth/login` | `/auth/login` |
 * | service name   | _absent_          | _absent_      |
 * | `responseTime` | 45.399            | 41.978        |
 *
 * Nothing joins those two lines — not a field, not an id, not even the service
 * name: neither server sets a Pino `name`, `base` or `mixin`, both being
 * literally `Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } })`
 * (`apps/api/src/server.ts:638`, `apps/auth/src/server.ts:129`). The only join
 * available is 2 ms of timestamp adjacency plus a guessed prefix rewrite, on an
 * idle box with one user.
 *
 * **`req-4` and `req-2` look like identifiers and are not.** Fastify 5's default
 * `requestIdHeader` is `false`, so `reqIdGenFactory` never consults a header and
 * returns a per-process counter. On the request one earlier in the same capture
 * api said `req-1` and auth said `req-1` **by coincidence** — worse than
 * mismatching, because it invites a join that is silently wrong the moment the
 * counters drift.
 *
 * ## The transport already works. Nobody sends anything down it.
 *
 * `@fastify/reply-from@12.6.2` forwards the whole header bag (`index.js:92`,
 * `{ ...req.headers }`, stripping only hop-by-hop names). A probe on the same
 * tree sent
 * `traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01` with the
 * login and an auth-side hook recorded it **arriving intact** — after which auth
 * logged `reqId: req-3` and the value was discarded unread. So the hop carries a
 * correlation header perfectly well; no process ever originates one, and no
 * process reads one that arrives.
 *
 * What api actually puts on the wire, recorded by the stub below when this pin
 * was written and **the whole list**:
 *
 * ```
 * connection, content-length, content-type, host, user-agent
 * ```
 *
 * Not a `traceparent`, and not a correlation-shaped header of any other
 * dialect either — no `x-request-id`, no `b3`, no `x-correlation-id`. There is
 * nothing to widen the assertion to.
 *
 * That is the assumption this pin exists to break:
 *
 * > **that a process can describe what happened to it.**
 *
 * api's `"source":"/auth/login"` is its entire account of its downstream work —
 * no upstream host, no upstream status, no upstream duration. api's 45.399 ms
 * and auth's 41.978 ms are the same 42 ms counted twice by two processes that
 * cannot tell they are talking about each other.
 *
 * ## What this pin deliberately does **not** assert, and why
 *
 * Only the **transport** is asserted here: the bytes on the wire out of this
 * process. Nothing about spans, `http.route`, or a Pino line carrying
 * `trace_id`.
 *
 * That is not modesty, it is reach. `@opentelemetry/instrumentation-undici`
 * hooks `diagnostics_channel` rather than patching a module, so it is the one
 * instrumentation that takes effect without the ESM loader hook and is therefore
 * observable from an ordinary vitest run. Everything else in this work depends
 * on load ordering — `register("@opentelemetry/instrumentation/hook.mjs", …)`
 * running before the app graph is imported, and `fastify` being external to the
 * bundle so it can be patched at all. Vitest has already loaded this module
 * graph by the time any test body runs, so a span assertion here would be
 * asserting a fact this process cannot establish, and would either fail
 * permanently or pass for the wrong reason.
 *
 * **Do not "fix" this pin by widening it.** The span objects, the `http.route`
 * attribute and the correlated Pino line are proven by **WP-BS**'s `otel-smoke`
 * CI job, which brings up two real containers and asserts on a collector's
 * output. WP-BS is also the package that flips this pin from `it.fails` to a
 * plain `it`.
 */

const env: ApiEnv = {
  port: 0,
  host: "127.0.0.1",
  jwtSecret: "test-secret",
  // Overwritten per-test with the stub's ephemeral port; see beforeEach.
  authUrl: "http://127.0.0.1:1",
  mailFrom: "Finance Planner <no-reply@test.local>",
  notifyEnabled: false,
  notifyHour: 8,
  enableDemoSeed: false,
  enablePlanDebug: false,
};

/** W3C `traceparent`, version 00: `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`. */
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** An all-zero trace id is invalid per the spec and means "no trace", so the
 *  shape alone is not enough to call the hop correlated. */
const ZERO_TRACE_ID = "0".repeat(32);

interface Received {
  url: string;
  headers: IncomingHttpHeaders;
}

/**
 * A plain `node:http` server standing in for `apps/auth`.
 *
 * Deliberately **not** the real auth service: the only question here is what api
 * puts on the wire, and a stub records every header without needing a second
 * store, a second port to guess, or auth's rate limiter. It listens on port 0 so
 * concurrent runs cannot collide.
 */
async function startStub(): Promise<{
  url: string;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    received.push({ url: req.url ?? "", headers: { ...req.headers } });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("one request across the api → auth hop", () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  let app: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    stub = await startStub();
    app = buildServer({
      store: new MemoryStore(),
      env: { ...env, authUrl: stub.url },
      // Left at its default of on. The proxy is the thing under test.
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await stub.close();
  });

  /** One login, forwarded. */
  async function login() {
    return app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.com", password: "hunter2" },
    });
  }

  /**
   * The fixture's precondition, and **a plain `it` on purpose**.
   *
   * The pin below says nothing at all unless the request genuinely left this
   * process and arrived at the stub with its prefix rewritten. Kept out of the
   * `it.fails` so that a proxy which stops forwarding turns the build red
   * instead of joining the expected failures.
   */
  it("really does cross the boundary, with the prefix rewritten", async () => {
    const res = await login();

    expect(res.statusCode).toBe(200);
    expect(stub.received).toHaveLength(1);
    expect(stub.received[0]!.url).toBe("/auth/login");
  });

  /**
   * **The pin.** One request, two processes, and nothing on the wire that says
   * so.
   *
   * Silent on *how* the header comes to exist — decision 56 expects
   * `instrumentation-undici` to inject it with no code change at all, but a
   * manual `onRequest` hook on the proxy would satisfy this assertion equally.
   * What is refused is the state today: a hop that carries a correlation header
   * fine and is never given one.
   */
  it.fails("carries a traceparent into auth", async () => {
    await login();
    const headers = stub.received[0]!.headers;
    const traceparent = typeof headers.traceparent === "string" ? headers.traceparent : "«absent»";
    const seen = Object.keys(headers).sort().join(", ");

    expect(
      traceparent,
      `nothing correlates api's request with auth's. headers on the wire: ${seen}`,
    ).toMatch(TRACEPARENT);
    expect(
      traceparent.slice(3, 35),
      "traceparent present but the trace id is all zeros, which is 'no trace'",
    ).not.toBe(ZERO_TRACE_ID);
  });
});
