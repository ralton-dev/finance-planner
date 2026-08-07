import { defineConfig, devices } from "@playwright/test";

// Non-default ports throughout: 5173/4000/4001 belong to `pnpm dev`, and a
// harness that grabbed them would either fight a dev server or, worse, quietly
// pass by talking to one.
const PORT = 4980;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  // Build the SPA, then serve it from a harness that also puts auth and the api
  // behind /api over one shared store — see e2e/stack.mts. `vite preview` would
  // serve the same bytes with nothing behind them, and the suite's real
  // assertion is about what the pages fetch.
  //
  // tsx is a devDependency of the services, not of the root and not of web, so
  // pnpm links the shim into apps/api/node_modules/.bin and nowhere higher up.
  webServer: {
    command: `pnpm build && ../api/node_modules/.bin/tsx e2e/stack.mts`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
