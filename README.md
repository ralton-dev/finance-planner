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

The plan is grounded in reality by a **contributions ledger**: record what you
actually set aside, check in your real balance, tick off transfers, and close
the month. From that same history it **projects 12 months forward** and tells
you what's due next.

Installable as a PWA. Deployed cloud-agnostically on Kubernetes via Helm.

- **Operations / runbook:** [`OPERATIONS.md`](./OPERATIONS.md)
- **Deferred backlog:** [`BACKLOG.md`](./BACKLOG.md)
- **Contributing:** [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- **Licence:** [MIT](./LICENSE)

## Feature tour

**Planning**

- Accounts with incomes and payments — monthly, yearly, custom-cadence, or a
  one-off `fixed_point` goal. Each payment carries a priority; the engine funds
  in priority order and reports shortfalls.
- Goals work two ways: **paced by date** (required monthly = remaining ÷ months
  left) or **contribution-first** — set a fixed monthly amount and the finish
  date becomes a consequence of the pace. A contribution-first goal needs no
  target date at all.
- **Projects** group payments across accounts.
- Free-form **tags** (≤ 40 chars) on payments, with suggestions from tags
  already used on the account.
- **What-if preview**: overlay up to five hypothetical payments/incomes on an
  account and see leftover, shortfall, and newly-at-risk goals before/after.
  Nothing is persisted. Account-level only — see `BACKLOG.md`.

**Household**

- Shared-pot vs personal accounts, per-member contribution shares, and
  shared vs personal expenses. Shared costs split by share; personal costs land
  on their bearer.
- Derived **transfers**: who moves what into which account each month.
- **Payday-anchored schedule** splits each transfer across that member's actual
  pay dates, derived from the incomes on their personal accounts.
- Household-wide month closes.

**Reality loop**

- **Contributions ledger** (`core.contributions`). A payment's "already saved"
  is derived — its manual base plus everything recorded against it — so the
  plan reflects what you really did.
- **Balance check-ins** (one per account per day) with a **drift warning** when
  the plan has reserved more than the account actually holds.
- **Transfer confirmations**: tick a planned transfer off and it writes the
  matching contributions into the destination account. Monthly, not per-payday.
- **Month closes** freeze income / planned / saved for a month, and the
  **savings scorecard** shows the resulting savings rate per month.
- **Net-worth chart** built from balance check-ins, one line per currency,
  carrying the last known balance forward.

**Forecasting**

- **12-month projection** (selectable 6/12/24) for an account or a whole
  household: re-plans every month against evolving state. Renders as a chart
  plus a payments × months grid marking the months each payment falls due.
  The projected-balance line needs at least one balance check-in.
- **Upcoming payments** feed (default 14 days) on the Overview, and an opt-in
  **daily email digest** covering the next 7 days of bills and transfers.

**Insight**

- Tag **treemap** ("where the month goes") and per-member **stacked bars**
  ("who carries what").
- Household **Sankey** — income → accounts → transfers → spending/left over —
  with a **£ / %** toggle.
- **PNG export** on every chart.
- **Privacy mode** blurs every amount on screen and veils charts; toggle from
  the sidebar, the command palette, or the `a` shortcut. Remembered locally.

**Platform / auth**

- Email + password, or **OIDC single sign-on** (PKCE, auto-provisioning
  passwordless users). Access tokens are short-lived; refresh tokens rotate and
  a replayed one revokes every session for that user.
- **TOTP 2FA** with step-up at login and eight single-use recovery codes
  (hashed at rest). **Password reset** by email.
- **JSON export / import** of your own data, and **account erasure**.
- **Installable PWA** — offline app shell, self-hosted JetBrains Mono, no CDN
  calls. `/api` is never cached.
- **Demo seed** plants a worked example into an empty account, gated behind
  `ENABLE_DEMO_SEED` and off by default.

## Architecture

```
Browser ──/api──▶ api (gateway/BFF) ──┬─ core domain (accounts, incomes,
                                       │   payments, projects, contributions,
                                       │   plan, projection, upcoming, overview)
                                       ├─ /api/auth/* ─proxy─▶ auth service
                                       └─ computes plans via @finance-planner/domain
                                       │
                  auth service ────────┘   (users, households, sessions, sharing,
                                            2FA, password reset, OIDC)
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
  security  scrypt password hashing, HS256 JWT (jose), TOTP
  mailer    Mailer interface + SmtpMailer (nodemailer) / LogMailer fallback
db/          SQL migrations (0001_init.sql … 0007_platform.sql) + seed
deploy/
  local/     docker-compose stack, compose nginx, kind helper
  helm/      cloud-agnostic chart (services, ingress, migrate Job, HPA, PDB, …)
             files/ mirrors db/migrations — keep the two in sync
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

Optional features are env-gated and off by default — outbound mail, the daily
digest, single sign-on, and the demo seed. `.env.example` documents each one;
`OPERATIONS.md` §1 is the full table.

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
  no component library; design tokens in `apps/web/src/styles.css`). Recharts
  for charts, lazily loaded. Installable PWA (manifest + hand-written service
  worker), self-hosted JetBrains Mono.
- **Backend:** Fastify 5 (api, auth, calc)
- **ORM / DB:** Drizzle ORM + PostgreSQL · **Cache/queue (reserved):** Redis
- **Mail:** nodemailer, wrapped by `packages/mailer`; falls back to logging
  when `SMTP_URL` is unset
- **Auth:** scrypt password hash + HS256 JWT access token + opaque refresh
  cookie + per-route rate-limit + reuse detection + TOTP 2FA + OIDC (PKCE)
- **Tests:** Vitest + React Testing Library + Playwright + Testcontainers
- **CI/CD:** GitHub Actions · **Runtime:** Kubernetes (Helm, cloud-agnostic)
