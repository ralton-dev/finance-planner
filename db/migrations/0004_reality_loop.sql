-- 0004_reality_loop.sql — ground the plan in reality.
-- Adds the contributions ledger (dated money-set-aside records that make
-- payments' already-saved a derived value), manual balance check-ins,
-- household transfer confirmations ("I made this month's transfer"), and
-- frozen month-close scorecards.
-- Idempotent: safe to apply against an already-migrated database.

-- A member confirming a planned monthly transfer between two accounts. The
-- contributions it implies reference it so un-confirming cleans them up.
CREATE TABLE IF NOT EXISTS core.transfer_confirmations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id    uuid NOT NULL,
  month           date NOT NULL, -- first day of the month it belongs to
  from_account_id uuid NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
  to_account_id   uuid NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
  member_user_id  uuid NOT NULL,
  amount_minor    bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfer_confirmation_unique
    UNIQUE (household_id, month, from_account_id, to_account_id, member_user_id)
);
CREATE INDEX IF NOT EXISTS transfer_confirmations_household_month_idx
  ON core.transfer_confirmations (household_id, month);

-- Dated ledger of money set aside toward a payment. A payment's effective
-- already-saved = payments.already_saved_minor (manual base) + SUM(these).
-- Rows created by confirming a household transfer carry the confirmation id
-- so deleting the confirmation removes them too.
CREATE TABLE IF NOT EXISTS core.contributions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id               uuid NOT NULL REFERENCES core.payments(id) ON DELETE CASCADE,
  account_id               uuid NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
  user_id                  uuid,          -- whose money / who recorded it
  month                    date NOT NULL, -- first day of the month it belongs to
  amount_minor             bigint NOT NULL,
  note                     text,
  transfer_confirmation_id uuid REFERENCES core.transfer_confirmations(id) ON DELETE CASCADE,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contributions_payment_idx ON core.contributions (payment_id);
CREATE INDEX IF NOT EXISTS contributions_account_month_idx
  ON core.contributions (account_id, month);

-- Manual balance check-ins: one per account per day, newest wins on conflict.
-- The planner stays transaction-free; these anchor plans to real money.
CREATE TABLE IF NOT EXISTS core.balance_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
  as_of_date    date NOT NULL,
  balance_minor bigint NOT NULL, -- may be negative (overdraft)
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT balance_snapshot_unique UNIQUE (account_id, as_of_date)
);
CREATE INDEX IF NOT EXISTS balance_snapshots_account_idx
  ON core.balance_snapshots (account_id, as_of_date);

-- Frozen month scorecards: what the plan asked for vs what got recorded.
-- Scoped to exactly one of a household or a standalone account.
CREATE TABLE IF NOT EXISTS core.month_closes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id      uuid,
  account_id        uuid REFERENCES core.accounts(id) ON DELETE CASCADE,
  month             date NOT NULL, -- first day of the closed month
  income_minor      bigint NOT NULL,
  planned_minor     bigint NOT NULL,
  contributed_minor bigint NOT NULL,
  closed_by         uuid,
  closed_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT month_close_scope CHECK ((household_id IS NULL) <> (account_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS month_closes_household_month_unique
  ON core.month_closes (household_id, month) WHERE household_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS month_closes_account_month_unique
  ON core.month_closes (account_id, month) WHERE account_id IS NOT NULL;
