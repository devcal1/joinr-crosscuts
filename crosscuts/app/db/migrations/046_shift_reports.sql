-- Workshop end-of-shift report (0.2.4, docs/plans/m25-contracts.md). Additive only.
-- shift_reports: one per person per Sydney day; sending again replaces the note and job list.
CREATE TABLE shift_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  job_ids TEXT NOT NULL DEFAULT '[]',
  sent_at TEXT NOT NULL,
  UNIQUE (user_id, date)
);

-- job_issues: a problem raised on a job (from the shift page), open until resolved.
-- photo_ids is a JSON array of photos.id.
CREATE TABLE job_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  body TEXT NOT NULL,
  photo_ids TEXT NOT NULL DEFAULT '[]',
  raised_by INTEGER REFERENCES users(id),
  raised_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX idx_job_issues_job ON job_issues(job_id, status);
