-- 0.2.13 (Todd 2026-11-07): sending an invoice by email through Resend. One row per send
-- (a re-send is a new row). status: sent (Resend accepted it, delivery not yet known), delivered,
-- bounced, failed. The sweep polls Resend for rows still 'sent'. Additive only.
CREATE TABLE invoice_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  to_addrs TEXT NOT NULL,
  cc_addrs TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  attachment_name TEXT NOT NULL DEFAULT '',
  resend_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','delivered','bounced','failed')),
  last_event TEXT,
  error TEXT,
  sent_by INTEGER REFERENCES users(id),
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status_checked_at TEXT,
  status_changed_at TEXT
);

CREATE INDEX idx_invoice_emails_invoice ON invoice_emails(invoice_id, id);
CREATE INDEX idx_invoice_emails_status ON invoice_emails(status, sent_at);
