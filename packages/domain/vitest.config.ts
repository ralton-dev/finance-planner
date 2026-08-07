import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/types.ts"],
      /**
       * The engine is the core of the product — hold it to a high bar.
       *
       * These sit just under what the package actually holds, so ordinary noise
       * passes and a real regression fails. They were 95/95/80/95 while the
       * package was measuring 99.9/100/95.6/99.9, which is how ~900 lines of
       * lightly-tested tracing landed in `scope.ts` with CI green and the drop
       * only visible to someone measuring both sides of the diff. A gate below
       * the achieved level is not a gate. Raise these when the figure rises;
       * never lower them to make a change fit.
       */
      thresholds: {
        lines: 99.9,
        functions: 100,
        branches: 95.5,
        statements: 99.8,
      },
    },
  },
});
