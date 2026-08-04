-- 0006_goal_modes_and_tags.sql — contribution-first goals + payment tags.
-- Adds the monthly contribution a fixed_point goal is funded at (making its
-- due date optional: the pace derives the finish date instead), and a free-text
-- label for grouping payments in charts.
-- Idempotent: safe to apply against an already-migrated database.

-- "I will set aside this much per month." Honoured only for category
-- 'fixed_point' — every other category is a bill with a real deadline, so the
-- engine ignores the cap there. NULL keeps the original behaviour: derive the
-- monthly contribution from the amount and the date.
ALTER TABLE core.payments ADD COLUMN IF NOT EXISTS fixed_monthly_minor bigint;

-- Free-text grouping label ("housing", "car", …). Deliberately not an enum or a
-- lookup table: it is a user's own vocabulary, and the plan never branches on it.
ALTER TABLE core.payments ADD COLUMN IF NOT EXISTS tag text;
