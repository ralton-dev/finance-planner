/**
 * The tracing bootstrap, written once.
 *
 * A request that crosses a process boundary is still one request. Every service
 * here logs its own private request counter and nothing joins the two lines, so
 * this module gives the request one identity and makes each process say which
 * one it is holding. The three services differ only by the name string they
 * pass in.
 *
 * Two properties are load-bearing and are why this file looks the way it does:
 *
 *  - **"off" means off.** The whole body sits behind an `OTEL_ENABLED !== "true"`
 *    return and every OpenTelemetry package is reached through dynamic
 *    `import()`. With the flag unset, the process loads no OTEL module at all —
 *    the cost is the one `if`. Do not "simplify" this to static imports; a
 *    static import at the top of a preloaded module is loaded before the `if`
 *    ever runs.
 *  - **it is a preload, not a plugin.** It never imports the app, and the app
 *    never imports it. It is wired in through `node --import`, which is what
 *    puts the ESM loader hook in place before Fastify, `pg` or Pino are
 *    resolved. Instrumentation that arrives after its target module has been
 *    loaded patches nothing.
 *
 * **On `@opentelemetry/api`'s version range.** It is declared `~1.9.1` here and
 * in all three apps, and the tilde is doing real work: `~1.9.1` is exactly
 * `>=1.9.1 <1.10.0`, and `<1.10.0` is the ceiling imposed by the
 * `peerDependencies` of `@opentelemetry/sdk-node` (`>=1.3.0 <1.10.0`) and of
 * `resources`, `core` and `sdk-trace-*`. A caret would float past it the day
 * 1.10.0 ships, and `.npmrc` sets `strict-peer-dependencies=false`, so nothing
 * would fail — it would just be out of range and quietly unsupported. Re-read
 * those peers before widening this; the repo's policy is the highest version
 * *within supported ranges*, which is not the same as the latest version.
 */

/**
 * Start tracing for a service, if tracing is enabled.
 *
 * @param serviceName the value for `service.name` — `"api"`, `"auth"`, `"calc"`.
 *   `service.version` and `deployment.environment.name` deliberately do **not**
 *   come from here: all three app `package.json` versions are literally
 *   `"0.0.0"`, so baking one in would ship a lie. They come from
 *   `OTEL_RESOURCE_ATTRIBUTES`, whose honest source is the image tag.
 *
 * Resolves once the SDK is running. Rejects only on misconfiguration detected
 * before anything is constructed — never on the collector being unreachable,
 * which is the exporter's problem and is retried in the background.
 */
export async function startTelemetry(serviceName: string): Promise<void> {
  // Decision 52. `OTEL_SDK_DISABLED` is deliberately not honoured: it defaults
  // to enabled and swaps in a no-op SDK rather than skipping the load, which is
  // the opposite of what this guard is for.
  if (process.env.OTEL_ENABLED !== "true") return;

  // Decision 57, checked before anything is constructed. The OTLP spec
  // *defaults* `OTEL_EXPORTER_OTLP_ENDPOINT` to `http://localhost:4318`, so it
  // is never unset from the SDK's point of view and "enabled with no endpoint"
  // would export quietly into the void. Read `process.env` directly and refuse.
  const generic = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const perSignal = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (!generic && !perSignal) {
    throw new Error(
      `OTEL_ENABLED=true but no collector endpoint is configured for "${serviceName}". ` +
        "Set OTEL_EXPORTER_OTLP_ENDPOINT to the collector's bare origin " +
        "(for example http://otel-collector:4318 — the SDK appends /v1/traces), " +
        "or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT to the full traces URL " +
        "(http://otel-collector:4318/v1/traces, used as-is). " +
        "Unset OTEL_ENABLED to run without tracing.",
    );
  }

  // This is a *tracing* bootstrap, and `NodeSDK` does not believe that. Given
  // only a `traceExporter` it still auto-configures metrics and logs from the
  // environment and points them at the same OTLP endpoint. Measured against a
  // recording stub collector: a four-second run POSTed 13 times to
  // `/v1/traces` and **8 times to `/v1/metrics`** that nothing in this repo
  // asked for, and stood up a logs exporter that would start posting the moment
  // anything emitted a log record. A process doing work nobody requested, and
  // not saying so, is the thing this package exists to stop.
  //
  // Assigned, not defaulted (`??=`): a service that ships no metric instruments
  // has no honest use for a metrics pipeline, and leaving the env var able to
  // switch one on means the leak comes back the first time someone copies a
  // generic OTEL block into the chart. Turning these on again is a change to
  // this file — one place, reviewed — rather than a change to a deployment.
  process.env.OTEL_METRICS_EXPORTER = "none";
  process.env.OTEL_LOGS_EXPORTER = "none";

  // Bound how long a dying process will wait on a collector that is not there.
  // Measured, dead collector, time from SIGTERM to exit: default (10000 ms)
  // → 7.6–8.6 s; 5000 → 5.05 s; 3000 → 2.94 s; 2000 → 1.22 s. Shutdown time is
  // simply the export budget being burnt on retries. A *healthy* collector
  // answered the same flush in 0.07 s, so 5000 ms keeps ~70x headroom over the
  // real cost while halving the worst case — at 2000 ms a loaded collector
  // could start dropping the final batch, which is exactly what the SIGTERM
  // handler below exists to prevent. Defaulted, not assigned: an operator with
  // a genuinely slow collector must be able to raise it.
  process.env.OTEL_EXPORTER_OTLP_TIMEOUT ??= "5000";

  // The ESM loader hook, first: it only patches modules resolved *after* it is
  // registered, so it has to be in place before the SDK — and before the app —
  // is loaded.
  //
  // Register OpenTelemetry's own wrapper, never `import-in-the-middle/hook.mjs`
  // directly; the docs are explicit that
  // `@opentelemetry/instrumentation/hook.mjs` is the only supported loader hook,
  // and the wrapper is where OTEL's own compatibility shims live.
  //
  // `--experimental-loader` is the officially-documented form of this and is
  // deprecated on Node 24, where it prints a runtime warning. `module.register()`
  // is what this repo uses instead; blessing it in the OTEL docs is tracked by
  //   https://github.com/open-telemetry/opentelemetry-js/issues/4933
  //   https://github.com/open-telemetry/opentelemetry-js/pull/6922
  const { register } = await import("node:module");
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { HttpInstrumentation },
    { FastifyInstrumentation },
    { UndiciInstrumentation },
    { PgInstrumentation },
    { PinoInstrumentation },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-fastify"),
    import("@opentelemetry/instrumentation-undici"),
    import("@opentelemetry/instrumentation-pg"),
    import("@opentelemetry/instrumentation-pino"),
  ]);

  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(),
    // A fixed set, in this order. No `auto-instrumentations-node`: it pulls
    // thirty-odd instrumentations for libraries this repo does not have.
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyInstrumentation(),
      // Load-bearing, not optional: this is what carries `traceparent` across
      // the api → auth hop. `@fastify/http-proxy` → `@fastify/reply-from` →
      // undici, and this instrumentation injects the header unconditionally in
      // `onRequestCreated`. It hooks `diagnostics_channel` rather than patching
      // a module, so it is the one instrumentation that works even bundled.
      new UndiciInstrumentation(),
      // `calc` has no Postgres and still gets this. It registers nothing on a
      // service that never loads `pg`, and one code path shared by three
      // services is worth more than a wart-free dependency list.
      new PgInstrumentation(),
      // Not a hand-written Pino `mixin`: this injects `trace_id` / `span_id` /
      // `trace_flags` into the logger Fastify constructs internally, with zero
      // change to app code. A mixin would mean editing three `server.ts` files
      // and keeping them in sync forever.
      new PinoInstrumentation(),
    ],
  });

  sdk.start();

  // Without this you get nothing — not a lost tail, the lot. The OTLP HTTP
  // exporter does not flush on exit and `BatchSpanProcessor`'s default delay is
  // 5000 ms, so a SIGTERM a second after the requests delivers zero spans.
  //
  // This deliberately does not close Fastify first, so in-flight requests are
  // dropped — exactly as they already are, since the repo has no SIGTERM
  // handler at all. A correct drain needs the server handle, which a preload
  // does not have; it is filed rather than built. Do not grow an `app.close()`
  // path in here.
  let down = false;
  const shutdown = (): void => {
    if (down) return;
    down = true;
    void sdk
      .shutdown()
      .catch(() => {
        // A collector that will not take the last batch must not change the
        // exit code of a service that was asked to stop.
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
