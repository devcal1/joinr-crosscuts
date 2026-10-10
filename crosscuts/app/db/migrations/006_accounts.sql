-- M2 Accounts (docs/plans/m2-contracts.md section 1). Additive only: new tables,
-- one nullable jobs column, no invoice rows created (m2-plan decision 5).
ALTER TABLE jobs ADD COLUMN client_abn TEXT;            -- Q-A: optional, printed on invoices

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit','progress','final','extra')),
  status TEXT NOT NULL CHECK (status IN ('pending','due','issued','paid','waived','void')),
  number TEXT UNIQUE,                                   -- null until issued
  lines_custom INTEGER NOT NULL DEFAULT 0 CHECK (lines_custom IN (0,1)),
  total_cents INTEGER,                                  -- frozen at issue
  gst_cents INTEGER,                                    -- frozen at issue: round(total/11)
  became_due_date TEXT,
  due_reason TEXT CHECK (due_reason IS NULL OR due_reason IN ('scheduled','materials_ordered','completed','manual')),
  issue_date TEXT,
  due_date TEXT,                                        -- payment due; default issue_date + 10 days
  paid_date TEXT,
  bill_to_name TEXT,                                    -- client snapshot, frozen at issue
  bill_to_address TEXT,
  bill_to_abn TEXT,
  site_address TEXT,
  myob_entered_date TEXT,
  external_id TEXT,                                     -- MYOB slot (D12); stored, never called
  notes TEXT NOT NULL DEFAULT '',
  last_contacted_date TEXT,
  follow_up_notes TEXT NOT NULL DEFAULT '',
  void_reason TEXT,
  waive_reason TEXT,
  replaces_id INTEGER REFERENCES invoices(id),          -- set on the copy made by a void
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_invoices_one_live ON invoices(job_id, kind)
  WHERE kind <> 'extra' AND status <> 'void';
CREATE INDEX idx_invoices_job ON invoices(job_id);
CREATE INDEX idx_invoices_status ON invoices(status, due_date);

CREATE TABLE invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  sort_order INTEGER NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL                         -- GST-inclusive; may be negative (a discount line)
);
CREATE INDEX idx_invoice_lines_invoice ON invoice_lines(invoice_id, sort_order);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  entity_type TEXT,
  entity_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id)
);
