# Helm chart: finance-planner

Cloud-agnostic chart deploying `web`, `api`, `auth`, `calc`, plus optional
in-cluster Postgres and Redis.

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

## Notes / Phase 0 limitations

- **Secrets**: `values.yaml` ships placeholder secrets for local use only. In
  real environments override via `--set`/`-f` or (preferably) an external
  secrets operator. Do not commit real secrets.
- **Migrations**: not yet a Helm hook — see chart `NOTES.txt`.
- **Prod**: `values-prod.yaml` disables in-cluster Postgres/Redis; point
  `secrets.DATABASE_URL` / `config.REDIS_URL` at managed instances.
- Later phases add HPA, PodDisruptionBudgets, NetworkPolicies, and a nightly
  recompute CronJob (see `plan/07-devops-cicd-kubernetes.md`).
