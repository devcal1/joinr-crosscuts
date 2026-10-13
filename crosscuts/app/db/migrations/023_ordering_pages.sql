-- M11 Ordering pages (docs/plans/m11-contracts.md section 2). Additive only: new tables.

-- Drawers ------------------------------------------------------------------------------------
-- The drawer name list: a Joinr catalogue name -> brand, height and length, or ignored.
CREATE TABLE drawer_names (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,                        -- as Joinr sends it (trimmed)
  name_key TEXT NOT NULL UNIQUE,             -- lower(trim(name)), single spaces
  brand TEXT,                                -- 'edge' | 'dtc' (checked in code)
  height INTEGER,                            -- mm, one of the brand's heights
  length INTEGER,                            -- mm, one of the lengths
  ignored INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  CHECK ((ignored = 1 AND brand IS NULL AND height IS NULL AND length IS NULL)
      OR (ignored = 0 AND brand IS NOT NULL AND height IS NOT NULL AND length IS NOT NULL))
);

-- A placed drawer order (one brand, one supplier order).
CREATE TABLE drawer_orders (
  id INTEGER PRIMARY KEY,
  brand TEXT NOT NULL,
  supplier TEXT NOT NULL,
  ordered_date TEXT NOT NULL,
  expected_date TEXT,
  grid_json TEXT NOT NULL,                   -- the sheet as sent (section 4.3), frozen
  stock_received_date TEXT,                  -- the stock row's delivery (null when no stock row)
  stock_received_by INTEGER REFERENCES users(id),
  stock_delivery_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id)
);

-- An order line that is a job's drawers (one brand per line).
CREATE TABLE order_drawers (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id),
  brand TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('joinr', 'manual')),
  joinr_lines TEXT,                          -- JSON: the quote's drawer lines when filled from Joinr (4.5)
  checked_at TEXT,                           -- Design/PM checked the grid
  checked_by INTEGER REFERENCES users(id),
  drawer_order_id INTEGER REFERENCES drawer_orders(id),
  CHECK ((checked_at IS NULL) = (checked_by IS NULL))
);
CREATE INDEX idx_order_drawers_drawer_order ON order_drawers(drawer_order_id);

CREATE TABLE order_drawer_counts (
  order_id INTEGER NOT NULL REFERENCES order_drawers(order_id),
  height INTEGER NOT NULL,
  length INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (order_id, height, length)
);

-- The stock row being prepared, per brand, before the order is placed.
CREATE TABLE drawer_stock_draft (
  brand TEXT NOT NULL,
  height INTEGER NOT NULL,
  length INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (brand, height, length)
);

-- Monthly stock order ------------------------------------------------------------------------
CREATE TABLE stock_items (
  id INTEGER PRIMARY KEY,
  supplier TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  item TEXT NOT NULL,
  link TEXT NOT NULL DEFAULT '',             -- http(s) or ''
  sort INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE stock_orders (
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL UNIQUE,               -- YYYY-MM
  counted_at TEXT,
  counted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((counted_at IS NULL) = (counted_by IS NULL))
);

CREATE TABLE stock_order_lines (
  stock_order_id INTEGER NOT NULL REFERENCES stock_orders(id),
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
  supplier TEXT NOT NULL,                    -- copied from the item when the line is first written
  code TEXT NOT NULL,
  item TEXT NOT NULL,
  have INTEGER CHECK (have IS NULL OR have >= 0),
  order_qty INTEGER CHECK (order_qty IS NULL OR order_qty >= 0),
  PRIMARY KEY (stock_order_id, stock_item_id)
);

-- One row per supplier group once it's ordered.
CREATE TABLE stock_order_groups (
  stock_order_id INTEGER NOT NULL REFERENCES stock_orders(id),
  supplier TEXT NOT NULL,
  ordered_date TEXT NOT NULL,
  ordered_by INTEGER REFERENCES users(id),
  expected_date TEXT,
  received_date TEXT,
  received_by INTEGER REFERENCES users(id),
  delivery_note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (stock_order_id, supplier)
);

-- Paint --------------------------------------------------------------------------------------
CREATE TABLE paint_items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  finish TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('colour', 'hardener', 'thinners', 'primer', 'abrasive', 'other')),
  unit TEXT NOT NULL CHECK (unit IN ('kg', 'each')),
  sort INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE paint_orders (
  id INTEGER PRIMARY KEY,
  supplier TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'ordered', 'received', 'cancelled')),
  notes TEXT NOT NULL DEFAULT '',
  ordered_date TEXT,
  ordered_by INTEGER REFERENCES users(id),
  expected_date TEXT,
  received_date TEXT,
  received_by INTEGER REFERENCES users(id),
  delivery_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  CHECK (status = 'draft' OR status = 'cancelled' OR ordered_date IS NOT NULL),
  CHECK (status <> 'received' OR received_date IS NOT NULL)
);
CREATE INDEX idx_paint_orders_status ON paint_orders(status);

CREATE TABLE paint_order_lines (
  id INTEGER PRIMARY KEY,
  paint_order_id INTEGER NOT NULL REFERENCES paint_orders(id),
  paint_item_id INTEGER REFERENCES paint_items(id),
  name TEXT NOT NULL,                        -- copied from the item (or typed)
  finish TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL CHECK (unit IN ('kg', 'each')),
  qty REAL NOT NULL CHECK (qty > 0),
  job_id INTEGER REFERENCES jobs(id),        -- null: workshop stock
  sort INTEGER NOT NULL
);
CREATE INDEX idx_paint_order_lines_order ON paint_order_lines(paint_order_id);

-- A paint order's job lines become one order line per job (Decision 6).
CREATE TABLE paint_order_jobs (
  paint_order_id INTEGER NOT NULL REFERENCES paint_orders(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  PRIMARY KEY (paint_order_id, job_id)
);

-- Board stocktake ----------------------------------------------------------------------------
CREATE TABLE boards (
  id INTEGER PRIMARY KEY,
  supplier TEXT NOT NULL DEFAULT '',
  thickness INTEGER CHECK (thickness IS NULL OR thickness > 0),   -- mm
  name TEXT NOT NULL,
  finish TEXT NOT NULL DEFAULT '',
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),  -- per sheet, ex GST
  sort INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE board_counts (
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL UNIQUE,               -- YYYY-MM
  status TEXT NOT NULL CHECK (status IN ('open', 'counted', 'valued')),
  counted_at TEXT,
  counted_by INTEGER REFERENCES users(id),
  valued_at TEXT,
  valued_by INTEGER REFERENCES users(id),
  adjustment_cents INTEGER NOT NULL DEFAULT 0,
  adjustment_note TEXT NOT NULL DEFAULT '',
  value_cents INTEGER,                       -- frozen when valued
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'open') = (counted_at IS NULL)),
  CHECK ((status = 'valued') = (valued_at IS NOT NULL AND value_cents IS NOT NULL))
);

CREATE TABLE board_count_lines (
  board_count_id INTEGER NOT NULL REFERENCES board_counts(id),
  board_id INTEGER NOT NULL REFERENCES boards(id),
  supplier TEXT NOT NULL,                    -- copied from the board when the line is first written
  thickness INTEGER,
  name TEXT NOT NULL,
  finish TEXT NOT NULL,
  qty REAL NOT NULL CHECK (qty >= 0),        -- whole and half sheets (lead's default 6)
  price_cents INTEGER,                       -- frozen when valued
  PRIMARY KEY (board_count_id, board_id)
);
