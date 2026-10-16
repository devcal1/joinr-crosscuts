-- Department notes (docs/plans/notes-contracts.md section 1). Additive only: two new tables and
-- one index. A week wall per department: signed notes stuck on a weekday (Monday to Friday) for
-- the people in that department to read, and a thumbs-up to say "seen".
-- note_date is the weekday (YYYY-MM-DD, Australia/Sydney) the note sits under; week_start is that
-- day's Monday, kept consistent by a CHECK. Removal is soft (removed_at).
CREATE TABLE dept_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dept TEXT NOT NULL CHECK (dept IN ('scheduling','design','ordering','accounts','admin')),
  note_date TEXT NOT NULL CHECK (
    note_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(note_date) IS note_date
    AND strftime('%w', note_date) IN ('1','2','3','4','5')
  ),
  week_start TEXT NOT NULL CHECK (
    week_start IS date(note_date, '-' || (CAST(strftime('%w', note_date) AS INTEGER) - 1) || ' days')
  ),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000 AND length(trim(body)) >= 1),
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT
);
CREATE INDEX idx_dept_notes_dept_week ON dept_notes(dept, week_start);

-- Who has given a note a thumbs-up. One row per person per note; a person can't acknowledge their
-- own note (checked in lib/notes.js).
CREATE TABLE dept_note_acks (
  note_id INTEGER NOT NULL REFERENCES dept_notes(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (note_id, user_id)
);
