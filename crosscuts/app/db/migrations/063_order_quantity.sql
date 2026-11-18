-- 0.2.22: job cards and supplier orders (docs/plans/jobcards-plan.md). Additive only.
-- An order line's quantity: a positive number up to 2 decimals (checked in lib/orders.js). NULL on
-- lines made before this and when left blank.
ALTER TABLE orders ADD COLUMN quantity REAL;
