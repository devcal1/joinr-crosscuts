-- Backup (docs/plans/backup-contracts.md section 2). Additive only: two new tables.
CREATE TABLE backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('snapshot','copy')),
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','startup','manual')),
  slot TEXT,                                          -- Sydney YYYY-MM-DD the timer ran it for; NULL for manual
  attempt INTEGER NOT NULL DEFAULT 1,                 -- 1..4 within a slot; 1 for manual
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  reason TEXT,                                        -- section 8 key; NULL on success
  exit_code INTEGER,
  detail TEXT NOT NULL DEFAULT '{}',                  -- JSON: counts, bytes, durations, archive names only
  requested_by INTEGER REFERENCES users(id)           -- the admin who pressed Back up now; NULL for the timer
);
CREATE INDEX idx_backup_runs_kind ON backup_runs(kind, started_at);
CREATE INDEX idx_backup_runs_slot ON backup_runs(kind, slot);

CREATE TABLE backup_blobs (
  stored_name TEXT PRIMARY KEY,                       -- the private file's name in uploads/files (<uuid>.<ext>)
  source_bytes INTEGER NOT NULL,                      -- its size when it was encrypted
  blob_bytes INTEGER NOT NULL,                        -- the size of <stored_name>.7z as encrypted
  encrypted_at TEXT NOT NULL,
  sent_at TEXT,                                       -- the last copy that sent it
  proven_at TEXT                                      -- the last copy that saw it on the NAS at blob_bytes
);
