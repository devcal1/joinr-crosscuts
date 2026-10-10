-- M4 Collaboration (docs/plans/m4-contracts.md section 1). Additive only: new tables,
-- indexes and four seeded channels. No existing table or row changes.
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  assignee_id INTEGER NOT NULL REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER REFERENCES jobs(id),
  due_date TEXT,                                        -- Sydney YYYY-MM-DD; null = no due date
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  done_at TEXT,
  done_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status, due_date);
CREATE INDEX idx_tasks_creator ON tasks(created_by, status);
CREATE INDEX idx_tasks_job ON tasks(job_id, status);
CREATE INDEX idx_tasks_status ON tasks(status, due_date);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task','job')),
  entity_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_comments_entity ON comments(entity_type, entity_id, id);

CREATE TABLE follows (
  user_id INTEGER NOT NULL REFERENCES users(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task','job')),
  entity_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, entity_type, entity_id)
);
CREATE INDEX idx_follows_entity ON follows(entity_type, entity_id);

CREATE TABLE channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT CHECK (role IS NULL OR role IN ('accounts','design_pm','scheduling')),
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
INSERT INTO channels (slug, name, role, position) VALUES
  ('all', 'All', NULL, 1),
  ('accounts', 'Accounts', 'accounts', 2),
  ('design', 'Design/PM', 'design_pm', 3),
  ('scheduling', 'Scheduling', 'scheduling', 4);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_messages_channel ON messages(channel_id, id);

CREATE TABLE channel_reads (
  user_id INTEGER NOT NULL REFERENCES users(id),
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stored_name TEXT NOT NULL UNIQUE,                     -- <uuid>.<ext>, ext from the allowlist
  original_name TEXT NOT NULL,                          -- display and download name only
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id)
);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,                                 -- YYYY-MM (Sydney month the report covers)
  category TEXT NOT NULL CHECK (category IN ('bank_reconciliation','bas','payroll','aged_debtors','other')),
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  file_id INTEGER NOT NULL UNIQUE REFERENCES files(id),
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_reports_period ON reports(period, category);

CREATE TABLE task_files (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  file_id INTEGER NOT NULL UNIQUE REFERENCES files(id),
  PRIMARY KEY (task_id, file_id)
);
