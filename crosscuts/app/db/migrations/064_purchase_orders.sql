-- 0.2.23: supplier orders kept as purchase orders with a frozen PDF (docs/plans/purchase-orders-plan.md).
-- Additive only: two new tables.
--
-- A saved supplier order. po_seq is the PO number (PO- plus po_seq padded to 4 digits), allocated as
-- MAX+1 inside the mark-ordered transaction and never reused (there is no delete). snapshot_json is
-- the order exactly as it was when Mark ordered was pressed (lib/purchaseorders.js); it is never
-- changed. pdf_path is the stored PDF's bare file name in <UPLOADS_DIR>/files (NULL until it is made);
-- once made it is never re-rendered.
CREATE TABLE supplier_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  po_seq        INTEGER UNIQUE NOT NULL,
  supplier      TEXT NOT NULL,
  ordered_date  TEXT NOT NULL,
  expected_date TEXT,
  supplier_ref  TEXT NOT NULL DEFAULT '',
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  pdf_path      TEXT,
  pdf_made_at   TEXT
);

-- The order lines on a saved order, in the screen's order. A line can be on more than one saved order
-- over time (ordered, undone, ordered again); the history is kept.
CREATE TABLE supplier_order_lines (
  supplier_order_id INTEGER NOT NULL REFERENCES supplier_orders(id),
  order_id          INTEGER NOT NULL REFERENCES orders(id),
  sort              INTEGER NOT NULL,
  PRIMARY KEY (supplier_order_id, order_id)
);
CREATE INDEX idx_supplier_order_lines_order ON supplier_order_lines(order_id);
