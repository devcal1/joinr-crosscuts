-- M5 Scheduling extras (docs/plans/m5-contracts.md section 1). Additive only: two new
-- tables and two nullable workers columns. No existing row changes; no backfill.
CREATE TABLE production_stages (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  week_start TEXT NOT NULL,                           -- Monday of the finished week, Sydney YYYY-MM-DD
  stage TEXT NOT NULL CHECK (stage IN ('cut_edge','kit','assemble','inspect','paint','install','return_visit')),
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (job_id, week_start)
);

CREATE TABLE leave (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  date_from TEXT NOT NULL,                            -- Sydney YYYY-MM-DD, inclusive
  date_to TEXT NOT NULL,                              -- Sydney YYYY-MM-DD, inclusive, >= date_from
  kind TEXT NOT NULL CHECK (kind IN ('leave','sick','other')),
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_leave_worker ON leave(worker_id, date_from, date_to);
CREATE INDEX idx_leave_dates ON leave(date_from, date_to);

ALTER TABLE workers ADD COLUMN days_per_week INTEGER CHECK (days_per_week IS NULL OR days_per_week BETWEEN 1 AND 4);
ALTER TABLE workers ADD COLUMN regular_days_off TEXT;   -- comma-separated day keys, e.g. 'fri' or 'mon,fri'; NULL = none
