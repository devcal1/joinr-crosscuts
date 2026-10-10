-- 001_baseline: the schema exactly as db.js created it before migrations existed.
-- Every statement is IF NOT EXISTS, so applying this to a live DB is a no-op.
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    thumb_filename TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    hue INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS week_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    week_start TEXT NOT NULL,
    panel TEXT NOT NULL CHECK(panel IN ('manufacturing','installing')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_row_id INTEGER NOT NULL REFERENCES week_rows(id),
    day TEXT NOT NULL CHECK(day IN ('mon','tue','wed','thu','fri')),
    worker_id INTEGER NOT NULL REFERENCES workers(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS day_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_row_id INTEGER NOT NULL REFERENCES week_rows(id),
    day TEXT NOT NULL CHECK(day IN ('mon','tue','wed','thu','fri')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(week_row_id, day)
  );

  CREATE TABLE IF NOT EXISTS backlog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_week_rows_lookup ON week_rows(week_start, panel, sort_order);
  CREATE INDEX IF NOT EXISTS idx_assignments_row ON assignments(week_row_id, day);
  CREATE INDEX IF NOT EXISTS idx_day_flags_row ON day_flags(week_row_id);
