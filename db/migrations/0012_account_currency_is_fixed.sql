-- 0012_account_currency_is_fixed.sql — an account is denominated once.
--
-- Product direction, not a workaround (Ben, 2026-08-05): the currency an account
-- is counted in is settled when the account is created and can never be changed.
--
-- ## Why the rule exists
--
-- Planning is per currency (ONE-ENGINE decision 10). `computeScopePlan`
-- partitions a scope by currency and runs the funding pass once per partition;
-- derived transfers never cross between them, and authoring a movement across
-- one is refused at POST because there is no rate anywhere in this system to
-- convert it with. Every one of those rules assumes an account sits in exactly
-- one partition and stays there.
--
-- `UPDATE core.accounts SET currency = ...` broke that assumption *after* the
-- fact: a movement authored inside one currency became a movement between two,
-- and the pass saw it leave a partition without arriving in any. That is what
-- made `36c90bf`'s defect reachable — a movement read from the partition that
-- could not see its sender reported a funded zero, and "I moved the money" was
-- recorded against £0. Fixing the currency does not handle that state; it stops
-- it arising.
--
-- ## Why this is a trigger and NOT a constraint
--
-- The same reasoning as `0011_one_household_per_user.sql`, and worth restating
-- because it is the whole reason this file is shaped the way it is. Every file
-- in this directory is re-applied in full, in lexical order, on every sync under
-- `psql -v ON_ERROR_STOP=1`. A CHECK constraint cannot express "this column may
-- not change" at all, and anything that validates against rows already in the
-- table risks failing an apply on data we cannot inspect and are not allowed to
-- delete — which would wedge every future deploy at the same line, forever.
--
-- A trigger is never validated against existing rows. It constrains the *next*
-- write and nothing else, so:
--
--   * an account whose currency was changed before this file landed keeps
--     whatever it now says, and its plan keeps whatever that implies. Those rows
--     exist: the API allowed this until today. They are not this file's to
--     rewrite, and the confirm handler's `unknown_source` filter stays in place
--     to keep reading them honestly.
--   * no *new* change can be made, by this application or by anyone at a `psql`
--     prompt;
--   * the file is additive and idempotent, and re-applying it is a no-op.
--
-- The application states the same rule twice above this: `updateAccountBody`
-- omits the field and `PATCH /api/accounts/:id` answers 422 rather than
-- stripping it, and `AccountPatch` keeps it out of the Store's type so no second
-- caller can reintroduce it. Those are where a user gets a readable refusal.
-- This is the floor under them — the guarantee that holds for a write that never
-- came through a Store at all.
--
-- INSERT is deliberately not covered: an insert is where an account gets its
-- currency, and there is nothing there to forbid.

-- ----------------------------------------------------------------------------
-- The rule
-- ----------------------------------------------------------------------------
-- `IS DISTINCT FROM` and not `<>`: the column is NOT NULL today, but a predicate
-- about "did this change" should not turn into NULL — and therefore pass — if
-- that ever stops being true.
--
-- Re-writing the same value is not a change and is allowed, which is the rule
-- the API applies as well: a client that PATCHes its whole form every save is
-- not asking for anything, and refusing it would mean the settings drawer could
-- no longer rename an account.
CREATE OR REPLACE FUNCTION core.account_currency_is_fixed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION
      'account % is denominated in %; an account''s currency is fixed at creation',
      OLD.id, OLD.currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- Attaching it
-- ----------------------------------------------------------------------------
-- `CREATE TRIGGER` has no `IF NOT EXISTS` before Postgres 14 and we do not rely
-- on one, hence the guard — a bare CREATE would succeed on the first sync and
-- then fail on every one after it, which is the wedge this directory's rules
-- exist to avoid. `DROP TRIGGER IF EXISTS` would also work and is deliberately
-- not used: nothing here drops anything it is not sanctioned to drop.
--
-- `UPDATE OF currency` narrows the firing to statements that name the column at
-- all, so the ordinary rename/buffer edit never reaches plpgsql. `PgStore
-- .updateAccount` no longer puts `currency` in a SET clause under any patch, so
-- on the application path this trigger has nothing to fire on.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'accounts_currency_is_fixed'
      AND tgrelid = 'core.accounts'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER accounts_currency_is_fixed
      BEFORE UPDATE OF currency
      ON core.accounts
      FOR EACH ROW
      EXECUTE FUNCTION core.account_currency_is_fixed();
  END IF;
END $$;
