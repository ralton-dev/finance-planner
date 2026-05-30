import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  // Bundle workspace packages (and their pure-ESM transitive deps); keep `pg`
  // external because its CJS internals use a dynamic `require` that the ESM
  // shim cannot service ("Dynamic require of \"events\" is not supported").
  // `pg` is declared as a direct dep of this app so Node resolves it locally.
  noExternal: [/^@finance-planner\//],
  external: ["pg", "pg-native", "pg-cloudflare"],
});
