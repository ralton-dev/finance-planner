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
