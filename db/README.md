# Database

PostgreSQL. Money is stored as integer **minor units** (pennies); never floats.
Three logical schemas: `auth`, `core`, `calc` — see the Drizzle definitions in
[`../packages/data/src/schema.ts`](../packages/data/src/schema.ts) for the
canonical model.

## Migrations

Plain numbered SQL files in `migrations/`, applied in lexical order. Add new
ones as `000N_description.sql` and they're picked up automatically by:

- Postgres `initdb` in compose (mounted into `/docker-entrypoint-initdb.d`)
  on a fresh volume.
- The Helm migration Job, which globs `files/*.sql` (mirror of this directory)
  and applies each with `ON_ERROR_STOP=1`.
- The integration test harness, which reads this directory and applies every
  file before exercising the store contract.

`make migrate` only applies `0001_init.sql` against an existing local DB —
extend it if you add migrations and need to apply them to an already-running
dev volume.

> Drift watch: keep `deploy/helm/finance-planner/files/` in sync with this
> directory. The chart embeds those copies into a ConfigMap. Adopting
> `drizzle-kit` to generate migrations from the schema is in `BACKLOG.md`.

## Seed data

`seed/seed.sql` creates a demo user, an account, an income, and one payment
of each category. Load it with `make seed`.
