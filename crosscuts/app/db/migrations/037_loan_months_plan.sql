-- Loans, monthly interest and plans (0.2.0, Todd 2026-10-24; docs/plans/m13-contracts.md section 6,
-- "changed 2026-10-24"). Additive only: new columns with defaults and one new table.
--
-- Interest is now charged once per calendar month on the balance at the start of the month and
-- ADDED to the balance; a payment reduces the balance by its total and is split automatically
-- (interest part = the month's interest still unpaid, the rest principal). loan_repayments keeps
-- principal_cents + interest_cents (their sum is the total paid); the split is worked out again
-- after every write unless interest_override = 1 (the interest part was typed to match a lender).
ALTER TABLE loan_repayments ADD COLUMN interest_override INTEGER NOT NULL DEFAULT 0 CHECK (interest_override IN (0, 1));

-- The plan per loan: a fixed amount a month, or paid off by a month (YYYY-MM); NULL = no plan.
ALTER TABLE loans ADD COLUMN plan_kind TEXT CHECK (plan_kind IS NULL OR plan_kind IN ('amount', 'payoff'));
ALTER TABLE loans ADD COLUMN plan_amount_cents INTEGER CHECK (plan_amount_cents IS NULL OR plan_amount_cents BETWEEN 1 AND 10000000000);
ALTER TABLE loans ADD COLUMN plan_payoff_period TEXT;

-- A month's charged interest typed to match a lender statement (instead of the worked-out figure).
CREATE TABLE loan_month_interest (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  period TEXT NOT NULL,                                   -- YYYY-MM
  interest_cents INTEGER NOT NULL CHECK (interest_cents BETWEEN 0 AND 10000000000),
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  UNIQUE (loan_id, period)
);
