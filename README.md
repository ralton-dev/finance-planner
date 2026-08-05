# Finance Planner

A web app for planning savings toward upcoming payments. Record your income and
your payments (with due dates and recurrence) and the app tells you how much to
set aside each month per goal to hit its target date, and how much you have
left over — per account and across all accounts.

**The unit of planning is the user, not the account.** An account is a location
money sits in, not a planning universe: a bills pot fed by your current account
is funded out of that account's surplus, so the two cannot be planned
independently. One funding pass covers everything you own, and every screen —
the account page, the household page, the flow diagram, the forecast — is a
**view** of that one pass rather than a calculation of its own. Money arriving
from outside is income; money you move between two of your own accounts is not —
it is your own money, moved.

Multi-user with shared **households**, cross-account **projects**, and a
**savings engine** that prioritises goals, surfaces shortfalls, and projects
completion when underfunded.

Households also get a **pooled money-flow plan**: tag each account as a shared
pot or personal to a member, set each member's proportional contribution share,
and mark expenses shared or personal. The engine then splits shared costs by
share, funds across all accounts by priority, and works out the **transfers**
each person should make into each account. A household is an **attribution
layer** — whose money this is, who bears a cost, how a shared cost splits —
never a boundary on which accounts take part in the plan, and never a
calculation boundary either: a household is the same pass with sharing rules,
and a solo user is a household of one at a 100% share. "Not in a household"
means "no sharing rules apply", not "planned by something else".

The plan is grounded in reality by a **contributions ledger**: record what you
actually set aside, check in your real balance, tick off transfers, and close
your month. From that same history it **projects 12 months forward** and tells
you what's due next.

Installable as a PWA. Deployed cloud-agnostically on Kubernetes via Helm.

- **Operations / runbook:** [`OPERATIONS.md`](./OPERATIONS.md)
- **Deferred backlog:** [`BACKLOG.md`](./BACKLOG.md)
- **UI redesign plan (delivered, WP-0…WP-8):** [`REDESIGN.md`](./REDESIGN.md)
- **Inflows plan (delivered):** [`INFLOWS.md`](./INFLOWS.md), which supersedes
  [`HOUSEHOLD-CONTEXT.md`](./HOUSEHOLD-CONTEXT.md)
- **One-engine plan (delivered, WP-O…WP-U):** [`ONE-ENGINE.md`](./ONE-ENGINE.md),
  which supersedes the two-engine architecture the way `INFLOWS.md` superseded
  `HOUSEHOLD-CONTEXT.md`
- **Month-close plan (delivered, WP-A…WP-F):**
  [`MONTH-CLOSE.md`](./MONTH-CLOSE.md), which continues `ONE-ENGINE.md`'s
  decision sequence at 14
- **Contributing:** [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- **Licence:** [MIT](./LICENSE)

## Feature tour

**Planning**

- Accounts with inflows and payments — monthly, yearly, custom-cadence, or a
  one-off `fixed_point` goal. Each payment carries a priority; the engine funds
  in priority order and reports shortfalls.
- **Inflows know where they came from.** `source: external` is what an income
  always was — a salary, a gift, interest. `source: account` is you moving your
  own money: one row authored once and read from both ends, arriving on one
  account and leaving the other. Total money in comes only from the external
  ones, so a current → pot → ISA chain reports one salary rather than three;
  everything else is redistribution of money already counted.
- **A pot with bills and no income feeds itself.** You do not author "£300 a
  month into the bills pot" and hope it covers the bills — the plan reads the
  bills and says the transfer is £303.20. Every expense-bearing account is fed
  this way, household or not, and nobody writes the transfer down. What you owe
  changes, and so does the transfer.
- **Movements you author are savings** — a sweep into an ISA, a standing amount
  into a holiday pot. Authored from the account page: what arrives here, what
  leaves here, and a drawer to add, change or call one off from either end.
  Authoring takes edit on _both_ accounts (a view grant says you may see my
  money, not that you may spend it); removing takes edit on either, because
  releasing a claim can harm neither end. The picker offers same-currency
  accounts only and the API refuses a cross-currency movement outright — there
  is no exchange rate anywhere in this system.
- **Expenses beat savings, always.** Your bills and your household's share one
  priority order and intertwine — either can outrank the other — and every one
  of them is funded before a penny goes to savings, whatever priority the
  movement carries. So a pot can never starve a bill. Money cannot be spent
  twice at any depth either: a £300 movement out of an account with £120 left
  after its bills moves £120, and says so.
- **Funding loops are detected, not refused.** A → B → C → A is a property of
  the estate rather than of whichever row happened to be saved last, so it is
  found when the plan is computed, reported with the accounts in the order money
  travels, and broken at one edge so everything else still plans. Never refused
  at authoring time, never a hang.
- Goals work two ways: **paced by date** (required monthly = remaining ÷ months
  left) or **contribution-first** — set a fixed monthly amount and the finish
  date becomes a consequence of the pace. A contribution-first goal needs no
  target date at all.
- **Projects** group payments across accounts.
- Free-form **tags** (≤ 40 chars) on payments, with suggestions from tags
  already used on the account.
- **What-if preview**: overlay up to five hypothetical payments/incomes on an
  account and see leftover, shortfall, and newly-at-risk goals before/after.
  Nothing is persisted. Account-level only — see `BACKLOG.md`.

**Household**

- **The household page and the account page cannot disagree.** They are not two
  computations reconciled after the fact; they are two views of one pass, so an
  account's left over is the same number on the household plan, on the account's
  own page and in the flow diagram — pinned to the penny by
  `packages/domain/src/parity.test.ts`. The plan endpoint, the projection, the
  what-if preview, the upcoming feed, the overview and the digest all read that
  same pass rather than six figures that can drift.
- Shared-pot vs personal accounts, per-member contribution shares, and
  shared vs personal expenses. Shared costs split by share; personal costs land
  on their bearer. Each share is rounded **up** to the penny, so a pot ends the
  month a few pence over rather than a bill ending it a penny short.
- Derived **transfers**: who moves what into which account each month. The same
  mechanism that feeds a solo user's pots — a household only changes whose
  obligation each transfer settles.
- **Payday-anchored schedule** splits each transfer across that member's actual
  pay dates, derived from the incomes on their personal accounts.
- Savings leaving a household account show as one **committed** total rather
  than itemised, and the headline left over is what is free after it. Which ISA
  somebody sweeps into is the account's business; the flow diagram itemises it.
- **A shared pot's own income is its owner's.** A "joint" account is one
  person's account shared into a household, so the lodger's rent paid into it is
  that person's income exactly as a salary into their current account is —
  whatever role the household gives the account. It joins their budget, and the
  transfers into the pot are net of what the pot pays for itself, so nobody is
  asked to send money that is already there.

**Reality loop**

- **Contributions ledger** (`core.contributions`). A payment's "already saved"
  is derived — its manual base plus everything recorded against it — so the
  plan reflects what you really did.
- **Balance check-ins** (one per account per day) with a **drift warning** when
  the plan has reserved more than the account actually holds.
- **Three statuses, not two.** A plan line is `funded`, `awaiting_transfer` —
  the plan covers it and nobody has moved the money yet, amber — or `at_risk` —
  the plan cannot cover it, red. Red means only the second. Two different
  problems with two different remedies, no longer the same colour.
- **Transfer confirmations**: tick a planned transfer off and it writes the
  matching contributions into the destination account. Monthly, not per-payday.
- **"I moved the money" works with nobody else involved.** A movement between
  two accounts you own is a row you can tick, on the Overview and in the digest,
  with no household anywhere. What gets booked is what actually arrived rather
  than what the row asks for, so a sender that could only spare £120 of an
  authored £300 records £120.
- **So does confirming a transfer the plan derived for you.** A feed into a pot
  that nobody authored is a confirmation in its own right, scoped by its two
  accounts, its month and the person moving the money — no household anywhere,
  no authored row to hang it on (migration `0010`, and
  `POST /api/accounts/:id/transfers/confirm`). It is listed as something to do
  on the Overview and in the digest, with the payday it is anchored to, and the
  tick beside it works.
- **Closing a month is something you do, not something a place has.** It freezes
  what you earned, planned and set aside — one frozen row per currency you plan
  in, every one of them closed by the single action — and the **savings
  scorecard** on the Overview shows the resulting savings rate per month, one
  card per currency, with re-open beside each month.
- **Net-worth chart** built from balance check-ins, one line per currency,
  carrying the last known balance forward.

**Forecasting**

- **12-month projection** (selectable 6/12/24) for an account or a whole
  household: re-plans the estate every month against evolving state, because
  what arrives in month seven is another account's month-seven surplus after
  month-seven's bills. Renders as a chart plus a payments × months grid marking
  the months each payment falls due. The projected-balance line needs at least
  one balance check-in.
- **Upcoming payments** feed (default 14 days) on the Overview, and an opt-in
  **daily email digest** covering the next 7 days of bills, plus the money this
  month funds and nobody has said they moved — derived transfers with the payday
  they are anchored to, household or not, and your own authored movements
  without one, because a movement says only that it happens each month.

**Insight**

- Tag **bar list** ("where the month goes") — one row per tag, ranked biggest
  first, colour carrying the ranking — and per-member **stacked bars** ("who
  carries what").
- **Flow diagrams over any set of accounts.** `/flow` draws income → accounts →
  movements → spending / left over for whatever scope you pick — everything you
  own, two households and a standalone pot, one pair — with a **£ / %** toggle.
  A household is one _preset_ over that scope rather than the mechanism, and the
  household plan page links across to the same picture where it can be widened
  past the household.
- **Hiding is presentation; scope is arithmetic.** An account taken out of the
  picture keeps its row and every one of its figures — nothing is recomputed and
  the server is not asked. Which accounts the diagram is computed over, which
  are hidden, and any household preset all travel in the URL, so every picture
  is bookmarkable and shareable. Naming a scope is a local convenience, stored
  in the browser beside the theme; a scope you want to keep is one to bookmark.
- **PNG export** on every chart.
- **Light and dark themes.** A new install follows your OS; the sidebar toggle
  (or `t t`) walks system → light → dark, and an explicit choice is remembered
  locally and outranks the OS in both directions. Nothing has to run before the
  first paint, so the app never flashes the wrong theme. One semantic token set
  drives both — every ink and status colour clears WCAG AA against every surface
  it sits on, in either theme — and the charts re-read those tokens when the
  theme changes, so a light-theme PNG exports light.
- **Privacy mode** blurs every amount on screen and veils charts, including
  figures written into prose ("£540.00 is short this month"); toggle from the
  sidebar, the command palette, or the `h a` shortcut. Remembered locally.

**Platform / auth**

- Email + password, or **OIDC single sign-on** (PKCE, auto-provisioning
  passwordless users). Access tokens are short-lived; refresh tokens rotate and
  a replayed one revokes every session for that user.
- **TOTP 2FA** with step-up at login and eight single-use recovery codes
  (hashed at rest). **Password reset** by email.
- **JSON export / import** of your own data — movements between your own
  accounts travel too, with the source named rather than referenced by an id
  that would be minted fresh, and so do the standalone confirmations against
  them — and **account erasure**.
- **Installable PWA** — offline app shell, self-hosted JetBrains Mono, no CDN
  calls. `/api` is never cached.
- **Demo seed** plants a worked example into an empty account, gated behind
  `ENABLE_DEMO_SEED` and off by default.

## Architecture

```
Browser ──/api──▶ api (gateway/BFF) ──┬─ core domain (accounts, inflows,
                                       │   payments, projects, contributions,
                                       │   plan, projection, flow, upcoming,
                                       │   overview)
                                       ├─ /api/auth/* ─proxy─▶ auth service
                                       └─ computes plans via @finance-planner/domain
                                       │
                  auth service ────────┘   (users, households, sessions, sharing,
                                            2FA, password reset, OIDC)
                          │
                          ▼
                    PostgreSQL  (schemas: auth, core, calc)
                    Redis       (reserved for cache/queue; not yet wired)
```

- **Single public entrypoint.** Only `/api` is exposed. `auth` and `calc` are
  internal-only behind the api gateway.
- **Calculation engine** is a pure library (`packages/domain`) — takes an
  explicit `asOfDate`, never reads the wall clock, exhaustively unit-tested
  (≥95% lines / ≥80% branches, gated in CI).
- **One funding pass over a scope; everything else is a view of it.**
  `computeScopePlan` (`packages/domain/src/scope.ts`) takes a set of accounts
  and the members whose money they are, partitions them by currency, and runs
  four phases per partition: **attribute** every active payment to members
  (shares for a shared cost, the bearer for a personal one); **fund** those
  obligations out of pooled member budgets in one global priority order, with
  household-shared and personal intertwined; **derive** the transfers that
  funding implies, which is how an account with bills and no income is fed; then
  fund **authored movements as savings**, last, out of what is left. One funding
  loop, one derivation of leftover, one concept of money crossing an account
  boundary.
- **A household is a scope with sharing rules; a solo user is a household of one
  at a 100% share** — the same pass, degenerate attribution. Attribution decides
  whose money a figure is, never which accounts get planned or by what.
- **The views own no arithmetic.** `accountPlanFromScope` (`engine.ts`),
  `householdPlanFromScope` (`household.ts`), `flowFromScope` (`flow.ts`) and
  `computeScopeProjection` (`projection.ts`) sum and pass through decisions the
  pass has already made; none of them funds anything. That is why the account
  page, the household page and the flow diagram print one number rather than
  three derivations of it — asserted to the penny in
  `packages/domain/src/parity.test.ts`, which was written against the two-engine
  tree and observed failing there. The API builds one scope per request
  (`apps/api/src/plan.ts`), closing over funding edges _and_ household
  assignment, so which accounts are planned together is a property of the
  accounts rather than of the question asked about them. A month close obeys the
  same rule over time: `closeForUser` freezes figures the pass has already
  produced, per currency, rather than deriving a second set that could disagree
  with the screen they came from.
- **Savings can loop; expense transport cannot.** An authored movement spends
  what its sending account has left, so A → B → C → A is a real cycle: found
  when the plan is computed, reported with the accounts in the order money
  travels, and broken at one edge so everything else still plans. Traversal is
  iterative, so a deep chain is a long estate and not a stack overflow
  (`estate.ts`). A derived transfer is paid out of a member budget settled
  before any transfer is derived, so each member's transfers form a star of
  depth one and there is no order to be circular.
- **Persistence** behind a `Store` interface (`packages/data`) with two
  implementations: `PgStore` (Drizzle + Postgres) and `MemoryStore` (tests
  and DB-less local dev). Services pick `PgStore` when `DATABASE_URL` is set.
- **Authorization** rules live in `packages/policies` — both api and auth
  build a per-request ability and call `ability.can(action, subject)` instead
  of inline role checks.

## Repository layout

```
apps/
  web    React 19 + Vite SPA (served static via nginx in prod)
  api    Fastify gateway/BFF — core domain + auth proxy
  auth   Fastify auth service — users, households, sessions, sharing
  calc   Fastify worker — hosts the engine (internal plan endpoint)
packages/
  domain    pure calculation engine + date math (the heart of the product)
  data      entities, Store interface, MemoryStore, Drizzle schema + PgStore
  contracts shared Zod schemas / DTOs (request bodies, primitives)
  policies  per-request authorisation rules (action + subject)
  security  scrypt password hashing, HS256 JWT (jose), TOTP
  mailer    Mailer interface + SmtpMailer (nodemailer) / LogMailer fallback
db/          SQL migrations (0001_init.sql … 0013_user_month_closes.sql) + seed
deploy/
  local/     docker-compose stack, compose nginx, kind helper
  helm/      cloud-agnostic chart (services, ingress, migrate Job, HPA, PDB, …)
             files/ mirrors db/migrations — keep the two in sync
.github/workflows/   format, lint, typecheck, test, coverage, build,
                     integration (Testcontainers), e2e (Playwright),
                     helm lint/render, docker image matrix,
                     stack-smoke (full compose + /healthz probes),
                     CodeQL
```

## Prerequisites

- Node.js 22 (`.nvmrc`)
- pnpm 10 (`corepack enable`)
- Docker (for the full stack and integration tests)

## Getting started

```bash
corepack enable
pnpm install
```

Three ways to run, pick whichever fits the moment:

**A. Integrated dev (recommended):** backend in containers, web via Vite for
hot-reload.

```bash
cp .env.example .env
make up                                  # postgres, redis, api, auth, calc, web (built)
pnpm --filter @finance-planner/web dev   # SPA on :5173, proxies /api -> :4000
```

**B. Full container stack including the built SPA:**

```bash
make up                                  # then open http://localhost:8080
```

**C. Quickest spin, no database (in-memory store):**

```bash
pnpm --filter @finance-planner/api dev &
pnpm --filter @finance-planner/auth dev &
pnpm --filter @finance-planner/web dev
```

Useful Make targets: `make migrate`, `make seed`, `make down`, `make up-kind`
(kind cluster).

Optional features are env-gated and off by default — outbound mail, the daily
digest, single sign-on, and the demo seed. `.env.example` documents each one;
`OPERATIONS.md` §1 is the full table.

## Common tasks

```bash
pnpm build         # build all apps (tsup for services, vite for web)
pnpm test          # unit + component + service-level (MemoryStore) tests
pnpm coverage      # enforces engine ≥95% lines / ≥80% branches
pnpm lint          # eslint
pnpm typecheck     # tsc --noEmit across workspaces
pnpm format        # prettier --write .

pnpm --filter @finance-planner/data test:int   # integration vs real Postgres (Testcontainers)
pnpm --filter @finance-planner/web test:e2e    # Playwright (builds + serves the SPA)
```

CI runs every layer on every push; merges to `main` require the full matrix
green including the `stack-smoke` job that brings the compose stack up and
probes `/healthz` on each service.

## Tooling

- **Monorepo:** pnpm workspaces + Turborepo
- **Language:** TypeScript (strict), Node 22
- **Frontend:** React 19 + Vite + React Router 7 (plain CSS — no Tailwind /
  no component library; design tokens in `apps/web/src/styles.css`). Recharts
  for charts, lazily loaded. Installable PWA (manifest + hand-written service
  worker), self-hosted JetBrains Mono.
- **Backend:** Fastify 5 (api, auth, calc)
- **ORM / DB:** Drizzle ORM + PostgreSQL · **Cache/queue (reserved):** Redis
- **Mail:** nodemailer, wrapped by `packages/mailer`; falls back to logging
  when `SMTP_URL` is unset
- **Auth:** scrypt password hash + HS256 JWT access token + opaque refresh
  cookie + per-route rate-limit + reuse detection + TOTP 2FA + OIDC (PKCE)
- **Tests:** Vitest + React Testing Library + Playwright + Testcontainers
- **CI/CD:** GitHub Actions · **Runtime:** Kubernetes (Helm, cloud-agnostic)
