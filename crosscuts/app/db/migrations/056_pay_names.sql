-- 0.2.11 (Todd 2026-11-01): a pay first name and surname for everyone on pay runs, shown as
-- "SURNAME, Firstname". The board keeps its own (sometimes nickname) worker names. Additive only.
ALTER TABLE pay_people ADD COLUMN first_name TEXT;
ALTER TABLE pay_people ADD COLUMN surname TEXT;
