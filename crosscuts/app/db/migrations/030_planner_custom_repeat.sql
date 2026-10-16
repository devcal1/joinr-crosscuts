-- Planner: custom repeats, "every N days / weeks / months / years" (2026-10-17). Additive only: two new
-- columns on planner_events. The repeat CHECK in 018 can't be widened without a table rebuild, so a
-- custom repeat is stored under the old values and told apart by repeat_unit:
--   every N days or weeks  -> repeat = 'weekly',  repeat_day NULL,        repeat_unit = 'day' | 'week'
--   every N months or years -> repeat = 'monthly', repeat_day = <the day>, repeat_months = 1,
--                              repeat_unit = 'month' | 'year'
-- so every older CHECK still holds. repeat_unit and repeat_every are both NULL (an ordinary repeat or
-- none) or both set. N runs 1 to 99; 1 is only ever kept for days ("every day"): the code turns
-- "every 1 week / month / year" into Weekly / Monthly / Every year, and the CHECK says the same. The code
-- (lib/planner/events.js) translates at the edge, so the API and the page see repeat = 'custom'
-- with repeatEvery and repeatUnit. Existing rows get NULL in both, so nothing changes for them.
ALTER TABLE planner_events ADD COLUMN repeat_unit TEXT CHECK (repeat_unit IS NULL OR repeat_unit IN ('day','week','month','year'));
ALTER TABLE planner_events ADD COLUMN repeat_every INTEGER CHECK (repeat_every IS NULL OR repeat_every BETWEEN 1 AND 99)
  CHECK ((repeat_unit IS NULL) = (repeat_every IS NULL))
  CHECK (repeat_every IS NULL OR repeat_unit = 'day' OR repeat_every >= 2);
