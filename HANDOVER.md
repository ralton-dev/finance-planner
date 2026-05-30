# Handover & Operations Guide

A practical guide for whoever owns this codebase next: how it fits together, how
to run and test it, how to deploy and operate it, and what's intentionally left
for later. For the original design rationale see [`plan/`](./plan); this document
is the operational counterpart.

---

## 1. What this is

A multi-user web app for planning savings toward upcoming payments. You record
income and payments (with due dates and recurrence); the app computes how much to
set aside each month per goal to hit its target date, how much is left over, and
where you fall short — per account and across all accounts. Accounts can be
shared with a household.

**Status:** feature-complete v1 (phases 0–6 + infra). Deferred stretch items are
listed in §11.

---

## 2. Architecture at a glance

```
Browser ──/api──▶ api (gateway/BFF) ──┬─ core domain (accounts, incomes,
                                       │   payments, plan, overview)
                                       ├─ /api/auth/* ─proxy─▶ auth service
                                       └─ computes plans via @finance-planner/domain
                                       │
                  auth service ────────┘   (users, households, sessions, sharing)
                          │
                          ▼
                    PostgreSQL  (schemas: auth, core, calc)
                    Redis       (reserved for cache/queue; not yet required)
```

- **Single entrypoint:** the browser only ever calls `/api`. The `api` gateway
  forwards `/api/auth/*` to the `auth` service; everything else it handles itself.
- **Calculation engine** is a pure library (`packages/domain`) imported by `api`
  (and exposed by `calc` as an internal worker endpoint). Same inputs → same
  outputs; it takes an explicit `asOfDate` and never reads the wall clock.
- **Persistence** is behind a `Store` interface (`packages/data`) with two
  implementations: `PgStore` (Drizzle + Postgres, production) and `MemoryStore`
  (tests and DB-less local dev). Services pick `PgStore` when `DATABASE_URL` is
  set, else `MemoryStore`.

Why coarse services + a gateway: see `plan/01-architecture.md` and decision #8 in
`plan/09-open-questions.md` (Fastify, not NestJS).

---

## 3. Repository layout

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
  security  scrypt password hashing + HS256 JWT (jose)
db/          SQL migration (0001_init.sql) + seed data
deploy/
  local/     docker-compose stack, compose nginx, kind helper
  helm/      cloud-agnostic chart (services, ingress, migrate Job, HPA, PDB, …)
.github/workflows/ci.yml   format, lint, typecheck, test, coverage, build,
                           integration (Testcontainers), e2e (Playwright),
                           helm lint/render, docker image matrix
plan/        design docs (00–10) — read 00-overview.md first
```

---

## 4. Local development

Prereqs: Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker (for the full
stack and integration tests).

```bash
corepack enable
pnpm install

# Option A — integrated dev (recommended):
cp .env.example .env
make up                                   # postgres, redis, api, auth, calc
pnpm --filter @finance-planner/web dev    # SPA on :5173, proxies /api -> :4000

# Option B — full container stack incl. built SPA:
make up                                   # then open http://localhost:8080

# Option C — quickest spin, no DB (in-memory store):
pnpm --filter @finance-planner/api dev & pnpm --filter @finance-planner/auth dev &
pnpm --filter @finance-planner/web dev
```

Useful: `make migrate`, `make seed`, `make down`, `make up-kind` (kind cluster).

---

## 5. Testing (per-feature is the rule)

| Layer                       | Command                                        | Where                                          |
| --------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| Unit + component + route    | `pnpm test`                                    | `**/*.test.ts(x)` (MemoryStore for routes)     |
| Engine coverage (gated)     | `pnpm coverage`                                | `packages/domain` (≥95% lines / ≥80% branches) |
| Integration (real Postgres) | `pnpm --filter @finance-planner/data test:int` | Testcontainers; needs Docker                   |
| E2E (real browser)          | `pnpm --filter @finance-planner/web test:e2e`  | Playwright; builds + serves the SPA            |

Full policy and the per-feature Definition of Done: `plan/10-testing-strategy.md`
and `plan/08-roadmap.md`. CI runs every layer (integration + e2e have their own
jobs because they need Docker / a browser).

---

## 6. Configuration (environment variables)

| Var                                | Services        | Default                         | Notes                                                                         |
| ---------------------------------- | --------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`                     | api, auth, calc | _(unset → MemoryStore)_         | Postgres connection string. Set it to use Postgres.                           |
| `JWT_SIGNING_KEY`                  | api, auth       | `dev-insecure-secret-change-me` | **Must be identical** for api & auth. Use a strong random value in real envs. |
| `AUTH_URL`                         | api             | `http://localhost:4001`         | Upstream auth service for the gateway proxy.                                  |
| `REDIS_URL`                        | api, calc       | `redis://localhost:6379`        | Reserved; not yet required by logic.                                          |
| `ACCESS_TTL_SECONDS`               | auth            | `900`                           | Access-token lifetime.                                                        |
| `REFRESH_TTL_DAYS`                 | auth            | `30`                            | Refresh-token / session lifetime.                                             |
| `COOKIE_SECURE`                    | auth            | `false`                         | Set `true` in production (HTTPS).                                             |
| `COOKIE_PATH`                      | auth            | `/api/auth`                     | Must match the gateway prefix.                                                |
| `LOG_LEVEL`                        | all             | `info`                          | Pino level.                                                                   |
| `API_PORT`/`AUTH_PORT`/`CALC_PORT` | resp.           | 4000/4001/4002                  |                                                                               |

In Kubernetes these come from the chart's ConfigMap (`config:`) and Secret
(`secrets:`) — see `deploy/helm/finance-planner/values.yaml`.

---

## 7. Deployment

- **Images:** one per service, built by CI and intended for GHCR
  (`ghcr.io/bralton/finance-planner/*`). Multi-stage Dockerfiles per app.
- **Chart:** `deploy/helm/finance-planner` (cloud-agnostic). Renders Deployments
  - Services for each app, an Ingress (`/api` → api, `/` → web), optional
    in-cluster Postgres/Redis, a **migration Job** (post-install/upgrade hook that
    waits for the DB then applies `0001_init.sql` from a ConfigMap), **HPA** and
    **PodDisruptionBudget** per service.
- **Environments:** `values.yaml` (defaults / non-prod), `values-staging.yaml`,
  `values-prod.yaml` (disables in-cluster Postgres/Redis; expects managed
  instances + injected secrets).

```bash
helm lint deploy/helm/finance-planner
helm template fp deploy/helm/finance-planner            # render to inspect
helm upgrade --install finance-planner deploy/helm/finance-planner \
  -f deploy/helm/finance-planner/values-prod.yaml \
  --set secrets.DATABASE_URL=... --set secrets.JWT_SIGNING_KEY=...
```

CI/CD: `ci.yml` validates everything (incl. `helm lint`/`template` and Docker
builds). **Deploying to a real cluster is deliberately not automated** — it needs
cluster credentials/secrets that aren't committed (decision #15). Wire that final
step into your CD with your provider's auth when ready.

---

## 8. Operational runbook

- **Migrations:** single idempotent SQL file (`db/migrations/0001_init.sql`,
  `CREATE … IF NOT EXISTS`). Applied automatically by the Helm Job on
  install/upgrade, by Postgres initdb in compose, or manually via `make migrate`.
  > **Drift watch:** `deploy/helm/finance-planner/files/0001_init.sql` is a copy
  > used by the chart ConfigMap. If you change the canonical file under
  > `db/migrations/`, copy it across. Adopting `drizzle-kit` for generated,
  > ordered migrations is the planned next step (decision #9).
- **Secrets:** never commit real ones. `values.yaml` ships dev placeholders.
  Override via `--set`/`-f` or an external-secrets operator. The JWT key must be
  the same for api and auth.
- **Health:** every service exposes `/healthz` (liveness) and `/readyz`
  (readiness). Probes are wired in the chart.
- **Scaling:** HPA on CPU (`autoscaling` in values). Deployments omit a static
  `replicas` when autoscaling is enabled so they don't fight the HPA.
- **Logs:** structured JSON (Pino). Add a log aggregator + OTel collector per the
  observability section of `plan/07-devops-cicd-kubernetes.md` (not yet wired).
- **Backups:** add a `pg_dump` CronJob (non-prod) / managed snapshots (prod);
  documented as a follow-up in the DevOps plan.

---

## 9. Security notes

- Passwords: scrypt with per-hash salt (`packages/security`). Decision #11 names
  Argon2id; scrypt was chosen to avoid a native build dependency — swapping the
  algorithm is isolated to `packages/security`.
- Tokens: short-lived access JWT (HS256) held in memory by the SPA; long-lived
  opaque refresh token in an httpOnly, SameSite=strict cookie with rotation on
  refresh (reuse → session revoked).
- Authorization: every account-scoped request resolves effective access
  (owner/edit/view); no access returns **404** (not 403) to avoid leaking
  existence. Covered by tests in `apps/api/src/server.test.ts`.
- Set `COOKIE_SECURE=true` and a strong `JWT_SIGNING_KEY` in production.

---

## 10. Where to look first (new-engineer pointers)

- The maths: `packages/domain/src/engine.ts` (+ `plan/03-calculation-engine.md`).
- The data model: `packages/data/src/schema.ts` + `db/migrations/0001_init.sql`
  (+ `plan/02-domain-model.md`).
- The API surface: `apps/api/src/server.ts` (+ `plan/04-backend-services.md`).
- Auth flows: `apps/auth/src/server.ts` (+ `plan/06-auth-and-households.md`).
- The UI: `apps/web/src/` (+ `plan/05-frontend.md`).

---

## 11. Known limitations & deferred backlog

Intentionally not built in v1 (see decisions in `plan/09-open-questions.md` and
the Phase 7 backlog in `plan/08-roadmap.md`):

- **Auto-accumulating contributions ledger** — `alreadySavedMinor` is a manual
  field today (decision #2).
- **Notifications** (goal at-risk / payment due) — decision #6.
- **OIDC / social login** and **real SMTP email** — only email+password and a
  `LogMailer` (dev transport) are wired (decision #11). The `Mailer` interface
  exists for a drop-in `SmtpMailer`.
- **Multi-currency FX** — accounts are single-currency; the overview groups by
  currency without conversion (decision #1).
- **Redis usage** — provisioned but the caching/queue path isn't required yet
  (plans compute on read). Add caching + a nightly recompute CronJob per
  `plan/07`/`plan/04` if read latency becomes a concern.
- **Observability stack** (Prometheus/Grafana/Loki/OTel) and **DB backups** —
  designed in `plan/07` but not yet wired.
- **Live-cluster CD** — gated on cluster credentials (decision #15).

---

## 12. Plan document index

| Doc                                 | Contents                                  |
| ----------------------------------- | ----------------------------------------- |
| `plan/00-overview.md`               | Vision, glossary, decisions, doc index    |
| `plan/01-architecture.md`           | Services, data flow, repo layout          |
| `plan/02-domain-model.md`           | Entities + Postgres schema                |
| `plan/03-calculation-engine.md`     | The savings maths (formulas + examples)   |
| `plan/04-backend-services.md`       | Service responsibilities + REST API       |
| `plan/05-frontend.md`               | React app structure                       |
| `plan/06-auth-and-households.md`    | Auth, households, sharing, permissions    |
| `plan/07-devops-cicd-kubernetes.md` | Docker, CI/CD, Helm, k8s, ops             |
| `plan/08-roadmap.md`                | Phased delivery plan + Definition of Done |
| `plan/09-open-questions.md`         | Locked decisions (all resolved)           |
| `plan/10-testing-strategy.md`       | Test layers, gates, UI testing            |
