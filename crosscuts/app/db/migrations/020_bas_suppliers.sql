-- M9 BAS sales and supplier accounts (docs/plans/m9-contracts.md section 2). Additive only:
-- three new tables and one index. No existing row changes.

-- One row per month that has a hand amount or has been lodged. A month with neither has no row.
-- period is 'YYYY-MM' (a Sydney calendar month).
CREATE TABLE bas_months (
  period TEXT PRIMARY KEY,
  hand_cents INTEGER,                                   -- GST-inclusive; may be negative (a refund)
  hand_gst_cents INTEGER,                               -- NULL = not known (imported history)
  hand_note TEXT NOT NULL DEFAULT '',
  lodged_at TEXT,                                       -- NULL while not lodged
  lodged_by INTEGER REFERENCES users(id),
  lodged_json TEXT,                                     -- frozen at lodge (section 5)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (hand_gst_cents IS NULL OR hand_cents IS NOT NULL),
  CHECK ((lodged_at IS NULL) = (lodged_json IS NULL))
);

-- The suppliers Accounts keep (never deleted; archived instead). Separate from the free-text
-- supplier names on Orders.
CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  from_period TEXT NOT NULL,                            -- first month it is listed in
  archived_from TEXT,                                   -- first month it is no longer listed in
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One supplier's line for one month. A listed supplier with no row is Waiting with blanks.
-- file_id is the statement attached to the line (Decision 6: one file per supplier per month);
-- this table is the link table, as task_files is for tasks.
CREATE TABLE supplier_statements (
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  period TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('have','waiting','na')),
  total_cents INTEGER,
  note TEXT NOT NULL DEFAULT '',
  reconciled INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0,1)),
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0,1)),
  myob INTEGER NOT NULL DEFAULT 0 CHECK (myob IN (0,1)),
  file_id INTEGER UNIQUE REFERENCES files(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (supplier_id, period)
);
CREATE INDEX idx_supplier_statements_period ON supplier_statements(period);

-- BAS reads paid invoices by month.
CREATE INDEX idx_invoices_paid_date ON invoices(paid_date) WHERE status = 'paid';
