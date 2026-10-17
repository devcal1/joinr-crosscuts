-- Team tasks (docs/plans/m4-contracts.md section 13, 2026-10-18). Additive only: one new table.
-- A task for a whole team (today only 'design': the holders of notes.design) rather than one
-- person. `tasks` can't hold it: assignee_id and created_by are NOT NULL there and SQLite can't relax
-- that without rebuilding the table, so a team task lives here, with the same columns apart from
-- the assignee. Its id is always 1000000000 or more (the code picks MAX(id)+1, floor 1e9), so a
-- task id means one thing across /api/tasks, comments, follows and alerts, whichever table holds it.
-- created_by is NULL for a task made by the system (created_label then says who, e.g.
-- 'Joinr (automatic)'). Nothing here is read until the code in lib/team-tasks.js runs.
CREATE TABLE team_tasks (
  id INTEGER PRIMARY KEY CHECK (id >= 1000000000),
  team TEXT NOT NULL CHECK (team IN ('design')),
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  job_id INTEGER REFERENCES jobs(id),
  due_date TEXT,                                        -- Sydney YYYY-MM-DD; null = no due date
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  done_at TEXT,
  done_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),              -- NULL: made by the system
  created_label TEXT,                                   -- the system's name when created_by is NULL
  source TEXT,                                          -- 'joinr' when made by the Joinr intake
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_team_tasks_team ON team_tasks(team, status, due_date);
CREATE INDEX idx_team_tasks_job ON team_tasks(job_id, status);
