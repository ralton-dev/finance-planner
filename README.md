# Finance Planner

A web app for planning savings toward upcoming payments. Record your income and
your payments (with due dates and recurrence) and the app tells you how much to
set aside each month per goal to hit its target date, and how much you have left
over — per account and across all accounts.

See [`plan/`](./plan) for the full implementation plans (vision, architecture,
domain model, calculation engine, API, frontend, auth, DevOps, roadmap).

## Status

**Phase 0 — Foundations.** Monorepo scaffold with buildable app/package
skeletons, shared tooling, local stack, and CI. The product features land in
later phases (see [`plan/08-roadmap.md`](./plan/08-roadmap.md)).

## Repository layout

```
apps/
  web      React + TS SPA (Vite), served static via Nginx in prod
  api      BFF / gateway (Fastify)            -> owns core domain
  auth     auth + households service (Fastify)
  calc     calculation worker/service (Fastify) -> hosts the savings engine
packages/
  contracts  shared DTOs / Zod schemas (API types)
  domain     shared domain types + the pure calculation engine
db/          SQL migrations + seed data
deploy/      docker-compose (local), Helm chart, kind helper
.github/     GitHub Actions CI
```

> The plan also references a `packages/config` and `packages/ui`. For Phase 0,
> shared lint/TS config lives at the repo root (`tsconfig.base.json`,
> `eslint.config.js`); a UI package can be extracted once shared components exist.

## Prerequisites

- Node.js 22 (`.nvmrc`)
- pnpm 10 (`corepack enable`)
- Docker (for the local stack)

## Getting started

```bash
corepack enable
pnpm install
pnpm dev            # web on :5173, api :4000, auth :4001, calc :4002
```

Or run the full containerised stack (Postgres + Redis + services):

```bash
cp .env.example .env
make up
```

## Common tasks

```bash
pnpm build       # build all apps
pnpm test        # run all tests (engine unit tests live in packages/domain)
pnpm lint        # eslint
pnpm typecheck   # tsc --noEmit across workspaces
make migrate     # apply db/migrations against the local DB
```

## Tooling

- **Monorepo:** pnpm workspaces + Turborepo
- **Language:** TypeScript (strict)
- **Frontend:** React 19 + Vite (SPA) + component library
- **Backend:** Node + Fastify (framework choice revisited in `plan/09-open-questions.md`)
- **DB:** PostgreSQL · **Cache/queue:** Redis
- **CI/CD:** GitHub Actions · **Runtime:** Kubernetes (Helm, cloud-agnostic)
