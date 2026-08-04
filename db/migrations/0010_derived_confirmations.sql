-- 0010_derived_confirmations.sql — "I moved the money", for a transfer nobody
-- authored and no household attributes.
--
-- 0009 made a confirmation reachable without a household by scoping it to the
-- inflow it confirms, and wrote `transfer_confirmation_scope` to forbid the one
-- shape it could not read: a confirmation scoped to *nothing*. That was right
-- about the tree it was written for, where every movement between two accounts
-- was authored as a `core.inflows` row. It stops being right the moment the
-- plan derives a transfer itself: an account with obligations and no income has
-- its feed computed rather than authored, so there is no inflow to point at —
-- and a user with no household has no household id either. Both scope columns
-- are null, and the row is nonetheless as precisely located as any other, by
-- (from_account_id, to_account_id, month, member_user_id): which money, moving
-- where, in which month, moved by whom. Four columns, every one of them already
-- NOT NULL since 0004.
--
-- So "scoped to nothing" was never a real state. What 0009 called scope is one
-- of the two *attribution* layers a movement may carry — a household's claim on
-- it, an inflow row authoring it — and neither is what locates the movement in
-- the world. The constraint keeps its name and states the true thing instead.
--
-- ## Why this drops a constraint, and why nothing else does
--
-- Sanctioned exception (ONE-ENGINE.md, 2026-08-04), and the only DROP in this
-- work. A CHECK cannot be widened additively: constraints are ANDed, so a
-- second, more permissive CHECK alongside the first loosens nothing — the older
-- one still refuses the row on its own. Dropping and re-adding is the only
-- route, and re-adding under the *same name* is not a stylistic choice: 0009
-- re-runs immediately before this file on every sync and re-adds
-- `transfer_confirmation_scope` whenever it finds the name free. Once derived
-- rows exist, that ADD would validate against them, fail, and wedge every
-- future sync under ON_ERROR_STOP=1. Holding the name is what keeps 0009's
-- guard a no-op forever.
--
-- Idempotent throughout — this file is re-applied on every sync. No data is
-- touched, and nothing else is dropped.

-- ----------------------------------------------------------------------------
-- The scope rule, restated over the columns that actually carry scope
-- ----------------------------------------------------------------------------
-- Two guarded steps inside one statement, so the table is never briefly
-- unconstrained and a failure rolls the pair back together.
--
--   * Step 1 fires only while 0009's predicate is in force, recognised by the
--     one column the new rule does not mention. After the swap the definition
--     no longer matches and a re-run does nothing.
--   * Step 2 takes the name back. It fires on the sync that frees it, and again
--     only if the name is ever found free for some other reason.
--
-- The new predicate is true of every row that can exist, because all four
-- columns are NOT NULL at the table level — so it validates instantly against
-- existing data and can never fail an apply. That does not make it idle. It is
-- the durable statement of what scopes a confirmation, and it fails loudly on
-- the day someone relaxes one of those NOT NULLs the way 0009 relaxed
-- household_id — which is the mistake this whole line of work exists to catch
-- one level earlier each time.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transfer_confirmation_scope'
      AND conrelid = 'core.transfer_confirmations'::regclass
      AND pg_get_constraintdef(oid) LIKE '%inflow_id%'
  ) THEN
    ALTER TABLE core.transfer_confirmations
      DROP CONSTRAINT transfer_confirmation_scope;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transfer_confirmation_scope'
      AND conrelid = 'core.transfer_confirmations'::regclass
  ) THEN
    ALTER TABLE core.transfer_confirmations
      ADD CONSTRAINT transfer_confirmation_scope
      CHECK (from_account_id IS NOT NULL
             AND to_account_id IS NOT NULL
             AND month IS NOT NULL
             AND member_user_id IS NOT NULL);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Uniqueness over the derived case
-- ----------------------------------------------------------------------------
-- The same hole 0009 closed, one shape along. `transfer_confirmation_unique`
-- (0004) is UNIQUE (household_id, month, from, to, member) and, because
-- Postgres treats NULLs as distinct, sees nothing with a null household;
-- `transfer_confirmations_inflow_month_unique` (0009) is UNIQUE (inflow_id,
-- month) and sees nothing with a null inflow. A derived confirmation is null in
-- both, so without this it could be recorded any number of times in one month,
-- booking its contributions again each time.
--
-- Keyed on the scope itself, since that is what identifies the movement. Two
-- derived feeds out of one account into two different pots are two movements
-- and confirm separately; the same feed twice in one month is one movement
-- recorded twice, and is refused. The WHERE clause is exactly the case neither
-- older key can reach, so neither is disturbed — an authored movement and a
-- derived feed between the same two accounts in the same month coexist,
-- because they are different movements.
CREATE UNIQUE INDEX IF NOT EXISTS transfer_confirmations_derived_month_unique
  ON core.transfer_confirmations (from_account_id, to_account_id, month, member_user_id)
  WHERE household_id IS NULL AND inflow_id IS NULL;

-- ----------------------------------------------------------------------------
-- Reading a derived confirmation from the receiving end
-- ----------------------------------------------------------------------------
-- "What arrived here this month" — the pot's side of its own feed, mirroring
-- transfer_confirmations_to_account_month_idx in 0009. The sending side needs
-- no index of its own: from_account_id is the leading column of the unique
-- index above, which carries the same partial predicate.
CREATE INDEX IF NOT EXISTS transfer_confirmations_derived_to_account_month_idx
  ON core.transfer_confirmations (to_account_id, month)
  WHERE household_id IS NULL AND inflow_id IS NULL;
