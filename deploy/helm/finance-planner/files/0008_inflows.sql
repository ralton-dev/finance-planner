-- 0008_inflows.sql — money arriving becomes a first-class record with a source.
--
-- `core.incomes` encodes one belief: money appears from outside. That is a
-- special case of the general truth — money arrives into an account either from
-- outside the estate (`source = 'external'`: salary, gift, interest) or out of
-- another account the same person owns (`source = 'account'`). The second is not
-- income. It is redistribution of money that has already been counted once, so
-- it is authored **once** and read from both ends: arriving on `account_id`,
-- leaving on `source_account_id`. Two independently-authored halves could drift;
-- one row cannot.
--
-- `core.incomes` is left exactly as it stands. Its rows are copied here once,
-- under their own ids so nothing downstream sees an identity change, and reads
-- move to this table. Dropping `core.incomes` is a separate, later, deliberate
-- migration.
--
-- Idempotent throughout — this file is re-applied on every sync. Every DDL
-- statement carries IF NOT EXISTS; the backfill runs exactly once ever, and the
-- paragraph above `core.migration_marks` explains how.

-- ----------------------------------------------------------------------------
-- One-shot migration marks
-- ----------------------------------------------------------------------------
-- A migration that only *creates* things can be re-run freely. A migration that
-- *copies user rows* cannot: a plain `WHERE NOT EXISTS` backfill resurrects
-- every row the user has since deleted, on the next deploy, forever. This table
-- is the durable "already done" record that makes copy-once possible.
CREATE TABLE IF NOT EXISTS core.migration_marks (
  key        text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- core.inflows
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.inflows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Where the money arrives.
  account_id        uuid NOT NULL REFERENCES core.accounts(id) ON DELETE CASCADE,
  name              text NOT NULL,
  -- 'external' = from outside the estate; 'account' = from another account.
  source            text NOT NULL DEFAULT 'external',
  -- Where the money leaves. Set exactly when source = 'account'. Cascades:
  -- a movement cannot outlive the account it comes out of.
  source_account_id uuid REFERENCES core.accounts(id) ON DELETE CASCADE,
  amount_minor      bigint NOT NULL CHECK (amount_minor >= 0),
  frequency         text NOT NULL,
  recurrence        jsonb,
  anchor_date       date NOT NULL,
  -- Rank among the outbound inflows of the *sending* account. Meaningless for
  -- source = 'external', which nothing sends. Lower is served first, matching
  -- core.payments.priority.
  priority          int NOT NULL DEFAULT 100,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inflow_source_known
    CHECK (source IN ('external', 'account')),
  -- Required when source = 'account', forbidden otherwise. The same shape as
  -- core.month_closes' scope check, read as an equivalence rather than an XOR
  -- because one side is a value test and the other a null test.
  CONSTRAINT inflow_source_account_scope
    CHECK ((source = 'account') = (source_account_id IS NOT NULL)),
  -- An account cannot fund itself: it would be money arriving out of nowhere,
  -- which is exactly what source = 'account' promises it is not.
  CONSTRAINT inflow_not_self_sourced
    CHECK (source_account_id IS NULL OR source_account_id <> account_id)
);

-- Arriving side: every read of "what lands here".
CREATE INDEX IF NOT EXISTS inflows_account_idx ON core.inflows (account_id);
-- Leaving side: the same rows read from the sending account, in the order it
-- serves them.
CREATE INDEX IF NOT EXISTS inflows_source_account_idx
  ON core.inflows (source_account_id, priority) WHERE source_account_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Backfill: every core.incomes row becomes an external inflow. Once. Ever.
-- ----------------------------------------------------------------------------
-- The claim CTE is the whole idempotency argument, in one statement:
--
--   * A data-modifying CTE is executed exactly once and always to completion,
--     so the INSERT into core.migration_marks always runs.
--   * ON CONFLICT DO NOTHING makes it return one row the first time and zero
--     rows every time after.
--   * CROSS JOIN claim therefore yields every income row on the first apply and
--     the empty set on every later apply — a deleted inflow is never resurrected.
--   * Mark and copy are one statement, so they commit or roll back together;
--     there is no window where the rows are copied but the mark is missing.
--   * ON CONFLICT (id) DO NOTHING is belt and braces: even a mark table wiped
--     by hand cannot produce a duplicate, because the inflow keeps the income's
--     own id.
--
-- Ids are carried over deliberately. Anything holding an income id — a URL, an
-- open browser tab — keeps working against the inflow it became.
WITH claim AS (
  INSERT INTO core.migration_marks (key)
  VALUES ('0008_incomes_to_inflows')
  ON CONFLICT (key) DO NOTHING
  RETURNING key
)
INSERT INTO core.inflows (
  id, account_id, name, source, source_account_id, amount_minor,
  frequency, recurrence, anchor_date, priority, active, created_at, updated_at
)
SELECT
  i.id, i.account_id, i.name, 'external', NULL, i.amount_minor,
  i.frequency, i.recurrence, i.anchor_date, 100, i.active, i.created_at, i.updated_at
FROM core.incomes i
CROSS JOIN claim
ON CONFLICT (id) DO NOTHING;
