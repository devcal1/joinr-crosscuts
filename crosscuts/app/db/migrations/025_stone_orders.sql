-- M12 Design/PM tools (docs/plans/m12-contracts.md section 2). Additive only: two new tables.

-- A stone benchtop order for a job: the form as it stands now (the working copy).
CREATE TABLE stone_orders (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),  -- the last revision sent; 0 = never sent
  supplier TEXT NOT NULL DEFAULT '',
  job_reference TEXT NOT NULL DEFAULT '',
  quote_number TEXT NOT NULL DEFAULT '',
  site_address TEXT NOT NULL DEFAULT '',
  site_access TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  client_phone TEXT NOT NULL DEFAULT '',
  our_contact TEXT NOT NULL DEFAULT '',
  our_phone TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  colour TEXT NOT NULL DEFAULT '',
  edge_height TEXT NOT NULL DEFAULT '',
  edge_profile TEXT NOT NULL DEFAULT '',
  cabinetry_install_date TEXT,                -- Sydney dates, or NULL
  measure_date TEXT,
  requested_install_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  CHECK ((status = 'draft' AND revision = 0) OR (status = 'sent' AND revision >= 1) OR status = 'cancelled')
);
CREATE INDEX idx_stone_orders_job ON stone_orders(job_id);
CREATE INDEX idx_stone_orders_status ON stone_orders(status);

-- Each revision as it was sent, frozen, so it can be printed again exactly.
CREATE TABLE stone_order_revisions (
  id INTEGER PRIMARY KEY,
  stone_order_id INTEGER NOT NULL REFERENCES stone_orders(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  form_json TEXT NOT NULL,                    -- the form as sent (section 3's keys), frozen
  sent_date TEXT NOT NULL,                    -- the Sydney date it was sent (typed; default today)
  sent_at TEXT NOT NULL,                      -- when it was marked sent (UTC ISO)
  sent_by INTEGER REFERENCES users(id),
  UNIQUE (stone_order_id, revision)
);
