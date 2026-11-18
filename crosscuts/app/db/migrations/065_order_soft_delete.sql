-- 0.2.23: delete lines and cards (Todd 2026-11-18; docs/plans/purchase-orders-plan.md "Delete lines and
-- cards"). Additive only. A deleted order line keeps its row: deleted_at (UTC ISO) and deleted_by are
-- set, and every list and count leaves it out (lib/orders.js). An admin can restore it (both cleared).
ALTER TABLE orders ADD COLUMN deleted_at TEXT;
ALTER TABLE orders ADD COLUMN deleted_by INTEGER REFERENCES users(id);
