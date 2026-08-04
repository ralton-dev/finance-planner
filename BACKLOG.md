# Backlog

Things we intentionally didn't build. Not a roadmap — just an honest list of
acknowledged gaps so a future contributor doesn't think the silence is
endorsement.

## Product

- **SHIP-BLOCKING — a household plan cannot see money leaving the household, and
  overstates what its accounts hold.** `HouseholdAccountInput`
  (`packages/domain/src/household.ts:38`) carries `incomes` and `payments` and
  has no word for inflows; `buildHouseholdInput` (`apps/api/src/plan.ts:694`)
  fills it with `externalOf(inflows)`, so an authored movement _out_ of a
  household account into an account outside the household is invisible to the
  household engine. Measured in a browser on the same account: **left over
  £2,793** on the household plan page against **£2,093** on the flow diagram —
  the difference is exactly the movements the household plan has never heard of.
  Four things make this urgent rather than a nit:
  - **The error runs in the dangerous direction.** The household page overstates
    the money in an account. An understatement is a nuisance; an overstatement
    is a household spending money that is already committed.
  - **This work created the exposure.** Account-sourced inflows did not exist
    before it, so a household plan could not be wrong about them. The
    source-account picker offers any account the caller can edit, household-
    assigned ones included, so authoring one movement out of a household account
    is enough to trigger it. Reachable through the UI, not theoretical.
  - **It is the original defect with the arrow reversed.**
    `HOUSEHOLD-CONTEXT.md` opens with "an account assigned to a household is
    planned twice, by two engines that never speak". This work fixed household →
    account, the pot that could not see its funding, and left account →
    household. The remedy is the same class: fix it in the plan, never in
    presentation (`INFLOWS.md` decision 2 — two sources of truth is the defect
    being avoided).
  - **There was an early warning.** WP-B reported that
    `packages/domain/src/household.ts:420` computes a second, structurally
    different `leftoverMinor` — `income + tin - tout - fout` — from the engine's,
    and judged it pre-existing and out of scope. It was, and the judgement was
    right at the time; it stopped being harmless the moment movements became
    authorable. That line is where the reconciliation has to start.

  Fixing it needs a decision about what a household plan _means_ once its
  accounts can send money outside it — is an outbound movement an obligation of
  the household, or of the member who authored it? **A new plan is being written
  for this.** It is not loose work to be picked up piecemeal.

- **The household projection is blind the same way.**
  `computeHouseholdProjection` (`packages/domain/src/projection.ts:584`) takes
  the same `HouseholdInput`, so every simulated month inherits the entry above:
  the household forecast ignores every authored movement, while
  `computeEstateProjection` beside it re-plans them each month. Two forecasts of
  the same accounts therefore disagree for the same reason the two plans do.
  Fix the input shape and this follows.
- **An account in two households is planned by whichever assigned it first.**
  `householdPlanningAccount` (`apps/api/src/plan.ts:203`) looks from the account
  outwards — the households its owner belongs to, then the households it is
  shared into — and takes the first that has actually assigned it a role. That
  is deterministic but arbitrary: an account genuinely assigned in two
  households gets one of them, and the other's allocation never reaches its
  plan. `GET /api/flow` inherits it through `householdAllocations`
  (`apps/api/src/plan.ts:517`). Fixing it means deciding what two allocations
  into one account add up to — a product question, not a lookup bug.
- **Saved flow scopes are browser-local.** `apps/web/src/lib/scopes.ts` keeps
  named scopes in `localStorage` beside the theme and the privacy toggle,
  because a scope decides how you are looking rather than anything about
  anyone's money. Server persistence — a `0010_` migration, a `flow_scopes`
  entity with Memory + Pg + contract parity, CRUD routes, export/import coverage
  — was deliberately not built: the scope already survives in the URL, so this
  buys cross-device sync and nothing else. The honest consequence today is that
  a scope you want to keep is one to bookmark.
- **Imported confirmations lose the tie to their contributions.**
  `apps/api/src/portability.ts` imports a transfer confirmation, and the
  contributions it once created arrive separately under the payments they were
  booked against with `transferConfirmationId: null`, as every imported
  contribution does. Both facts survive the trip; the link between them does
  not, so un-confirming an imported movement leaves its imported contributions
  where they are rather than taking them with it. The import site says so in a
  comment. Relinking needs the import to match contributions back to the
  confirmation that produced them, and nothing in the file identifies that
  today.
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
  reference — today it is derived fresh on every read. A movement between two
  accounts you own is monthly for a different and deliberate reason: it carries
  no date at all (`apps/api/src/notify.ts:47`), because it says only that it
  happens each month and inventing a day would be a fact the plan does not hold.
  Any per-slice design has to answer both cases, not just the household one.
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
  currency rather than a total. There is no rate anywhere in the system, so
  everything that would need one is now refused rather than guessed: a movement
  between two accounts in different currencies is a 422 naming the pair (and the
  source picker never offers one), and a flow diagram spanning currencies is a
  422 too. Adding FX = a rates source + a per-user display-currency preference,
  and those three refusals become the places it plugs in.
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
  import/export, authoring a movement, the flow diagram and its scopes) have
  browser-level coverage; they're tested at the unit and service level only.
  Several of those were driven by hand against a real API in Chromium at 1280
  and 390 while they were built, which is exactly the evidence a spec file would
  have kept.
- **`TransferChecklist` is household-shaped in three independent ways.**
  `apps/web/src/components/TransferChecklist.tsx:43` renders a **who** column
  keyed on household members, detects orphan confirmations with a
  `fromAccountId|toAccountId|memberUserId` key, and ends in a `PaydayPlan`
  section that has no standalone analogue at all — a movement carries no date,
  decided deliberately at `apps/api/src/notify.ts:47`. Two packages
  independently judged generalising it _not contained_ and routed around it
  instead, so the Overview derives its standalone movement rows separately.
  Booking it means answering two design questions rather than doing a
  refactor: what the "who" column says for a movement between two accounts one
  person owns, and what replaces the payday breakdown when there is no payday to
  anchor to.
- **`listAccountConfirmations` has no consumers.** `apps/web/src/lib/api.ts:437`
  wraps `GET /api/accounts/:id/transfers/confirmations` — the read that answers
  "what moved into or out of this account", household or not, and which the API
  tests exercise — and nothing in the app calls it.
  `apps/web/src/pages/HouseholdPlanPage.tsx:34` still reads confirmations with
  `listTransferConfirmations(householdId, month)`, which can only ever describe
  movement inside one household. Either wire the account-scoped read up or
  delete the method; a typed, unused client method is a claim the app does not
  make.
- **`packages/domain/src/projection.ts` is invisible to `grep` and `rg`.** It
  contains a literal NUL byte at offset 22393 — a deliberate key separator in
  the template literal at `lineKey()`, line 571 — so `grep` skips the file
  silently (exit 1, no output at all) and `rg` prints `binary file matches`
  instead of the lines. Searching it needs `grep -a` / `rg --text`, and nothing
  tells you that until you notice the projection engine never appears in any
  result. It has already cost one contributor time. Swapping the separator for
  an ordinary character removes the trap.
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
