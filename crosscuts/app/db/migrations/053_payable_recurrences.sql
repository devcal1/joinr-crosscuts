-- Recurring individual invoices: a rule (every N weeks or months from a first due date) that lists
-- its occurrences as ordinary payables, generated lazily when a month is read. Additive only.
CREATE TABLE payable_recurrences (
  id INTEGER PRIMARY KEY,
  payee TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER,
  myob INTEGER NOT NULL DEFAULT 0 CHECK (myob IN (0, 1)),
  unit TEXT NOT NULL CHECK (unit IN ('weeks', 'months')),
  every INTEGER NOT NULL CHECK (every BETWEEN 1 AND 52),
  anchor_date TEXT NOT NULL,                 -- the first due date; later ones are counted from it
  end_date TEXT,                             -- no occurrence after this day
  stopped_at TEXT,                           -- set when a user stops the recurrence
  stopped_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
ALTER TABLE payables ADD COLUMN recurrence_id INTEGER REFERENCES payable_recurrences(id);
ALTER TABLE payables ADD COLUMN recurrence_due TEXT;
CREATE UNIQUE INDEX idx_payables_recurrence ON payables(recurrence_id, recurrence_due) WHERE recurrence_id IS NOT NULL;
