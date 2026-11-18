-- 0.2.23: the saved supplier order a line is on NOW (docs/plans/purchase-orders-plan.md). Additive only.
-- Set by lib/orders.js markOrderedMany when a supplier order's Mark ordered saves the order; cleared when the
-- line goes back to to_order, is cancelled, or is ordered again by any other path (a single PATCH).
-- Received keeps it. supplier_order_lines keeps the history; this column is the current link.
ALTER TABLE orders ADD COLUMN supplier_order_id INTEGER REFERENCES supplier_orders(id);
