# Architecture

> See `00-overview.md` for product context and the decisions referenced here.

## 1. Architectural style

A small set of **coarse-grained services** behind a single API gateway / BFF,
deployed as independent containers on Kubernetes, all backed by a shared
PostgreSQL instance with **per-service schemas** (logical isolation now,
physical split possible later).

This satisfies the "multiple microservice containers" requirement without the
operational overhead of fine-grained per-entity services.

## 2. Services

```
                       ┌───────────────────────────────┐
   Browser  ──────────▶│  web (React/TS, static + Nginx)│
                       └───────────────┬───────────────┘
                                       │  HTTPS (REST/JSON)
                                       ▼
                       ┌───────────────────────────────┐
                       │        api  (BFF / gateway)     │
                       │  - auth verification (JWT)      │
                       │  - accounts, incomes, payments  │
                       │  - request orchestration        │
                       └───┬───────────────┬─────────────┘
                           │               │
            internal gRPC/REST             │ enqueue / sync call
                           │               ▼
              ┌────────────▼──────┐   ┌──────────────────────────┐
              │  auth service      │   │  calc service (worker)    │
              │  - users           │   │  - savings engine         │
              │  - households      │   │  - plan recomputation     │
              │  - sessions/tokens │   │  - scheduled projections  │
              └────────────┬──────┘   └────────────┬─────────────┘
                           │                       │
                           ▼                       ▼
                       ┌───────────────────────────────┐
                       │         PostgreSQL              │
                       │  schemas: auth, core, calc      │
                       └───────────────────────────────┘
                                       ▲
                       ┌───────────────┴───────────────┐
                       │  redis (cache + job queue)      │
                       └───────────────────────────────┘
```

### 2.1 `web`

- React + TypeScript SPA (Vite build), served as static assets via Nginx.
- Talks only to `api`. No direct DB or auth-service access.

### 2.2 `api` (Backend-for-Frontend / gateway)

- The single public backend entrypoint.
- Verifies JWTs (issued by `auth`), enforces account/household authorization.
- Owns the **core domain**: accounts, incomes, payments.
- Orchestrates calls to `calc` for plan computation and to `auth` for
  user/household lookups.
- Exposes the REST API consumed by `web` (see `04-backend-services.md`).

### 2.3 `auth`

- Owns users, credentials/identity, households, membership, and account-sharing
  grants. Issues and validates tokens.
- See `06-auth-and-households.md`.

### 2.4 `calc` (calculation worker)

- Stateless, deterministic **savings calculation engine** (`03-calculation-engine.md`).
- Two modes:
  - **Synchronous**: `api` requests an on-demand plan computation.
  - **Asynchronous/scheduled**: recomputes projections (e.g. nightly, or when
    a payment/income changes) and caches results for fast reads.
- Reads core data (read-only) and writes computed snapshots to the `calc` schema.

### 2.5 Supporting infrastructure

- **PostgreSQL** — primary datastore (schemas: `auth`, `core`, `calc`).
- **Redis** — response/plan cache and the job queue for `calc` recomputation.

## 3. Data flow examples

### Adding a payment and seeing the impact

1. User submits a new payment in `web`.
2. `api` validates, authorizes (does the user have write access to this
   account?), persists it in `core.payments`.
3. `api` enqueues a recompute job (or calls `calc` synchronously for a quick
   single-account plan).
4. `calc` computes required monthly contributions + leftover/shortfall, writes a
   snapshot to `calc.plan_snapshots`, caches in Redis.
5. `api` returns the updated plan; `web` renders the breakdown.

### Viewing the all-accounts overview

1. `web` requests `/overview`.
2. `api` resolves the set of accounts visible to the user (own + shared via
   household), fetches the latest cached plan snapshots from `calc`/Redis,
   aggregates totals, returns the consolidated view.

## 4. Synchronous vs. asynchronous computation

- Single-account, on-demand edits → synchronous compute for immediate feedback.
- Cross-account overview & periodic re-projection → async, cached snapshots.
- The engine is **pure** (same inputs → same outputs), so sync and async paths
  share one code path and stay consistent. See `03-calculation-engine.md`.

## 5. Inter-service communication

- `web → api`: REST/JSON over HTTPS.
- `api → auth`, `api → calc`: internal REST/JSON over the cluster network
  (mTLS optional via service mesh later). Keep contracts in a shared
  `packages/contracts` package (typed DTOs/Zod schemas).
- Async jobs: Redis-backed queue (BullMQ) between `api` and `calc`.

## 6. Repository layout (monorepo)

A single repository (monorepo) with workspaces keeps shared types and tooling
consistent and simplifies CI matrix builds.

```
finance-planner/
├── plan/                      # these planning docs
├── apps/
│   ├── web/                   # React + TS SPA
│   ├── api/                   # BFF / gateway service
│   ├── auth/                  # auth + households service
│   └── calc/                  # calculation worker/service
├── packages/
│   ├── contracts/             # shared DTOs, Zod schemas, API types
│   ├── domain/                # shared domain types + the pure calc engine lib
│   ├── config/                # shared tsconfig, eslint, prettier
│   └── ui/                    # shared React component library (optional)
├── db/
│   ├── migrations/            # SQL migrations (per schema)
│   └── seed/                  # seed/fixture data for local dev
├── deploy/
│   ├── helm/                  # Helm chart(s) for the stack
│   ├── kustomize/             # overlays: local / staging / prod
│   └── local/                 # kind/minikube + docker-compose for dev
├── .github/workflows/         # GitHub Actions pipelines
├── docker/                    # per-service Dockerfiles (or co-located)
├── package.json               # workspace root (pnpm/turbo)
└── turbo.json / nx.json       # build orchestration (TBD, see open questions)
```

> **Why monorepo over polyrepo:** the pure calculation engine lives in
> `packages/domain` and is imported by both `api` (sync path) and `calc` (worker)
> as well as exercised directly in `web` for optimistic previews. Sharing types
> via `packages/contracts` removes a whole class of drift bugs. Build tooling
> (Turborepo vs. Nx) is flagged in `09-open-questions.md`.

## 7. Cross-cutting concerns

| Concern        | Approach                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Config         | 12-factor env vars; k8s ConfigMaps + Secrets.                                                            |
| Observability  | Structured JSON logs; OpenTelemetry traces; `/healthz` + `/readyz` on every service; Prometheus metrics. |
| Validation     | Zod schemas in `packages/contracts`, shared client + server.                                             |
| Migrations     | Versioned SQL migrations run as a k8s Job/init container before rollout.                                 |
| Money handling | Store as integer minor units (pennies) + ISO currency code; never floats.                                |
| Time/dates     | Store UTC; all recurrence/target maths uses date-only logic in the account's timezone.                   |

## 8. Environments

| Env        | Cluster                             | Purpose                        |
| ---------- | ----------------------------------- | ------------------------------ |
| local      | kind / minikube (or docker-compose) | Developer machines.            |
| staging    | any k8s                             | Integration + QA, seeded data. |
| production | any k8s                             | Live.                          |

Cloud-agnostic: no provider-specific resources in the base manifests; managed
Postgres/Redis are wired in per-overlay if/when a cloud is chosen.
