-- 0001_init.sql — initial schema scaffold.
-- Money is always stored as integer minor units (pennies); never floats.
-- See plan/02-domain-model.md for the full model.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS calc;

-- ----------------------------------------------------------------------------
-- core
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE core.payment_category AS ENUM
    ('monthly_recurring','yearly_recurring','custom_recurring','fixed_point');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE core.frequency AS ENUM ('monthly','yearly','custom','one_off');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS core.accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id         uuid NOT NULL,
  name                  text NOT NULL,
  description           text,
  currency              char(3) NOT NULL DEFAULT 'GBP',
  opening_balance_minor bigint NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.incomes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
  name         text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  frequency    core.frequency NOT NULL,
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
  category            core.payment_category NOT NULL,
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
-- auth (minimal scaffold; expanded in the auth phase — see plan/06)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  password_hash text,
  display_name  text NOT NULL,
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- calc
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calc.plan_snapshots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid REFERENCES core.accounts(id) ON DELETE CASCADE,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  as_of_date           date NOT NULL,
  monthly_income_minor bigint NOT NULL,
  total_required_minor bigint NOT NULL,
  total_funded_minor   bigint NOT NULL,
  leftover_minor       bigint NOT NULL,
  shortfall_minor      bigint NOT NULL,
  inputs_hash          text NOT NULL,
  detail               jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_snapshots_account_idx
  ON calc.plan_snapshots (account_id, computed_at DESC);
