-- Project jobs (0.2.1, Todd 2026-10-25; docs/plans/m22-project-jobs.md). Additive only: new nullable
-- or defaulted columns and one new table; no existing row is rewritten.
--
-- jobs.project_owner_id: the one person who owns the job in Projects (separate from job_people).
-- jobs.sent_to_ordering_at: set when the job is sent (or moved by hand) to Ordering. A job at the
--   stored stage 'design_ordering' shows as Projects while this is NULL and as Ordering once set
--   (migration 003's CHECK can't take a new stage value).
-- jobs.project_notes: the project page's job notes.
ALTER TABLE jobs ADD COLUMN project_owner_id INTEGER REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN sent_to_ordering_at TEXT;
ALTER TABLE jobs ADD COLUMN project_notes TEXT NOT NULL DEFAULT '' CHECK (length(project_notes) <= 5000);

-- Per materials line: colour and finish (materials), brand, code (hardware) and the supplier the
-- line is ordered from. Crosscuts-only fields: a Joinr sync never writes them.
ALTER TABLE job_materials ADD COLUMN colour TEXT CHECK (colour IS NULL OR length(colour) <= 100);
ALTER TABLE job_materials ADD COLUMN finish TEXT CHECK (finish IS NULL OR length(finish) <= 100);
ALTER TABLE job_materials ADD COLUMN brand TEXT CHECK (brand IS NULL OR length(brand) <= 100);
ALTER TABLE job_materials ADD COLUMN code TEXT CHECK (code IS NULL OR length(code) <= 100);
ALTER TABLE job_materials ADD COLUMN supplier TEXT CHECK (supplier IS NULL OR length(supplier) <= 200);

-- A finalised order list: a frozen revision (A, B, C...) of the job's live materials and hardware
-- lines. fingerprint is the hash of those lines' ordering fields at finalise, so the page can say
-- the list changed since. sent_at is set when this revision was sent to Ordering.
CREATE TABLE project_order_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 3),
  lines_json TEXT NOT NULL,
  line_count INTEGER NOT NULL CHECK (line_count >= 0),
  fingerprint TEXT NOT NULL,
  finalised_at TEXT NOT NULL,
  finalised_by INTEGER REFERENCES users(id),
  sent_at TEXT,
  sent_by INTEGER REFERENCES users(id),
  UNIQUE (job_id, revision)
);
CREATE INDEX idx_project_order_lists_job ON project_order_lists(job_id, id);
CREATE INDEX idx_jobs_project_owner ON jobs(project_owner_id) WHERE project_owner_id IS NOT NULL;
