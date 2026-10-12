-- M8 Pay runs (docs/plans/m8-contracts.md section 2). Additive only: five new tables and a
-- seed of Victorian public holidays. No existing row changes.

-- Who can have a timesheet. A board worker gets a row the first time a pay-run write needs one
-- (no backfill: a worker with no row counts as on the pay run). Pay-only people (office staff)
-- always have a row and a name of their own.
CREATE TABLE pay_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER UNIQUE REFERENCES workers(id),
  name TEXT,                                            -- pay-only people only; NULL for workers
  on_pay_run INTEGER NOT NULL DEFAULT 1 CHECK (on_pay_run IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),  -- pay-only people only
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((worker_id IS NULL) <> (name IS NULL))
);

CREATE TABLE pay_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date TEXT NOT NULL UNIQUE,                      -- a Monday on the fortnight grid
  end_date TEXT NOT NULL,                               -- start_date + 11 (the second Friday)
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','finalised')),
  rules_json TEXT,                                      -- frozen at finalise (§3 rules object)
  summary_json TEXT,                                    -- frozen at finalise (§6.4 summary)
  finalised_at TEXT,
  finalised_by INTEGER REFERENCES users(id),
  myob_entered_date TEXT,                               -- Sydney date; finalised runs only
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One employee's sheet in one pay run.
CREATE TABLE pay_timesheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pay_run_id INTEGER NOT NULL REFERENCES pay_runs(id),
  person_id INTEGER NOT NULL REFERENCES pay_people(id),
  name TEXT NOT NULL,                                   -- set at add, refreshed at finalise
  notes TEXT NOT NULL DEFAULT '',
  signed INTEGER NOT NULL DEFAULT 0 CHECK (signed IN (0,1)),
  entered INTEGER NOT NULL DEFAULT 0 CHECK (entered IN (0,1)),   -- "typed in" tick
  saved_at TEXT,                                        -- NULL until the first save
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (pay_run_id, person_id)
);
CREATE INDEX idx_pay_timesheets_run ON pay_timesheets(pay_run_id);

-- One row of the paper form. Only days with something typed are stored. All hours are
-- integer minutes; start and finish are minutes after midnight.
CREATE TABLE pay_days (
  timesheet_id INTEGER NOT NULL REFERENCES pay_timesheets(id),
  date TEXT NOT NULL,                                   -- one of the run's ten weekdays
  start_min INTEGER,
  finish_min INTEGER,
  lunch_min INTEGER,
  phol_min INTEGER,
  sick_min INTEGER,
  arl_min INTEGER,
  onsite_min INTEGER,
  job TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (timesheet_id, date)
);

CREATE TABLE public_holidays (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Victorian public holidays on weekdays from the pay-run anchor (5 Oct 2026) to the end of 2027
-- (Decision 6). Weekend days are left out: they never touch a timesheet. Local days (Bendigo Cup)
-- and the Friday before the 2027 AFL Grand Final (not yet declared) are added by hand.
INSERT INTO public_holidays (date, name) VALUES
  ('2026-11-03', 'Melbourne Cup'),
  ('2026-12-25', 'Christmas Day'),
  ('2026-12-28', 'Boxing Day (substitute)'),
  ('2027-01-01', 'New Year''s Day'),
  ('2027-01-26', 'Australia Day'),
  ('2027-03-08', 'Labour Day'),
  ('2027-03-26', 'Good Friday'),
  ('2027-03-29', 'Easter Monday'),
  ('2027-06-14', 'King''s Birthday'),
  ('2027-11-02', 'Melbourne Cup'),
  ('2027-12-27', 'Christmas Day (substitute)'),
  ('2027-12-28', 'Boxing Day (substitute)');
