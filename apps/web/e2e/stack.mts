/**
 * The end-to-end stack, in one process.
 *
 * Playwright's `webServer` runs this instead of `vite preview`, because a
 * preview server has no backend behind it and the whole point of the suite it
 * boots is to watch what the pages *fetch*. What it puts up:
 *
 *   - auth and api built over **one shared `MemoryStore`**. In DB-less mode each
 *     `buildServer()` makes a private store of its own, so household routes 404
 *     across processes — which looks exactly like the regression this suite
 *     exists to catch, and would make the suite lie in the most convincing way
 *     available to it.
 *   - the api keeps its `/api/auth/*` proxy, so the browser talks to one origin
 *     and the refresh cookie behaves the way it does in production behind nginx.
 *   - a static server for `dist` that forwards `/api` onward, **including every
 *     response header and every `set-cookie`**. Dropping `set-cookie` silently
 *     401s every navigation; a suite that fails the run on a 401 would report
 *     that as a spectacular false red.
 *
 * Auth is built with `rateLimit: false`. Every request in a Playwright run comes
 * from one IP, and login is throttled at 5/min per IP — a suite that logs in
 * would otherwise start 429ing itself as soon as it grew a second test.
 *
 * The api and auth modules are loaded through a computed specifier so that
 * `tsc --noEmit` on this package does not drag `apps/api` and `apps/auth`'s
 * source into the web program. The shapes below are the narrow slice this file
 * calls; if a signature moves, this harness fails loudly at boot and takes the
 * e2e job with it, which is the failure we want.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_USER } from "./fixture.js";

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4980);
const API_PORT = Number(process.env.E2E_API_PORT ?? 4981);
const AUTH_PORT = Number(process.env.E2E_AUTH_PORT ?? 4982);
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

/** The slice of a Fastify instance this file uses. */
interface Listenable {
  listen(opts: { port: number; host: string }): Promise<unknown>;
  close(): Promise<unknown>;
}
interface ServerModule {
  buildServer(deps: Record<string, unknown>): Listenable;
}
interface StoreModule {
  MemoryStore: new () => object;
}

const DIST = new URL("../dist/", import.meta.url);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Read the whole request body. Every API call the SPA makes is small JSON.
 *
 * A plain `Uint8Array`, not a `Buffer`: this package compiles with the DOM lib,
 * where `fetch`'s `BodyInit` is `BufferSource` and a `Buffer<ArrayBufferLike>`
 * does not satisfy it.
 */
function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

/**
 * Forward one `/api` call to the api service and copy the answer back whole.
 *
 * `set-cookie` is the header that matters and the one a naive copy loses:
 * `Headers` folds repeats into a single comma-joined string, and a folded
 * `Expires=...,` breaks every cookie in the list. `getSetCookie()` hands them
 * back as separate values. The content-* encoding headers are the deliberate
 * exception — `fetch` has already decoded the body, so forwarding the upstream's
 * `content-encoding`/`content-length` would describe bytes we are not sending.
 */
async function proxyApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === "host" || key === "connection" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }

  const upstream = await fetch(`${API_ORIGIN}${req.url ?? "/"}`, {
    method: req.method,
    headers,
    body: body && body.length > 0 ? body : undefined,
    redirect: "manual",
  });

  const out = Buffer.from(await upstream.arrayBuffer());
  for (const [key, value] of upstream.headers) {
    if (key === "set-cookie" || key === "content-encoding" || key === "content-length") continue;
    res.setHeader(key, value);
  }
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  res.writeHead(upstream.status);
  res.end(out);
}

/** Serve a built file, falling back to index.html so client routes resolve. */
async function serveStatic(url: string, res: ServerResponse): Promise<void> {
  const path = url.split("?")[0] ?? "/";
  const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  let file = new URL(rel, DIST);
  let ext = extname(rel);
  let bytes: Buffer;
  try {
    bytes = await readFile(fileURLToPath(file));
  } catch {
    // Unknown path with an extension is a genuinely missing asset — a 404 here
    // is the truth, and the suite is entitled to fail the run over it. Only
    // extensionless paths are client routes.
    if (ext !== "") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    file = new URL("index.html", DIST);
    ext = ".html";
    bytes = await readFile(fileURLToPath(file));
  }
  res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
  res.end(bytes);
}

/** POST/GET the api as the seeded user, failing loudly on anything but 2xx. */
async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<unknown> {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`seed: ${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function main(): Promise<void> {
  const auth = (await import(
    new URL("../../auth/src/server.ts", import.meta.url).href
  )) as ServerModule;
  const api = (await import(
    new URL("../../api/src/server.ts", import.meta.url).href
  )) as ServerModule;
  const data = (await import(
    new URL("../../../packages/data/src/index.ts", import.meta.url).href
  )) as StoreModule;

  // One store, both services. This is the whole reason the harness exists.
  const store = new data.MemoryStore();
  const jwtSecret = "e2e-harness-secret";
  const publicWebUrl = `http://127.0.0.1:${WEB_PORT}`;

  const authApp = auth.buildServer({
    store,
    rateLimit: false,
    env: {
      port: AUTH_PORT,
      host: "127.0.0.1",
      jwtSecret,
      accessTtlSeconds: 900,
      refreshTtlDays: 30,
      cookieSecure: false,
      cookiePath: "/api/auth",
      publicWebUrl,
      mailFrom: "Finance Planner <no-reply@e2e.local>",
    },
  });
  await authApp.listen({ port: AUTH_PORT, host: "127.0.0.1" });

  const apiApp = api.buildServer({
    store,
    // `registerAuthProxy` left on: one origin, one cookie, like production.
    env: {
      port: API_PORT,
      host: "127.0.0.1",
      jwtSecret,
      authUrl: `http://127.0.0.1:${AUTH_PORT}`,
      mailFrom: "Finance Planner <no-reply@e2e.local>",
      notifyEnabled: false,
      notifyHour: 8,
      enableDemoSeed: true,
      enablePlanDebug: false,
    },
  });
  await apiApp.listen({ port: API_PORT, host: "127.0.0.1" });

  // Seed before the browser can reach anything: register, log in once, plant
  // the worked example, then read back the ids the spec navigates to.
  await call("POST", "/api/auth/register", { body: E2E_USER });
  const session = (await call("POST", "/api/auth/login", {
    body: { email: E2E_USER.email, password: E2E_USER.password },
  })) as { accessToken: string };
  await call("POST", "/api/demo/seed", { token: session.accessToken });
  const accounts = (await call("GET", "/api/accounts", { token: session.accessToken })) as {
    id: string;
    name: string;
  }[];
  const households = (await call("GET", "/api/auth/households", {
    token: session.accessToken,
  })) as { id: string; name: string }[];
  if (accounts.length === 0 || households.length === 0) {
    throw new Error(
      `seed produced nothing to open: ${accounts.length} accounts, ${households.length} households`,
    );
  }
  const seeded = { accountId: accounts[0]!.id, householdId: households[0]!.id };

  const web = createServer((req, res) => {
    const url = req.url ?? "/";
    const done = url.startsWith("/api/")
      ? proxyApi(req, res)
      : // Harness-only: what the seed made, so the spec can navigate to a real
        // account and a real household without scraping the UI for ids.
        url.startsWith("/__e2e__/seeded")
        ? Promise.resolve(
            void res
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify(seeded)),
          )
        : serveStatic(url, res);
    done.catch((err: unknown) => {
      process.stderr.write(`harness: ${url} failed: ${String(err)}\n`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });

  // Listening last is the readiness gate: Playwright waits on this port, so it
  // cannot start a test against a stack that has not finished seeding.
  await new Promise<void>((resolve) => web.listen(WEB_PORT, "127.0.0.1", resolve));
  process.stdout.write(
    `harness: web :${WEB_PORT} · api :${API_PORT} · auth :${AUTH_PORT} · ` +
      `${accounts.length} accounts, ${households.length} households seeded\n`,
  );

  const stop = (): void => {
    web.close();
    void apiApp.close();
    void authApp.close();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

await main();
