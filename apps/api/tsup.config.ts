import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries: the server, and the `--import` preload that starts tracing
  // before the server graph is loaded. `src/otel.ts` deliberately does not
  // import `./server.js` — a preload that pulls the app in has already lost the
  // race it exists to win.
  entry: ["src/index.ts", "src/otel.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  // Bundle workspace packages (and their transitive deps); keep `pg` external
  // because its CJS internals use a dynamic `require` that the ESM shim cannot
  // service ("Dynamic require of \"events\" is not supported"). `pg` is declared
  // as a direct dep of this app so Node resolves it locally.
  //
  // `fastify` is external for a different reason and it is not redundant — do
  // not tidy it away. OpenTelemetry's instrumentations patch modules *as Node
  // resolves them*; a module inlined into this bundle is never resolved, so it
  // is never patched. With `fastify` bundled you get zero Fastify spans and —
  // the part that is easy to miss — every HTTP server span collapses to a bare
  // `GET` with no `http.route` attribute, which destroys grouping in any
  // backend. Externalising `fastify` itself is sufficient; the `@fastify/*`
  // plugin packages may stay bundled. The `@opentelemetry/*` entry keeps the
  // preload from inlining the SDK, and it must be a RegExp: tsup silently
  // ignores glob externals like "@opentelemetry/*" and emits a ~2.8 MB
  // `dist/otel.js` with no warning. Check the output size, not this config.
  noExternal: [/^@finance-planner\//],
  external: ["pg", "pg-native", "pg-cloudflare", "fastify", /^@opentelemetry\//],
  // @finance-planner/mailer pulls in nodemailer, which is CJS and does call
  // `require()` at load. Hand the bundle a real `require` so esbuild's shim
  // uses it instead of throwing — the alternative would be re-declaring
  // nodemailer here purely so it could stay external.
  banner: {
    js: "import { createRequire as __nodeCreateRequire } from 'node:module';\nconst require = __nodeCreateRequire(import.meta.url);",
  },
});
