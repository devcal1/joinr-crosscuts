-- M6 Joinr intake (docs/plans/m6-contracts.md section 1). Additive only.
CREATE TABLE joinr_intake (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_quote_id TEXT NOT NULL UNIQUE,                 -- Joinr rootQuoteId (uuid): one record per quote
  quote_id TEXT NOT NULL,                             -- the latest revision's quoteId
  quote_number TEXT,
  joinr_status TEXT NOT NULL,                         -- the quote's status in Joinr, as last seen
  last_event TEXT NOT NULL CHECK (last_event IN ('won','unwon','changed','deleted')),
  payload TEXT NOT NULL,                              -- the last item, as JSON
  state TEXT NOT NULL DEFAULT 'new'
    CHECK (state IN ('new','accepted','linked','ignored','withdrawn')),
  changed INTEGER NOT NULL DEFAULT 0,                 -- 1: Joinr changed it after a decision
  job_id INTEGER REFERENCES jobs(id),
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT
);
CREATE INDEX idx_joinr_intake_state ON joinr_intake(state, last_seen_at);
CREATE INDEX idx_joinr_intake_job ON joinr_intake(job_id);

CREATE TABLE integration_sync (
  name TEXT PRIMARY KEY,                              -- 'joinr'
  cursor TEXT,
  last_run_at TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  last_items INTEGER NOT NULL DEFAULT 0
);
