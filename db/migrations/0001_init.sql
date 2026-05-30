-- 0001_init.sql — initial schema.
-- Money is always stored as integer minor units (pennies); never floats.
-- Kept in sync with packages/data/src/schema.ts (Drizzle).

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS calc;

-- ----------------------------------------------------------------------------
-- auth
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth.users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  password_hash  text,
  display_name   text NOT NULL,
  status         text NOT NULL DEFAULT 'active',
  email_verified boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth.sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL,
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_token_idx ON auth.sessions (refresh_token_hash);

CREATE TABLE IF NOT EXISTS auth.email_verification_tokens (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS auth.households (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth.household_memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES auth.households(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  role         text NOT NULL DEFAULT 'member',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON auth.household_memberships (user_id);

CREATE TABLE IF NOT EXISTS auth.account_shares (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL,
  household_id uuid NOT NULL,
  permission   text NOT NULL DEFAULT 'view',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shares_account_idx ON auth.account_shares (account_id);
CREATE INDEX IF NOT EXISTS shares_household_idx ON auth.account_shares (household_id);

-- ----------------------------------------------------------------------------
-- core
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id         uuid NOT NULL,
  name                  text NOT NULL,
  description           text,
  currency              text NOT NULL DEFAULT 'GBP',
  opening_balance_minor bigint NOT NULL DEFAULT 0,
  monthly_buffer_minor  bigint NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accounts_owner_idx ON core.accounts (owner_user_id);

CREATE TABLE IF NOT EXISTS core.incomes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
  name         text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  frequency    text NOT NULL,
  recurrence   jsonb,
  anchor_date  date NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incomes_account_idx ON core.incomes (account_id);

CREATE TABLE IF NOT EXISTS core.payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
  name                text NOT NULL,
  category            text NOT NULL,
  amount_minor        bigint NOT NULL CHECK (amount_minor >= 0),
  due_date            date,
  recurrence          jsonb,
  target_date         date,
  priority            int NOT NULL DEFAULT 100,
  already_saved_minor bigint NOT NULL DEFAULT 0 CHECK (already_saved_minor >= 0),
  auto_renew          boolean NOT NULL DEFAULT true,
  active              boolean NOT NULL DEFAULT true,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fixed_point_needs_due_date
    CHECK (category <> 'fixed_point' OR due_date IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS payments_account_idx ON core.payments (account_id);
CREATE INDEX IF NOT EXISTS payments_account_priority_idx ON core.payments (account_id, priority);

-- ----------------------------------------------------------------------------
-- calc
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calc.plan_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
  computed_at timestamptz NOT NULL DEFAULT now(),
  as_of_date  date NOT NULL,
  inputs_hash text NOT NULL,
  detail      jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_snapshots_account_idx ON calc.plan_snapshots (account_id, computed_at DESC);
