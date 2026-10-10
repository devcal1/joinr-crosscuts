-- M3 Design/PM (docs/plans/m3-contracts.md section 1). Additive only: two new tables,
-- one nullable jobs column, one index. photos.job_id already exists (003_jobs.js).
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  supplier TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'to_order'
    CHECK (status IN ('to_order','ordered','received','cancelled')),
  ordered_date TEXT,                                    -- Sydney YYYY-MM-DD
  expected_date TEXT,                                   -- Sydney YYYY-MM-DD
  received_date TEXT,                                   -- Sydney YYYY-MM-DD
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_orders_job ON orders(job_id, status);
CREATE INDEX idx_orders_status ON orders(status, expected_date);

CREATE TABLE inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  date TEXT NOT NULL,                                   -- Sydney YYYY-MM-DD
  time TEXT,                                            -- Sydney HH:MM (24 h); null = time not set
  host TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'booked'
    CHECK (status IN ('booked','done','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_inspections_job ON inspections(job_id);
CREATE INDEX idx_inspections_date ON inspections(status, date);

CREATE INDEX idx_photos_job ON photos(job_id);

ALTER TABLE jobs ADD COLUMN materials_in_date TEXT;     -- Sydney date; set when every live line is received
