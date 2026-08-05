-- 0013_user_month_closes.sql — a month close belongs to a person.
--
-- Product direction, not a workaround (Ben, 2026-08-05, MONTH-CLOSE.md decision
-- 14): closing a month is freezing a plan, and the unit of planning is the user
-- (ONE-ENGINE decision 1). So a close is per user — and, because planning
-- partitions by currency (ONE-ENGINE decision 10), one row per
-- (user, month, currency). The household close and the account close this
-- supersedes are deleted a package later, along with the nineteen-line comment
-- that had to redefine "income" to make a *location's* scorecard mean anything.
-- This file only makes room for the row that replaces them; it deletes nothing
-- and migrates nothing (decision 17: no close rows exist).
--
-- `core.month_closes` (0004) admitted exactly two scopes and said so:
-- `month_close_scope CHECK ((household_id IS NULL) <> (account_id IS NULL))`, a
-- genuine XOR over the only two columns that then existed. A third scope cannot
-- be added beside it. Constraints are ANDed, so a second, more permissive CHECK
-- loosens nothing — the 0004 predicate goes on refusing, on its own, a row
-- whose only scope is a user. Dropping and re-adding is the only route.
--
-- ## Why this drops a constraint, and why nothing else does
--
-- Second sanctioned exception (MONTH-CLOSE.md decision 18, 2026-08-05); the
-- first was spent on 0010. `month_close_scope` is the only thing this file
-- drops, and nothing else in this plan drops anything.
--
-- The re-add is under the **same name**, and the reason is not 0010's — worth
-- being exact, because the two cases look identical and only one of them can
-- wedge a cluster. 0010 had to hold its name or be broken forever: 0009 re-runs
-- immediately before it on every sync and guards its own ADD *by name*, so a
-- freed name would be refilled with the old, now-false predicate and validated
-- against the rows that break it. Nothing does that here. 0004 states
-- `month_close_scope` inline in a `CREATE TABLE IF NOT EXISTS`: on every sync
-- after the first the table exists, the whole statement is a no-op, and no file
-- in this directory re-adds the old predicate under any circumstances. The name
-- is held for a smaller reason — a renamed constraint would leave two scope
-- rules on the table if this swap ever ran half-way, and one name that always
-- means "what scopes a close" is the thing a reader can trust.
--
-- Idempotent throughout — this file is re-applied in full, in lexical order, on
-- every sync under `psql -v ON_ERROR_STOP=1`. No data is touched.

-- ----------------------------------------------------------------------------
-- The two columns a user close needs
-- ----------------------------------------------------------------------------
-- `user_id` cascades on delete: this table's own `account_id` sets that
-- precedent (0004), and `core.notification_log.user_id` (0007) sets the
-- precedent for pointing at `auth.users` from `core`. A frozen scorecard is
-- nobody's once the person it scores is erased.
--
-- Nullable, and it has to be: every row that already exists is scoped to a
-- household or a standalone account and names no user, and both legacy scopes
-- go on working unchanged until the package that deletes them.
--
-- That is also what makes everything below safe to apply. Both columns arrive
-- NULL on every pre-existing row, so the foreign key, the two CHECKs and the
-- unique index each state something trivially true of the data already in the
-- table. None of them can fail validation — the failure mode 0011 and 0012 were
-- shaped around, where a rule we cannot prove of existing rows wedges every
-- future deploy at the same line, is simply not reachable from here, and no
-- trigger is needed to dodge it.
ALTER TABLE core.month_closes
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- Which currency partition this close scores. Null on the two legacy scopes,
-- which never partitioned; required of a user close, by the CHECK below.
ALTER TABLE core.month_closes ADD COLUMN IF NOT EXISTS currency text;

-- ----------------------------------------------------------------------------
-- The scope rule, restated over three columns
-- ----------------------------------------------------------------------------
-- Two guarded steps inside one statement, so the table is never briefly
-- unscoped and a failure rolls the pair back together — 0010's shape.
--
--   * Step 1 fires only while 0004's predicate is in force. 0010 could
--     recognise its old rule by a column the new one had stopped mentioning;
--     there is no such column here, because the new rule names a superset of
--     the old one's. So the test is the mirror image: the predicate that has
--     never heard of `user_id` is the one to replace. After the swap the
--     definition mentions it and a re-run does nothing.
--   * Step 2 takes the name back. It fires on the sync that frees it, and again
--     only if the name is ever found free for some other reason.
--
-- Counting the non-null columns rather than chaining `<>` because XOR does not
-- generalise: `a <> b <> c` is true of all three being non-null, which is
-- exactly the shape a scope rule exists to refuse. Every row that can already
-- exist satisfies this — 0004's CHECK was there from the moment the table was,
-- so every row has exactly one of household/account, and `user_id` is NULL on
-- all of them.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'month_close_scope'
      AND conrelid = 'core.month_closes'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%user_id%'
  ) THEN
    ALTER TABLE core.month_closes
      DROP CONSTRAINT month_close_scope;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'month_close_scope'
      AND conrelid = 'core.month_closes'::regclass
  ) THEN
    ALTER TABLE core.month_closes
      ADD CONSTRAINT month_close_scope
      CHECK ((household_id IS NOT NULL)::int
             + (account_id IS NOT NULL)::int
             + (user_id IS NOT NULL)::int = 1);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- A user close names its currency
-- ----------------------------------------------------------------------------
-- A new constraint of its own, not part of the exception above: nothing is
-- dropped to make room for it. It is separate from the scope rule on purpose —
-- a close being scoped to a user and a user close naming its partition are two
-- different claims, and a violation should say which one was broken.
--
-- One-sided, because the legacy scopes have no currency to name: a household or
-- account close carries NULL and always did. `ADD CONSTRAINT` has no
-- `IF NOT EXISTS`, hence the guard — a bare ADD would succeed on the first sync
-- and fail on every one after it, the wedge this directory's rules exist to
-- avoid.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'month_close_user_currency'
      AND conrelid = 'core.month_closes'::regclass
  ) THEN
    ALTER TABLE core.month_closes
      ADD CONSTRAINT month_close_user_currency
      CHECK (user_id IS NULL OR currency IS NOT NULL);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- One close per user, per month, per currency
-- ----------------------------------------------------------------------------
-- The new scope's key, keeping the shape 0004 gave the other two: a partial
-- unique index over the scope column, so each scope's rows are counted only
-- among their own kind and neither older key is disturbed.
--
-- Currency is in the key, not merely checked, because closing a month closes
-- every partition the user has at once (decision 14) — two rows for one month
-- are the normal state for anyone holding an account abroad, and the thing to
-- refuse is the *same* partition twice. A unique index rather than a trigger
-- because 0011's hazard cannot bite: `user_id` is created by this very file, so
-- every pre-existing row is NULL in it and the `WHERE` excludes them all. The
-- index is empty at build time on any database that has ever run, and an empty
-- index cannot fail to build.
--
-- No separate lookup index: `user_id` leads this one, so "every close of mine,
-- newest first" reads it, exactly as the household and account lists read
-- theirs.
CREATE UNIQUE INDEX IF NOT EXISTS month_closes_user_month_currency_unique
  ON core.month_closes (user_id, month, currency) WHERE user_id IS NOT NULL;
