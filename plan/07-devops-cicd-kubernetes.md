# DevOps: Docker, CI/CD & Kubernetes

> Decision: **cloud-agnostic manifests + local dev** (`00-overview.md`).
> Built with **GitHub Actions**, deployed to **Kubernetes**, **PostgreSQL** backend.

## 1. Containerisation

Each service ships its own image, built from a multi-stage Dockerfile.

| Image | Base | Notes |
|-------|------|-------|
| `web` | `node` build → `nginx:alpine` serve | Static SPA + Nginx config (SPA fallback, gzip). |
| `api` | `node:22-alpine` (distroless for prod) | Runs the BFF. |
| `auth` | `node:22-alpine` | |
| `calc` | `node:22-alpine` | Worker + internal HTTP. |
| `migrator` | `node:22-alpine` | Runs DB migrations as a k8s Job. |

Multi-stage pattern: shared `deps` stage (pnpm install with workspace), `build`
stage (turbo build the target app), slim `runtime` stage. Use `.dockerignore`,
non-root user, pinned digests, and Trivy scanning in CI.

## 2. Local development

Two options, both committed under `deploy/local/`:

1. **docker-compose** — fastest inner loop: Postgres, Redis, and the four
   services + web, with hot reload via mounted volumes.
2. **kind / minikube** — to exercise the real k8s manifests locally before
   pushing. A `make up-kind` target loads images and applies the local overlay.

`make` targets: `dev` (compose), `up-kind`, `seed`, `migrate`, `test`, `lint`.

## 3. Kubernetes resources (cloud-agnostic)

Packaged as a **Helm chart** under `deploy/helm/finance-planner`, with
environment values files and/or **kustomize overlays** for `local` / `staging`
/ `prod`.

Per service:
- `Deployment` (2+ replicas in prod; HPA on CPU/latency).
- `Service` (ClusterIP; `web` + `api` fronted by Ingress).
- `ConfigMap` (non-secret config) + `Secret` (DB creds, JWT keys).
- `livenessProbe` → `/healthz`, `readinessProbe` → `/readyz`.
- Resource requests/limits; `securityContext` (non-root, read-only FS).
- `NetworkPolicy`: only `api` may reach `auth`/`calc`; only services reach DB.

Cluster-level:
- `Ingress` (nginx-ingress; cert-manager for TLS) routing `/` → web, `/api` → api.
- **PostgreSQL**: in-cluster StatefulSet (e.g. Bitnami/CloudNativePG) for
  local/staging; in prod, point to managed Postgres via a values override —
  no provider lock-in in the base chart.
- **Redis**: in-cluster for non-prod; managed/HA option per overlay.
- **Migrations**: a Helm pre-install/pre-upgrade `Job` (the `migrator` image)
  gates rollout — app pods only start after migrations succeed.
- **CronJob**: nightly `calc` recompute-all (keeps "months until due" current).

```
deploy/
├── helm/finance-planner/
│   ├── Chart.yaml
│   ├── values.yaml              # defaults
│   ├── values-staging.yaml
│   ├── values-prod.yaml
│   └── templates/               # deployments, services, ingress, jobs, hpa, netpol
└── kustomize/
    ├── base/
    └── overlays/{local,staging,prod}/
```

## 4. CI/CD with GitHub Actions

### 4.1 CI — `ci.yml` (on PR + push)
Path-filtered, parallel matrix across affected workspaces (Turborepo remote
cache to skip unchanged):
1. **Setup**: checkout, pnpm install (cached), Turbo cache restore.
2. **Lint + typecheck**: eslint, `tsc --noEmit`.
3. **Unit tests**: Vitest per package/app (engine golden-file tests included).
4. **Integration tests**: spin Postgres + Redis as service containers; run API
   integration tests (or Testcontainers).
5. **Build**: build all apps; build Docker images (don't push on PRs).
6. **Security**: Trivy image scan, `pnpm audit`, secret scanning, CodeQL.
7. **E2E (optional gate)**: docker-compose up the stack; run Playwright smoke.

### 4.2 Build & publish — `release.yml` (on push to `main` / tags)
1. Build multi-arch images (`linux/amd64,arm64`) via buildx.
2. Tag with git SHA + semver; push to GHCR (`ghcr.io/bralton/finance-planner/*`).
3. Generate SBOM; sign images (cosign).

### 4.3 Deploy — `deploy.yml`
- **Staging**: auto-deploy on `main` — `helm upgrade --install` against the
  staging cluster using the SHA-tagged images and `values-staging.yaml`.
- **Production**: manual approval (GitHub Environment protection) → promote the
  same images with `values-prod.yaml`.
- Cluster access via OIDC-federated credentials or a kubeconfig secret
  (provider-agnostic; documented per target in the deploy overlay README).
- Migrations run automatically via the Helm pre-upgrade Job; rollout is gated on
  readiness probes; `helm rollback` on failure.

### 4.4 Branching & environments
- Trunk-based: PRs into `main`; feature branches (this work is on
  `claude/finance-planning-app-design-6HBt5`).
- GitHub Environments: `staging` (auto), `production` (required reviewers).
- Secrets via GitHub Environments / external secrets operator → k8s Secrets.

## 5. Configuration & secrets

- 12-factor env vars; never bake secrets into images.
- Per env: `DATABASE_URL`, `REDIS_URL`, `JWT_SIGNING_KEY`/JWKS, service URLs,
  `LOG_LEVEL`.
- Secret sourcing options (per overlay): k8s Secrets from GitHub Environments, or
  External Secrets Operator backed by a vault — provider-agnostic.

## 6. Observability & ops

- Prometheus scraping `/metrics`; Grafana dashboards (per-service latency,
  recompute duration, queue depth, error rate).
- Centralised logs (Loki/ELK) with request-id correlation.
- OpenTelemetry traces (collector in-cluster, exporter configurable per env).
- Alerts: readiness flaps, queue backlog, DB connection saturation, 5xx rate.

## 7. Reliability

- Multiple replicas + PodDisruptionBudgets for `api`/`web`.
- HPA on `api` and `calc`.
- DB backups (pg_dump CronJob for non-prod; managed snapshots in prod) +
  documented restore runbook.
- Graceful shutdown (drain in-flight requests / queue jobs on SIGTERM).

## 8. Definition of "deployable"

A change is deployable when: CI green (lint, types, unit, integration, security),
images built + scanned + signed, migrations apply cleanly forward, and the
staging smoke E2E passes.
