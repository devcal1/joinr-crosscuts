-- M13 Owner-only (docs/plans/m13-contracts.md section 2). Additive only: users.is_owner and its
-- backfill, and new tables for bonuses, alarm holders and loans.

-- The owner -----------------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1));
-- At most one owner, ever. "Exactly one" is kept by the code (section 3.4).
CREATE UNIQUE INDEX idx_users_one_owner ON users(is_owner) WHERE is_owner = 1;

-- Backfill: the first-run setup user (the auth.setup audit row) while still an enabled admin; else
-- the earliest-created enabled admin; else the earliest admin. A database with no users (fresh, or
-- the old app's) gets nobody, and first-run setup marks the owner (section 3.3).
UPDATE users SET is_owner = 1 WHERE id = (
  SELECT u.id
    FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'admin'
   ORDER BY COALESCE(u.disabled = 0 AND u.id = (SELECT CAST(a.entity_id AS INTEGER) FROM audit_log a
                                                  WHERE a.action = 'auth.setup' ORDER BY a.id LIMIT 1), 0) DESC,
            u.disabled ASC, u.created_at ASC, u.id ASC
   LIMIT 1);

-- Bonuses -------------------------------------------------------------------------------------
-- The rate (one row).
CREATE TABLE bonus_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (rate_bp BETWEEN 0 AND 10000),   -- basis points of the price
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id)
);
INSERT INTO bonus_settings (id, rate_bp) VALUES (1, 0);

-- Who shares a job's bonus, and their points (the share total is the sum, never typed).
CREATE TABLE bonus_holders (
  person_id INTEGER PRIMARY KEY REFERENCES pay_people(id),
  points INTEGER NOT NULL CHECK (points BETWEEN 0 AND 1000),
  sort INTEGER NOT NULL
);

-- One bonus per job.
CREATE TABLE bonuses (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents BETWEEN 0 AND 10000000000),
  ran_by INTEGER REFERENCES pay_people(id),          -- who ran the job
  checked_by INTEGER REFERENCES pay_people(id),      -- who checked it
  quoted_factory_min INTEGER CHECK (quoted_factory_min IS NULL OR quoted_factory_min BETWEEN 0 AND 600000),
  quoted_install_min INTEGER CHECK (quoted_install_min IS NULL OR quoted_install_min BETWEEN 0 AND 600000),
  actual_factory_min INTEGER CHECK (actual_factory_min IS NULL OR actual_factory_min BETWEEN 0 AND 600000),
  actual_install_min INTEGER CHECK (actual_install_min IS NULL OR actual_install_min BETWEEN 0 AND 600000),
  quoted_from_joinr INTEGER NOT NULL DEFAULT 0 CHECK (quoted_from_joinr IN (0, 1)),
  check_drawn INTEGER NOT NULL DEFAULT 0 CHECK (check_drawn IN (0, 1)),
  check_ordered INTEGER NOT NULL DEFAULT 0 CHECK (check_ordered IN (0, 1)),
  check_assembled INTEGER NOT NULL DEFAULT 0 CHECK (check_assembled IN (0, 1)),
  check_installed INTEGER NOT NULL DEFAULT 0 CHECK (check_installed IN (0, 1)),
  check_no_fuss INTEGER NOT NULL DEFAULT 0 CHECK (check_no_fuss IN (0, 1)),
  check_on_time INTEGER NOT NULL DEFAULT 0 CHECK (check_on_time IN (0, 1)),
  check_hours INTEGER CHECK (check_hours IS NULL OR check_hours IN (0, 1)),  -- NULL: follow the suggestion
  note TEXT NOT NULL DEFAULT '',
  -- Frozen at confirm (section 4.4):
  confirmed_date TEXT,                               -- Sydney date (typed; default today)
  rate_bp INTEGER,
  possible_cents INTEGER,
  earned_cents INTEGER,
  shares_json TEXT,                                  -- [{personId, name, points}] and the total
  confirmed_at TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  CHECK ((status = 'draft' AND confirmed_date IS NULL AND rate_bp IS NULL AND possible_cents IS NULL
          AND earned_cents IS NULL AND shares_json IS NULL AND confirmed_at IS NULL)
      OR (status = 'confirmed' AND confirmed_date IS NOT NULL AND rate_bp IS NOT NULL AND possible_cents IS NOT NULL
          AND earned_cents IS NOT NULL AND shares_json IS NOT NULL AND confirmed_at IS NOT NULL
          AND price_cents IS NOT NULL AND check_hours IS NOT NULL))
);
CREATE INDEX idx_bonuses_status ON bonuses(status);

-- Each holder's share of a confirmed bonus (only shares above 0 cents), and its payment.
CREATE TABLE bonus_shares (
  bonus_id INTEGER NOT NULL REFERENCES bonuses(id),
  person_id INTEGER NOT NULL REFERENCES pay_people(id),
  points INTEGER NOT NULL,
  share_cents INTEGER NOT NULL CHECK (share_cents > 0),
  paid_date TEXT,                                    -- Sydney date
  pay_run_id INTEGER REFERENCES pay_runs(id),        -- optional: which pay run it went in
  paid_at TEXT,
  paid_by INTEGER REFERENCES users(id),
  PRIMARY KEY (bonus_id, person_id),
  CHECK ((paid_date IS NULL) = (paid_at IS NULL)),
  CHECK (paid_date IS NOT NULL OR pay_run_id IS NULL)
);
CREATE INDEX idx_bonus_shares_person ON bonus_shares(person_id);

-- Alarms --------------------------------------------------------------------------------------
-- A user slot on the alarm panel. The code is AES-256-GCM ciphertext (section 5.1); never plain.
CREATE TABLE alarm_slots (
  id INTEGER PRIMARY KEY,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 999),
  person_id INTEGER REFERENCES pay_people(id),       -- a staff holder ...
  holder_name TEXT,                                  -- ... or a typed name (temp, cleaner, outsider)
  holder_type TEXT NOT NULL CHECK (holder_type IN ('office', 'staff', 'temp')),
  given_date TEXT,
  removed_date TEXT,                                 -- set: the slot is no longer in use
  note TEXT NOT NULL DEFAULT '',
  code_ct TEXT,                                      -- base64 ciphertext
  code_iv TEXT,                                      -- base64, 12 bytes
  code_tag TEXT,                                     -- base64, 16 bytes
  code_key_id TEXT,                                  -- which key (section 5.1), 16 hex
  code_set_at TEXT,
  code_set_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  CHECK ((person_id IS NULL) <> (holder_name IS NULL)),
  CHECK ((code_ct IS NULL) = (code_iv IS NULL) AND (code_ct IS NULL) = (code_tag IS NULL)
     AND (code_ct IS NULL) = (code_key_id IS NULL) AND (code_ct IS NULL) = (code_set_at IS NULL)),
  CHECK (removed_date IS NULL OR code_ct IS NULL)    -- a removed slot keeps no code
);
-- A slot number is unique among slots in use.
CREATE UNIQUE INDEX idx_alarm_slots_active ON alarm_slots(slot) WHERE removed_date IS NULL;

-- The alarm company (one row). No monitoring password, by design (Decision 6).
CREATE TABLE alarm_company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id)
);
INSERT INTO alarm_company (id) VALUES (1);

-- The weekly times: arms in the evening, disarms in the morning (Decision 6). 1 = Monday.
CREATE TABLE alarm_times (
  day INTEGER PRIMARY KEY CHECK (day BETWEEN 1 AND 7),
  arms_at TEXT,                                      -- HH:MM or NULL
  disarms_at TEXT,                                   -- HH:MM or NULL
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id)
);
INSERT INTO alarm_times (day) VALUES (1), (2), (3), (4), (5), (6), (7);

-- Loans ---------------------------------------------------------------------------------------
CREATE TABLE loans (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('lent_to_business', 'lent_by_business')),
  other_party TEXT NOT NULL DEFAULT '',
  opening_balance_cents INTEGER NOT NULL CHECK (opening_balance_cents BETWEEN 0 AND 10000000000),
  opening_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

-- The annual rate from a date (the rate history).
CREATE TABLE loan_rates (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  from_date TEXT NOT NULL,
  rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 5000),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  UNIQUE (loan_id, from_date)
);

-- A repayment: principal and interest paid on a date. The balance is never stored.
CREATE TABLE loan_repayments (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  paid_date TEXT NOT NULL,
  principal_cents INTEGER NOT NULL CHECK (principal_cents BETWEEN 0 AND 10000000000),
  interest_cents INTEGER NOT NULL CHECK (interest_cents BETWEEN 0 AND 10000000000),
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  CHECK (principal_cents + interest_cents > 0)
);
CREATE INDEX idx_loan_repayments_loan ON loan_repayments(loan_id, paid_date, id);
