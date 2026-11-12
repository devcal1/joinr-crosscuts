-- 0.2.17 (Todd 2026-11-12/13, docs/plans/payrun-notes-plan.md): an admin's note on one person's day,
-- for Accounts to read on the pay run. Keyed to the person and the date (not a run or a sheet), so a
-- note can be written on the day before the run or sheet exists, and removing an empty sheet or
-- deleting an empty run never loses one. Additive only.
CREATE TABLE pay_day_notes (
  person_id INTEGER NOT NULL REFERENCES pay_people(id),
  date TEXT NOT NULL,                                   -- YYYY-MM-DD, one of its fortnight's days
  note TEXT NOT NULL CHECK (note <> ''),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (person_id, date)
);
