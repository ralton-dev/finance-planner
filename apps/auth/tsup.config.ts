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
  // Bundle workspace packages (and their transitive deps); keep `pg` external
  // because its CJS internals use a dynamic `require` that the ESM shim cannot
  // service. `pg` is declared as a direct dep of this app.
  //
  // `fastify` is external for a different reason and it is not redundant — do
  // not tidy it away. OpenTelemetry patches modules as Node resolves them, and
  // a module inlined into this bundle is never resolved, so it is never
  // patched: bundled, you get no Fastify spans and no `http.route` on the HTTP
  // server spans. The `@opentelemetry/*` entry keeps the preload from inlining
  // the SDK, and it must be a RegExp — tsup silently ignores glob externals.
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
