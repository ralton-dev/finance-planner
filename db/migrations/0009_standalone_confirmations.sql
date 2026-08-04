-- 0009_standalone_confirmations.sql — "I moved the money", without a household.
--
-- core.transfer_confirmations (0004) was written when a household was the only
-- thing that could move money between two accounts, so `household_id` is
-- NOT NULL. Money you move between two accounts you own has no household in it,
-- and that one NOT NULL is what makes such a movement impossible to record.
-- Household is an attribution layer — whose money, who bears the cost, how a
-- shared cost splits — never a gate on whether a movement may be confirmed.
--
-- A movement is an authored core.inflows row with source = 'account' (0008), so
-- a confirmation with no household is scoped to the inflow it confirms. The
-- shape follows core.month_closes (0004): nullable scope columns, a CHECK that
-- something is named, and partial unique indexes doing the work a plain UNIQUE
-- cannot do over NULLs.
--
-- Additive only, and idempotent throughout — this file is re-applied on every
-- sync. Nothing is dropped: the existing `transfer_confirmation_unique`
-- constraint keeps guarding household rows exactly as it always did.

-- ----------------------------------------------------------------------------
-- The two scope columns
-- ----------------------------------------------------------------------------
-- Re-runnable: DROP NOT NULL on a column that is already nullable is a no-op.
ALTER TABLE core.transfer_confirmations
  ALTER COLUMN household_id DROP NOT NULL;

-- The movement this confirms. Cascades: a confirmation of a movement that no
-- longer exists has nothing left to be a confirmation *of*, and the
-- contributions it created follow it out through their own cascade, exactly as
-- un-confirming by hand would take them.
--
-- `member_user_id` deliberately stays NOT NULL. A solo movement has no
-- *member*, but it always has an actor — the person who says they moved it —
-- and that is what the column has always held. Relaxing it would buy nothing
-- and would cost every reader a null check.
ALTER TABLE core.transfer_confirmations
  ADD COLUMN IF NOT EXISTS inflow_id uuid REFERENCES core.inflows(id) ON DELETE CASCADE;

-- ----------------------------------------------------------------------------
-- A confirmation must be scoped to something
-- ----------------------------------------------------------------------------
-- Deliberately OR, not the XOR core.month_closes uses. A month close really is
-- one thing or the other — a household's month or an account's. A confirmation
-- is not: a movement can perfectly well be both an authored inflow *and* one a
-- household attributes to a member, and the whole point of this work is that
-- household stops being a boundary. An XOR here would forbid that state
-- forever, which is the same mistake as the NOT NULL above, one level along.
-- What must never exist is a confirmation scoped to *nothing*, and that is
-- exactly what this rejects. Every row written before this migration names a
-- household, so the constraint validates against existing data.
--
-- ADD CONSTRAINT has no IF NOT EXISTS, hence the guard: a bare ADD would
-- succeed once and then wedge every future sync.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transfer_confirmation_scope'
      AND conrelid = 'core.transfer_confirmations'::regclass
  ) THEN
    ALTER TABLE core.transfer_confirmations
      ADD CONSTRAINT transfer_confirmation_scope
      CHECK (household_id IS NOT NULL OR inflow_id IS NOT NULL);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Uniqueness over the standalone case
-- ----------------------------------------------------------------------------
-- `transfer_confirmation_unique` is UNIQUE (household_id, month, from, to,
-- member) and stays. Postgres treats NULLs as distinct, so with household_id
-- null it constrains nothing at all: the same movement could be confirmed any
-- number of times in one month, each one booking its contributions again. This
-- index is that hole, closed.
--
-- Keyed on the inflow rather than on (from, to): two different movements
-- between the same pair of accounts are two different rows in core.inflows —
-- a holiday pot and an ISA top-up out of the same current account — and each
-- gets confirmed on its own. `WHERE household_id IS NULL` scopes it to exactly
-- the case the constraint above cannot reach; a household-attributed movement
-- is one confirmation *per member*, which is the old constraint's business.
CREATE UNIQUE INDEX IF NOT EXISTS transfer_confirmations_inflow_month_unique
  ON core.transfer_confirmations (inflow_id, month)
  WHERE household_id IS NULL;

-- ----------------------------------------------------------------------------
-- Reading a movement's confirmations without naming a household
-- ----------------------------------------------------------------------------
-- The two faces of one row, mirroring inflows_account_idx /
-- inflows_source_account_idx in 0008: what arrived here, and what left here.
-- Partial, because a household-derived confirmation carries no inflow and is
-- always read through transfer_confirmations_household_month_idx instead.
CREATE INDEX IF NOT EXISTS transfer_confirmations_to_account_month_idx
  ON core.transfer_confirmations (to_account_id, month)
  WHERE inflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS transfer_confirmations_from_account_month_idx
  ON core.transfer_confirmations (from_account_id, month)
  WHERE inflow_id IS NOT NULL;
