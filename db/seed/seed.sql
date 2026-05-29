-- Seed data for local development. Idempotent-ish: safe to run on a fresh DB.

WITH u AS (
  INSERT INTO auth.users (email, display_name, status)
  VALUES ('demo@example.com', 'Demo User', 'active')
  ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
  RETURNING id
),
acc AS (
  INSERT INTO core.accounts (owner_user_id, name, description, currency, opening_balance_minor)
  SELECT u.id, 'Everyday Account', 'Primary current account', 'GBP', 250000 FROM u
  RETURNING id
)
INSERT INTO core.payments (account_id, name, category, amount_minor, due_date, recurrence, priority)
SELECT acc.id, v.name, v.category::core.payment_category, v.amount, v.due::date, v.rec::jsonb, v.priority
FROM acc, (VALUES
  ('Phone bill',     'monthly_recurring', 4500,   NULL,         NULL, 10),
  ('Car insurance',  'yearly_recurring',  32000,  '2026-09-01', NULL, 20),
  ('Water bill',     'custom_recurring',  9000,   '2026-07-01', '{"interval":3,"unit":"month","anchor":"2026-07-01"}', 30),
  ('Summer holiday', 'fixed_point',       120000, '2026-08-01', NULL, 5)
) AS v(name, category, amount, due, rec, priority);

INSERT INTO core.incomes (account_id, name, amount_minor, frequency, anchor_date)
SELECT a.id, 'Salary', 250000, 'monthly', '2026-01-25'
FROM core.accounts a WHERE a.name = 'Everyday Account';
