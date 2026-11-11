-- Department notes by week (0.2.15, Todd 2026-11-11). Additive only: one new column.
-- A note now belongs to a week (week_start, unchanged) and may carry an optional day tag. day_tagged
-- = 1 means note_date is the weekday the note is tagged for (every note written before this
-- migration, so each keeps its day); 0 means the note is for the whole week, and note_date is just
-- that week's Monday (it must stay a weekday for the 029 CHECKs). Nothing is deleted or rewritten.
ALTER TABLE dept_notes ADD COLUMN day_tagged INTEGER NOT NULL DEFAULT 1 CHECK (day_tagged IN (0, 1));

-- Reacts on notes (0.2.15, Todd 2026-11-11): a person may give each note any of four reacts, once
-- each: up (thumbs-up), down (thumbs-down), laugh, sad. Existing thumbs-ups (dept_note_acks, 029)
-- are copied in as 'up' reacts; the old table is left as it is and no longer read.
CREATE TABLE dept_note_reacts (
  note_id INTEGER NOT NULL REFERENCES dept_notes(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('up','down','laugh','sad')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (note_id, user_id, kind)
);
INSERT INTO dept_note_reacts (note_id, user_id, kind, created_at)
  SELECT note_id, user_id, 'up', created_at FROM dept_note_acks;
