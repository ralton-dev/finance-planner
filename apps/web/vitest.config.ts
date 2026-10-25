import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Let jsdom provide browser storage instead of Node's host storage.
    execArgv: ["--no-experimental-webstorage"],
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Unit/component tests only; Playwright E2E lives in ./e2e.
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
