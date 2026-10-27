-- Morning check and completion (0.2.5, docs/plans/m26-contracts.md). Additive only.
-- production_days: the schedule manager's daily stage (and/or note) per job, from the Morning check.
-- The job's current production stage is the latest of these and production_stages (Finish week).
CREATE TABLE production_days (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  date TEXT NOT NULL,                                  -- Sydney YYYY-MM-DD, the day checked
  stage TEXT CHECK (stage IS NULL OR stage IN ('cut_edge','kit','assemble','inspect','paint','install','return_visit')),
  note TEXT NOT NULL DEFAULT '',
  set_by INTEGER REFERENCES users(id),
  set_at TEXT NOT NULL,
  PRIMARY KEY (job_id, date)
);

-- jobs.installed_date: Finish week's "Installed" outcome; the project manager then confirms complete.
ALTER TABLE jobs ADD COLUMN installed_date TEXT;
