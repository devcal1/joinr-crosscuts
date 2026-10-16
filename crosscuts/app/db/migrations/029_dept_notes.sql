-- Department notes (docs/plans/notes-contracts.md section 1). Additive only: one new table and
-- one index. A weekly sheet per department where its people leave signed notes for each other.
-- week_start is the Monday (Australia/Sydney, YYYY-MM-DD) of the week the note was written in;
-- removal is soft (removed_at).
CREATE TABLE dept_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dept TEXT NOT NULL CHECK (dept IN ('scheduling','design','ordering','accounts','admin')),
  week_start TEXT NOT NULL CHECK (week_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000 AND length(trim(body)) >= 1),
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT
);
CREATE INDEX idx_dept_notes_dept_week ON dept_notes(dept, week_start);
