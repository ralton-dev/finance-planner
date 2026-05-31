# Helm chart: finance-planner

Cloud-agnostic chart deploying `web`, `api`, `auth`, `calc`, plus optional
in-cluster Postgres and Redis. See [`../../../OPERATIONS.md`](../../../OPERATIONS.md)
for environment variables, the migration Job, scaling defaults, and the
operational runbook.

```bash
# Lint
helm lint deploy/helm/finance-planner

# Render manifests (no cluster needed)
helm template finance-planner deploy/helm/finance-planner

# Install (local/kind)
helm upgrade --install finance-planner deploy/helm/finance-planner

# Staging / prod
helm upgrade --install finance-planner deploy/helm/finance-planner \
  -f deploy/helm/finance-planner/values-staging.yaml
```

## What this chart ships

- A Deployment + Service per app (web, api, auth, calc).
- An Ingress routing `/` to web and `/api` to the api gateway.
- Optional in-cluster Postgres (StatefulSet) and Redis (Deployment) for
  non-prod; disabled in `values-prod.yaml` so you point at managed instances.
- A pre/post-install **migration Job** that applies every `files/*.sql` in
  lexical order with `ON_ERROR_STOP=1` (see `OPERATIONS.md §3 Migrations` for
  the drift-watch note on keeping `files/` in sync with `db/migrations/`).
- Horizontal Pod Autoscaler (CPU) and PodDisruptionBudget per service.

## Secrets

`values.yaml` ships placeholder secrets for local use only. Override via
`--set` / `-f` or (preferably) an external-secrets operator. The JWT key must
be identical for api and auth. Don't commit real secrets.

## Known gaps in the chart

See [`../../../BACKLOG.md`](../../../BACKLOG.md) — in particular NetworkPolicies,
the audit log subject, the nightly recompute CronJob, and the
post→pre-install hook switch for the migration Job.
