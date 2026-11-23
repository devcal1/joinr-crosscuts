-- 0.2.26 job page (docs/plans/jobpage-contracts.md). Additive only.
--
-- Orders and materials (section C):
--   suggested    JSON list of the detail fields (supplier, brand, code, colour, finish) still shown as a
--                suggestion: set by lib/materials.js prefill, a field leaves the list when a person edits it.
--   prefilled_at when prefill last looked at the line; NULL means not yet. A field a person clears is
--                never refilled because prefill runs once per line.
--   skip_order   1: the line is left out of the order (drawers are on the drawer order). Left out of
--                finalise, problems, fingerprint and send. Default 0 keeps every existing fingerprint.
ALTER TABLE job_materials ADD COLUMN suggested TEXT NOT NULL DEFAULT '[]';
ALTER TABLE job_materials ADD COLUMN prefilled_at TEXT;
ALTER TABLE job_materials ADD COLUMN skip_order INTEGER NOT NULL DEFAULT 0 CHECK (skip_order IN (0,1));

-- The default supplier per materials section (edited on the Users admin page).
CREATE TABLE material_section_suppliers (
  section TEXT PRIMARY KEY CHECK (length(trim(section)) > 0 AND length(section) <= 40),
  supplier TEXT NOT NULL CHECK (length(trim(supplier)) > 0 AND length(supplier) <= 200),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id)
);

-- Quote tab PDF (section B): the last good copy of a job's Joinr quote PDF and the attempt guard.
-- file is a name inside uploads/files; fetched_at is when a good copy was stored (NULL: none yet).
CREATE TABLE joinr_quote_pdfs (
  intake_id INTEGER PRIMARY KEY REFERENCES joinr_intake(id),
  quote_id TEXT NOT NULL,
  file TEXT,
  size INTEGER,
  sha256 TEXT,
  fetched_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT
);
