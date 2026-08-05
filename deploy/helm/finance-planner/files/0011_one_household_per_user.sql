-- 0011_one_household_per_user.sql — a user belongs to exactly one household.
--
-- Product direction, not a workaround (Ben, 2026-08-04): a person has one
-- household. Joining a second means leaving the first. It is also what makes
-- the scope pass sound. `computeScopePlan` takes **one member vector per
-- scope**, and a scope closes over household assignment, common ownership and
-- funding edges — so while a user could sit in two households, two rosters
-- could be dragged into one connected component and a `scope: 'shared'`
-- payment would split across both. Sharing an account already requires
-- membership of the target household, so with membership exclusive an account
-- can only ever be visible to one household, two rosters can never join, and
-- that defect stops being reachable rather than merely unlikely.
--
-- ## Why this is a trigger and NOT `CREATE UNIQUE INDEX ... (user_id)`
--
-- The obvious spelling is a unique index on `user_id`, and it is the wrong one
-- here. Every file in this directory is re-applied in full, in lexical order,
-- on every sync under `psql -v ON_ERROR_STOP=1`. `CREATE UNIQUE INDEX IF NOT
-- EXISTS` is idempotent in *form* but it is not safe against *data*: it builds
-- the index, and if a single pre-existing row violates it the statement fails,
-- the sync aborts, and — because we cannot `DELETE` the offending rows and
-- cannot take the failing statement back out of history — every future deploy
-- fails at exactly the same line. Forever. There is no `IF NOT EXISTS` for
-- that.
--
-- We cannot prove no such row exists. Nothing before this file forbade a second
-- membership: `auth.household_memberships` (0001) carries no unique constraint
-- at all, and until now the product positively supported a user in two
-- households. Any deployed instance may hold a violator, and the only honest
-- statements about it are "we do not know" and "we may not delete it".
--
-- A trigger states the same rule and cannot fail an apply, because a trigger is
-- never validated against rows that already exist — it constrains the *next*
-- write and nothing else. So:
--
--   * pre-existing rows survive untouched, whatever they say (no DELETE, and
--     history is not rewritten);
--   * no *new* violation can be created, by this application or by anyone at a
--     `psql` prompt;
--   * the file is additive and idempotent, and re-applying it is a no-op.
--
-- The application enforces the same rule one level up, in
-- `packages/data`'s `addMembership` / `createHousehold`, which is where a
-- caller gets a readable 422 instead of a raw SQL error. That check is the
-- user-facing rule; this trigger is the floor under it — the guarantee that
-- holds even when the write does not come through the Store.
--
-- Deliberately silent about *duplicate* memberships of the **same** household:
-- 0001 never forbade those either, the auth service answers 409 for them, and a
-- unique key over `(household_id, user_id)` would carry exactly the wedge
-- hazard described above for a hole this file was not written to close.

-- ----------------------------------------------------------------------------
-- The rule
-- ----------------------------------------------------------------------------
-- `CREATE OR REPLACE FUNCTION` is idempotent by definition, and re-defining a
-- function an existing trigger points at re-points the trigger with it.
--
-- The predicate deliberately says `household_id <> NEW.household_id` rather
-- than "any membership at all": a second row for the household the user is
-- already in is a duplicate, not an exclusivity breach, and is not this file's
-- business (see above). Raising `unique_violation` rather than a bare error
-- gives the driver a SQLSTATE that reads as what it is — a uniqueness rule,
-- expressed the only way it safely can be.
CREATE OR REPLACE FUNCTION auth.household_membership_is_exclusive()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.household_memberships m
    WHERE m.user_id = NEW.user_id
      AND m.household_id <> NEW.household_id
  ) THEN
    RAISE EXCEPTION
      'user % already belongs to a household; they must leave it before joining another',
      NEW.user_id
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- Attaching it
-- ----------------------------------------------------------------------------
-- `CREATE TRIGGER` has no `IF NOT EXISTS` before Postgres 14 and we do not rely
-- on one, hence the guard — a bare CREATE would succeed on the first sync and
-- then fail on every one after it, which is the very wedge this file is written
-- to avoid. `DROP TRIGGER IF EXISTS` would also work and is deliberately not
-- used: nothing in this directory drops anything it is not sanctioned to drop,
-- and a guard reads as what it is.
--
-- `UPDATE OF user_id` and not `UPDATE`: in a BEFORE UPDATE the row's own
-- pre-image is still in the table, so a trigger firing on a change to
-- `household_id` would find that pre-image, see a different household, and
-- refuse a write that moves one membership rather than adding a second. Nothing
-- updates `user_id` today; covering it costs nothing and is correct, because
-- re-pointing a membership at a different person genuinely can put that person
-- in a second household.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'household_memberships_one_per_user'
      AND tgrelid = 'auth.household_memberships'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER household_memberships_one_per_user
      BEFORE INSERT OR UPDATE OF user_id
      ON auth.household_memberships
      FOR EACH ROW
      EXECUTE FUNCTION auth.household_membership_is_exclusive();
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Reading a user's one household
-- ----------------------------------------------------------------------------
-- `memberships_user_idx` (0001) already indexes `user_id` and stays exactly as
-- it is. Nothing is added here: with the rule above in force the lookup returns
-- at most one row on new data, and on legacy data the readers take the first in
-- a stable order, which is what they have always done.
