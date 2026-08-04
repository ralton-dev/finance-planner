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

| File                           | Adds                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `0001_init.sql`                | `auth`/`core`/`calc` schemas: users, sessions, households, accounts, incomes, payments.             |
| `0002_projects.sql`            | Cross-account projects.                                                                             |
| `0003_household_shares.sql`    | Contribution shares; shared/personal scope on accounts and payments.                                |
| `0004_reality_loop.sql`        | `core.contributions`, `core.balance_snapshots`, `core.transfer_confirmations`, `core.month_closes`. |
| `0005_auth_hardening.sql`      | `auth.users.totp_secret`/`totp_enabled_at`, `auth.recovery_codes`, `auth.password_reset_tokens`.    |
| `0006_goal_modes_and_tags.sql` | `core.payments.fixed_monthly_minor`, `core.payments.tag`.                                           |
| `0007_platform.sql`            | `auth.users.notify_email`, `core.notification_log` (unique `(user_id, date, kind)`).                |

Every file is idempotent (`IF NOT EXISTS` throughout), so re-applying the set
against a migrated database is a no-op.

`make migrate` only applies `0001_init.sql` against an existing local DB —
extend it if you add migrations and need to apply them to an already-running
dev volume.

> Drift watch: keep `deploy/helm/finance-planner/files/` in sync with this
> directory. The chart embeds those copies into a ConfigMap. Adopting
> `drizzle-kit` to generate migrations from the schema is in `BACKLOG.md`.

## Seed data

`seed/seed.sql` creates a demo user, an account, an income, and one payment
of each category. Load it with `make seed`.
