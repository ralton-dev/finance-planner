# Operations

The runbook. How to configure, deploy, and operate Finance Planner. See
[`README.md`](./README.md) for the architecture and local-dev quickstart.

## 1. Configuration (environment variables)

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

## 2. Deployment (Helm)

The chart lives at `deploy/helm/finance-planner` and renders Deployments +
Services for each of the four apps, an Ingress (`/api` → api, `/` → web),
optional in-cluster Postgres/Redis, a **migration Job** (post-install /
post-upgrade hook that loops every `db/migrations/*.sql` in lexical order),
HPA, and PodDisruptionBudgets per service.

Per environment:

- `values.yaml` — defaults / non-prod
- `values-staging.yaml`
- `values-prod.yaml` — disables in-cluster Postgres/Redis; expects managed
  instances injected via external secrets

```bash
helm lint deploy/helm/finance-planner
helm template fp deploy/helm/finance-planner            # render to inspect
helm upgrade --install finance-planner deploy/helm/finance-planner \
  -f deploy/helm/finance-planner/values-prod.yaml \
  --set secrets.DATABASE_URL=... --set secrets.JWT_SIGNING_KEY=...
```

### CI/CD

`.github/workflows/ci.yml` runs on every push:

1. **build-test** — format / lint / typecheck / test / coverage / build
2. **integration** — Testcontainers Postgres, applies every migration in order,
   exercises the store contract end-to-end
3. **e2e** — Playwright against the built SPA
4. **helm** — `helm lint` + `helm template` (default + prod values)
5. **docker** — build all four images (matrix; no push)
6. **stack-smoke** — `docker compose up -d --build --wait`, then curl
   `/healthz` on api/auth/calc and `/` on web; tears down on success or
   failure. **This is the job that catches runtime regressions a unit test
   can't see** (bundler issues, missing migrations, wrong env wiring).
7. **codeql** — security scanning on a separate workflow

All seven gate merges to `main` via branch protection. CodeQL runs in
parallel to the rest.

Pushing built images to GHCR + auto-deploying staging/prod are intentionally
**not** wired — they need cluster credentials that aren't committed. Plug
that into your CD with provider-specific auth when ready.

## 3. Operational runbook

### Migrations

Plain numbered SQL under `db/migrations/`. Applied:

- Automatically by Postgres `initdb` in compose (mounted into
  `/docker-entrypoint-initdb.d`) — only on a **fresh** volume.
- Automatically by the Helm Job on install / upgrade (loops every file in
  `files/*.sql`, lexical order, ON_ERROR_STOP=1).
- Manually via `make migrate` (only applies `0001_init.sql`; extend if you
  add migrations and need to apply them to an existing dev volume).

Drift watch: the chart copies SQL files into
`deploy/helm/finance-planner/files/`. Keep that mirror in sync with
`db/migrations/`. Adopting `drizzle-kit` for generated migrations is on the
backlog.

### Secrets

Never commit real ones. `values.yaml` ships dev placeholders. Override via
`--set` / `-f` or (preferably) an external-secrets operator. The JWT key
must be the same for api and auth.

### Health

Every service exposes `GET /healthz` (liveness) and `GET /readyz`
(readiness). Probes are wired in the chart with reasonable initial delays.

### Scaling

HPA on CPU per service (`autoscaling` in values, default 70% utilisation,
min 2 / max 6 replicas). Deployments omit a static `replicas` when
autoscaling is enabled so they don't fight the HPA. Each service has a
PodDisruptionBudget with `minAvailable: 1`.

### Auth-specific

- Per-route rate-limit (`@fastify/rate-limit`): register 3/min, login 5/min,
  refresh 20/min per IP.
- Refresh tokens rotate on use. A presented-but-revoked token triggers
  **reuse detection**: every active session for the user is revoked and the
  client must re-login. Surfaced as `401 reuse_detected`.
- Account access uses a 404-not-403 leak rule: no access at all returns 404
  (preserves existence privacy), insufficient permission returns 403.

### Logs

Structured JSON (Pino). Centralised log aggregation isn't wired — adding a
Loki / ELK sink is on the backlog. For dev, `make logs` tails the compose
stack.

### Backups

Not wired in the chart. For non-prod: a `pg_dump` CronJob is the planned
shape. For prod: rely on the managed-Postgres provider's snapshot policy
(documented in `BACKLOG.md`).

## 4. Where to look first (new-engineer pointers)

- The maths: `packages/domain/src/engine.ts`
- Authorisation rules: `packages/policies/src/ability.ts`
- The data model: `packages/data/src/schema.ts` + `db/migrations/*.sql`
- The API surface: `apps/api/src/server.ts`
- Auth flows: `apps/auth/src/server.ts`
- The UI shell + design tokens: `apps/web/src/components/Layout.tsx` +
  `apps/web/src/styles.css`
