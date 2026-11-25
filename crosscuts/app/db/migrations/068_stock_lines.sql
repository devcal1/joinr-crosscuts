-- 0.2.27: monthly stock orders on the Orders page (docs/plans/stock-orders-plan.md). Additive only:
-- one new table and two new columns; nothing is changed or deleted.
--
-- stock_lines: one row per stock item on a month's order, with no job. Made by hand (Orders page)
-- or by a count's rule A (lib/stocklines.js). A soft-deleted row keeps its place (deleted_at, deleted_by)
-- and is in no list or count. supplier_order_id is the saved supplier order (PO) the line is on now;
-- cleared by Undo ordered, kept when received.
CREATE TABLE stock_lines (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  month             TEXT NOT NULL,                 -- YYYY-MM (Sydney)
  supplier          TEXT NOT NULL CHECK (length(trim(supplier)) > 0),
  item              TEXT NOT NULL CHECK (length(trim(item)) > 0),
  code              TEXT NOT NULL DEFAULT '',
  quantity          REAL NOT NULL CHECK (quantity > 0),
  status            TEXT NOT NULL DEFAULT 'to_order' CHECK (status IN ('to_order', 'ordered', 'received')),
  ordered_date      TEXT,
  expected_date     TEXT,
  received_date     TEXT,
  received_by       INTEGER REFERENCES users(id),
  notes             TEXT NOT NULL DEFAULT '',
  delivery_note     TEXT NOT NULL DEFAULT '',
  source            TEXT NOT NULL CHECK (source IN ('count', 'hand')),
  stock_item_id     INTEGER REFERENCES stock_items(id),
  supplier_order_id INTEGER REFERENCES supplier_orders(id),
  deleted_at        TEXT,
  deleted_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  created_by        INTEGER REFERENCES users(id),
  updated_at        TEXT NOT NULL,
  updated_by        INTEGER REFERENCES users(id)
);
CREATE INDEX idx_stock_lines_month ON stock_lines(month);
CREATE INDEX idx_stock_lines_status ON stock_lines(status);
CREATE INDEX idx_stock_lines_item_status ON stock_lines(stock_item_id, status);

-- A count sent to the monthly order (rule A): when, and the month its lines went to.
ALTER TABLE stock_orders ADD COLUMN sent_at TEXT;
ALTER TABLE stock_orders ADD COLUMN sent_period TEXT;
