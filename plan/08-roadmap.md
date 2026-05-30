# Delivery Roadmap

> **Status:** Phases 0–6 implemented and verified (engine, persistence, full
> API, auth + households, all-accounts overview, React SPA), plus the Phase 6
> hardening/infra (Dockerfiles, Helm chart with migration Job + HPA + PDB, CI
> with integration and E2E). **Phase 7 is the deferred backlog** — see
> `09-open-questions.md` and `HANDOVER.md` §11. Operational details live in
> `HANDOVER.md`.

> Phased so each phase is independently shippable and demonstrable. Phases build
> on each other; acceptance criteria gate progress.

## Phase 0 — Foundations (repo & tooling)

**Goal:** a monorepo that builds, lints, tests, and containerises an empty stack.

- Monorepo scaffold (pnpm workspaces + Turborepo), shared `config`,
  `contracts`, `domain` packages.
- App skeletons: `web`, `api`, `auth`, `calc` with `/healthz` + `/readyz`.
- Postgres + Redis via docker-compose; migration tooling wired.
- GitHub Actions CI (lint, typecheck, unit, build).
- Dockerfiles + base Helm chart that deploys the empty stack to kind.

**Acceptance:** `make dev` runs the stack locally; CI green; `helm install` on
kind brings all pods to ready.

## Phase 1 — Domain core & calculation engine

**Goal:** the maths works and is trusted, independent of UI.

- `packages/domain`: types + pure engine for all four payment categories,
  income normalisation, prioritised funding, leftover/shortfall, projections.
- Golden-file + edge-case unit tests (`03-calculation-engine.md` §8).
- `core` schema migrations (accounts, incomes, payments).
- `calc` service: sync `/internal/calc/account-plan`.

**Acceptance:** given fixture inputs, the engine returns correct per-payment
contributions, leftover, and shortfall across all categories and edge cases.

## Phase 2 — Accounts, incomes & payments (single-user, no auth yet)

**Goal:** full CRUD + plan, end to end, for one implicit user.

- `api`: CRUD for accounts/incomes/payments; `GET /accounts/:id/plan` wired to
  `calc`; recompute-on-change + caching.
- `web`: account list, account detail with the plan breakdown table,
  category-aware add/edit forms with client-side preview.

**Acceptance:** create an account, add income + each payment category, see
correct required-per-month and leftover/shortfall; edits update the plan.

## Phase 3 — Authentication

**Goal:** real users; data is private per user.

- `auth` service: register/login/refresh/logout, Argon2id, sessions.
- `api`: JWT verification, per-account authorization (owner only for now).
- `web`: auth screens, token/refresh handling, route guards.

**Acceptance:** users only see their own accounts; unauthorized access → 404/403;
auth security tests pass.

## Phase 4 — Households & sharing

**Goal:** the multi-user collaboration requirement.

- `auth`: households, memberships, invites, account shares; ACL endpoint.
- `api`: effective-permission resolution (view/edit), share/household endpoints.
- `web`: household management + sharing UI; account context for shared accounts.

**Acceptance:** a user can share an account with a household; members see it with
the granted permission; permission matrix tests pass.

## Phase 5 — All-accounts overview

**Goal:** the consolidated view across accounts.

- `calc`: per-currency aggregation; overview snapshotting.
- `api`: `GET /overview` aggregating visible accounts.
- `web`: overview dashboard (KPIs, per-account cards, cross-account at-risk list,
  charts).

**Acceptance:** overview totals equal the sum of per-account plans (per currency);
at-risk goals surface correctly.

## Phase 6 — Production hardening & deploy

**Goal:** runnable in a real cluster with confidence.

- Helm values for staging/prod; nightly recompute CronJob; HPA; NetworkPolicies;
  PodDisruptionBudgets.
- CI/CD: image build/publish/sign (GHCR), staging auto-deploy, prod gated deploy,
  migration Jobs.
- Observability: metrics, dashboards, logs, traces, alerts.
- Security pass: dependency/image scanning, secrets management, rate limiting,
  backups + restore runbook.

**Acceptance:** push to `main` → staging deploys automatically and smoke E2E
passes; prod promotion works with manual approval; rollback verified.

## Phase 7 — Polish & stretch (backlog)

- Email verification + password reset; optional OIDC sign-in.
- "What-if" simulation; lump-sum/windfall allocation; savings buffers.
- Notifications (payment due soon, goal at risk).
- Data export/import; GDPR erasure flows.
- Multi-currency conversion (if pursued).
- Recurring-income edge tooling, audit history UI.

## Definition of Done (every feature)

Tests are completed **per feature** — see `10-testing-strategy.md`. A feature is
not done until:

- Unit tests cover new pure logic; **`packages/domain` stays ≥ 95% coverage**.
- Integration tests cover new/changed API endpoints against a real DB
  (Testcontainers), including auth/authorization.
- Component tests (React Testing Library) cover new UI with meaningful states.
- E2E (Playwright) is extended when a user journey is added or changed.
- `format:check`, `lint`, `typecheck`, `test`, and the E2E smoke are green in CI.
- Docs updated; the change is demoable on kind/local.

## Cross-cutting (every phase)

- Tests written alongside code (unit + integration); CI stays green.
- Each phase ends with updated docs and a demo-able deployment to kind/staging.
- Accessibility and money/date correctness are not deferred — they're baked in.

## Suggested sequencing notes

- Phases 1–2 deliver the core value fastest and de-risk the maths early.
- Auth (3) before sharing (4) before overview (5) keeps authorization correct as
  the data-visibility surface grows.
- Phase 6 can begin in parallel (infra is independent) but gates the first real
  production release.
