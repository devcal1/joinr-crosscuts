-- Jobs as containers, Tradify style (0.2.8, docs/plans/jobs-tradify-contracts.md section 1;
-- Todd 2026-10-30). Additive: two new tables, one new column with an index and a trigger.
-- The only write to existing rows is the backfill of the NEW column jobs.job_number (section 1.4).

-- 1. Notes on a job: a running list, newest first. Soft delete only.
CREATE TABLE job_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  user_id INTEGER NOT NULL REFERENCES users(id),           -- who wrote it
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at TEXT,                                           -- last edit by the author, or NULL
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_job_notes_job ON job_notes(job_id, created_at);

-- 2. Files on a note: rows in files (migration 012) under <UPLOADS_DIR>/files, served only by
-- GET /api/files/:id. Never in photos, so never in the photo library.
CREATE TABLE job_note_files (
  note_id INTEGER NOT NULL REFERENCES job_notes(id),
  file_id INTEGER NOT NULL UNIQUE REFERENCES files(id),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (note_id, file_id)
);

-- 3. Job number: the Joinr quote number, else J-<id>. Backfill first, then the index and trigger.
ALTER TABLE jobs ADD COLUMN job_number TEXT;

UPDATE jobs
   SET job_number = CASE
     WHEN trim(coalesce(quote_number, '')) <> ''
      AND upper(substr(trim(quote_number), 1, 2)) <> 'J-'
      AND (SELECT COUNT(*) FROM jobs o
            WHERE upper(trim(o.quote_number)) = upper(trim(jobs.quote_number))) = 1
     THEN trim(quote_number)
     ELSE 'J-' || printf('%04d', id)
   END
 WHERE job_number IS NULL;

CREATE UNIQUE INDEX idx_jobs_job_number ON jobs(job_number COLLATE NOCASE) WHERE job_number IS NOT NULL;

CREATE TRIGGER trg_jobs_job_number AFTER INSERT ON jobs
WHEN NEW.job_number IS NULL
BEGIN
  UPDATE jobs
     SET job_number = CASE
       WHEN trim(coalesce(NEW.quote_number, '')) <> ''
        AND upper(substr(trim(NEW.quote_number), 1, 2)) <> 'J-'
        AND NOT EXISTS (SELECT 1 FROM jobs o
                         WHERE o.id <> NEW.id
                           AND o.job_number = trim(NEW.quote_number) COLLATE NOCASE)
       THEN trim(NEW.quote_number)
       ELSE 'J-' || printf('%04d', NEW.id)
     END
   WHERE id = NEW.id;
END;
