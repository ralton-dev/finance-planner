# Backend Services & API

> Architecture context in `01-architecture.md`; domain types in
> `02-domain-model.md`; engine in `03-calculation-engine.md`.

## 1. Proposed stack

| Concern        | Proposal                                                    | Alternatives (see `09-open-questions.md`) |
| -------------- | ----------------------------------------------------------- | ----------------------------------------- |
| Language       | TypeScript (Node 22 LTS)                                    | —                                         |
| HTTP framework | **NestJS** (structured, DI, good for multi-module services) | Fastify (lighter), Express                |
| Validation     | Zod (shared via `packages/contracts`)                       | class-validator                           |
| DB access      | **Drizzle ORM** (typed SQL, lightweight migrations)         | Prisma, Kysely                            |
| Queue          | BullMQ on Redis                                             | —                                         |
| Auth tokens    | JWT (access) + opaque refresh tokens                        | —                                         |
| Testing        | Vitest + Supertest; Testcontainers for Postgres             | Jest                                      |

> NestJS + Drizzle is the recommended default: NestJS gives clean module
> boundaries that map to our coarse services, and Drizzle keeps SQL explicit and
> migrations simple. Final ORM/framework choice tracked in open questions.

## 2. Service responsibilities

### 2.1 `api` (BFF / gateway)

Public REST API. Owns `core` schema (accounts, incomes, payments). Verifies
JWTs, enforces authorization, orchestrates `auth` and `calc`.

### 2.2 `auth`

Users, households, memberships, account shares, token issue/verify. Details in
`06-auth-and-households.md`. Exposes an internal API to `api`.

### 2.3 `calc`

Stateless engine host. Internal sync endpoint + queue consumer for async
recompute. Writes `calc` schema snapshots. Imports `packages/domain`.

## 3. REST API (public, served by `api`)

All endpoints require a valid access token unless noted. Money fields are
`*_minor` integers. Authorization: the caller must own or have a share on the
referenced account.

### 3.1 Auth (proxied to `auth` service)

```
POST   /api/auth/register           { email, password, displayName }
POST   /api/auth/login              { email, password } -> { accessToken, refreshToken }
POST   /api/auth/refresh            { refreshToken } -> { accessToken }
POST   /api/auth/logout
GET    /api/me                      -> current user + households
```

### 3.2 Households & sharing

```
GET    /api/households
POST   /api/households               { name }
POST   /api/households/:id/members   { email, role }      // invite
DELETE /api/households/:id/members/:userId
POST   /api/accounts/:id/shares      { householdId, permission }  // share account
DELETE /api/accounts/:id/shares/:shareId
```

### 3.3 Accounts

```
GET    /api/accounts                 -> accounts visible to user (own + shared)
POST   /api/accounts                 { name, currency, openingBalanceMinor, description? }
GET    /api/accounts/:id             -> account detail
PATCH  /api/accounts/:id
DELETE /api/accounts/:id
GET    /api/accounts/:id/plan        -> AccountPlan (latest cached or recompute)
GET    /api/accounts/:id/plan?asOf=YYYY-MM-DD  -> plan for a given reference date
```

### 3.4 Incomes

```
GET    /api/accounts/:id/incomes
POST   /api/accounts/:id/incomes     { name, amountMinor, frequency, recurrence?, anchorDate }
PATCH  /api/incomes/:incomeId
DELETE /api/incomes/:incomeId
```

### 3.5 Payments

```
GET    /api/accounts/:id/payments
POST   /api/accounts/:id/payments    { name, category, amountMinor, dueDate?, recurrence?,
                                       targetDate?, priority?, alreadySavedMinor?, autoRenew? }
PATCH  /api/payments/:paymentId      // includes re-prioritisation
DELETE /api/payments/:paymentId
PATCH  /api/accounts/:id/payments/reorder  { orderedPaymentIds[] }  // bulk priority update
```

### 3.6 Overview

```
GET    /api/overview                 -> aggregated plan across all visible accounts
                                        (grouped per currency; see calc §7)
```

### 3.7 Health

```
GET    /healthz   // liveness, no auth
GET    /readyz    // readiness (DB/redis reachable), no auth
```

## 4. Internal APIs

### `calc` (internal only)

```
POST   /internal/calc/account-plan   { accountId, asOfDate? } -> AccountPlan   // sync
POST   /internal/calc/recompute      { accountId | "all" }                     // enqueue async
// queue consumer: recompute job -> writes calc.plan_snapshots, caches in redis
```

### `auth` (internal only)

```
POST   /internal/auth/verify         { token } -> { userId, claims }
GET    /internal/auth/users/:id/accounts-acl  -> account ids the user can read/write
```

## 5. Authorization model

- Every account-scoped request resolves the caller's **effective access** to the
  account: `owner` (full) or via an `AccountShare` to a household they belong to,
  with a `permission` of `view` or `edit`.
- `api` calls `auth`'s ACL endpoint (cached briefly in Redis) to build the set of
  readable/writable account ids per request.
- Mutations require `edit`; reads require `view`.
- See `06-auth-and-households.md` for roles and permission semantics.

## 6. Recompute triggering

A plan snapshot is (re)computed when:

- A payment or income on the account is created/updated/deleted → `api` enqueues
  `recompute(accountId)`.
- A share/household membership change alters visibility → invalidate overview cache.
- Nightly scheduled job → recompute all active accounts so "monthsUntil" stays
  current as time passes (CronJob in k8s).
- On read, if no fresh snapshot exists (`inputs_hash` mismatch or stale
  `as_of_date`) → compute synchronously and persist.

## 7. Caching & invalidation

- Redis caches `AccountPlan` keyed by `accountId:inputsHash:asOfDate`.
- `inputs_hash` = hash of the account's incomes + payments + as-of month.
- Overview cache keyed by `userId` + set of visible account snapshot hashes.
- Any mutation bumps the relevant hash, naturally invalidating stale entries.

## 8. Error handling & API conventions

- JSON error envelope: `{ error: { code, message, details? } }`.
- Validation errors → 422 with field-level `details` from Zod.
- AuthN → 401; AuthZ → 403; not found / no access → 404 (avoid leaking
  existence of others' accounts).
- Idempotency keys accepted on POST mutations to tolerate client retries.
- All list endpoints paginate (`?limit&cursor`) — though per-account volumes are
  small, the overview and audit endpoints benefit.

## 9. Observability

- Structured JSON logs with request id + user id (no PII/amounts in logs beyond
  ids).
- OpenTelemetry traces across `web → api → calc/auth`.
- Prometheus metrics: request latency, recompute duration, queue depth,
  cache hit ratio.

## 10. Testing strategy (backend)

- **Unit**: engine (`packages/domain`) golden-file tests; service logic.
- **Integration**: API + real Postgres via Testcontainers; auth flows.
- **Contract**: validate `api` responses against `packages/contracts` Zod schemas.
- **E2E**: a thin set against a docker-compose stack in CI (see `07`).
