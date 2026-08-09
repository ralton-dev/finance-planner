# Backlog

Things we intentionally didn't build. Not a roadmap — just an honest list of
acknowledged gaps so a future contributor doesn't think the silence is
endorsement.

## Product

The first three entries are what is **left** of four **defects the one-engine
work created**, each found in source by the agents that built the scope pass and
verified again when it closed ([`ONE-ENGINE.md`](./ONE-ENGINE.md)). Three later
plans took most of them where they showed on a screen — the fourth is gone
entirely, and the first two here are the residue of theirs, narrowed to the part
no surface depends on. That is the pattern to expect and the reason to re-read
an entry before working it: a backlog entry is dated evidence about the tree on
the day it was written, and the half of it that hurt a reader is the half that
gets fixed first.

- **`HouseholdMemberPlan.shortfallMinor` is the last figure published over two
  scopes without saying so.** This entry used to name four: a member's
  `obligationMinor`, `fundedMinor`, `committedMinor` and `shortfallMinor` all
  came straight off the whole-scope partition while `lines`,
  `totalRequiredMinor` and `totalFundedMinor` were restricted to the household's
  own accounts, so a person's costs exceeded everything the breakdown beneath
  them could explain. The first three took the "publish both and name them"
  option — `householdObligationMinor` / `elsewhereObligationMinor` and their
  funded and committed siblings (`packages/domain/src/household.ts:101-156`),
  each pair summing to the pass's figure, which is what lets the page reconcile.
  `shortfallMinor` (`packages/domain/src/household.ts:467`) did not: it is still
  `m.shortfallMinor` verbatim, a whole-scope figure sitting beside two halved
  ones. It has never been observed wrong on a screen because a member short on
  the household's bills is normally short overall, and that is a coincidence
  about the fixtures rather than a property of the figure. Splitting it means
  first deciding what "short" _means_ restricted to one household when the same
  income funds bills the household cannot see — the same question the other
  three answered, on the one figure where the answer is not obviously additive.
- **`confirmedInflowMinor` still conflates two questions; nothing depends on it
  any more.** `packages/domain/src/scope.ts:979-980` adds derived-transfer
  confirmations and authored-arrival confirmations into one total. That used to
  be load-bearing: `accountPlanFromScope` tested each line's
  `fundedFromInflowMinor` against a running sum of it, so confirming an authored
  movement into a pot flipped a line actually fed by an **unconfirmed** derived
  transfer from `awaiting_transfer` to `funded` — amber to green on money nobody
  had moved. That half is fixed; the status test now asks
  `confirmedTransferMinor`, derived-transfer money only, and says at length why
  (`packages/domain/src/engine.ts:205-226`). What is left is a published field
  whose name promises one question and whose value answers two, with no caller
  relying on either reading — which is the state in which a field is cheapest to
  split and easiest to forget about until something new reads it.
- **One member vector per scope.** `computeScopePlan`
  (`packages/domain/src/scope.ts:185`, weighted at `:499`) holds a single ordered
  list of members with one share weight each, and `scopeMembers`
  (`apps/api/src/plan.ts:518`)
  unions the rosters of every household the scope closed over. Two households
  joined into one connected component by a single authored movement between
  their accounts therefore get **both** rosters, and a `scope: "shared"` payment
  splits across all of them, including people with no claim on it. No fixture
  reaches it today. The fix is per-payment share weights inside the pass rather
  than one vector for the whole scope; it pairs with the two-households entry
  below.
- **An account in two households is planned by whichever assigned it first.**
  `householdPlanningAccount` (`apps/api/src/plan.ts:285`) looks from the account
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
- **An estate whose accounts share a name can be backed up and not restored.**
  A name is the export file's only way of saying which account, so an import
  carrying a repeated one is refused outright (decision 29,
  `packages/contracts/src/index.ts`, `importBody`). The export stays permissive
  — two accounts really can be called "Savings", and the record of that is
  honest — so the pair is coherent but the user meets it at the worst moment:
  the refusal arrives at the restore, months later, naming a duplicate they must
  now fix in a file rather than in the product. Saying it at the export, where
  renaming is still easy, needs a warning on `GET /api/export` and somewhere on
  Settings to show it.
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
- **Multi-currency FX.** Accounts are single-currency and the overview groups
  per currency without conversion, so a person with two currencies reads two
  figures and never a total. There is no rate anywhere in the system, so
  everything that would need one is now refused rather than guessed: a movement
  between two accounts in different currencies is a 422 naming the pair (and the
  source picker never offers one), and a flow diagram spanning currencies is a
  422 too. Adding FX = a rates source + a per-user display-currency preference,
  and those three refusals become the places it plugs in.
- **Audit history UI.** No surface for "who changed this share / role / amount".
- **Project breakdown on the Overview page.** Projects render on `/projects`
  only; the Overview never aggregates them. Unaffected by a project now being
  personal or shared ([`MINE-AND-OURS.md`](./MINE-AND-OURS.md) decision 22) —
  that decided what a project _is_, not where it is totalled.

## Decided against, not deferred

Things that were built, shipped, and then deliberately removed. They are here so
nobody reads their absence as an oversight and rebuilds them.

- **Net worth is deleted, not fixed** (Ben, 2026-08-05,
  [`MINE-AND-OURS.md`](./MINE-AND-OURS.md) decision 21). The Overview carried a
  net-worth section and a per-currency chart built from balance check-ins. It
  summed over every account the caller could **see**, which on a household of
  two included a co-member's account shared into the household — so the headline
  figure on your own dashboard was partly somebody else's money. The fix and the
  deletion were costed against each other and the deletion won: a total across
  accounts you do not own answers no question a person actually has, and one
  built only over the accounts you own is the left over the page already prints.
  The section, the chart, `netWorthTotals`, `netWorthSentence`,
  `buildNetWorthSeries`, `seriesCurrencies`, `NetWorthChart`, the history fetch
  and every test naming a net-worth figure went with it.

  What deliberately **stayed**: `reservedMinor` on the wire, read by
  `apps/web/src/components/RealityStrip.tsx:27`, which is a legitimate
  per-account figure; `GET /api/accounts/:id/balances`; and balance check-ins
  themselves. A balance is a fact about a place. Only the roll-up over it was
  ever the problem, and rebuilding the roll-up is the thing this entry exists to
  stop.

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
- **Observability stack: metrics and log aggregation.** Prometheus, Grafana and
  Loki — none wired. **Traces are.** OpenTelemetry ships in every backend image
  behind `OTEL_ENABLED`, one trace spans the api → auth hop with auth's server
  span parented on api's client span, and every Pino line carries the
  `trace_id` of the request that produced it, so logs and traces already
  correlate ([`WHICH-HOP.md`](./WHICH-HOP.md), [issue #73](https://github.com/ralton-dev/finance-planner/issues/73)). What is
  missing is a metrics pipeline — the SDK's metrics and logs exporters are
  deliberately forced to `none` — and somewhere to send the logs.
- **`/readyz` asserts a readiness it never checked, and nothing probes it
  anyway.** All three services return a hardcoded `{ ready: true, checks: {} }`
  (`apps/api/src/server.ts:1164`, `apps/auth/src/server.ts:390`,
  `apps/calc/src/server.ts:50`), and `checks` is typed in
  `packages/contracts/src/index.ts` as a record built to carry named results
  that has never carried one. Worse, the chart never calls the endpoint:
  `values.yaml` sets a single `health:` path per service and
  `templates/services.yaml` points **both** the readinessProbe and the
  livenessProbe at it, so readiness is a liveness check under another name.
  `/healthz` is a literal `status: "ok"` while the contract allows
  `"degraded"`, so a pod with a dead Postgres pool reports ready and takes
  traffic. **The fix is not uniform**, which is why this is one entry and not
  one line: api needs a pool ping plus auth reachability — and `StoreHandle` is
  `{ store, close }` with **no ping**, so that is a new Store capability, with
  MemoryStore parity; auth needs store, mailer and its in-process JWT rotation
  state, because SAID-AND-DONE decision 33 makes a freshly-started replica
  genuinely not-ready in a way only auth knows; calc genuinely needs nothing
  and `ready: true` is honest there. Found independently by three packages of
  the tracing work.
- **A refused collector is completely silent.** With `OTEL_ENABLED=true` and an
  endpoint that nothing is listening on, `startTelemetry` resolves, the service
  serves 200s, spans are produced, and **nothing logs the failed export** at the
  default level. The symptom of a wrong endpoint and the symptom of a working
  one are identical on stdout. That the service survives is the intended half —
  tracing must not take the process with it — but the silence is not, and it was
  confirmed independently by four packages. `.env.example` ships a commented
  `OTEL_LOG_LEVEL=debug` as the escape hatch and `OPERATIONS.md` §3 makes it
  step one of the runbook; a real fix logs the first export failure once at
  `warn` without becoming a log flood.
- **The bulk `secretRef` puts every Secret key on every pod.** Each Deployment
  in `templates/services.yaml` does `envFrom: secretRef`, including the nginx
  `web` container, which has no use for any of them — so `JWT_SIGNING_KEY`,
  `DATABASE_URL`, `SMTP_URL` and `OIDC_CLIENT_SECRET` are all readable from a
  container that serves static files. Pre-existing and unchanged by the tracing
  work, which routed **around** it: the OTLP headers secret is read by
  `secretKeyRef` with `optional: true` so it lands only on the three backends.
  Closing it properly means splitting the Secret per service in
  `templates/config.yaml` and giving each Deployment its own reference.
- **The orphan `calc` service.**
  [Issue #76](https://github.com/ralton-dev/finance-planner/issues/76).
  `POST /internal/calc/account-plan` is calc's
  only route and it is referenced solely by calc's own test; api computes plans
  in-process through `packages/domain` and has never called it
  ([`WHICH-HOP.md`](./WHICH-HOP.md) decision 49). So a whole service, image,
  Deployment, Service, HPA and PDB exist for one caller that does not exist.
  It is instrumented and traced like the other two, which means it is ready on
  the day something calls it — but the honest options are to give it work or to
  delete it, and issue #73's stated "SPA → api → auth → calc" trace cannot be
  observed until one of those happens.
- **Graceful HTTP shutdown.** The SIGTERM/SIGINT handler added with tracing
  flushes the span exporter and then calls `process.exit(0)` **without closing
  Fastify**, so in-flight requests are dropped — exactly as they were before it
  existed, when the repository had no signal handler at all
  ([`WHICH-HOP.md`](./WHICH-HOP.md) decision 60). A correct drain needs the
  server handle, which a `--import` preload does not have, and it changes how
  every deploy behaves, so it was named rather than built. Do not let it grow
  an `app.close()` path inside the preload.
- **Browser / RUM instrumentation for `apps/web`.**
  [Issue #77](https://github.com/ralton-dev/finance-planner/issues/77).
  [Issue #73](https://github.com/ralton-dev/finance-planner/issues/73) put it out
  of scope deliberately. Today a trace begins at the api server span, so the
  first hop of a real user request — browser → nginx → api — is invisible, and
  the time a user waits is not the time any span measures.
- **`@opentelemetry/instrumentation-fastify` is deprecated** in favour of
  [`@fastify/otel`](https://github.com/fastify/otel), maintained by the Fastify
  authors. It is the sole reason `@opentelemetry/instrumentation@0.213.0` and
  `@0.221.0` both exist in the lockfile. **Kept deliberately:** `@fastify/otel`
  is a _plugin_, so adopting it means registering it in all three `server.ts`
  files, which destroys the zero-app-code premise the current instrumentation
  was chosen for ([`WHICH-HOP.md`](./WHICH-HOP.md) decision 55). Proven untidy
  rather than broken — one physical `import-in-the-middle` and one
  `require-in-the-middle` on disk, both bases resolving to the same realpaths,
  so Node keys them as a single singleton. The attribute that goes missing if
  that ever stops being true is `http.route`, and it goes missing silently.
- **`deploy/helm/finance-planner/Chart.yaml:6` says `appVersion: "0.0.0"`.** A
  fourth altitude telling the version lie the tracing work fixed at the other
  three. Inert today — nothing references `.Chart.AppVersion` — and owned by
  nobody, which is why it is here rather than fixed in passing.
- **What `otel-smoke` still cannot see.** The job is green and proves a trace
  crosses one process boundary; it is worth being explicit that this is less
  than it sounds, so a green tick does not get read as coverage. It runs two
  pods on one host rather than through a Service VIP, an ingress or a mesh
  sidecar, any of which can strip `traceparent`. It never restarts a service
  mid-request. A collector that is simply down would fail it as "0 spans",
  indistinguishable from a broken hop. **`calc` is entirely unasserted** — it
  gets the same preload and nothing makes it emit a span. The nginx → api and
  ingress → api hops, which are the real first hop of a user request, are not
  exercised at all. Nor is sampling.
- **DB backups.** No `pg_dump` CronJob for non-prod; prod is left to whichever
  managed-Postgres provider you point the chart at.
- **Live-cluster CD, and the image tag that names no build** —
  [issue #75](https://github.com/ralton-dev/finance-planner/issues/75). CI
  builds, tests, and renders the chart; the actual `helm upgrade` against a real
  cluster is intentionally **not** automated, because it needs credentials that
  aren't committed. The consequence has grown a second head: the chart now
  renders `APP_VERSION` and `service.version` from `.Values.image.tag`, on the
  argument that the image tag is the one version a container honestly has — and
  until something stamps that tag with a build, it stays `latest`.
  `values-staging.yaml` says images are SHA-tagged by CI one line above its own
  `tag: latest`. So `/healthz` reports `latest` where it used to report `0.0.0`:
  a different lie, not the absence of one, and it stops being one the moment
  this entry is done.
- **Auth rate-limits every caller as one client** —
  [issue #74](https://github.com/ralton-dev/finance-planner/issues/74). The
  per-route limiter keys on the peer IP, which for every request through the
  gateway is **api's** IP: there is no `keyGenerator`, no `trustProxy`, and no
  `x-forwarded-for` crosses the hop. The effective global limit is therefore
  `max × api replica count` and it moves with the HPA.
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

- **The api → auth proxy is exercised by no test in the repository.** Every case
  in `apps/api/src/server.test.ts` builds the gateway with
  `registerAuthProxy: false`, and the `e2e` job is the single smoke test above,
  so the one piece of the system that carries a session cookie across a process
  boundary is covered by nothing. `apps/api/src/server.ts:533-539` registers
  `@fastify/http-proxy` on bare defaults — `upstream`, `prefix`,
  `rewritePrefix`, no `rewriteHeaders` — which means header forwarding is
  entirely the library's behaviour rather than the repository's, and a change in
  it is invisible here. That is not hypothetical: `@fastify/http-proxy` 11.6.0
  was itself a security release whose headline fix was _"sanitize invalid
  characters in proxied response headers"_ (GHSA-7hrw-592w-9wh2,
  GHSA-mx7v-qhg9-2mvv), and the same refresh moved `undici` and `find-my-way`
  underneath it. Verified by hand on **2026-08-07** against the versions the
  dependency refresh brings — fastify 5.11.2, `@fastify/http-proxy` 11.6.0,
  `@fastify/cookie` 11.1.2, `undici` 7.29.0, `find-my-way` 9.7.0 — rather than
  the ones on `main` when this was written (5.8.5, 11.4.4, 7.26.0, 9.6.0),
  booting auth and api in one process over a shared `MemoryStore`: login through
  the proxy returns `set-cookie` whose name and
  every attribute match the response taken directly from auth
  (`fp_refresh; Max-Age=2592000; Path=/api/auth; HttpOnly; SameSite=Strict`);
  the proxied cookie then drives `POST /api/auth/refresh` to a 200 that rotates
  it; and logout returns the clearing cookie with `Max-Age=0` and an epoch
  `Expires`. A real test would assert those three things — that the attributes
  survive, that the cookie the client receives is _usable_ against the next
  proxied request, and that the clear comes back through the proxy too — because
  a proxy that drops `set-cookie` does not fail loudly. It 401s every
  navigation, which reads as an auth bug anywhere but here.
- **`createRemoteJWKSet` is reached only through a path whose tests replace
  it.** `packages/security/src/jwks.ts:24` builds the remote key set that
  verifies a third-party `id_token`, and its only caller is
  `apps/auth/src/oidc.ts:103`. Every auth test that touches SSO injects
  `deps.oidcClient`, so no test in the repository ever fetches a JWKS or
  verifies a real signature — the one place the product trusts a key it did not
  mint. `packages/security/src/security.test.ts` covers `tokens.ts` well
  (round-trip, wrong secret, expiry, and access-versus-pending separation) and
  stops at the symmetric case. The gap became worth writing down on
  **2026-08-07**, when the dependency refresh took `jose` **5.10.0 → 6.2.8** — a
  major that drops the Node crypto build for a single WebCrypto one — and
  typecheck and the whole suite passed without touching the untested path.
  (`main` is still on 5.10.0 as this is written.) Verified by hand at 6.2.8
  against a real RS256 key pair and a JWKS served over HTTP: the happy path
  returns the expected claims, the per-URI cache in `jwks.ts:9` holds so two
  verifications cost one fetch, a wrong `audience` and a wrong `issuer` each
  raise `JWTClaimValidationFailed`, and a token signed by a different key
  carrying a matching `kid` raises `JWSSignatureVerificationFailed`. A real test
  would assert those five, and the last is the one that matters — it is the
  difference between checking a token's shape and checking that it was signed by
  the provider.
- **`TransferChecklist` is household-shaped in three independent ways.**
  `apps/web/src/components/TransferChecklist.tsx:117` renders a **who** column
  keyed on household members, detects orphan confirmations with a
  `fromAccountId|toAccountId|memberUserId` key, and ends in a `PaydayPlan`
  section that has no standalone analogue at all — a movement carries no date,
  decided deliberately at `apps/api/src/notify.ts:74-78`. Two packages
  independently judged generalising it _not contained_ and routed around it
  instead, so the Overview derives its standalone movement rows separately.
  Booking it means answering two design questions rather than doing a
  refactor: what the "who" column says for a movement between two accounts one
  person owns, and what replaces the payday breakdown when there is no payday to
  anchor to.
- **`listAccountConfirmations` has no consumers.** `apps/web/src/lib/api.ts:436`
  wraps `GET /api/accounts/:id/transfers/confirmations` — the read that answers
  "what moved into or out of this account", household or not, and which the API
  tests exercise — and nothing in the app calls it.
  `apps/web/src/pages/HouseholdPlanPage.tsx:36` still reads confirmations with
  `listTransferConfirmations(householdId, month)`, which can only ever describe
  movement inside one household. Either wire the account-scoped read up or
  delete the method; a typed, unused client method is a claim the app does not
  make.
- **`NewMonthClose` cannot require what a close actually needs.**
  `packages/data/src/store.ts:107` makes `userId` and `currency` optional
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

### Left from the mine-and-ours work: "your money" said of somebody else's

Four packages in a row each found the next instance of the same sentence —
_the product says money is yours when it is not_ — and a fifth swept the product
once more to end the chain deliberately rather than by exhaustion
([`MINE-AND-OURS.md`](./MINE-AND-OURS.md), WP-AF / WP-AJ / WP-AK / WP-AL /
WP-AM). Everything below was **found, verified and left unfixed on purpose**,
because none of it reaches a reader today and each would have widened a package
that had a boundary to hold. Severity is stated per item, because they are not
the same kind of thing.

- **Dead code, and wrong the moment anyone renders it.**
  `apps/web/src/components/MemberTagBars.tsx:62` (a segment's `title`) and `:85`
  (the legend row) both read `elsewhere in your plan · £X` on **every** member's
  bar, and the component takes no `userId` — so a co-member's bar claims their
  money is yours. Its own `aria-label` (`:43`) correctly says `Bob: …`, so the
  accessible name and the tooltip disagree about whose figure it is. Imported by
  nothing but its own test, which is the **only** reason it was not fixed.
  Anyone who wires this component to a screen ships the defect with it.
- **Live, imprecise, and true.** `apps/web/src/components/AccountMovements.tsx:424`
  says "nothing you authored." It renders only when there are zero authored rows
  from **anybody**, so it is literally true for every reader who can reach it —
  imprecise rather than false, which is why it was left. It becomes wrong the
  day that branch renders with a co-member's authored row present.
- **A strict improvement with nothing asserting it.**
  `apps/web/src/pages/AccountPage.tsx:228-241` resolves a payment's project chip
  against `listProjects()`, which now carries co-members' shared projects — so a
  payment on your account filed by a co-member into their shared project names
  and links it, where before it silently rendered nothing. Safe by construction
  (`proj ? … : null`), and untested. Wants a test that a payment filed into a
  co-member's shared project renders its chip, before someone "tidies" the
  lookup back to owned projects and nobody notices.
- **Stale internal comments — fifteen of them, one belief.** Each says the
  predicate is _"another account you own"_ where the code's real predicate is
  `requireAccess(…, "edit")`, which a co-member's shared account satisfies. This
  is precisely the belief that kept being re-implemented one function away for
  four packages running, which is why clearing the comments is worth doing
  rather than cosmetic: `packages/contracts/src/index.ts:179-180`;
  `apps/web/src/lib/types.ts:276, :347, :1084`;
  `apps/web/src/lib/needsYou.ts:207, :647, :1011`;
  `apps/web/src/components/Fold.tsx:177`; `apps/web/src/lib/api.ts:404`;
  `packages/domain/src/types.ts:351`; `packages/domain/src/flow.ts:44`;
  `apps/api/src/portability.ts:43`; `packages/data/src/entities.ts:284`;
  `apps/api/src/server.ts:985, :1962`.
- **Do not "clean up" these four.** They look identical to the fifteen above and
  they are **correct as written**: each narrates a defect this work fixed, in the
  words of the wrong belief, which is what makes them read like instances of it.
  `apps/web/src/components/MovementDrawer.tsx:40` and `:97`;
  `apps/web/src/lib/needsYou.ts:612`; `apps/api/src/notify.ts:83`. A sweep that
  greps for the phrase will delete the explanations along with the errors —
  which is the whole reason this warning is booked beside the list rather than
  left to be rediscovered.
