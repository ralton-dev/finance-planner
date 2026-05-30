import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Integration tests (Postgres via Testcontainers) run separately.
    exclude: ["src/**/*.int.test.ts", "**/node_modules/**"],
  },
});
