import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries: the server, and the `--import` preload that starts tracing
  // before the server graph is loaded. `src/otel.ts` deliberately does not
  // import `./server.js` — a preload must not pull the app in.
  entry: ["src/index.ts", "src/otel.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  // This service had no externals at all until tracing arrived, so both of
  // these are new here. `fastify` must be external because OpenTelemetry
  // patches modules as Node resolves them: inlined into this bundle it is
  // never resolved and never patched, which costs every Fastify span and the
  // `http.route` attribute on the HTTP server spans. `@opentelemetry/*` keeps
  // the preload from inlining the SDK, and it must be a RegExp — tsup silently
  // ignores glob externals like "@opentelemetry/*" and emits a ~2.8 MB
  // `dist/otel.js` with no warning. Check the output size, not this config.
  noExternal: [/^@finance-planner\//],
  external: ["fastify", /^@opentelemetry\//],
});
