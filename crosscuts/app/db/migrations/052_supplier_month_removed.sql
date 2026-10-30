-- Removing a supplier (or admin account) line from one month on Supplier accounts / Admin accounts
-- (Todd 2026-10-30). Additive: one new table. A row here hides that supplier from that month's
-- list; the supplier_statements row and its file are kept untouched, so a removal can be undone
-- by deleting the row here.
CREATE TABLE supplier_month_removed (
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  period TEXT NOT NULL,
  removed_by INTEGER REFERENCES users(id),
  removed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (supplier_id, period)
);
