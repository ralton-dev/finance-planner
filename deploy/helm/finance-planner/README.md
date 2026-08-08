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
- A `post-install`/`post-upgrade` **migration Job** that applies every `files/*.sql` in
  lexical order with `ON_ERROR_STOP=1` (see `OPERATIONS.md §3 Migrations` for
  the drift-watch note on keeping `files/` in sync with `db/migrations/`).
- Horizontal Pod Autoscaler (CPU) and PodDisruptionBudget per service.

## Configuration

`config:` and `secrets:` are shared by every service (ConfigMap + Secret,
consumed via `envFrom`) — note that this means **every** Secret key reaches
**every** pod, `web` included. `serviceEnv.<service>` adds an `env:` block to
one Deployment only — that's where mail, digest, demo-seed, and OIDC settings
go. Empty values are omitted from the render, so leaving one blank means unset
rather than `""`. Full table in
[`../../../OPERATIONS.md`](../../../OPERATIONS.md) §1.

`tracing:` is the exception to that shape, and deliberately: it is one
top-level switch rather than a per-service entry, because a request that
crosses a process boundary is still one request and half a fleet exporting
spans is a trace that stops at the hop. With `tracing.enabled: false` — the
default — **no `OTEL_*` variable is rendered onto any pod at all**, and the
preload in each image loads no SDK. Enabled, it renders onto the three
backends and never onto `web`, which is nginx. Two things to know before you
set it:

- `tracing.endpoint` wants a **bare origin**, e.g.
  `http://opentelemetry-collector.observability:4318`. The chart `fail`s the
  render if tracing is on and it is empty, matching the services, which refuse
  to start in the same case — because the OTLP spec defaults the endpoint to
  localhost, so an unset one exports into the void rather than looking unset.
- There is **no collector in this chart**. Point the endpoint at one you
  already run. If it needs a token, add an `OTEL_EXPORTER_OTLP_HEADERS` key to
  `secrets:` — it is read by key with `optional: true` rather than through the
  bulk `secretRef`, so it lands only on the pods that export spans.

`APP_VERSION` is rendered onto every service from `.Values.image.tag`, and
`service.version` on every span comes from the same place. The tag is the only
version a container actually carries: all three app `package.json` versions are
`0.0.0` and nothing sets `npm_package_version` under `node dist/index.js`. It
follows that the value is only as honest as your tag — deploy with
`--set image.tag=sha-$SHA` rather than the shipped `latest`.

## Secrets

`values.yaml` ships placeholder secrets for local use only. Override via
`--set` / `-f` or (preferably) an external-secrets operator. The JWT key must
be identical for api and auth. Don't commit real secrets.

## Known gaps in the chart

See [`../../../BACKLOG.md`](../../../BACKLOG.md) — in particular NetworkPolicies,
the audit log subject, the nightly recompute CronJob, and the
post→pre-install hook switch for the migration Job. Four are worth naming here
because they are properties of these templates rather than of the product:

- **`readinessProbe` is a liveness check under another name.** Each service
  declares one `health:` path in `values.yaml` and `templates/services.yaml`
  renders it into both probes, so the `/readyz` endpoint every service exposes
  is never called. It would not tell you much if it were: all three return a
  hardcoded `{ ready: true, checks: {} }`, so a pod whose database is gone
  still reports ready and still takes traffic.
- **Every Secret key reaches every pod.** The bulk `secretRef` on each
  Deployment means the nginx `web` container is handed `JWT_SIGNING_KEY`,
  `DATABASE_URL`, `SMTP_URL` and `OIDC_CLIENT_SECRET`, none of which it has any
  use for. Closing it means splitting the Secret per service in
  `templates/config.yaml`.
- **`Chart.yaml`'s `appVersion` is still `"0.0.0"`.** Inert — nothing
  references `.Chart.AppVersion` — but it is the last altitude still reporting
  a version no deployment has ever had.
- **Nothing deploys this chart**
  ([issue #75](https://github.com/ralton-dev/finance-planner/issues/75)), so
  `image.tag` never names a build and the version the pods report is whatever
  you passed by hand. `values-staging.yaml` claims images are SHA-tagged by CI
  one line above its own `tag: latest`.
