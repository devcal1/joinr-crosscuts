-- Accounts and vehicles (0.2.7, docs/plans/m28-contracts.md). Additive only: new tables and new
-- nullable columns. The vehicles register starts empty (Todd 2026-10-28).

-- The vehicles register: dates and bookings only, no costs (Todd 2026-10-26).
CREATE TABLE vehicles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  rego TEXT NOT NULL DEFAULT '',
  make_model TEXT NOT NULL DEFAULT '',
  rego_expiry TEXT,                          -- YYYY-MM-DD
  insurance_expiry TEXT,                     -- YYYY-MM-DD
  insurer TEXT NOT NULL DEFAULT '',
  policy_number TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

-- Service, repair and inspection bookings; the workshop manager books and confirms them.
CREATE TABLE vehicle_bookings (
  id INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  kind TEXT NOT NULL CHECK (kind IN ('service', 'repair', 'inspection', 'other')),
  date TEXT NOT NULL,                        -- YYYY-MM-DD
  time TEXT,                                 -- HH:MM or NULL
  place TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  done_at TEXT,
  done_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_vehicle_bookings_date ON vehicle_bookings(date);
CREATE INDEX idx_vehicle_bookings_vehicle ON vehicle_bookings(vehicle_id, date);

-- One bell per vehicle, expiry kind, threshold (30 or 7 days) and expiry date.
CREATE TABLE vehicle_bells (
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  what TEXT NOT NULL CHECK (what IN ('rego', 'insurance')),
  threshold INTEGER NOT NULL CHECK (threshold IN (30, 7)),
  expiry TEXT NOT NULL,
  belled_at TEXT NOT NULL,
  PRIMARY KEY (vehicle_id, what, threshold, expiry)
);

-- Individual (non-account) invoices to pay, listed under the supplier accounts in their month.
CREATE TABLE payables (
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL,                      -- YYYY-MM, the month it is listed in
  payee TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER,                      -- NULL: the figure is missing
  due_date TEXT,
  file_id INTEGER UNIQUE REFERENCES files(id),
  myob INTEGER NOT NULL DEFAULT 0 CHECK (myob IN (0, 1)),
  paid_date TEXT,
  paid_by INTEGER REFERENCES users(id),
  supplier_id INTEGER REFERENCES suppliers(id),   -- set when the payee was made a supplier account
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id),
  added_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_payables_period ON payables(period);

-- Invoices: sent, the follow-up interval per invoice, and the contact log.
ALTER TABLE invoices ADD COLUMN sent_date TEXT;
ALTER TABLE invoices ADD COLUMN followup_days INTEGER CHECK (followup_days IS NULL OR followup_days BETWEEN 1 AND 365);
CREATE TABLE invoice_contacts (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  by_user INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_invoice_contacts_invoice ON invoice_contacts(invoice_id, date);

-- Each client's default payment terms (days), keyed by the folded client name on the job.
CREATE TABLE client_terms (
  client_key TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  followup_days INTEGER NOT NULL CHECK (followup_days BETWEEN 1 AND 365),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- Loans: a month ticked as checked against the lender's statement.
CREATE TABLE loan_months (
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  period TEXT NOT NULL,                      -- YYYY-MM
  checked_at TEXT NOT NULL,
  checked_by INTEGER REFERENCES users(id),
  PRIMARY KEY (loan_id, period)
);
