-- 0003_household_shares.sql — proportional household cost-sharing.
-- Adds per-member contribution shares, per-payment cost scope, and per-household
-- account roles. Together these drive the household plan engine: shared costs
-- split by share, personal costs borne by one member, and the transfers needed
-- between accounts to fund everything.
-- Idempotent: safe to apply against an already-migrated database.

-- Each member's proportional contribution to shared costs, in basis points
-- (0–10000). The engine normalises against the household total, so 6600/3400
-- and 66/34 produce the same split.
ALTER TABLE auth.household_memberships
  ADD COLUMN IF NOT EXISTS contribution_share_bp integer NOT NULL DEFAULT 0;

-- Per-payment cost attribution: 'shared' (split across members by share) or
-- 'personal' (borne entirely by bearer_user_id, defaulting at compute time to
-- the owning member of a personal account).
ALTER TABLE core.payments
  ADD COLUMN IF NOT EXISTS scope          text NOT NULL DEFAULT 'shared',
  ADD COLUMN IF NOT EXISTS bearer_user_id uuid;

-- Per-household account role: a shared pot, or personal to one member. Distinct
-- from auth.account_shares (which grants view/edit access) — this drives cost
-- attribution and transfer derivation, not permissions. Unique per (household,
-- account); cascades when the account is deleted.
CREATE TABLE IF NOT EXISTS core.household_account_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id   uuid NOT NULL,
  account_id     uuid NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
  role           text NOT NULL DEFAULT 'shared',
  member_user_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT household_account_unique UNIQUE (household_id, account_id),
  CONSTRAINT personal_needs_member
    CHECK (role <> 'personal' OR member_user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS assignments_household_idx
  ON core.household_account_assignments (household_id);
CREATE INDEX IF NOT EXISTS assignments_account_idx
  ON core.household_account_assignments (account_id);
