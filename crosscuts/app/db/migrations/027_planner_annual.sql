-- Planner: annual repeats (2026-10-16). Additive only: one new column on planner_events.
-- The repeat CHECK in 018 can't be widened without a table rebuild, so an annual event is stored as
-- repeat = 'monthly', repeat_day = <the day>, repeat_months = 12 (every 12 months). Existing rows get
-- 1 (every month), so nothing changes for them. The code (lib/planner/events.js) translates, so the
-- API and the page only ever see repeat = 'annually'.
ALTER TABLE planner_events ADD COLUMN repeat_months INTEGER NOT NULL DEFAULT 1 CHECK (repeat_months IN (1,12));
