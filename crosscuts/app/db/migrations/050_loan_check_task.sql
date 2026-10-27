-- Accounts and vehicles (0.2.7, docs/plans/m28-contracts.md section 4; Todd 2026-10-28): the monthly
-- Accounts department task "Check loan balances against statements", seeded once. Additive: one row,
-- and only if no rule of that title exists (a migration runs once, so a deleted rule is not re-made).
-- First due on the 1st of next month (Sydney); editable and deletable on Admin > Tasks.
INSERT INTO recurring_tasks (title, notes, dept, repeat, start_date, created_from)
SELECT 'Check loan balances against statements',
       'Tick Statement checked on each loan month on Accounts > Loans once it matches the lender''s statement.',
       'accounts', 'monthly',
       date('now', '+10 hours', 'start of month', '+1 month'),
       date('now', '+10 hours')
 WHERE NOT EXISTS (SELECT 1 FROM recurring_tasks WHERE title = 'Check loan balances against statements');
