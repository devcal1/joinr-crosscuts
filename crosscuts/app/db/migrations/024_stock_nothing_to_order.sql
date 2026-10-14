-- M11 · 4.3 "Nothing to order this month" (docs/plans/m11-contracts.md sections 7 and 15.19).
-- Additive only: two new columns on stock_orders, NULL for every existing row.
ALTER TABLE stock_orders ADD COLUMN nothing_at TEXT;                       -- when Ordering closed a counted month needing nothing
ALTER TABLE stock_orders ADD COLUMN nothing_by INTEGER REFERENCES users(id);
