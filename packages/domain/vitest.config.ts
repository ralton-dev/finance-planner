import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/types.ts"],
      // The engine is the core of the product — hold it to a high bar.
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 80,
        statements: 95,
      },
    },
  },
});
