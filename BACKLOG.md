# Backlog

Things we intentionally didn't build. Not a roadmap — just an honest list of
acknowledged gaps so a future contributor doesn't think the silence is
endorsement.

## Product

- **Household plan — effective-dated contribution shares.** A member's share is
  a single current value (`household_memberships.contribution_share_bp`). The
  planner is forward-looking, so changing 60/40 → 66/34 just updates the split
  from now on; past splits aren't retained. Storing dated rows + resolving the
  active one at `asOfDate` would add history (pairs with the share-change audit
  log below).
- **Household plan — multi-currency households.** `computeHouseholdPlan` assumes
  one currency across a household's accounts (it labels output with the first
  account's currency). Mixed-currency households need the FX work below first.
- **Household plan — shared-pot income.** Income on a _shared_ account is
  uncommon and currently accumulates as pot surplus rather than reducing each
  member's contribution. If joint accounts start receiving income directly,
  offset it against the pot's funding need before splitting.
- **Household plan — bearer picker in quick-add.** A personal expense's bearer
  is settable per-payment in the engine/API (`bearerUserId`), but the quick-add
  drawer only exposes the shared/personal toggle and defaults a personal expense
  to the owning member of its account. A member dropdown would cover "personal
  expense on a shared account, borne by X".
- **What-if preview for households.** `POST /api/accounts/:id/plan/preview`
  overlays hypothetical payments/incomes on one account. There is no household
  equivalent: a household overlay has to say which account each hypothetical
  lands in and who bears it, then re-derive the transfers — a design question of
  its own rather than a second call site for the account version.
- **Transfer confirmations are monthly, not per-payday.** A confirmation covers
  a whole planned transfer for the month; the payday schedule underneath it is
  display-only, so you can't tick off "the first half, paid on the 15th".
  Per-slice confirmations would need the schedule to be stable enough to
  reference — today it is derived fresh on every read.
- **Upcoming feed skips undated recurring bills.** `packages/domain/src/upcoming.ts`
  needs a calendar day to pin a row to, so a `monthly_recurring` (or yearly, or
  custom) payment with no `dueDate` never appears in the digest or the Overview
  card. It still counts in the plan as a monthly cost. Inferring a day (from
  first contribution? account payday?) is the obvious fix and deliberately not
  guessed at.
- **Lump-sum / windfall allocation.** Split a one-off inflow across goals by
  priority. Not built — contributions are recorded one payment at a time.
- **Email verification enforcement.** Tokens are issued on register and
  `POST /auth/verify-email` works, but login doesn't block unverified users
  (`apps/auth/src/server.ts` checks the password hash and nothing else).
- **Multi-currency FX.** Accounts are single-currency; overview groups per
  currency without conversion, and the net-worth chart draws one line per
  currency rather than a total. Adding FX = a rates source + a per-user
  display-currency preference.
- **Audit history UI.** No surface for "who changed this share / role / amount".
- **Project breakdown on the Overview page.** Projects render on `/projects`
  only; the Overview never aggregates them.

## Platform / ops

- **QR code for TOTP enrolment.** `POST /auth/totp/setup` returns the secret and
  an `otpauth://` URI, and Settings renders both as copyable text. Nothing on
  screen is actually scannable — enrolment means pasting the URI or typing the
  secret. Rendering the URI as a QR needs a generator dependency (or a
  hand-rolled encoder) that hasn't been taken on.
- **Auth is stateful, so it cannot be scaled out.** Refresh-token rotation keeps
  a short grace window for the token it has just replaced in an **in-process
  `Map`** (`apps/auth/src/server.ts`), so a retried or concurrent refresh is not
  read as token theft. At one replica that is correct; at two, a refresh landing
  on the other pod trips reuse detection and revokes every session for that user
  — the reload-logout bug returning, load-balancer-dependent and invisible in a
  one-pod dev stack. `values-prod.yaml` therefore pins `auth.replicas: 1` and
  autoscaling must stay off for auth. The fix is to move the link onto the
  session row — a `rotated_to_session_id` column plus a rotated-at timestamp, so
  any pod can follow the chain — or, as a stopgap, sticky routing in front of
  `POST /api/auth/refresh`.
- **Notification scheduler assumes a single api replica.** The digest sender is
  a 15-minute `setInterval` inside the api process, not a CronJob or a queue.
  There is no leader election or distributed lock — the unique
  `(user_id, date, kind)` key on `core.notification_log` is the only thing
  stopping a double-send, and it is a constraint, not a lock. Scaling api out
  with `NOTIFY_ENABLED=true` means N replicas racing on the same INSERT.
- **Redis caching + nightly recompute CronJob.** Redis is provisioned but the
  caching/queue path isn't required yet (plans recompute on read).
- **Observability stack.** Prometheus + Grafana + Loki + OpenTelemetry — none
  wired. Services already log structured JSON (Pino).
- **DB backups.** No `pg_dump` CronJob for non-prod; prod is left to whichever
  managed-Postgres provider you point the chart at.
- **Live-cluster CD.** CI builds, tests, and renders the chart; the actual
  `helm upgrade` against a real cluster is intentionally **not** automated —
  it needs credentials that aren't committed. Plug into your CD with provider
  auth when ready.
- **NetworkPolicies.** The chart doesn't ship them — any pod in the cluster
  can reach auth and calc directly today.
- **Image scanning + SBOM + signing.** No Trivy, no syft, no cosign. CI
  builds images but doesn't scan or sign them.
- **drizzle-kit migrations.** SQL is hand-written and applied in lexical order,
  and the chart carries its own copy under `deploy/helm/finance-planner/files/`
  that has to be kept in sync by hand (it has drifted before). Adopting
  `drizzle-kit generate` would let the schema drive the SQL; templating the
  ConfigMap from `db/migrations/` directly would remove the mirror.
- **Helm migration Job runs as `post-install`/`post-upgrade`.** App pods start
  before migrations succeed and flap readiness for a few seconds. Switching to
  `pre-install`/`pre-upgrade` would gate the rollout properly.
- **Audit log of role + share changes.** Plan called for one; not wired.

## Internal / code quality

- **E2E coverage is one smoke test.** `apps/web/e2e/smoke.spec.ts` loads the SPA
  and checks it renders — that's the whole suite. None of the flows shipped
  since (contributions, check-ins, transfer confirmations, 2FA enrolment,
  import/export) have browser-level coverage; they're tested at the unit and
  service level only.
- **Inline edit affordance for amounts.** Today changing an income/payment
  amount opens the full drawer; a click-to-edit on the row would be slicker.
  Same for moving a payment to a project or another account — both work in the
  edit drawer, neither has a row-level action on the Account page.
- **CASL.** The `packages/policies` module mimics the can/cannot shape; if
  the rules get more conditional (status-based, ownership-based across new
  subjects) we'd swap to `@casl/ability`.
- **Frontend permission flags.** UI hides edit actions based on
  `account.permission` / `household.yourRole`. Duplicates the server-side
  policy. A single shared client+server CASL ability would fix the drift risk.
