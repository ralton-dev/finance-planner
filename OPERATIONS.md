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

### Mail

| Var              | Services  | Default                                            | Notes                                                                                                                                        |
| ---------------- | --------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `SMTP_URL`       | api, auth | _(unset → mail is logged, not sent)_               | nodemailer transport URL, e.g. `smtps://user:pass@smtp.example.com:465`. Carries credentials — keep it a secret.                             |
| `MAIL_FROM`      | api, auth | `Finance Planner <no-reply@finance-planner.local>` | `From:` header on outbound mail.                                                                                                             |
| `PUBLIC_WEB_URL` | auth      | `http://localhost:5173`                            | Public origin of the SPA. Builds emailed password-reset links and is where a successful SSO round-trip lands. Trailing slashes are stripped. |

Without `SMTP_URL` both services fall back to a `LogMailer`: verification
tokens, reset links, and digests are written to the normal log stream instead
of being sent. That is the intended local-dev behaviour — the reset link is in
`make logs`. An empty string counts as unset.

### Notifications (api)

| Var              | Default | Notes                                                                                                            |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `NOTIFY_ENABLED` | `false` | Runs the daily digest sender in-process. Must be the literal string `true`.                                      |
| `NOTIFY_HOUR`    | `8`     | Local hour (0–23) from which the day's digests may go out. Anything unparseable or out of range falls back to 8. |

### Demo seed (api)

| Var                 | Default | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_DEMO_SEED`  | `false` | Exposes `POST /api/demo/seed`. The route 404s while this is false; `GET /api/meta` reports `{"demoSeedEnabled": …}` publicly.                                                                                                                                                                                                                                                                                                                                                               |
| `ENABLE_PLAN_DEBUG` | `false` | Exposes `GET /api/debug/plan` and its page. The route 404s while this is false; `GET /api/meta` reports `{"planDebugEnabled": …}` publicly and the app hides the link. **A household member who opens it reads the household's whole calculation** — co-members' personal accounts, incomes, bills and balances included — because the engine plans over the whole funding scope. That is the trace doing its job, not a hole in it, which is why turning it on is the operator's decision. |

### OIDC single sign-on (auth)

| Var                  | Default | Notes                                                                            |
| -------------------- | ------- | -------------------------------------------------------------------------------- |
| `OIDC_ISSUER`        | _unset_ | Provider base URL. Discovery is `$OIDC_ISSUER/.well-known/openid-configuration`. |
| `OIDC_CLIENT_ID`     | _unset_ | Client registered with the provider.                                             |
| `OIDC_CLIENT_SECRET` | _unset_ | Keep it a secret. Sent in the token-exchange body.                               |
| `OIDC_REDIRECT_URI`  | _unset_ | **Must be the gateway path**: `<public origin>/api/auth/oidc/callback`.          |

All four must be set or SSO stays off — a half-configured provider is treated
as absent rather than half-on. `GET /api/auth/oidc/meta` reports
`{"enabled": false}` and the login/callback routes 404 `oidc_disabled`.

The redirect URI is not negotiable in shape: the handshake cookies
(`fp_oidc_state`, `fp_oidc_verifier`, signed, `SameSite=Lax`, 10-minute TTL)
are scoped to `COOKIE_PATH`, which defaults to `/api/auth`. A callback
delivered straight to the auth service port arrives without them and fails
`403 invalid_state`. Register the gateway path with the provider and set the
same value here — it is sent verbatim in both the authorize request and the
token exchange, so the three must match exactly. The flow uses PKCE (S256);
state and verifier live in those cookies, not in server-side storage.

### Tracing

Distributed tracing over OTLP/HTTP. These span api, auth and calc together
rather than belonging to one service, because a request that crosses a process
boundary is still one request — half a fleet exporting spans is a trace that
stops at the hop.

| Var                                  | Services        | Default                 | Notes                                                                                                                                                                                                                                            |
| ------------------------------------ | --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OTEL_ENABLED`                       | api, auth, calc | `false`                 | Must be the literal string `true`. Every image starts through a `--import ./dist/otel.js` preload whose entire body sits behind this check, so anything else loads no OpenTelemetry module at all. On costs ~1 ms of startup; off costs nothing. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | api, auth, calc | _unset_                 | **A bare origin, no path** — the SDK appends `/v1/traces`. Required whenever tracing is on: the service **refuses to start** without it. See the footgun below.                                                                                  |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | api, auth, calc | _unset_                 | The per-signal alternative, accepted in place of the row above and used **verbatim**. Prefer the generic one — the chart and `.env.example` both do.                                                                                             |
| `OTEL_EXPORTER_OTLP_HEADERS`         | api, auth, calc | _unset_                 | `key=value,key=value` for a collector behind authentication. Carries a token — keep it a secret.                                                                                                                                                 |
| `OTEL_TRACES_SAMPLER`                | api, auth, calc | `parentbased_always_on` | Head sampler, the SDK's own variable. Leave it alone until the volume hurts, then `parentbased_traceidratio`. **Set it on all three or the ratio is decided twice** and you keep half-traces.                                                    |
| `OTEL_TRACES_SAMPLER_ARG`            | api, auth, calc | _unset_                 | The sampler's argument, e.g. `0.1` for a tenth of traces.                                                                                                                                                                                        |
| `OTEL_RESOURCE_ATTRIBUTES`           | api, auth, calc | _unset_                 | Comma-separated resource attributes. The chart sets `service.version` and `deployment.environment.name` (the current stable name — not the older `deployment.environment`) plus `service.instance.id` from the pod name via the downward API.    |
| `OTEL_LOG_LEVEL`                     | api, auth, calc | `info`                  | The SDK's own diagnostic level. `debug` is the escape hatch for a collector that is refusing connections — see the tracing runbook in §3.                                                                                                        |
| `APP_VERSION`                        | api, auth, calc | `0.0.0`                 | Reported as `version` by `GET /healthz` and as `service.version` on every span. Read before `npm_package_version`, which containers never set because they run `node dist/index.js` rather than npm.                                             |

**The footgun, and it is silent.** The two endpoint variables are not
interchangeable. The generic one is a base that the SDK appends `/v1/traces`
to; the per-signal one is used exactly as given. So `http://collector:4318`
— correct in the first — POSTs to `/` in the second, and every span is dropped
without a word in any log. Use the generic variable with a bare origin. The
chart's `tracing.endpoint` and `.env.example` both do, and `values.yaml` says
why beside the key.

Both variables are checked directly from `process.env` **before the SDK is
constructed**, and an enabled service with neither set throws at startup naming
both. This is deliberate: the OTLP spec _defaults_ the generic endpoint to
`http://localhost:4318`, so an unset endpoint does not look unset to the SDK —
it looks like a collector on localhost, and exports into the void. Failing to
boot is the louder half of that choice. `OTEL_SDK_DISABLED` is **not** honoured:
it defaults to enabled and swaps in a no-op SDK rather than skipping the load,
which is the opposite of what the flag above promises.

**The reported version is only as honest as whatever sets that variable.** The chart renders it from
`.Values.image.tag`, which is the only version a container actually carries —
all three app `package.json` versions are literally `0.0.0`. But nothing deploys
the chart yet ([issue #75](https://github.com/ralton-dev/finance-planner/issues/75)),
and `values.yaml` ships `tag: latest`, so until something stamps the tag with a
build the pods report `latest`. That is a different lie from `0.0.0`, not the
absence of one. `values-staging.yaml` claims images are SHA-tagged by CI one line
above its own `tag: latest`. Compose sets it to `dev` for the same reason:
a locally-built image has no tag worth reporting.

Two settings are made for you inside the bootstrap and are not operator knobs:
`OTEL_METRICS_EXPORTER` and `OTEL_LOGS_EXPORTER` are forced to `none` (the
SDK otherwise auto-configures both from the same endpoint and posts metrics
this repo never asked for), and `OTEL_EXPORTER_OTLP_TIMEOUT` is defaulted to
`5000` ms. Both carry their measurements in comments in
`packages/telemetry/src/telemetry.ts`.

In Kubernetes most of these come from the chart's ConfigMap (`config:`), Secret
(`secrets:`), and the per-service `serviceEnv:` map — see
`deploy/helm/finance-planner/values.yaml`. `serviceEnv` renders as `env:` on a
single Deployment and **omits empty values**, so a setting left blank arrives
unset rather than as `""` (which `PUBLIC_WEB_URL` would otherwise accept as
real configuration). Put `SMTP_URL` and `OIDC_CLIENT_SECRET` in `secrets:`;
everything else in the sections above is non-secret and belongs in `serviceEnv`.

Tracing is the exception, and deliberately so: it is a **chart-level** switch
under its own top-level `tracing:` block, not a `serviceEnv` entry, because it
has to be the same answer for every service at once. The chart renders it onto
the three backends and never onto `web`, which is nginx and runs no SDK. The one
secret among them is read out of the Secret **by key** rather than through the
bulk `secretRef`, so an OTLP token lands only on the pods that export spans —
worth knowing because every _other_ Secret key does reach every pod, `web`
included (see `BACKLOG.md`).

## 2. Deployment (Helm)

The chart lives at `deploy/helm/finance-planner` and renders Deployments +
Services for each of the four apps, an Ingress (`/api` → api, `/` → web),
optional in-cluster Postgres/Redis, a **migration Job** (post-install /
post-upgrade hook that globs the chart's own `files/*.sql` mirror of
`db/migrations/` into a ConfigMap and applies each in lexical order), HPA, and
PodDisruptionBudgets per service.

Env reaches the pods four ways, and the fourth is the newest:

1. `config:` → a ConfigMap, `envFrom`'d by **every** service including `web`.
2. `secrets:` → a Secret, likewise `envFrom`'d by every service. Every key of it
   therefore reaches every pod, `web` included — true today of
   `JWT_SIGNING_KEY`, `DATABASE_URL`, `SMTP_URL` and `OIDC_CLIENT_SECRET`, and
   filed in `BACKLOG.md` rather than fixed here.
3. `serviceEnv.<service>` → an `env:` block on that one Deployment, for settings
   only one service reads: `NOTIFY_ENABLED`/`NOTIFY_HOUR`/`ENABLE_DEMO_SEED` and
   `ENABLE_PLAN_DEBUG` on api, `PUBLIC_WEB_URL` and the four `OIDC_*` on auth.
   Nothing is set per service on calc or web.
4. The template itself, for values derived from the release rather than
   configured: `APP_VERSION` from `.Values.image.tag` on **every** service, and —
   when `tracing.enabled` is true — the tracing block from §1 on the three
   backends only, with the pod name injected through the downward API and the
   OTLP headers pulled from the Secret by key with `optional: true`.

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
4. **helm** — `helm lint` + `helm template` (default + prod values), then a
   diff of the exact set of services that get an HPA. Auth must never get one;
   the render is proved non-empty first so a half-rendered chart cannot match
   no HPA and call it success.
5. **docker** — a matrix of four services × two platforms, **each architecture
   on its own native runner** (emulated arm64 builds of the bundles blew past
   GitHub's 6h limit). Each leg pushes by digest only. Uses `GITHUB_TOKEN`,
   no PAT.
6. **docker-merge** — one job per service, assembling the multi-arch manifest
   list from those digests and tagging it `sha-<full-commit-sha>` and
   `:latest` under `ghcr.io/ralton-dev/finance-planner/<service>`. Runs on
   pushes to `main` only; PR builds are verify-only. The chart's
   `image.registry` points at the same path, so a real deploy is just
   `helm upgrade --install --set image.tag=sha-$SHA`.
7. **stack-smoke** — `docker compose up -d --build --wait`, then curl
   `/healthz` on api/auth/calc and `/` on web; tears down on success or
   failure. **This is the job that catches runtime regressions a unit test
   can't see** (bundler issues, missing migrations, wrong env wiring).
8. **otel-smoke** — the same compose stack brought up with the `otel` profile
   and `OTEL_ENABLED=true`, then one request through the api → auth proxy hop.
   It asserts on the collector's own output that **auth's server span names
   api's undici client span as its parent** — structurally joined, not merely
   sharing a trace id, because two processes that each started their own trace
   can produce the same id twice by coincidence and this repository has already
   been bitten by exactly that shape. It prints its whole inventory before
   asserting: a job that asserted over zero spans and passed is the defect
   rather than the fix.
9. **codeql** — security scanning on a separate workflow

Those eight job definitions expand to **18 jobs** on a push to `main` (the
docker matrix is eight and docker-merge is four), and all of them gate merges
via branch protection. CodeQL runs in parallel to the rest.

Auto-deploying staging/prod is intentionally **not** wired — it needs
cluster credentials that aren't committed. Plug into your CD with
provider-specific auth (kubeconfig secret or OIDC-federated) when ready;
the chart + images are already in place, so the final step is just
`helm upgrade --install ... --set image.tag=$SHA`.

## 3. Operational runbook

### Migrations

Plain numbered SQL under `db/migrations/`. Applied:

- Automatically by Postgres `initdb` in compose (mounted into
  `/docker-entrypoint-initdb.d`) — only on a **fresh** volume.
- Automatically by the Helm Job on install / upgrade (loops every file in
  `files/*.sql`, lexical order, ON_ERROR_STOP=1).
- Manually via `make migrate`, which loops every `db/migrations/*.sql` in
  lexical order under `ON_ERROR_STOP=1` — the same thing the Job does, against
  an existing dev volume.

The set, in order:

| File                                 | Adds                                                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_init.sql`                      | auth/core/calc schemas: users, sessions, households, accounts, incomes, payments.                                                         |
| `0002_projects.sql`                  | Cross-account projects.                                                                                                                   |
| `0003_household_shares.sql`          | Contribution shares, shared/personal account + payment scope.                                                                             |
| `0004_reality_loop.sql`              | `core.contributions`, `core.balance_snapshots`, `core.transfer_confirmations`, `core.month_closes`.                                       |
| `0005_auth_hardening.sql`            | `auth.users.totp_secret`/`totp_enabled_at`, `auth.recovery_codes`, `auth.password_reset_tokens`.                                          |
| `0006_goal_modes_and_tags.sql`       | `core.payments.fixed_monthly_minor` and `core.payments.tag`.                                                                              |
| `0007_platform.sql`                  | `auth.users.notify_email` opt-in and `core.notification_log` (unique `(user_id, date, kind)`).                                            |
| `0008_inflows.sql`                   | `core.inflows` — money arriving with a source, so a movement between two of your own accounts is a first-class row rather than an income. |
| `0009_standalone_confirmations.sql`  | A transfer confirmation with no household: scoped by its two accounts, its month and the member.                                          |
| `0010_derived_confirmations.sql`     | A confirmation of a transfer the plan _derived_ — there is no authored row to hang it off.                                                |
| `0011_one_household_per_user.sql`    | One household per user, enforced in the database.                                                                                         |
| `0012_account_currency_is_fixed.sql` | An account is denominated once, at creation, and never re-denominated.                                                                    |
| `0013_user_month_closes.sql`         | `core.month_closes.user_id` + `.currency`: a close is per user, per currency (`MONTH-CLOSE.md` decision 14).                              |

All of them are idempotent (`IF NOT EXISTS` throughout), so re-running the Job
against an already-migrated database is a no-op.

Two of them drop a constraint, which nothing else in this directory is allowed
to do: `0010` and `0013`, each under a named exception recorded in the plan that
asked for it. Both re-add under the same name inside a guarded `DO $$` block,
and both files say at length why the name has to be held. Adding a third means
asking first.

Drift watch: the chart copies SQL files into
`deploy/helm/finance-planner/files/`. **Keep that mirror in sync with
`db/migrations/` — adding a migration and forgetting the copy ships a chart
that silently under-migrates** (0004–0007 were missing until they were
copied in). `diff -rq db/migrations deploy/helm/finance-planner/files` should
be empty. Adopting `drizzle-kit` for generated migrations is on the backlog.

### Secrets

Never commit real ones. `values.yaml` ships dev placeholders. Override via
`--set` / `-f` or (preferably) an external-secrets operator. The JWT key
must be the same for api and auth.

### Health

Every service exposes `GET /healthz` and `GET /readyz`, and both probes in the
chart point at **`/healthz`** — `values.yaml` sets one `health:` path per
service (`/` for web, `/healthz` for the three backends) and
`templates/services.yaml` renders it into the readinessProbe and the
livenessProbe alike, with reasonable initial delays.

**So `/readyz` is not wired to anything, and neither endpoint asks a question.**
`/healthz` returns a literal `status: "ok"` and `/readyz` a literal
`{ ready: true, checks: {} }` in all three services — nothing pings the
Postgres pool, nothing checks that api can reach auth. A pod with a dead
database therefore reports ready and takes traffic, and the `readinessProbe`
is a liveness check under another name. The `checks` map exists in the
contract to carry named results and has never carried one. Filed in
`BACKLOG.md`; the fix is not uniform across the three services, which is why
it is an entry rather than a one-line change.

### Scaling

HPA on CPU per service (`autoscaling` in values, default 70% utilisation,
min 2 / max 6 replicas). Deployments omit a static `replicas` when
autoscaling is enabled so they don't fight the HPA. Each service has a
PodDisruptionBudget with `minAvailable: 1`.

> **auth must stay at one replica.** `values-prod.yaml` pins
> `services.auth.replicas: 1`, and autoscaling must stay off for auth. The
> service keeps a refresh-token rotation grace window **in process** — a short
> memory of the token it has just replaced, so a retried or concurrent refresh
> is not mistaken for token theft. A second pod has no such memory: a refresh
> that lands on it looks like a presented-but-revoked token, reuse detection
> fires, and **every session for that user is revoked** — the reload-logout bug,
> back again and now load-balancer-dependent, so it will reproduce roughly half
> the time and never in a one-pod dev stack. Lift the constraint only once the
> rotation link lives on the session row (see BACKLOG), or put sticky routing in
> front of `POST /api/auth/refresh`.

### Auth-specific

- Per-route rate-limit (`@fastify/rate-limit`), per IP: register 3/min, login
  5/min, TOTP step-up 10/min, TOTP setup/enable/disable 10/min, forgot-password
  3/min, reset 5/min, account deletion 3/min, refresh 20/min.
- Refresh tokens rotate on use. A presented-but-revoked token triggers
  **reuse detection**: every active session for the user is revoked and the
  client must re-login. Surfaced as `401 reuse_detected`.
- A rotated token is forgiven for a short grace window, held in an **in-process
  `Map`** — which is what makes the auth service stateful and pins it to one
  replica (see Scaling above).
- Account access uses a 404-not-403 leak rule: no access at all returns 404
  (preserves existence privacy), insufficient permission returns 403.
- TOTP is optional per user. Enrolment issues single-use recovery codes;
  step-up is required at login once enabled. OIDC logins deliberately skip the
  step-up — the provider owns that factor.
- Password-reset tokens are valid for one hour and are consumed on use.

### Notifications

The daily digest ("due in the next 7 days" + "transfers for the next 7 days")
is sent by the **api** service to users who opted in with
`PATCH /api/auth/me {"notifyEmail": true}` — off by default, nobody is mailed
who didn't ask.

- **In-process, not a CronJob.** `NOTIFY_ENABLED=true` starts a **15-minute
  ticker** inside the api process (`apps/api/src/notify.ts`). It is unref'd, so
  it never holds the process open, and it's torn down on Fastify `onClose`.
- **Hour gate.** A tick does nothing until the process's **local** hour has
  reached `NOTIFY_HOUR`. It's a lower bound, not a target time — the first tick
  at or after the hour sends, and a process started at 23:00 still sends that
  day. Containers set no `TZ`, so local is UTC unless you set one; the digest
  is keyed by UTC date, so the two only agree when the container is UTC.
- **Dedupe.** Before building a digest the sender claims a row in
  `core.notification_log` with `INSERT … ON CONFLICT DO NOTHING` on the unique
  key **`(user_id, date, kind)`** (kind is `daily_digest`) and only mails if it
  won the row. Restarts, redeploys, and slow ticks therefore can't double-send.
  A claimed-then-crashed run loses that day's digest rather than repeating it.
- **Single-replica assumption.** The ticker runs in **every** api replica that
  has the flag on, and there is no distributed lock — the unique key is the only
  cross-process safety. Enable `NOTIFY_ENABLED` on exactly one replica; the
  chart's `serviceEnv.api` sets it for the whole Deployment, so scaling api out
  with it on means N replicas racing on the same INSERT. Harmless, but wasteful.
- A user with nothing due and no transfers gets no mail (the slot is still
  claimed).

### Demo seed

`ENABLE_DEMO_SEED=true` exposes `POST /api/demo/seed`, which plants a worked
example into an **empty** account so a fresh install has something to look at:
one current account, a salary, four bills (one of each recurrence shape), a
contribution, and a balance snapshot, all dated relative to today.

- Requires a bearer token — an unauthenticated caller gets 401, not 404.
- 404s while the flag is off, deliberately rather than 403, so an install
  without it doesn't advertise the route.
- 409 `demo_not_empty` if the caller already owns any account.
- `GET /api/meta` is public and returns `{"demoSeedEnabled": bool}`; the SPA
  uses it to decide whether to offer the button on an empty Overview.

Leave it off outside demo installs.

### Data portability and erasure

- `GET /api/export` streams a JSON document (`version: 1`) as a file
  attachment: **owned accounts only**, with their incomes, movements between
  the exporter's own accounts, payments (each with its contributions) and
  balance snapshots; plus owned projects; plus the exporter's **month closes at
  the file's top level**, one row per month per currency. Closes sit there
  rather than under an account because that is where the fact lives — a close
  scores one person across every account they plan in (`MONTH-CLOSE.md`
  decision 14), so there is no account to hang it off. Accounts merely shared
  _with_ the caller are excluded on purpose — they belong to their owner, and
  exporting them would hand one household member a copy of another's finances.
  Household memberships, shares and **household** transfer confirmations are
  likewise not in the document: they describe an arrangement between people.
  The exporter's own standalone confirmations do travel — both the kind that
  rides on an authored movement and the kind confirming a transfer the plan
  derived — because "I moved this money" between two accounts you own is a fact
  about your own rows, and dropping it let a restore silently un-move money
  that moved.
- `POST /api/import` takes that same schema and is **additive**: every row is
  created fresh under the importing user. Nothing is matched, overwritten, or
  deleted, so importing the same file twice gives two copies. Project and
  bearer references are dropped (the document doesn't carry those ids), and a
  close for a `(month, currency)` already closed is skipped rather than
  erroring. A file that doesn't match the schema is a 422.
- The version did **not** move for the close relocation. A file written before
  it carries its closes inside `accounts[]`, where the schema drops them as
  unknown keys — a loss of nothing, because no close row was ever written by a
  shipped scope (decision 17). An old backup still restores, minus a scorecard
  nobody had.
- `DELETE /api/auth/me` erases the account: **owned** accounts (and everything
  under them), owned projects, households the user founded, their memberships
  of other people's households, sessions, tokens, recovery codes,
  notification-log rows, and their month closes — which hang off no account and
  so are deleted by name rather than cascaded — then the user row. Accounts and households owned by
  _other_ people survive. Rate limited to 3/min. The current password is
  required unless the user has none (SSO-only), where the access token is the
  proof. Refresh cookie is cleared; responds 204.
- **Deleting a household founder changes other people's projects, and this is the
  one place the blast radius reaches past the caller.** Deleting a founded
  household runs the departure cascade for **every** member, not just the leaver
  (`Store.deleteHousehold` calls `dissolveMembershipBenefits` per member —
  decision 23, `MINE-AND-OURS.md`). So each surviving member's **shared** projects
  flip back to `personal` and drop their payments on accounts they do not own,
  and every account share into that household goes with its shared-project links.
  Nothing of theirs is deleted — a project they own stays theirs, and their
  payments on their own accounts survive inside it — but a project changes shape
  and loses links because somebody _else_ closed their account. That is the
  intended rule ("you do not keep the household's benefits once the household is
  gone"), and it is irreversible: re-founding a household does not re-share the
  projects or restore the dropped links. Warn the member before running this for
  a founder, and expect support questions from people who did nothing.

### Logs

Structured JSON (Pino). Centralised log aggregation isn't wired — adding a
Loki / ELK sink is on the backlog. For dev, `make logs` tails the compose
stack.

With `OTEL_ENABLED=true` every Pino line also carries `trace_id`, `span_id` and
`trace_flags`, injected into Fastify's internally-constructed logger with no
app code involved. **That is the field to join on across services.** Do not join
on `reqId`: Fastify 5's default `requestIdHeader` is `false`, so `reqId` is a
per-process counter that starts at one in every service. In a captured
two-process login, api and auth both called the same request `req-4` — which is
worse than a mismatch, because it invites a join that is silently wrong the
moment the counters drift.

### Tracing

`make up-otel` starts the local collector and turns tracing on; `make logs-otel`
prints every span it receives. In a cluster, set `tracing.enabled` and
`tracing.endpoint` in values — there is no collector in the chart, so point it
at one you already run.

**When no spans arrive, read this first: a refused collector is completely
silent.** The service starts, serves 200s, produces spans, and never says that
none of them reached anywhere — the symptom of a wrong endpoint and the symptom
of a working one are the same thing on stdout. That is deliberate (tracing must
not take the service down with it) and it means the absence of errors proves
nothing. In order:

1. Set `OTEL_LOG_LEVEL=debug` on one service and restart it. The exporter's
   failures are then printed. `.env.example` ships the line commented out for
   exactly this.
2. Check the endpoint is a **bare origin** if you used the generic variable, and
   a full `/v1/traces` URL if you used the per-signal one. Getting these the
   wrong way round drops every span silently — see §1.
3. Confirm the service is enabled at all: `OTEL_ENABLED` must be the literal
   string `true`. An enabled service with no endpoint does not start, so a
   running service that emits nothing is enabled-and-exporting-nowhere or not
   enabled.
4. Give it time before concluding. `BatchSpanProcessor`'s default delay is
   5000 ms; a single poll immediately after a request legitimately sees nothing.

**What a healthy trace looks like across the hop.** One trace spans api's server
span, api's undici client span and auth's server span, with auth's server span
naming api's client span as its **parent** — the `traceparent` header rides the
proxy without a hook, because `@fastify/http-proxy` forwards through undici and
the undici instrumentation injects it. `pg` spans nest under the api request
that issued them, and `http.route` is set on server spans so grouping works.
A shared trace id alone is not the assertion; `otel-smoke` checks the parent
link for the reason given above about `req-4`.

Shutdown flushes the SDK on SIGTERM and SIGINT — without that, a container
stopped a second after a request exported **zero** spans rather than a lost
tail, because the OTLP HTTP exporter does not flush on exit. The handler exits
without draining in-flight HTTP requests, exactly as the services did before it
existed; see `BACKLOG.md`.

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
