-- 0.2.19: overdue invoice reminder emails (docs/plans/invoice-reminders-plan.md). Additive only.

-- Reminders are invoice emails too: same history, same delivery poll. Existing rows are 'invoice'.
ALTER TABLE invoice_emails ADD COLUMN kind TEXT NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice','reminder'));
ALTER TABLE invoice_emails ADD COLUMN reminder_step INTEGER;
ALTER TABLE invoice_emails ADD COLUMN bcc_addrs TEXT NOT NULL DEFAULT '';

-- One row per invoice per step: the claim that makes double sending impossible.
CREATE TABLE invoice_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  step INTEGER NOT NULL CHECK (step BETWEEN 1 AND 3),
  days_overdue INTEGER NOT NULL,             -- when it was prepared
  state TEXT NOT NULL CHECK (state IN ('queued','sending','sent','failed','skipped','cancelled','dry')),
  how TEXT CHECK (how IN ('auto','approved','manual')),
  email_id INTEGER REFERENCES invoice_emails(id),
  idem_key TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  note TEXT,                                 -- skip reason or Resend's error, never the key
  acted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (invoice_id, step)
);
CREATE INDEX idx_invoice_reminders_state ON invoice_reminders(state, created_at);

-- Pause on one invoice (until a date, or indefinitely when the date is null and paused = 1).
ALTER TABLE invoices ADD COLUMN reminders_paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN reminders_paused_until TEXT;
ALTER TABLE invoices ADD COLUMN reminders_pause_note TEXT;

-- Paused clients, keyed like client_terms (lib/followup.js clientKey).
CREATE TABLE client_reminder_pauses (
  client_key TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  until_date TEXT,
  note TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);
