-- 0.2.11 (Todd 2026-11-01): an admin's review tick on each pay-run sheet, telling accounts the
-- hours are checked. Additive only; existing sheets start unreviewed.
ALTER TABLE pay_timesheets ADD COLUMN admin_reviewed INTEGER NOT NULL DEFAULT 0 CHECK (admin_reviewed IN (0,1));
ALTER TABLE pay_timesheets ADD COLUMN reviewed_by INTEGER REFERENCES users(id);
ALTER TABLE pay_timesheets ADD COLUMN reviewed_at TEXT;
