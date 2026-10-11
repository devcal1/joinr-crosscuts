-- M7 Staff planner (docs/plans/m7-contracts.md section 3). Additive only: three new tables and
-- four indexes on existing date columns. No existing row changes; no backfill.

-- Hand-made events. A repeating event is one row (a series); its occurrences are worked out when
-- asked, never stored. Dates are Sydney YYYY-MM-DD; times are Sydney HH:MM wall clock.
CREATE TABLE planner_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  layer TEXT NOT NULL CHECK (layer IN ('company','install','accounts','design_pm','scheduling','workshop','personal')),
  owner_id INTEGER NOT NULL REFERENCES users(id),      -- the creator; for personal, the only person who sees it
  title TEXT NOT NULL,                                 -- 1..200 characters (checked in code)
  notes TEXT NOT NULL DEFAULT '',                      -- up to 4,000 characters (checked in code)
  job_id INTEGER REFERENCES jobs(id),
  all_day INTEGER NOT NULL CHECK (all_day IN (0,1)),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,                              -- inclusive; = start_date for a timed event
  start_time TEXT,                                     -- NULL when all-day
  end_time TEXT,                                       -- NULL when all-day; after start_time
  repeat TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none','weekly','fortnightly','monthly')),
  repeat_until TEXT,                                   -- last allowed occurrence START date; NULL = no end
  repeat_day INTEGER CHECK (repeat_day IS NULL OR repeat_day BETWEEN 1 AND 31),  -- monthly only: the day aimed for
  split_from_id INTEGER REFERENCES planner_events(id), -- set on the second half of a split series
  reminder TEXT CHECK (reminder IS NULL OR reminder IN ('start','min15','hour1','day1','morning','day_before')),
  remind_layer INTEGER NOT NULL DEFAULT 0 CHECK (remind_layer IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id),
  CHECK (end_date >= start_date),
  CHECK ((all_day = 1 AND start_time IS NULL AND end_time IS NULL)
      OR (all_day = 0 AND start_time IS NOT NULL AND end_time IS NOT NULL
          AND end_time > start_time AND end_date = start_date)),
  CHECK (repeat <> 'none' OR repeat_until IS NULL),
  CHECK ((repeat = 'monthly') = (repeat_day IS NOT NULL)),
  CHECK (layer <> 'personal' OR remind_layer = 0),
  CHECK (remind_layer = 0 OR reminder IS NOT NULL)
);
CREATE INDEX idx_planner_events_layer ON planner_events(layer, start_date);
CREATE INDEX idx_planner_events_owner ON planner_events(owner_id, layer);
CREATE INDEX idx_planner_events_job ON planner_events(job_id);

-- One-off changes to one occurrence of a series. NULL override = as the series. An exception can
-- never change the layer, the job, all-day-ness or the reminder, so who sees an occurrence is
-- always the series' rule.
CREATE TABLE planner_exceptions (
  event_id INTEGER NOT NULL REFERENCES planner_events(id),
  occurrence_date TEXT NOT NULL,                       -- the occurrence's ORIGINAL start date (the key)
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0,1)),
  title TEXT,
  notes TEXT,
  start_date TEXT,
  end_date TEXT,
  start_time TEXT,
  end_time TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id),
  PRIMARY KEY (event_id, occurrence_date),
  CHECK ((start_date IS NULL) = (end_date IS NULL)),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK ((start_time IS NULL) = (end_time IS NULL)),
  CHECK (end_time IS NULL OR end_time > start_time)
);
CREATE INDEX idx_planner_exceptions_dates ON planner_exceptions(start_date, end_date);

-- Reminders already sent (the dedupe record). A moved occurrence gets a new fire_at and reminds
-- again. Never pruned (tiny).
CREATE TABLE planner_reminders_sent (
  event_id INTEGER NOT NULL REFERENCES planner_events(id),
  occurrence_date TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  fire_at TEXT NOT NULL,                               -- UTC ISO with milliseconds
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (event_id, occurrence_date, user_id, fire_at)
);

-- Ranged reads for the automatic events (section 8). The other sources are indexed already.
CREATE INDEX idx_jobs_promised_install ON jobs(promised_install_date);
CREATE INDEX idx_jobs_materials_ordered ON jobs(materials_ordered_date);
CREATE INDEX idx_jobs_materials_in ON jobs(materials_in_date);
CREATE INDEX idx_orders_expected ON orders(expected_date);
