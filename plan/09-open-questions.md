# Open Questions & Assumptions

Items to resolve in further discovery. Each has a **working assumption** the
plans currently use, so work can proceed without blocking.

## Resolved in discovery (recorded for traceability)
| Question | Decision |
|----------|----------|
| Auth / user model | Multi-user + shared households. |
| Service granularity | A few coarse services sharing Postgres. |
| Income shortfall behaviour | Prioritise + show shortfall. |
| Infrastructure target | Cloud-agnostic manifests + local dev. |

## Open — product
1. **Multi-currency.** Is each account single-currency (current assumption), or
   do you need accounts/goals in different currencies with conversion in the
   overview? *Assumption: single currency per account; overview groups by
   currency, no FX.*
2. **"Already saved" tracking.** Does the user manually maintain
   `already_saved` per goal, or should the app track contributions over time and
   accumulate it automatically (requires a ledger of actual deposits)?
   *Assumption: manual field in v1; ledger is a Phase 7 stretch.*
3. **Account balance semantics.** Is `opening_balance` just informational, or
   should leftover roll into a running balance month over month?
   *Assumption: informational in v1.*
4. **Monthly recurring vs. savings goals.** Should monthly bills be shown
   separately from "savings toward future dated goals" in totals? *Assumption:
   both consume monthly income; UI separates "bills" from "savings" visually.*
5. **Savings buffer.** Do you want to reserve an emergency-fund/buffer off the
   top before funding goals? *Assumption: not in v1; optional later.*
6. **Notifications.** Email/push when a goal goes at-risk or a payment is due
   soon? *Assumption: Phase 7.*
7. **Income variability.** Do you need variable/irregular income (e.g. commission)
   beyond fixed amounts per frequency? *Assumption: fixed amount per frequency in
   v1.*

## Open — technical
8. **Backend framework.** NestJS (recommended) vs. Fastify vs. Express.
9. **ORM / DB toolkit.** Drizzle (recommended) vs. Prisma vs. Kysely.
10. **Monorepo build tool.** Turborepo (recommended) vs. Nx.
11. **Auth method in v1.** Email+password only, OIDC only, or both? Is email
    verification required for launch? *Assumption: email+password with
    verification relaxable in early phases; OIDC is a stretch.*
12. **Token storage on the client.** Access token in memory + refresh in
    httpOnly cookie (recommended) — confirm acceptable given the SPA + BFF split.
13. **Persist computed contributions?** Always snapshot to `calc` schema, or
    compute on the fly and only cache in Redis? *Assumption: cache in Redis +
    snapshot on write for history/audit.*
14. **Physical DB split.** Stay single Postgres with per-schema isolation
    (current plan) or split per service later? *Assumption: single now,
    splittable later — cross-schema refs kept logical.*

## Open — infra/ops
15. **Target cluster for the first real deployment.** Even though manifests are
    cloud-agnostic, which cluster hosts staging/prod first (homelab/k3s, a cloud,
    other)? Affects ingress/cert/secret wiring in overlays.
16. **Managed vs. in-cluster Postgres/Redis in prod.** *Assumption: in-cluster
    for non-prod; overlay swaps to managed in prod if a cloud is chosen.*
17. **Image registry.** GHCR assumed (`ghcr.io/bralton/finance-planner/*`).
    Confirm.
18. **Domain & TLS.** Hostname(s) and cert issuer (cert-manager + Let's Encrypt
    assumed).

## How these get resolved
- Items blocking a phase are pulled into that phase's kickoff (see
  `08-roadmap.md`). Most can default to the working assumption and be revisited
  without rework, because the architecture isolates these choices (engine is
  framework-agnostic; DB access is behind a repository layer; infra specifics
  live in overlays).
