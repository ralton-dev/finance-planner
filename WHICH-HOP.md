# Implementation plan — which hop was slow

Agreed 2026-08-08, on `main` at `56ffc61`, tree clean, nothing in flight. Written
to be picked up cold; read it in full before starting. Conventions and the
definition of done are inherited from [`ONE-ENGINE.md`](./ONE-ENGINE.md) and
[`SAID-AND-DONE.md`](./SAID-AND-DONE.md) — integer minor units, explicit
`asOfDate`, Store parity for data changes, plain CSS through design tokens,
stage only owned paths, never `git add -A`. Decisions 1–48 stand; this plan adds
**49–60**. It closes [issue #73](https://github.com/bralton/finance-planner/issues/73).

**The local gate for every package includes `pnpm build` and
`pnpm exec prettier --check .`** — both are fatal CI jobs. The domain coverage
gate is whatever `packages/domain/vitest.config.ts` says today; **read it from
the config, not from prose.** Nothing in this plan touches `packages/domain`, so
no package here should move that number at all — if yours does, you have touched
something you do not own.

This plan **adds dependencies**, which no plan since REDESIGN has. That makes
`pnpm-lock.yaml` a choke point for the whole plan: exactly one package installs,
and it installs alone. See the wave table.

Every `file:line` in this document is a **hint to verify**. They were re-checked
against `56ffc61` on 2026-08-08 and they will still drift — `apps/api/src/server.ts`
is 3058 lines and every package that edits above a reference moves it. Grep for
the symbol, confirm it says what this document claims, and **report the drift
rather than working around it.**

---

## One request, and what each process called it

Observed on `56ffc61`, 2026-08-08, by booting auth (pid 44049, port 4991) and api
(pid 44067, port 4990) as **two separate processes** with `registerAuthProxy` at
its default of on, and issuing one `POST /api/auth/login` that api forwarded to
auth. These are the real captured lines, not a reconstruction.

**api said:**

```json
{"level":30,"time":1786220145709,"pid":44067,"reqId":"req-4","req":{"method":"POST","url":"/api/auth/login",…},"msg":"incoming request"}
{"level":30,"time":1786220145709,"pid":44067,"reqId":"req-4","source":"/auth/login","msg":"fetching from remote server"}
{"level":30,"time":1786220145754,"pid":44067,"reqId":"req-4","res":{"statusCode":200},"responseTime":45.399,"msg":"request completed"}
```

**auth said, for the same request:**

```json
{"level":30,"time":1786220145711,"pid":44049,"reqId":"req-2","req":{"method":"POST","url":"/auth/login",…},"msg":"incoming request"}
{"level":30,"time":1786220145753,"pid":44049,"reqId":"req-2","res":{"statusCode":200},"responseTime":41.978,"msg":"request completed"}
```

| field          | api               | auth          |
| -------------- | ----------------- | ------------- |
| `reqId`        | **`req-4`**       | **`req-2`**   |
| `url`          | `/api/auth/login` | `/auth/login` |
| service name   | _absent_          | _absent_      |
| `responseTime` | 45.399            | 41.978        |

**Nothing joins these two lines.** Not a field, not an id, not even the service
name — neither server sets a Pino `name`, `base`, or `mixin`; both are literally
`Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } })`
(`apps/api/src/server.ts:638`, `apps/auth/src/server.ts:129`). The only join
available is 2 ms of timestamp adjacency plus a guessed prefix rewrite, on an
idle box with one user. Two simultaneous logins produce four indistinguishable
lines and even that is gone.

Three facts make it worse than "unwired", and each is checkable:

- **`req-4` and `req-2` look like identifiers and are not.** Fastify 5's default
  `requestIdHeader` is `false` — verify at
  `apps/api/node_modules/fastify/lib/config-validator.js:1265` — so
  `reqIdGenFactory` never consults a header and returns a **per-process
  counter** (`lib/req-id-gen-factory.js:19`). On the request one earlier in the
  same capture, api said `req-1` and auth said `req-1` **by coincidence**. That
  is worse than mismatching: it invites a join that is silently wrong the moment
  the counters drift.
- **The correlation header already crosses the hop, and is thrown away.**
  `@fastify/reply-from@12.6.2` forwards the whole header bag
  (`index.js:92`, `{ ...req.headers }`, stripping only hop-by-hop names). Sending
  `traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01` with the
  login, an auth-side probe recorded it arriving **intact**. Auth then logged
  `reqId: req-3`. The transport works; nothing reads it.
- **api's only account of its downstream work is `"source":"/auth/login"`.** No
  upstream host, no upstream status, no upstream duration. api's 45.399 ms and
  auth's 41.978 ms are the same 42 ms counted twice by two processes that cannot
  tell they are talking about each other.

## The reframing

**A request that crosses a process boundary is still one request, and every
process here is certain it is the only one.**

Two Pino streams that cannot be joined. Two request counters that both start at
one. A proxy that forwards a correlation header nobody sends and nobody reads.
Three health endpoints that each report a version of `"0.0.0"` because
`npm_package_version` is undefined under `CMD ["node", "dist/index.js"]`. A
`calc` service holding a `DATABASE_URL` it never reads, for callers that do not
exist.

Every package below gives the request one identity and makes each process say
which one it is holding.

---

## Decisions (49–60, continuing SAID-AND-DONE's numbering — do not relitigate)

49. **All three backends are instrumented; the `api → calc` trace is dropped
    from the acceptance** (Ben, 2026-08-08). `apps/api` **never calls**
    `apps/calc` — calc's only route, `POST /internal/calc/account-plan`
    (`apps/calc/src/server.ts:56`), is referenced solely by its own test, and api
    computes plans in-process through `packages/domain`. Issue #73's "SPA → api →
    auth → calc" cannot be observed today and no package is to invent the call to
    make it observable. Calc still gets the same bootstrap, because it is nearly
    free once the shared package exists and it is then ready on the day something
    calls it. **WP-BT files the orphan as a backlog entry.**

50. **`fastify` becomes `external` in all three tsup builds** (Ben, 2026-08-08),
    accepting that this changes the shipped bundle of every service
    **unconditionally, whether OTEL is on or off**. This is not a preference. It
    was measured: with fastify bundled you get **zero Fastify spans**, and — the
    part that is easy to miss — **every HTTP server span collapses to a bare
    `GET` with no `http.route` attribute**, which destroys grouping in any
    backend. `@opentelemetry/instrumentation`'s README states the rule
    ("modules are not included in a bundle"). Externalising `fastify` alone is
    sufficient; the `@fastify/*` plugin packages may stay bundled.

    The mechanism is already load-bearing here — `pg` has been external in api
    and auth since the beginning, and `apps/api/Dockerfile:16` copies the whole
    `/repo` to service it. Note the comment one line above it already reads
    _"Carry the installed workspace so external deps (fastify) are available at
    runtime"_ while `fastify` is still bundled: this decision makes that comment
    true rather than aspirational. The genuinely new case is **calc**, which
    externalises nothing today.

51. **Issue #73's "startup time unchanged" is amended, with a measured figure.**
    Decision 50 costs **~57 ms of startup, unconditionally** (median 58.9 ms
    bundled → 115.8 ms external, macOS/pnpm; **not** re-measured inside
    `node:24-alpine` — WP-BO does that and records the real number). The
    **preload** costs `+0.7 ms` when disabled, which is what the issue's clause
    was actually protecting. So the acceptance reads: _the OTEL preload costs
    ~1 ms and loads nothing when disabled; the externalisation costs a measured,
    named, one-off amount._ You cannot have both route-named spans and unchanged
    startup, and route-named spans are worth more.

52. **The preload is conditional and lazy, and that is what makes "off" mean
    off.** `dist/otel.js` is in the `CMD` permanently, but its entire body sits
    behind `if (process.env.OTEL_ENABLED === "true")` and reaches the SDK only
    through dynamic `import()`. Measured: with `OTEL_ENABLED` unset the process
    loads **273 CJS modules, zero of them OTEL** — byte-identical to running with
    no `--import` at all. With it on, 784. Do not "simplify" this to static
    imports.

53. **In tsup, externals must be RegExp, not globs.** `external:
["@opentelemetry/*"]` is **silently ignored** by tsup — it produces a
    2,868,026-byte `dist/otel.js`, byte-identical to declaring no external at
    all, with no warning. `external: [/^@opentelemetry\//]` produces 831 bytes.
    Exact strings (`"fastify"`, `"pg"`) do work, which is exactly why the failure
    hides: `index.js` shrinks correctly in the same broken build. **Check the
    output size, not the config.**

54. **A SIGTERM handler is mandatory, and without it you get nothing.** The OTLP
    HTTP exporter does not flush on exit and `BatchSpanProcessor`'s default delay
    is 5000 ms. Measured: SIGTERM one second after the requests delivered
    **0 spans** without a handler and **11 with one**. Total loss, not a lost
    tail. The handler lives inside the conditional block so it costs nothing when
    disabled, and it is the **first SIGTERM handler in this repository** — see
    decision 60.

55. **`@opentelemetry/instrumentation-pino`, not a hand-written Pino `mixin`.**
    It injects `trace_id` / `span_id` / `trace_flags` into Fastify's
    **internally-constructed** logger with **zero change to app code**, verified
    against this repo's exact `{ level }`-only configuration. A mixin would mean
    editing three `server.ts` files and keeping them in sync forever. The mixin's
    only advantage — surviving bundling — is void once decision 50 lands.

56. **Trace context across the api → auth hop needs no manual hook.**
    `@fastify/http-proxy@11.6.0` → `@fastify/reply-from@12.6.2` → **undici**
    (`shouldUseUndici` returns true unless you opt out), and
    `@opentelemetry/instrumentation-undici` injects `traceparent` unconditionally
    in `onRequestCreated`. Proven end-to-end across two processes: one trace id
    spanning api's server span, api's undici client span, and auth's server span
    and handler span. **`instrumentation-undici` is load-bearing for this** — it
    is not optional, and it hooks via `diagnostics_channel` rather than module
    patching, so it is the one instrumentation that works even bundled.

57. **`OTEL_ENABLED` is checked before the SDK is constructed, and so is the
    endpoint.** The OTLP spec **defaults** `OTEL_EXPORTER_OTLP_ENDPOINT` to
    `http://localhost:4318`, so it is never unset from the SDK's point of view
    and "enabled with no endpoint" exports quietly into the void. The preload
    reads `process.env` **directly** and throws before constructing anything if
    `OTEL_ENABLED === "true"` and neither `OTEL_EXPORTER_OTLP_ENDPOINT` nor
    `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is a non-empty string. `OTEL_SDK_DISABLED`
    is deliberately **not** honoured — it defaults to enabled and swaps in a no-op
    SDK rather than skipping the load, which is the opposite of decision 52.

58. **The generic endpoint variable takes a bare origin; the per-signal one takes
    a full path.** The SDK appends `/v1/traces` to `OTEL_EXPORTER_OTLP_ENDPOINT`
    and uses `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` **as-is**. Setting the
    per-signal variable to `http://collector:4318` therefore POSTs to `/` and
    drops every span, silently. Documentation and chart both use the **generic**
    variable with a bare origin.

59. **`service.version` and `deployment.environment.name` come from
    `OTEL_RESOURCE_ATTRIBUTES`, not from code.** Ben chose "bake the version at
    build time", and that mechanism is defeated by a fact found afterwards: **all
    three app `package.json` versions are literally `"0.0.0"`**, so a tsup
    `define` bakes the same lie one stage earlier. The honest source is the image
    tag, which the chart already renders (`.Values.image.tag`, SHA-tagged by CI).
    Ben's intent — make the version stop lying — is served; his mechanism is not
    used, and this decision records why. Note the current stable attribute is
    **`deployment.environment.name`**, not the older `deployment.environment`.
    Using the env var keeps `@opentelemetry/resources` and
    `@opentelemetry/semantic-conventions` out of the dependency list entirely:
    `NodeSDKConfiguration` has `serviceName` but **no** `serviceVersion`, and the
    only code route to `service.version` is a hand-built `Resource`.

60. **Graceful HTTP shutdown is named, not built.** Decision 54's handler calls
    `sdk.shutdown()` then `process.exit(0)` **without** closing Fastify, so
    in-flight requests are dropped — as they already are today, since the repo
    has no SIGTERM handler at all. This plan does not fix that: a correct
    shutdown needs the server handle, which the preload does not have, and it is
    a change to how every deploy drains. **WP-BT files it.** Do not let a package
    quietly grow an `app.close()` path.

Still binding from earlier plans, carried forward because packages here touch the
files they govern: **SAID-AND-DONE decision 33** (auth is excluded from the HPA
and its rotation state stays in process — nothing here may add an auth replica or
assume one), and the standing rule that **superseded code is deleted by the
package that supersedes it**, below.

---

## Deletion belongs to the package that supersedes

This plan supersedes very little, which is itself the risk: it is nearly all
addition, and addition is where dead configuration accumulates. Two things are
genuinely superseded and **must be deleted by the package that replaces them**:

- the `BACKLOG.md` observability bullet at `:197-198` is **narrowed, not
  deleted** — Prometheus, Grafana and Loki stay unwired and stay listed (WP-BT);
- `DATABASE_URL` and `REDIS_URL` on the `calc` service in
  `deploy/local/docker-compose.yml:94-95`, which calc has never read (WP-BP).

Every package reports **per symbol**: deleted, or kept with the name of whoever
still calls it. "Nothing calls it any more, so I left it" is not an answer. A red
build from a deletion is a result — it inventories the callers better than any
grep.

---

## The red pin

**One pin, one file**, landed as `it.fails` (vitest: passes while the assertion
fails, fails the moment it passes) with the observed evidence in a comment in the
test itself, against `56ffc61`. CI stays green while the defect stands and the
tree documents that the disagreement is known. Follow the shape of
`apps/api/src/pins/confirmation-ledger.pin.test.ts` and its two siblings.

**The plan's one objective completion signal: no `it.fails` remains in
`apps/api/src/pins/trace-across-the-hop.pin.test.ts`, and the `otel-smoke` CI job
is green on `main`.**

The pin asserts the _transport_, not the SDK, and that is deliberate — it is the
one half of this work that is testable inside an ordinary vitest run, because
`instrumentation-undici` hooks `diagnostics_channel` rather than patching a
module and therefore does not depend on load ordering. Everything that **does**
depend on load ordering — the ESM loader hook, the `fastify` external,
`http.route`, cross-process continuity — is provably out of reach of an in-process
test and is proven by WP-BS's CI job instead. Say this in the pin's own header
comment so the next person does not "fix" the pin by widening it.

---

## WP-BM · The pin: the header that crosses the hop and is never sent

**Goal:** the assertion that would have caught this exists before the work that
satisfies it, and the plan has one objective completion signal.

- New file `apps/api/src/pins/trace-across-the-hop.pin.test.ts`. Boot api via
  `buildServer({ store, env })` with `registerAuthProxy` left at its default of
  **on** and `env.authUrl` pointed at a **plain `node:http` stub server the test
  owns** — not at the real auth service. The stub records the headers it
  receives and replies 200.
- Issue one request under `/api/auth/*` so it is proxied. Assert the stub
  received a **`traceparent`** header matching `/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/`
  with a non-zero trace id. Today no such header exists: **the assertion fails,
  and the agent must see it fail and say so in its report.**
- **Do not** assert on span objects, `http.route`, or Pino `trace_id`. Those need
  the loader hook and cannot be reached from vitest — the pin's header comment
  explains this and names WP-BS as the package that proves them.
- Record in the comment the observed `req-4` / `req-2` pair from the evidence
  table above, and the probe result showing an inbound `traceparent` reaching
  auth intact and being discarded. A pin is the record of what went wrong.
- Name **WP-BS** as the flipping package in the header comment.

**Acceptance:** `pnpm test` green with one test reported as an expected failure.
Running it with `it` instead of `it.fails` fails, and the agent has **seen** that
and says so. No production code is touched, and no dependency is added.

Owns: `apps/api/src/pins/trace-across-the-hop.pin.test.ts` (new file — nothing
else). Size **S**. Depends: none.

---

## WP-BN · `packages/telemetry` — the bootstrap, written once

**Goal:** one module knows how to start tracing, and the three services differ
only by a name string.

- New workspace package `@finance-planner/telemetry`. **Copy
  `packages/mailer`'s scaffold exactly** — `package.json` with
  `main`/`types`/`exports` all `./src/index.ts` (no build step; apps bundle the
  TypeScript source), `tsconfig.json`, `src/`, and the three standard scripts.
  Use `vitest run --passWithNoTests` if you ship no tests, as
  `packages/contracts` does.
- Export **`startTelemetry(serviceName: string): Promise<void>`**. Its entire
  body sits behind `if (process.env.OTEL_ENABLED !== "true") return;`
  (decision 52) and reaches every OTEL package through **dynamic `import()`**.
  In order: `register("@opentelemetry/instrumentation/hook.mjs", import.meta.url)`
  from `node:module`, then the SDK, then `sdk.start()`, then the SIGTERM/SIGINT
  handler from decision 54 (idempotent — guard with a `let down = false`).
- **Register OTEL's wrapper, never `import-in-the-middle/hook.mjs` directly.**
  The OTEL docs are explicit: _"The only currently supported loader hook is
  `@opentelemetry/instrumentation/hook.mjs`."_ Note in a comment that
  `--experimental-loader` is the officially-documented form and is **deprecated
  on Node 24** (it warns); `module.register()` is what this repo uses, and OTEL
  issue #4933 / PR #6922 track blessing it. Link them.
- The startup check from decision 57, **before** anything is constructed: throw
  with a message naming both acceptable variables and what an operator should set.
- Instrumentations, fixed set, in this order: `http`, `fastify`, `undici`, `pg`,
  `pino`. Calc has no Postgres and still declares `instrumentation-pg` — it
  registers nothing on a service that never loads `pg`, and one code path is
  worth more than a wart-free dependency list. Say so in a comment.
- **The versions, verified against the registry on 2026-08-08.** The stable and
  experimental lines move separately and the contrib instrumentations each have
  their own `0.x` line — do not assume they match:

  ```jsonc
  "@opentelemetry/api": "^1.9.1",
  "@opentelemetry/sdk-node": "^0.221.0",
  "@opentelemetry/exporter-trace-otlp-http": "^0.221.0",
  "@opentelemetry/instrumentation-http": "^0.221.0",
  "@opentelemetry/instrumentation-fastify": "^0.57.0",
  "@opentelemetry/instrumentation-pg": "^0.73.0",
  "@opentelemetry/instrumentation-undici": "^0.31.0",
  "@opentelemetry/instrumentation-pino": "^0.67.0"
  ```

  **The ceiling is `@opentelemetry/api < 1.10.0`**, from the `peerDependencies`
  of `sdk-node`, `resources`, `core` and `sdk-trace-*`. Latest api is 1.9.1, so
  highest-in-range happens to be latest **today**; when 1.10.0 ships it will fall
  outside every stable peer range. Re-read the peers before bumping — this is the
  dependency policy applied, not a pin for its own sake. Do **not** add
  `@opentelemetry/resources` or `@opentelemetry/semantic-conventions`
  (decision 59), and do not add the `auto-instrumentations-node` meta-package.

- **Declare the OTEL packages in all three apps' `package.json` as well**, not
  only in `packages/telemetry`. `.npmrc` sets no hoisting, so pnpm's strict
  layout means the bare specifiers that survive externalisation (decision 53)
  must resolve from `/repo/apps/<app>/node_modules`. Add
  `"@finance-planner/telemetry": "workspace:*"` to each app too.
- Check whether the install adds anything to the root `pnpm.overrides` block's
  concerns — `protobufjs@7` and `undici@7` are already pinned there and
  `sdk-node` pulls the gRPC exporters transitively. **Report** what the lockfile
  gained; do not add overrides speculatively.

**Acceptance:** `pnpm install` is clean and `pnpm-lock.yaml` is committed;
`pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` all pass with the new
package in the graph. A short report naming every transitive dependency the
install added, and the resolved version of `@opentelemetry/api`. No app behaviour
changes yet — nothing imports `startTelemetry` in this package.

Owns: `packages/telemetry/**` (new), `pnpm-lock.yaml`, and
`apps/{api,auth,calc}/package.json` (dependency blocks only — **not**
`tsup.config.ts`, which is WP-BO's). Size **M**. Depends: none.
**Choke point: `pnpm-lock.yaml` — runs alone, and it is the only package in this
plan that installs.**

---

## WP-BO · fastify comes out of the bundles

**Goal:** the build produces a preload that Node can `--import`, and
instrumentation can reach the modules it needs to patch.

- Add a second entry and the externals to all three tsup configs. **Exactly
  these arrays** — decision 53 is why they are RegExp:

  `apps/api/tsup.config.ts` and `apps/auth/tsup.config.ts`:

  ```ts
  entry: ["src/index.ts", "src/otel.ts"],
  external: ["pg", "pg-native", "pg-cloudflare", "fastify", /^@opentelemetry\//],
  ```

  `apps/calc/tsup.config.ts` (which has no `external` key at all today, and no
  `pg`):

  ```ts
  entry: ["src/index.ts", "src/otel.ts"],
  external: ["fastify", /^@opentelemetry\//],
  ```

  Keep `noExternal: [/^@finance-planner\//]`, keep api's and auth's
  `createRequire` banner, and leave `splitting` at its default. Extend the
  existing comment at `apps/api/tsup.config.ts:9-14` to say why `fastify` joined
  the list — the next person will otherwise delete it as redundant.

- New `apps/{api,auth,calc}/src/otel.ts`, three lines each:
  `import { startTelemetry } from "@finance-planner/telemetry"; await startTelemetry("api");`
  with the service's own name — the same string as the `SERVICE` const at
  `apps/api/src/server.ts:82`, `apps/auth/src/server.ts:42`,
  `apps/calc/src/server.ts:10`. Do not import it from `server.ts`; a preload must
  not pull the app graph in.
- **Verify by output size, not by config** (decision 53). `dist/otel.js` should
  be **on the order of 1 KB**. If it is megabytes, the externals did not apply —
  report the size for all three services either way.
- **Measure the startup cost of decision 50 inside the real image**, which is the
  number decision 51 says has not been taken yet: build `apps/api`'s Docker image
  before and after, and time `node dist/index.js` to listen, ten runs each,
  median. Put the figure in your report and in decision 51's margin. The macOS
  figure was +56.9 ms; alpine may differ.
- `pnpm build` and the existing suites must pass with fastify resolved from
  `node_modules` rather than inlined. Run
  `pnpm --filter @finance-planner/web test:e2e` — it boots the real servers and
  will catch a resolution failure in eight seconds.

**Acceptance:** all three `dist/otel.js` are ~1 KB and all three `dist/index.js`
still boot and serve `/healthz` when run directly with `node dist/index.js`
(no `--import` yet). The alpine startup delta is measured and reported as a
number. The e2e fixture passes. Nothing is enabled: `OTEL_ENABLED` is not set
anywhere in this package.

Owns: `apps/{api,auth,calc}/tsup.config.ts`, `apps/{api,auth,calc}/src/otel.ts`
(new). Size **M**. Depends: WP-BN.

---

## WP-BP · The Dockerfiles, the compose collector, and the local loop

**Goal:** a person can run `make up` with tracing on and watch a single trace
cross from api into auth.

- Three Dockerfiles: `CMD ["node", "--import", "./dist/otel.js", "dist/index.js"]`.
  **The `./` is load-bearing** — `--import dist/otel.js` without it is treated as
  a bare package specifier and dies with `ERR_MODULE_NOT_FOUND`. The specifier
  resolves against **cwd**, and the Dockerfiles already `WORKDIR /repo/apps/<app>`
  before `CMD`, so this is correct as written. Verified in exactly that shape.
- `deploy/local/otel-collector-config.yaml` (new): OTLP HTTP receiver on
  `0.0.0.0:4318`, `batch` processor, `debug` exporter at `verbosity: detailed`.
  The `logging` exporter is gone; `debug` at the default `basic` verbosity prints
  only counts and will look like it is not working.
- An `otel-collector` service in `deploy/local/docker-compose.yml`, image
  **`otel/opentelemetry-collector-contrib:0.158.0`** (do not use `latest`; Docker
  Hub's recent-tag list is dominated by `0.159.0-nightly.*` builds, which are not
  releases). Mount the config — the image's built-in default does work, but it
  also starts Jaeger, Zipkin, zpages and a self-scrape, which is a lot of noise
  for a dev loop.
- **Gate it behind `profiles: ["otel"]`.** This repo has no compose profile
  anywhere today (`grep -rn "profiles" deploy Makefile .github` returns nothing),
  so this is a new pattern and you are introducing it deliberately: without the
  gate the collector starts on every `make up` **and in the `stack-smoke` CI job**,
  which runs `up -d --build --wait` over all services. Add a `Makefile` target
  beside `up`/`down`/`logs` at `Makefile:41-48`, which hardcode the compose file
  and pass no `--profile`.
- `.env.example`: a commented prose block in the file's existing style — the
  optional/secret vars ship commented out, the boolean flags ship live and off.
  `OTEL_ENABLED=false` live; the endpoint commented out with the collector's
  compose address. **`.github/workflows/ci.yml:267` copies `.env.example` to
  `.env` verbatim**, so anything live here takes effect in `stack-smoke` — the
  health probes at `:269-281` must still pass.
- **Delete `DATABASE_URL` and `REDIS_URL` from the `calc` service** at
  `docker-compose.yml:94-95`. Calc has never read either. Report it as a deletion.

**Acceptance:** `make up` with the profile brings the collector up; one request
to a proxied `/api/auth/*` route produces collector output containing **one trace
id present on both an api span and an auth span**, with `http.route` set on the
server spans and `pg` spans nested under an api request that hits the database.
A Pino line from the same request carries the same `trace_id`. Paste the
collector output and the log line into your report. `make up` **without** the
profile starts no collector, and `stack-smoke`'s probes still pass locally.

Owns: `apps/{api,auth,calc}/Dockerfile`, `deploy/local/docker-compose.yml`,
`deploy/local/otel-collector-config.yaml` (new), `Makefile`, `.env.example`.
Size **M**. Depends: WP-BO.

---

## WP-BQ · The chart

**Goal:** an operator can turn tracing on in a cluster without editing a
template.

- There is **no per-service Deployment template** —
  `deploy/helm/finance-planner/templates/services.yaml:1` is a single `range`
  over `.Values.services`. So this is a **values change**, and a template change
  only if you need a per-service derived value.
- Put the OTEL vars in **`serviceEnv`** (`values.yaml:51-76`), not in the shared
  `config:` map — `config:` is `envFrom`'d by **every** service including the
  nginx `web` container. `serviceEnv.calc` does not exist yet and is a new key.
  Note the useful property: `services.yaml:4-7` **drops empty values**, so
  `OTEL_EXPORTER_OTLP_ENDPOINT: ""` renders nothing at all, which is the
  idiomatic "off" here.
- `OTEL_EXPORTER_OTLP_HEADERS` may carry an auth token — it belongs in
  `secrets:` (`values.yaml:94-103`), consumed either by the bulk `secretRef` at
  `services.yaml:56-57` or individually via `secretKeyRef` in the manner of
  `templates/migrate-job.yaml:43-48`. Note that the secret template renders
  **every** key including empty ones, unlike `serviceEnv`.
- `OTEL_RESOURCE_ATTRIBUTES` per decision 59, rendered per service:
  `"service.version={{ $.Values.image.tag }},deployment.environment.name={{ $.Values.environment }}"`.
  Confirm both values exist and are what you think — `values-staging.yaml` says
  images are SHA-tagged by CI. Set `APP_VERSION` from the same
  `.Values.image.tag` for WP-BR.
- `values-prod.yaml:38-40` already has a `serviceEnv.auth` override to copy;
  `values-staging.yaml` has no `serviceEnv` block at all.
- **Do not add a collector to `.Values.services`.** `ci.yml:117-137` renders the
  chart and diffs the exact HPA name set; a new service fails that job. Shipping
  a collector in the chart is out of scope — the endpoint points at whatever the
  operator already runs.

**Acceptance:** `helm lint` passes and `helm template` renders, with the defaults,
**no OTEL env at all** on any pod — verified by grepping the rendered output for
`OTEL_` and getting nothing. With `otel.enabled`-style values set, the three
backend Deployments each carry the endpoint and resource attributes and `web`
carries none. The `ci.yml:117-137` HPA assertion still passes against your
render.

Owns: `deploy/helm/finance-planner/values.yaml`, `values-staging.yaml`,
`values-prod.yaml`, and `templates/services.yaml` **only if** a derived per-service
value forces it — say so if you touch it. Size **S–M**. Depends: none.

---

## WP-BR · The version that is always `0.0.0`

**Goal:** `/healthz` stops reporting a version that no deployment has ever had.

- `VERSION` is `process.env.npm_package_version ?? "0.0.0"` at
  `apps/api/src/server.ts:83`, `apps/auth/src/server.ts:43`,
  `apps/calc/src/server.ts:11`. Containers run `node dist/index.js`, not npm, so
  `npm_package_version` is **always undefined** and every pod reports `"0.0.0"`.
  All three app `package.json` versions are also literally `"0.0.0"`, so reading
  the manifest changes nothing — see decision 59 for why the build-time bake was
  ruled out after it was chosen.
- Read `process.env.APP_VERSION` first, falling back to the existing chain. One
  line per service. WP-BQ and WP-BP set the variable from the image tag.
- `packages/contracts/src/index.ts:64-76` defines the `healthResponse` shape; the
  **shape does not change**, only the value. Do not touch contracts.
- **`apps/api/src/server.ts` is a hard choke point.** You are the only claimant
  in this plan; keep it that way and change nothing else in the file. Note also
  that `apps/auth/src/server.ts` declares its routes inside `app.after()`
  (`:382`) for reasons the comment at `:369-381` explains — you are editing a
  module-scope const above that, not a route, so it does not apply to you, but
  read it before you touch the file.
- Grep the other altitudes for the string `"0.0.0"` before you finish — a version
  asserted in `apps/api/src/server.test.ts` or in `stack-smoke` would break at a
  different altitude than the one you edited. **Report what you find rather than
  editing a file you do not own.**

**Acceptance:** with `APP_VERSION=1.2.3` set, all three `/healthz` payloads report
`1.2.3`; with it unset, behaviour is exactly as today. Existing suites pass
unchanged. A list of every other place `0.0.0` is asserted.

Owns: `apps/{api,auth,calc}/src/server.ts` (the `VERSION` const only). Size **S**.
Depends: none. **Choke point: `apps/api/src/server.ts` — sole claimant in this
plan; no other package may take a line in it.**

---

## WP-BS · The CI job that proves a trace crossed the hop, and flips the pin

**Goal:** CI fails if a trace stops at the process boundary — the thing no
in-process test can check.

- New `otel-smoke` job in `.github/workflows/ci.yml`, modelled on `stack-smoke`
  at `:260-287`. Bring compose up **with the `otel` profile** and
  `OTEL_ENABLED=true`, pointed at the collector. Sign in or hit a proxied
  `/api/auth/*` route so the request genuinely crosses into auth — confirm it did
  by the auth-side log, as the evidence above does, not by assuming.
- Assert on the collector's stdout: **one trace id appearing on both an api span
  and an auth span**, an `http.route` attribute present on a server span, and a
  Pino line from a service log carrying the same `trace_id`. Print what you
  inspected — a job that asserted over zero spans and passed is the defect, not
  the fix. `apps/web/e2e/journey.spec.ts` prints `inspected 107 responses, 63 of
them /api` for exactly this reason; match that habit.
- Give the collector time. `BatchSpanProcessor`'s default delay is 5000 ms;
  either wait for it or set `OTEL_BSP_SCHEDULE_DELAY` low in the job. Do not poll
  once and conclude.
- **Flip WP-BM's pin to a plain `it`** as part of this package's acceptance, and
  update its header comment to past tense naming this package — that is the
  house shape (`apps/api/src/pins/confirm-month.pin.test.ts:7-24`).
- `.github/workflows/ci.yml` is a **choke point**. Run alone.

**Acceptance:** the job is red against a tree where `fastify` has been put back
into the bundle (demonstrate this by reverting WP-BO's external locally and
watching it fail — **do it and say you did**, do not assert it), and green on
`main`. `apps/api/src/pins/trace-across-the-hop.pin.test.ts` contains no
`it.fails`. `pnpm test` green.

Owns: `.github/workflows/ci.yml`,
`apps/api/src/pins/trace-across-the-hop.pin.test.ts`. Size **M**. Depends: WP-BP,
WP-BM. **Choke point: `.github/workflows/ci.yml` — runs alone.**

---

## WP-BT · Closing the books

**Goal:** the documentation describes the system that now exists, and the three
things this plan deliberately did not do are on the backlog rather than in
somebody's memory.

- `OPERATIONS.md` §1: a new **`### Tracing`** subsection using the four-column
  `Var / Services / Default / Notes` form, since these span api, auth and calc.
  Match the existing rows at `:13` and `:18`. Document `OTEL_ENABLED`,
  `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
  `OTEL_TRACES_SAMPLER`/`_ARG`, `OTEL_RESOURCE_ATTRIBUTES`, `APP_VERSION` —
  **including decision 58's footgun**, which is the row most likely to save
  somebody an afternoon. Then fix the three paragraphs a new per-service var
  invalidates: `:70-76` (which var goes in ConfigMap vs Secret vs `serviceEnv`),
  `:87-90` (an explicit enumeration of what is set per service), and
  `:107-136` (`### CI/CD` enumerates the jobs — `otel-smoke` is a new one).
  `:331-335` `### Logs` is the natural anchor for a short tracing runbook.
- `BACKLOG.md:197-198`: **narrow** the observability bullet to Prometheus,
  Grafana and Loki, and say traces and log correlation are wired. Add three new
  entries, each with its decision number: **the orphan `calc` service**
  (decision 49 — a service with one route nothing calls); **graceful HTTP
  shutdown** (decision 60 — the SIGTERM handler flushes the SDK and drops
  in-flight requests, as today); and **browser/RUM instrumentation for
  `apps/web`**, which issue #73 put out of scope.
- `README.md`: add this plan to the index at `:45-63`, following the entry
  template — and **add `SAID-AND-DONE.md` too**, which was never added and is not
  marked delivered anywhere. Update `:377-379`, which enumerates every env-gated
  optional feature and is now incomplete. Add `packages/telemetry` to the
  repository layout at `:316-322` or that block is wrong. Add a tracing line to
  `## Tooling` (`:399-414`).
- `deploy/helm/finance-planner/README.md:34-41` (Configuration) and `:49-53`
  (Known gaps).
- **Do not** fix `README.md:386`, which states the coverage thresholds wrongly —
  report it. It is a real drift and it is not this plan's.

**Acceptance:** `pnpm exec prettier --check .` passes, which for markdown means
the tables are realigned. Every variable this plan introduced appears in
`OPERATIONS.md` §1 exactly once. The `BACKLOG.md` bullet no longer claims
OpenTelemetry is unwired, and the three deferred items are entries with decision
numbers. Someone reading only `README.md` can find this plan.

Owns: `OPERATIONS.md`, `BACKLOG.md`, `README.md`,
`deploy/helm/finance-planner/README.md`. Size **M**. Depends: all.

---

## Waves

| Wave | Packages                      | Notes                                                                                                   |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1    | WP-BM + WP-BN + WP-BQ + WP-BR | four-way disjoint: one new pin file · new package + lockfile + manifests · helm · the three `server.ts` |
| 2    | WP-BO                         | **alone** — nothing else may touch a `tsup.config.ts` while the build shape changes                     |
| 3    | WP-BP                         | **alone** — needs WP-BO's `dist/otel.js` to exist before a `CMD` can point at it                        |
| 4    | WP-BS                         | **alone** — owns `.github/workflows/ci.yml`, and flips WP-BM's pin                                      |
| 5    | WP-BT                         | **alone** — documents what the previous four actually landed                                            |

Checked against the `Owns` lists rather than the shape. Wave 1's four sets are
`apps/api/src/pins/trace-across-the-hop.pin.test.ts` ·
`packages/telemetry/**` + `pnpm-lock.yaml` + `apps/*/package.json` ·
`deploy/helm/**` · `apps/*/src/server.ts`. **No file appears twice** — note
particularly that WP-BN takes the three `package.json` files and WP-BR takes the
three `server.ts` files and WP-BO (wave 2) takes the three `tsup.config.ts`
files: three packages, three different files, in the same three directories.
That is disjoint and it will not look disjoint at a glance. Do not merge them.

**Choke-point files, never co-owned:** `apps/api/src/server.ts` (WP-BR is the
sole claimant here), `packages/contracts/src/index.ts` (nobody claims it — the
health payload shape does not change), `apps/web/src/lib/api.ts`,
`apps/web/src/styles.css`, `.github/workflows/ci.yml` (WP-BS, alone), and for
this plan **`pnpm-lock.yaml`** (WP-BN, alone — it is the only package that runs
an install). A package owning one runs alone in its wave, and that is not to be
re-parallelised later.

**Five waves**, and waves 2–4 are serial by construction rather than by
timidity: the build shape must exist before anything can run it, and something
must run it before CI can prove it did. Everything genuinely independent is in
wave 1.

**At every wave boundary,** the orchestrator re-opens each finding any agent
dismissed as "premise false" and re-tests it against the premise as it then
stands — ONE-ENGINE's standing rule, carried forward. A dismissal is dated
evidence about a past tree, never a settled fact about the current one. This
plan is unusually exposed to it: several of its facts are about **load ordering
and bundler output**, both of which change under your feet when a dependency
moves.

---

## The regression to fear

**What must provably not move:** every service with `OTEL_ENABLED` unset. That is
the whole product today, and this plan's entire value proposition is that turning
the feature off leaves it alone. The measurable form: **273 CJS modules loaded,
zero of them OpenTelemetry** — the same count as a process started with no
`--import` at all. If a package makes that number move, it has broken decision 52
and the acceptance criterion issue #73 cares most about. Check the count, not the
absence of errors.

**What will move, and is meant to:** startup time, by a measured amount, on every
service, in every environment, whether tracing is on or off (decisions 50 and
51). `/healthz` reports a real version where it reported `"0.0.0"`
(decision 59). `dist/index.js` shrinks by roughly the size of Fastify and the
runtime resolves it from `node_modules` instead — which means **a broken
`node_modules` in an image now breaks startup where it previously would not**.
Those are the only intended changes; anything else that moves is a defect.

**What shape the fixtures avoid.** Every test in this repository runs **in one
process**, and the defect this plan exists to fix is defined by there being two.
`apps/web/e2e/fixture.ts` — the committed harness, and the right thing to reuse —
deliberately runs api and auth **in one process over a shared injected store**,
which is what makes it fast and which collapses the exact boundary this work is
about. The one-process form of the evidence run above reproduced the `req-4` /
`req-2` result _and_ gave both services the same `pid`, so a lazier investigator
would have concluded the logs were joinable. The gaps that leaves, and where the
live defect will therefore be:

- **Two pods, not two ports.** Everything measured here ran on one laptop with
  one `hostname`. In a cluster `hostname` differs and is the only field that
  currently distinguishes the services at all.
- **Concurrency.** One request at a time makes timestamp adjacency look like a
  correlation strategy. Two simultaneous logins are what proves it is not.
- **A restart mid-request.** Decision 54's handler exits without draining, and
  nothing here tests shutdown under load.
- **A collector that is down.** `OTEL_ENABLED=true` against an endpoint that
  refuses connections must not take the service with it. No package above tests
  this and every one of them should — if you are holding a package, try it.
- **An image built from a cold cache.** The `fastify` external means resolution
  now happens at runtime; the failure mode is a container that builds and then
  will not boot.

**The standing instruction, which finds more than any audit: hunt for the
assumption rather than assuming its absence, and name the assumption.** For this
plan the assumption is stated once and every package should test it against its
own files:

> **that a process can describe what happened to it.**

Each of these is that assumption wearing different clothes: a counter named like
an identifier, a duration that measures somebody else's work and calls it its
own, a version read from a variable that the runtime never sets, a health check
that returns `{ ready: true }` without asking anything
(`apps/api/src/server.ts:1164` and its two siblings — a stub in all three
services, and nobody has noticed because it has never been false). Where you find
another — a figure a process reports about work it did not do, or a fact it
asserts without having checked — say so, whether or not it is in your package.
