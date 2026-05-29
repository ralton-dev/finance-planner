import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  // Bundle workspace packages into the output; keep node_modules deps external.
  noExternal: [/^@finance-planner\//],
});
