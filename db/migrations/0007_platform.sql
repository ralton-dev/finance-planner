-- 0007_platform.sql — email digest opt-in + the send-once log.
-- Backs the daily notification digest: a per-user switch, and a record of what
-- has already gone out so a restarted (or briefly duplicated) notifier cannot
-- mail the same person twice for the same day.
-- Idempotent: safe to apply against an already-migrated database.

-- Off by default. Nobody is opted into mail they didn't ask for.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS notify_email boolean NOT NULL DEFAULT false;

-- One row per notification actually sent. The unique key is the whole point:
-- the sender claims a (user, day, kind) slot with an INSERT ... ON CONFLICT DO
-- NOTHING and only mails when it wins the row.
CREATE TABLE IF NOT EXISTS core.notification_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date       date NOT NULL,
  kind       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, date, kind)
);
CREATE INDEX IF NOT EXISTS notification_log_user_idx ON core.notification_log (user_id);
