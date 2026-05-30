-- 0002_projects.sql — cross-account groupings of payments.
-- Idempotent: safe to apply against an already-migrated database.

CREATE TABLE IF NOT EXISTS core.projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL,
  name            text NOT NULL,
  description     text,
  color           text,
  target_date     date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON core.projects (owner_user_id);

-- Nullable FK: a payment can belong to 0 or 1 projects. When a project is
-- deleted, member payments lose the link but otherwise stay intact.
ALTER TABLE core.payments
  ADD COLUMN IF NOT EXISTS project_id uuid
    REFERENCES core.projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS payments_project_idx ON core.payments (project_id);
