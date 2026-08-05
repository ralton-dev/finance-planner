# Backlog

Things we intentionally didn't build. Not a roadmap — just an honest list of
acknowledged gaps so a future contributor doesn't think the silence is
endorsement.

## Product

The first three entries are **defects the one-engine work created**, not polish.
Each was found in source by the agents that built the scope pass and verified
again when it closed ([`ONE-ENGINE.md`](./ONE-ENGINE.md)). A follow-up package is
expected to take them together: they touch the same DTOs and the same pass, and
picking this class of thing up piecemeal is how the two-engine split survived a
whole plan.

- **`householdPlanFromScope` mixes two scopes in one response.**
  `packages/domain/src/household.ts:214-228`: `members` comes straight off the
  partition, so a member's `obligationMinor`, `fundedMinor` and
  `shortfallMinor` are **whole-scope** figures, while `lines`,
  `totalRequiredMinor` and `totalFundedMinor` are restricted to the household's
  own accounts. Measured in a browser: a person's costs exceeded everything the
  cost breakdown could explain, and the unexplained tail painted red on a month
  with a shortfall of zero. WP-T patched the symptom where it showed
  (`elsewhereMinor` in `apps/web/src/lib/tags.ts`, quiet and never red); the DTO
  still publishes two scopes side by side without saying which is which. Fixing
  it means deciding what a member's obligation _means_ when the same pass funds
  their bills on an account this household cannot see — restrict the figure, or
  publish both and name them.
- **`confirmedInflowMinor` conflates two questions.**
  `packages/domain/src/scope.ts:802-803` adds derived-transfer confirmations and
  authored-arrival confirmations into one total, and `accountPlanFromScope`
  (`packages/domain/src/engine.ts:216-224`) tests each line's
  `fundedFromInflowMinor` against a running sum of it. So confirming an authored
  movement into a pot can flip a line actually fed by an **unconfirmed** derived
  transfer from `awaiting_transfer` to `funded` — amber to green on money nobody
  has moved. The two kinds of arrival need separate totals, and a line's status
  needs to ask about the one that funded it.
- **One member vector per scope.** `computeScopePlan`
  (`packages/domain/src/scope.ts:421-423`) holds a single ordered list of members
  with one share weight each, and `scopeMembers` (`apps/api/src/plan.ts:476`)
  unions the rosters of every household the scope closed over. Two households
  joined into one connected component by a single authored movement between
  their accounts therefore get **both** rosters, and a `scope: "shared"` payment
  splits across all of them, including people with no claim on it. No fixture
  reaches it today. The fix is per-payment share weights inside the pass rather
  than one vector for the whole scope; it pairs with the two-households entry
  below.
- **Cosmetic, and pre-existing: a household's transfer table can name an account
  it cannot see.** `householdPlanFromScope`
  (`packages/domain/src/household.ts:269-276`) keeps a transfer with _either_ end
  inside the household but publishes only the household's own accounts, so a
  transfer whose far end sits outside renders as "Ben → account £303.20" in
  `TransferChecklist` and in `needsYou`. Either carry the far end's name — it is
  another household's business, so probably not — or say plainly that the money
  leaves.
- **An account in two households is planned by whichever assigned it first.**
  `householdPlanningAccount` (`apps/api/src/plan.ts:253`) looks from the account
  outwards — the households its owner belongs to, then the households it is
  shared into — and takes the first that has actually assigned it a role. That
  is deterministic but arbitrary: an account genuinely assigned in two
  households gets one of them, and the other's sharing rules never reach it. The
  scope loader takes that answer, so every surface reading the pass inherits it.
  Fixing it means deciding what two sets of sharing rules over one account add
  up to — a product question, not a lookup bug.
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
- **A derived transfer you confirmed does not survive an export.**
  `apps/api/src/portability.ts:95-99` skips every confirmation without an
  `inflowId`, and the export schema hangs confirmations off
  `exportAccountInflow` (`packages/contracts/src/index.ts:462-481`) — an
  authored movement. A confirmation of a transfer the _pass_ derived has no
  authored row to hang on, so "I moved the money" for a pot fed automatically is
  dropped on the way out and the restore reads `awaiting_transfer` for a month
  that was settled. Carrying it needs a new top-level field on the export
  schema, keyed the way the confirmation itself is: two accounts, a month and a
  member.
- **Household plan — effective-dated contribution shares.** A member's share is
  a single current value (`household_memberships.contribution_share_bp`). The
  planner is forward-looking, so changing 60/40 → 66/34 just updates the split
  from now on; past splits aren't retained. Storing dated rows + resolving the
  active one at `asOfDate` would add history (pairs with the share-change audit
  log below).
- **Household plan — multi-currency households.** The pass partitions by
  currency and plans each partition on its own (`ONE-ENGINE.md` decision 10), so
  nothing derived crosses a currency and every figure is honest as far as it
  goes. `scopeForHousehold` (`apps/api/src/plan.ts:571`) then picks one
  partition — the currency of the roster's first account — and
  `householdPlanFromScope` reports that one, so a household whose accounts span
  two currencies has the rest silently absent from its plan. Presenting one
  needs the FX work below first.
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
  no date at all (`apps/api/src/notify.ts:49`), because it says only that it
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

  The sharpest instance to date, because it is not a hypothetical: `1409e5f`
  deleted the six account- and household-scoped close routes
  (`MONTH-CLOSE.md` decision 14) while `apps/web/src/lib/api.ts` still called
  all six. The account page and the household plan page therefore fetched 404s
  on load, and **CI stayed green through it**. It could not have gone
  otherwise: no job in the matrix drives a real browser against a real API, so
  a client method pointing at a route that no longer exists is invisible to
  every one of them. Only opening the page found it, and the next package
  restored the pages a commit later. A single spec that logs in, opens an
  account and opens a household would have caught it, and is the smallest
  version of this entry worth doing first.

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
- **Two DTOs make the web layer re-derive figures the pass already holds.**
  `HouseholdAccountPlan` (`packages/domain/src/household.ts:85`) carries no
  `movementInMinor`, and `AccountPlan` (`packages/domain/src/types.ts:224`) no
  `transferOutMinor`, though `ScopeAccountPlan` computes both. So `arrivingMinor`
  (`apps/web/src/lib/flow.ts:123`) and `derivedTransferOutMinor`
  (`apps/web/src/components/AccountMovements.tsx:436`) rearrange each plan's
  published identity to recover them. Both are correct, both say in a comment
  that carrying the field directly would be better, and both are a place where a
  future change to the identity breaks a caller silently rather than at the type
  level.
- **`NewMonthClose` cannot require what a close actually needs.**
  `packages/data/src/store.ts:100` makes `userId` and `currency` optional
  (`Omit<…> & Partial<Pick<…>>`) because the Store still admits three scopes,
  and `packages/data/src/store-contract.ts` writes the two legacy ones at seven
  of its thirteen `createMonthClose` sites. Nothing else writes them:
  `MONTH-CLOSE.md` decision 14 deleted both location-scoped endpoints, their
  handlers, the client methods and the UI, so the only producer of a household
  or account close left in the repository is the contract test proving the
  Store can still produce one. Tightening the type is therefore not a type
  change — it means first deciding **whether the Store keeps the legacy scopes
  at all**, which is a schema question (`month_close_scope` admits three since
  `0013`), a migration question (`0013` was additive on purpose), and a
  portability question (the export carries user closes only). Until that is
  answered the optionality is honest: it describes a Store deliberately wider
  than the product.
- **`core.month_closes` is mixed on referential integrity.** `account_id`
  references `core.accounts` (`0004`) and `user_id` references `auth.users`
  (`0013`), both `ON DELETE CASCADE`. `household_id` and `closed_by` are bare
  `uuid` columns with no foreign key, and never had one — so a deleted
  household or a deleted actor leaves a close pointing at a row that is gone,
  and only the application knows. The cross-schema precedent exists
  (`user_id` → `auth.users`, and `core.notification_log.user_id` before it), so
  the objection is not technical. Both stores delete a user's own closes by
  name in `deleteUserCascade`, which is why nothing has been observed; the gap
  is what happens to the two legacy scopes, and it pairs with the question
  above — deleting the household scope would retire one of the two columns
  rather than give it a key.
- **`MemoryStore.deleteAccount` leaves contributions Postgres would cascade.**
  `packages/data/src/memory-store.ts:486-488` drops every transfer confirmation
  touching the account, but only deletes contributions whose own `accountId` is
  the account — so a contribution sitting on a _third_ account and carrying the
  `transferConfirmationId` of a deleted confirmation survives, pointing at
  nothing. `PgStore` gets it for free from
  `core.contributions.transfer_confirmation_id … ON DELETE CASCADE`
  (`db/migrations/0004_reality_loop.sql:37`). Pre-existing; the contract test
  does not reach it because nothing in it books a contribution against a third
  account.
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
