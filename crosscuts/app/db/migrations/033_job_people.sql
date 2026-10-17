-- Names on Pipeline job tiles (2026-10-18). Additive only.
--
-- users.worker_id links a login to a board worker (nullable). At most one login per worker, so
-- the worker's colour identifies one person. job_people holds the names people have put on a job:
-- one row per (job, login). added_by is who clicked (kept for the trail). The chip on the tile
-- uses the linked worker's hue, or grey when the login has no worker.
ALTER TABLE users ADD COLUMN worker_id INTEGER REFERENCES workers(id);
CREATE UNIQUE INDEX idx_users_worker_id ON users(worker_id) WHERE worker_id IS NOT NULL;

CREATE TABLE job_people (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  added_by INTEGER REFERENCES users(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (job_id, user_id)
);
CREATE INDEX idx_job_people_user ON job_people(user_id);
