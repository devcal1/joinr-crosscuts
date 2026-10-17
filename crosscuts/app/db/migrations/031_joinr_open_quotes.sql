-- Joinr open-quotes cache (task J3, Crosscuts side, 2026-10-17). Additive only: two new tables,
-- nothing existing is touched (joinr_intake and the inbox are unchanged).
--
-- joinr_open_quotes holds the last good answer of Joinr's open-quotes list
-- (docs/integrations/joinr-crosscuts-intake.md, version 3): one row per sent or won quote.
-- The whole table is replaced in one transaction on each good fetch, together with the meta row.
-- The Pipeline's Quoted column reads it (GET /api/pipeline/joinr-quotes) once it has been filled.
CREATE TABLE joinr_open_quotes (
  quote_id TEXT PRIMARY KEY,                          -- this revision's id (uuid, lower case)
  root_quote_id TEXT NOT NULL,                        -- the job's id; matches joinr_intake.root_quote_id
  quote_number TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent','won')),
  client_name TEXT NOT NULL DEFAULT '',
  site_address TEXT,
  label TEXT,
  value_inc_gst_cents INTEGER CHECK (value_inc_gst_cents IS NULL OR value_inc_gst_cents >= 0),
  sent_at TEXT,                                       -- ISO UTC, or NULL
  won_at TEXT,                                        -- ISO UTC, or NULL
  updated_at TEXT NOT NULL,                           -- ISO UTC (normalised, so it sorts as text)
  url TEXT NOT NULL CHECK (url LIKE 'http://%' OR url LIKE 'https://%'),
  fetched_at TEXT NOT NULL                            -- when Crosscuts stored this row
);
CREATE INDEX idx_joinr_open_quotes_root ON joinr_open_quotes(root_quote_id);
CREATE INDEX idx_joinr_open_quotes_updated ON joinr_open_quotes(updated_at);

-- One row (id 1), made by the first attempt. fetched_at stays NULL until a fetch has succeeded:
-- NULL means "never filled", and the Pipeline then falls back to the intake list. The last-attempt,
-- last-error and retry-after columns are the once-a-minute guard and the 429 back-off; a failed
-- attempt changes only those, never the cached list.
CREATE TABLE joinr_open_quotes_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at TEXT,                                    -- last good fetch
  generated_at TEXT,                                  -- Joinr's own snapshot time (generatedAt)
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  line_count INTEGER NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  last_attempt_at TEXT,
  last_error TEXT,                                    -- NULL when the last attempt was good
  retry_after_until TEXT                              -- after a 429: no attempt before this
);
