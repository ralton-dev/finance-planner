import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  // Bundle workspace packages (and their transitive deps); keep `pg` external
  // because its CJS internals use a dynamic `require` that the ESM shim cannot
  // service. `pg` is declared as a direct dep of this app.
  noExternal: [/^@finance-planner\//],
  external: ["pg", "pg-native", "pg-cloudflare"],
  // @finance-planner/mailer pulls in nodemailer, which is CJS and does call
  // `require()` at load. Hand the bundle a real `require` so esbuild's shim
  // uses it instead of throwing — the alternative would be re-declaring
  // nodemailer here purely so it could stay external.
  banner: {
    js: "import { createRequire as __nodeCreateRequire } from 'node:module';\nconst require = __nodeCreateRequire(import.meta.url);",
  },
});
