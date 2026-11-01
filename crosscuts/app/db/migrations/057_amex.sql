-- 0.2.12 (Todd 2026-11-02): the AMEX page, a company credit card ledger under Accounts. Charges
-- (transactions) and repayments; a repayment covers the transactions it was ticked against. No
-- interest. Soft delete through removed_at. Additive only.
CREATE TABLE amex_repayments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paid_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  note TEXT NOT NULL DEFAULT '',
  removed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE amex_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_date TEXT NOT NULL,
  supplier TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  repayment_id INTEGER REFERENCES amex_repayments(id),
  removed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_amex_txn_date ON amex_transactions(txn_date);
CREATE INDEX idx_amex_txn_repayment ON amex_transactions(repayment_id);
CREATE INDEX idx_amex_rep_date ON amex_repayments(paid_date);
