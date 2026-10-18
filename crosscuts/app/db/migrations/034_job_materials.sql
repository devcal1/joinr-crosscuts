-- A materials list per job (2026-10-18, docs/plans/materials-contracts.md). Additive only.
--
-- One row per line of a job's Materials list. A line is either `joinr` (prefilled from the won
-- quote; joinr_key is its stable key, so a later sync can match it) or `manual` (typed by a person;
-- joinr_key stays NULL). A person who edits a Joinr line sets `overridden`, and a sync then leaves
-- it alone. A removed line is soft-removed (removed_at) so a removed Joinr line does not come back
-- on the next sync. gone_from_joinr marks a Joinr line the latest quote no longer has (shown as
-- "No longer in Joinr"; never deleted). order_id is set when the line is turned into an order line
-- (orders.id); the line counts as ordered while that order is not cancelled.
-- section is free text (at most 40 characters) so a later Joinr contract can bring its own section
-- ids; the app offers boards, edging, doors, benchtop, handles, hardware, drawers, room_extras,
-- paint and other for typed lines.
CREATE TABLE job_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  section TEXT NOT NULL DEFAULT 'other' CHECK (length(trim(section)) > 0 AND length(section) <= 40),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 300),
  qty REAL CHECK (qty IS NULL OR (qty >= 0 AND qty <= 1000000)),
  unit TEXT CHECK (unit IS NULL OR length(unit) <= 30),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  source TEXT NOT NULL CHECK (source IN ('joinr','manual')),
  joinr_key TEXT CHECK (joinr_key IS NULL OR (length(joinr_key) > 0 AND length(joinr_key) <= 400)),
  overridden INTEGER NOT NULL DEFAULT 0 CHECK (overridden IN (0,1)),
  gone_from_joinr INTEGER NOT NULL DEFAULT 0 CHECK (gone_from_joinr IN (0,1)),
  removed_at TEXT,
  order_id INTEGER REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  CHECK (source <> 'joinr' OR joinr_key IS NOT NULL),
  CHECK (source <> 'manual' OR joinr_key IS NULL)
);
CREATE INDEX idx_job_materials_job ON job_materials(job_id, position);
CREATE UNIQUE INDEX idx_job_materials_key ON job_materials(job_id, joinr_key) WHERE joinr_key IS NOT NULL;
CREATE INDEX idx_job_materials_order ON job_materials(order_id) WHERE order_id IS NOT NULL;
