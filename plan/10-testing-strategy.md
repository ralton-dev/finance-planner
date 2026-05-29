# Testing Strategy

> Tests are **completed per feature** — a feature is not "done" until its tests
> exist and pass in CI (see the Definition of Done in `08-roadmap.md`). This
> document defines the layers, tools, and gates. UI testing is a first-class
> part of the harness.

## 1. Test pyramid

| Layer              | Scope                                                     | Tools                                     | Where                                       |
| ------------------ | --------------------------------------------------------- | ----------------------------------------- | ------------------------------------------- |
| **Unit**           | Pure logic, especially the calculation engine             | Vitest                                    | `packages/*`, `apps/*/src/**/*.test.ts`     |
| **Component (UI)** | React components/hooks in isolation                       | Vitest + React Testing Library + jsdom    | `apps/web/src/**/*.test.tsx`                |
| **Integration**    | A service against real Postgres/Redis                     | Vitest + Testcontainers, Fastify `inject` | `apps/{api,auth,calc}/src/**/*.int.test.ts` |
| **Contract**       | API responses conform to `packages/contracts` Zod schemas | Vitest (schema `.parse`)                  | api integration tests                       |
| **E2E (UI)**       | Full user journeys through the running app                | Playwright (Chromium)                     | `apps/web/e2e/*.spec.ts`                    |

Bias toward the base: the savings engine is exhaustively unit-tested with
**golden-file fixtures**; UI gets focused component tests plus a small,
high-value set of E2E journeys.

## 2. UI testing (explicit)

Two complementary layers, both wired in Phase 0:

1. **Component tests** (Vitest + React Testing Library, jsdom): render
   components, assert on accessible roles/text, simulate user events with
   `@testing-library/user-event`, mock network at the `fetch` boundary. Fast,
   run on every `pnpm test`.
2. **End-to-end** (Playwright): drive a real browser against the built SPA.
   Phase 0 ships a smoke spec (home page renders, API-health indicator). Later
   phases add journeys: register → create account → add income + payments →
   verify the plan numbers → verify the overview aggregation. Playwright's
   `webServer` builds and serves the app automatically.

> E2E runs in its own task (`pnpm --filter @finance-planner/web test:e2e`) and CI
> job so the default `pnpm test` stays fast and browser-free.

## 3. Per-feature requirements (Definition of Done)

Every feature PR must include:

- **Unit tests** for new pure logic (engine rules, utils, reducers).
- **Integration tests** for new/changed API endpoints, hitting a real DB
  (Testcontainers) and asserting auth/authorization where relevant.
- **Component tests** for new UI components with meaningful logic or states
  (loading, empty, error, at-risk vs. on-track, etc.).
- **E2E** coverage extended when the feature adds or changes a user journey.
- **Contract** assertions when API shapes change.
- All gates green in CI (below). No skipped/`.only` tests committed.

## 4. Coverage & quality gates

- Coverage via Vitest V8 provider. **Thresholds: `packages/domain` ≥ 95%
  lines/statements/functions and ≥ 80% branches** (it is the core of the
  product); these are enforced in CI via `pnpm coverage`, which fails the build
  below threshold.
- Deterministic tests only: the engine takes an explicit `asOfDate`; never
  depend on the wall clock. Use fixed dates and seeded data.
- No network in unit/component tests — mock at the boundary.
- Lint, typecheck, format, unit, integration, and the E2E smoke must all pass
  before merge.

## 5. CI wiring (GitHub Actions)

- `build-test` job: `format:check` → `lint` → `typecheck` → `test`
  (unit + component + integration via Testcontainers) → `build`.
- `e2e` job: install Playwright Chromium, run `test:e2e` against the built app.
- `docker` job: build all images (no push on PRs).
- Integration tests get Postgres + Redis as Actions **service containers** (or
  Testcontainers, which manages its own).

## 6. Fixtures & helpers

- `packages/domain`: golden-file fixtures (`*.fixtures.ts` → expected
  `AccountPlan` JSON). Any maths change requires a deliberate fixture update,
  making the diff reviewable.
- Integration: a shared test harness spins a disposable Postgres, runs
  migrations, seeds, and tears down per suite.
- UI: a `renderWithProviders` helper wraps components in the app's providers
  (router, query client, theme) once those exist.

## 7. Local commands

```bash
pnpm test                     # unit + component + integration (all workspaces)
pnpm --filter @finance-planner/domain test --coverage
pnpm --filter @finance-planner/web test:e2e   # Playwright (builds + serves app)
```
