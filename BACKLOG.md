# Backlog

Things we intentionally didn't build in v1. Not a roadmap — just an honest list
of acknowledged gaps so a future contributor doesn't think the silence is
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
- **Auto-accumulating contributions ledger.** `Payment.alreadySavedMinor` is a
  manual field today. The intended replacement: a `core.contributions` table
  recording per-month allocations, with `alreadySavedMinor` becoming a derived
  view. Affects `packages/domain/src/engine.ts` (would consume a derived value
  instead of a raw one).
- **Notifications.** Goal-at-risk, payment-due. No transport, no scheduler.
- **Real SMTP mailer.** Only `LogMailer` is wired — registration emails go to
  stdout. The `Mailer` interface in `apps/auth/src/mailer.ts` is shaped for a
  drop-in `SmtpMailer`.
- **Email verification enforcement.** Tokens are issued on register and the
  verify endpoint works, but login doesn't block unverified users.
- **Password reset flow.** Not implemented; piggy-backs on the SMTP mailer.
- **OIDC / social sign-in.** Schema already allows `password_hash` to be null,
  so the data layer is ready.
- **Multi-currency FX.** Accounts are single-currency; overview groups per
  currency without conversion. Adding FX = a rates source + a per-user
  display-currency preference.
- **"What-if" simulation.** Add a hypothetical payment and preview the impact
  without persisting.
- **Lump-sum / windfall allocation.** Split a one-off inflow across goals by
  priority.
- **Data export / import + GDPR erasure flows.** Schema uses cascading deletes
  so erasure is feasible; the UI + retention policy aren't built.
- **Audit history UI.** No surface for "who changed this share / role / amount".
- **Move existing payment to a project.** Today projectId is set-at-create;
  no row-level "move to project" action on the Account detail page.
- **Project breakdown on the Overview page.** Projects render on `/projects`
  only; the Overview never aggregates them.
- **"What's due today" digest on Overview.** Payments coming up in the next
  N days aren't surfaced.

## Platform / ops

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
- **drizzle-kit migrations.** SQL is hand-written and applied in lexical order.
  Adopting `drizzle-kit generate` would let the schema drive the SQL.
- **Helm migration Job runs as `post-install`/`post-upgrade`.** App pods start
  before migrations succeed and flap readiness for a few seconds. Switching to
  `pre-install`/`pre-upgrade` would gate the rollout properly.
- **Audit log of role + share changes.** Plan called for one; not wired.

## Internal / code quality

- **Inline edit affordance for amounts.** Today changing an income/payment
  amount opens the full drawer; a click-to-edit on the row would be slicker.
- **CASL.** The `packages/policies` module mimics the can/cannot shape; if
  the rules get more conditional (status-based, ownership-based across new
  subjects) we'd swap to `@casl/ability`.
- **Frontend permission flags.** UI hides edit actions based on
  `account.permission` / `household.yourRole`. Duplicates the server-side
  policy. A single shared client+server CASL ability would fix the drift risk.
