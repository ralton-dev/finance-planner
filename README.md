# Finance Planner

A web app for planning savings toward upcoming payments. Record your income and
your payments (with due dates and recurrence) and the app tells you how much to
set aside each month per goal to hit its target date, and how much you have
left over — per account and across all accounts.

Multi-user with shared **households**, cross-account **projects**, and a
**savings engine** that prioritises goals, surfaces shortfalls, and projects
completion when underfunded.

Households also get a **pooled money-flow plan**: tag each account as a shared
pot or personal to a member, set each member's proportional contribution share,
and mark expenses shared or personal. The engine then splits shared costs by
share, funds across all accounts by priority, and works out the **transfers**
each person should make into each account — visualised as a Sankey diagram.

Deployed cloud-agnostically on Kubernetes via Helm.

- **Operations / runbook:** [`OPERATIONS.md`](./OPERATIONS.md)
- **Deferred backlog:** [`BACKLOG.md`](./BACKLOG.md)
- **Contributing:** [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- **Licence:** [MIT](./LICENSE)

## Architecture

```
Browser ──/api──▶ api (gateway/BFF) ──┬─ core domain (accounts, incomes,
                                       │   payments, projects, plan, overview)
                                       ├─ /api/auth/* ─proxy─▶ auth service
                                       └─ computes plans via @finance-planner/domain
                                       │
                  auth service ────────┘   (users, households, sessions, sharing)
                          │
                          ▼
                    PostgreSQL  (schemas: auth, core, calc)
                    Redis       (reserved for cache/queue; not yet wired)
```

- **Single public entrypoint.** Only `/api` is exposed. `auth` and `calc` are
  internal-only behind the api gateway.
- **Calculation engine** is a pure library (`packages/domain`) — takes an
  explicit `asOfDate`, never reads the wall clock, exhaustively unit-tested
  (≥95% lines / ≥80% branches, gated in CI).
- **Persistence** behind a `Store` interface (`packages/data`) with two
  implementations: `PgStore` (Drizzle + Postgres) and `MemoryStore` (tests
  and DB-less local dev). Services pick `PgStore` when `DATABASE_URL` is set.
- **Authorization** rules live in `packages/policies` — both api and auth
  build a per-request ability and call `ability.can(action, subject)` instead
  of inline role checks.

## Repository layout

```
apps/
  web    React 19 + Vite SPA (served static via nginx in prod)
  api    Fastify gateway/BFF — core domain + auth proxy
  auth   Fastify auth service — users, households, sessions, sharing
  calc   Fastify worker — hosts the engine (internal plan endpoint)
packages/
  domain    pure calculation engine + date math (the heart of the product)
  data      entities, Store interface, MemoryStore, Drizzle schema + PgStore
  contracts shared Zod schemas / DTOs (request bodies, primitives)
  policies  per-request authorisation rules (action + subject)
  security  scrypt password hashing + HS256 JWT (jose)
db/          SQL migrations (0001_init.sql, 0002_projects.sql, …)
deploy/
  local/     docker-compose stack, compose nginx, kind helper
  helm/      cloud-agnostic chart (services, ingress, migrate Job, HPA, PDB, …)
.github/workflows/   format, lint, typecheck, test, coverage, build,
                     integration (Testcontainers), e2e (Playwright),
                     helm lint/render, docker image matrix,
                     stack-smoke (full compose + /healthz probes),
                     CodeQL
```

## Prerequisites

- Node.js 22 (`.nvmrc`)
- pnpm 10 (`corepack enable`)
- Docker (for the full stack and integration tests)

## Getting started

```bash
corepack enable
pnpm install
```

Three ways to run, pick whichever fits the moment:

**A. Integrated dev (recommended):** backend in containers, web via Vite for
hot-reload.

```bash
cp .env.example .env
make up                                  # postgres, redis, api, auth, calc, web (built)
pnpm --filter @finance-planner/web dev   # SPA on :5173, proxies /api -> :4000
```

**B. Full container stack including the built SPA:**

```bash
make up                                  # then open http://localhost:8080
```

**C. Quickest spin, no database (in-memory store):**

```bash
pnpm --filter @finance-planner/api dev &
pnpm --filter @finance-planner/auth dev &
pnpm --filter @finance-planner/web dev
```

Useful Make targets: `make migrate`, `make seed`, `make down`, `make up-kind`
(kind cluster).

## Common tasks

```bash
pnpm build         # build all apps (tsup for services, vite for web)
pnpm test          # unit + component + service-level (MemoryStore) tests
pnpm coverage      # enforces engine ≥95% lines / ≥80% branches
pnpm lint          # eslint
pnpm typecheck     # tsc --noEmit across workspaces
pnpm format        # prettier --write .

pnpm --filter @finance-planner/data test:int   # integration vs real Postgres (Testcontainers)
pnpm --filter @finance-planner/web test:e2e    # Playwright (builds + serves the SPA)
```

CI runs every layer on every push; merges to `main` require the full matrix
green including the `stack-smoke` job that brings the compose stack up and
probes `/healthz` on each service.

## Tooling

- **Monorepo:** pnpm workspaces + Turborepo
- **Language:** TypeScript (strict), Node 22
- **Frontend:** React 19 + Vite + React Router 7 (plain CSS — no Tailwind /
  no component library; design tokens in `apps/web/src/styles.css`)
- **Backend:** Fastify 5 (api, auth, calc)
- **ORM / DB:** Drizzle ORM + PostgreSQL · **Cache/queue (reserved):** Redis
- **Auth:** scrypt password hash + HS256 JWT access token + opaque refresh
  cookie + per-route rate-limit + reuse detection
- **Tests:** Vitest + React Testing Library + Playwright + Testcontainers
- **CI/CD:** GitHub Actions · **Runtime:** Kubernetes (Helm, cloud-agnostic)
