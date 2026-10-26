-- Projects steps and hand-offs (0.2.2, Todd 2026-10-26; docs/plans/m23-contracts.md). Additive only:
-- two new tables, one new column on jobs, one on channels, and two new channels.
--
-- job_steps: the project manager's ticks. One row per job per step while it is ticked; an untick
-- deletes the row (the audit log keeps who ticked and unticked it, and when). "Order list ready"
-- is not stored: it is a finalised current order list revision (migration 041).
CREATE TABLE job_steps (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  step TEXT NOT NULL CHECK (step IN ('drawn','check_measured','nested')),
  done_at TEXT NOT NULL,
  done_by INTEGER REFERENCES users(id),
  PRIMARY KEY (job_id, step)
);

-- check_measures: a check measure booked ahead (like inspections, migration 010). Dates are Sydney
-- YYYY-MM-DD, times Sydney HH:MM. Shown on the Planner on the Projects layer.
CREATE TABLE check_measures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  date TEXT NOT NULL,
  time TEXT,
  host TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','done','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_check_measures_job ON check_measures(job_id, date);
CREATE INDEX idx_check_measures_date ON check_measures(date, status);

-- The project manager's requested install date (Sydney YYYY-MM-DD). The existing
-- promised_install_date stays the confirmed date the schedule manager sets.
ALTER TABLE jobs ADD COLUMN requested_install_date TEXT
  CHECK (requested_install_date IS NULL OR date(requested_install_date) IS requested_install_date);

-- channels.access_key: a feature key that opens the channel (admins see every channel). The role
-- CHECK of migration 012 can't take the new departments, so the two new channels use a key.
ALTER TABLE channels ADD COLUMN access_key TEXT;
INSERT INTO channels (slug, name, role, position, access_key) VALUES
  ('ordering', 'Ordering', NULL, 5, 'notes.ordering'),
  ('workshop', 'Workshop', NULL, 6, 'notes.workshop');
