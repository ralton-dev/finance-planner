# Decisions (formerly Open Questions)

**Status: all resolved.** Every question below has a locked decision so the
project can be built end-to-end without further input. These decisions are
**authoritative** and supersede any "recommended/proposed" wording elsewhere in
the plans.

## Decision log

| #   | Topic                        | Decision                                                                                                                                                                                                                     |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —   | Auth / user model            | Multi-user + shared households.                                                                                                                                                                                              |
| —   | Service granularity          | A few coarse services sharing one Postgres (per-schema isolation).                                                                                                                                                           |
| —   | Income-shortfall behaviour   | Prioritise + show shortfall.                                                                                                                                                                                                 |
| —   | Infrastructure target        | Cloud-agnostic manifests + local dev (kind).                                                                                                                                                                                 |
| —   | Frontend framework           | React 19 + Vite SPA + component library (shadcn/ui default).                                                                                                                                                                 |
| 1   | Multi-currency               | **Single currency per account.** Overview groups by currency; **no FX conversion**.                                                                                                                                          |
| 2   | "Already saved" tracking     | **Manual `alreadySavedMinor` field in v1.** Auto-accumulating contribution ledger is Phase 7.                                                                                                                                |
| 3   | Account balance semantics    | **Informational only** in v1 (no month-over-month carry).                                                                                                                                                                    |
| 4   | Bills vs. savings goals      | Both consume monthly income; **UI separates "bills" (monthly_recurring) from dated savings goals**.                                                                                                                          |
| 5   | Savings buffer               | **Include** an optional per-account `monthlyBufferMinor`, reserved off the top before funding. Default 0. Implemented in Phase 1 engine work.                                                                                |
| 6   | Notifications                | **Deferred to Phase 7** (not built in the core run).                                                                                                                                                                         |
| 7   | Income variability           | **Fixed amount per frequency** in v1.                                                                                                                                                                                        |
| 8   | Backend framework            | **Fastify** (already scaffolded; matches the coarse-service shape; minimal overhead).                                                                                                                                        |
| 9   | ORM / DB toolkit             | **Drizzle ORM** + `drizzle-kit` migrations.                                                                                                                                                                                  |
| 10  | Monorepo build tool          | **Turborepo** (already in place).                                                                                                                                                                                            |
| 11  | Auth method in v1            | **Email + password** with email-verification token flow. Mail sent via a pluggable mailer interface (log transport in dev; SMTP wired later). **OIDC deferred to Phase 7.**                                                  |
| 12  | Client token storage         | **Access token in memory + refresh token in httpOnly, SameSite=strict cookie.**                                                                                                                                              |
| 13  | Persist computed plans       | **Cache in Redis + snapshot to `calc` schema on write** (history/audit).                                                                                                                                                     |
| 14  | Physical DB split            | **Single Postgres, per-schema isolation**, splittable later (cross-schema refs kept logical).                                                                                                                                |
| 15  | First real deploy target     | **kind locally is the verified target.** Staging/prod manifests stay provider-neutral and are **credential-gated** — CI builds & publishes images but does **not** auto-deploy to a real cluster without configured secrets. |
| 16  | Managed vs. in-cluster infra | **In-cluster Postgres/Redis for non-prod**; prod overlay expects **managed** instances injected via external secrets.                                                                                                        |
| 17  | Image registry               | **GHCR**: `ghcr.io/bralton/finance-planner/*`.                                                                                                                                                                               |
| 18  | Domain & TLS                 | **cert-manager + Let's Encrypt**; hostnames `staging.finance.example.com` / `finance.example.com` (placeholders, overridable per overlay).                                                                                   |

## Notes on selected decisions

- **#5 buffer:** the engine computes `availableForSavings = monthlyIncome −
monthlyBufferMinor` before the prioritised funding loop. Buffer is surfaced as
  a distinct line in the plan summary. Added with tests in Phase 1.
- **#8 Fastify over NestJS:** the services are thin (BFF + auth + calc worker);
  Fastify keeps cold-start and bundle size low and is already wired. Module
  boundaries are enforced by folder/package structure, not a DI framework.
- **#11 mailer:** define a `Mailer` interface with `LogMailer` (dev/test) and
  `SmtpMailer` (prod, config-gated). Verification works end-to-end in tests
  against `LogMailer`; no external email provider is required to build/run.
- **#15 deploys:** "automated without input" means the **code, tests, images and
  manifests** are produced and verified automatically. Pushing to a live cluster
  still requires real cluster credentials/secrets, which are intentionally not
  committed; that final step remains a gated, human-triggered action.

## Testing is non-negotiable

Per the product owner: **tests are completed per feature**, and **UI testing**
is part of the harness. The policy and gates live in
`10-testing-strategy.md`; the per-feature Definition of Done is in
`08-roadmap.md`.
