# Database

PostgreSQL. Money is stored as integer **minor units** (pennies); never floats.
Three logical schemas: `auth`, `core`, `calc` (see `plan/02-domain-model.md`).

## Migrations

Phase 0 uses plain, ordered SQL files in `migrations/`. They run automatically
when the local Postgres container first starts (mounted into
`/docker-entrypoint-initdb.d`), and can be applied manually with `make migrate`.

> A migration runner (e.g. Drizzle Kit / node-pg-migrate) is introduced when the
> ORM is chosen — see `plan/09-open-questions.md` (#9). Until then, add new files
> as `000N_description.sql` in order.

## Seed data

`seed/seed.sql` creates a demo user, an account, an income, and one payment of
each category. Load it with `make seed`.
