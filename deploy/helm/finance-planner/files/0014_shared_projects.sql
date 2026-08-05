-- 0014_shared_projects.sql — a project is personal, or shared with your household.
--
-- Product direction (Ben, 2026-08-05, MINE-AND-OURS.md decision 22): a project
-- says which it is, and "shared" means shared into the owner's household. One
-- column, no `project_shares` table, no permission enum — because there is only
-- ever one possible target and only one thing to say about it.
--
-- ## Why there is no `household_id` column here
--
-- A user belongs to exactly one household (0011_one_household_per_user.sql), so
-- "shared" already names its audience without being told: it resolves through
-- the owner's membership **at read time**. A stored household id would be a
-- second copy of a fact that can change underneath it — the owner leaves, the
-- household is deleted, they join another — and the copy would go stale silently
-- while still being the thing a reader trusts. A project whose owner has no
-- household is shared with nobody, which is exactly what reading through the
-- membership says, and exactly what a stale stored id would not.
--
-- The membership is also what the departure rule leans on (decision 23): a
-- member who leaves keeps their projects, never the household's contents, so on
-- leaving their shared projects flip back to 'personal' and drop the payments on
-- accounts they do not own. That is a Store cascade rather than a database one —
-- it spans `core.payments`, `core.projects` and `auth.account_shares`, and it is
-- stated once in `Store.removeMember` where the rest of the departure cascade
-- already lives.
--
-- Additive only. This file drops nothing, deletes nothing and claims no
-- sanctioned exception — the two granted so far (0010, 0013) stay at two. It is
-- re-applied in full, in lexical order, on every sync under
-- `psql -v ON_ERROR_STOP=1`, so every statement below is idempotent.

-- ----------------------------------------------------------------------------
-- Which it is
-- ----------------------------------------------------------------------------
-- `NOT NULL DEFAULT 'personal'`, and both halves matter. The default is what
-- makes this safe to apply to a table that already has rows: every project
-- written before this file existed was one person's and nobody else's, which is
-- precisely what 'personal' means, so the backfill is the truth rather than a
-- placeholder. And the default is what keeps every existing writer working —
-- `INSERT` statements that have never heard of this column go on succeeding and
-- go on producing personal projects.
--
-- text rather than an enum type, matching `core.payments.scope` (0003) and
-- `core.household_account_assignments.role`: an enum's value list can only be
-- extended by ALTER TYPE, which has no idempotent form, and a CHECK states the
-- same rule in a place a later migration can restate.
ALTER TABLE core.projects
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'personal';

-- ----------------------------------------------------------------------------
-- …and it is one of exactly two things
-- ----------------------------------------------------------------------------
-- `ADD CONSTRAINT` has no `IF NOT EXISTS` form, so it is guarded by name — a
-- bare ADD would succeed on the first sync and fail on every one after it, which
-- is the wedge this directory's rules exist to avoid.
--
-- A CHECK rather than a trigger, and safe as one: a constraint is validated
-- against existing rows, but the column it constrains was created by the
-- statement above with a NOT NULL DEFAULT, so on any database that has ever run,
-- every row reads 'personal' and satisfies this trivially. The hazard 0011 and
-- 0012 were shaped around — a rule that cannot be proven of data already in the
-- table wedging every future deploy at the same line — is not reachable from
-- here.
--
-- Nothing in this directory adds a constraint of this name under any other
-- predicate, so a re-run after the first finds it present and does nothing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_visibility'
      AND conrelid = 'core.projects'::regclass
  ) THEN
    ALTER TABLE core.projects
      ADD CONSTRAINT project_visibility
      CHECK (visibility IN ('personal', 'shared'));
  END IF;
END $$;

-- No new index. Every question this column is asked arrives with an owner
-- attached — "the projects of these people, of which the shared ones" — and
-- `projects_owner_idx` (0002) already leads on `owner_user_id`. A second index
-- on a two-valued column behind that one would earn nothing.
