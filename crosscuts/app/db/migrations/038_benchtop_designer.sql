-- Benchtop designer (0.2.0, Todd 2026-10-24; docs/plans/m21-benchtop-designer.md). Additive only:
-- four new tables and a starting list of edge finishes.

-- Admin > Benchtop lists: the stone materials a piece may be made of.
CREATE TABLE benchtop_materials (
  id INTEGER PRIMARY KEY,
  supplier TEXT NOT NULL,
  range_name TEXT NOT NULL DEFAULT '',
  colour TEXT NOT NULL,
  thickness_mm INTEGER NOT NULL CHECK (thickness_mm BETWEEN 5 AND 200),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Admin > Benchtop lists: the edge finishes, each drawn in one line style with a short code.
CREATE TABLE benchtop_edge_finishes (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  line_style TEXT NOT NULL CHECK (line_style IN ('heavy', 'thin', 'double', 'dashed', 'dotted')),
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One plan per job: the working copy. design_json holds the pieces (see the contracts note).
CREATE TABLE benchtop_plans (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  design_json TEXT NOT NULL DEFAULT '{"pieces":[]}',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

-- Each printed revision (A, B, C...), frozen with the material and finish names as they were.
CREATE TABLE benchtop_plan_revisions (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES benchtop_plans(id),
  seq INTEGER NOT NULL CHECK (seq >= 1),        -- 1 = A, 2 = B, ... 27 = AA
  letter TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  printed_at TEXT NOT NULL,
  printed_by INTEGER REFERENCES users(id),
  UNIQUE (plan_id, seq),
  UNIQUE (plan_id, letter)
);

INSERT INTO benchtop_edge_finishes (code, name, line_style, sort, created_at, updated_at) VALUES
  ('PR', 'Pencil round', 'heavy', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('AR', 'Arris', 'thin', 2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('MITRE', 'Mitred', 'double', 3, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('BN', 'Bullnose', 'dotted', 4, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('RAW', 'Raw, against wall', 'dashed', 5, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
