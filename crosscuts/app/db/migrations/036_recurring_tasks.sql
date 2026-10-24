-- Recurring tasks (0.2.0, docs/plans/m20-recurring-tasks.md). Additive only: three new tables.
--
-- recurring_tasks: the rules admins keep on Admin > Tasks. Each is given to ONE person
-- (assignee_id) or ONE department (dept), never both. The repeat uses the Planner's choices:
-- weekly, fortnightly, monthly, annually, or custom "every N day/week/month/year".
-- deleted_at set = deleted: no more occurrences; the tasks already made stay.
CREATE TABLE recurring_tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  assignee_id INTEGER REFERENCES users(id),
  dept TEXT CHECK (dept IN ('scheduling','design','ordering','accounts','admin')),
  repeat TEXT NOT NULL CHECK (repeat IN ('weekly','fortnightly','monthly','annually','custom')),
  repeat_every INTEGER CHECK (repeat_every IS NULL OR (repeat_every BETWEEN 1 AND 99)),
  repeat_unit TEXT CHECK (repeat_unit IS NULL OR repeat_unit IN ('day','week','month','year')),
  start_date TEXT NOT NULL,                             -- Sydney YYYY-MM-DD, the first due date
  end_date TEXT,                                        -- last possible due date; NULL = no end
  lead_days INTEGER NOT NULL DEFAULT 0 CHECK (lead_days BETWEEN 0 AND 60),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_from TEXT NOT NULL,                           -- Sydney date the rule was made: no occurrence due before it
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  CHECK ((assignee_id IS NULL) <> (dept IS NULL))
);
CREATE INDEX idx_recurring_tasks_live ON recurring_tasks(deleted_at, active);

-- dept_tasks: one shared task for a whole department, ticked once for all. The same columns as
-- team_tasks (migration 032), whose CHECK allows only 'design'; ids are 2000000000 or more so a task
-- id still means one thing across /api/tasks, comments, follows and alerts.
CREATE TABLE dept_tasks (
  id INTEGER PRIMARY KEY CHECK (id >= 2000000000),
  team TEXT NOT NULL CHECK (team IN ('scheduling','design','ordering','accounts','admin')),
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  job_id INTEGER REFERENCES jobs(id),
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  done_at TEXT,
  done_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_label TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_dept_tasks_team ON dept_tasks(team, status, due_date);

-- recurring_occurrences: one row per occurrence made, so an occurrence is never made twice.
-- task_id is a tasks id (a person) or a dept_tasks id (a department).
CREATE TABLE recurring_occurrences (
  id INTEGER PRIMARY KEY,
  recurring_id INTEGER NOT NULL REFERENCES recurring_tasks(id),
  due_date TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (recurring_id, due_date)
);
CREATE INDEX idx_recurring_occ_task ON recurring_occurrences(task_id);
