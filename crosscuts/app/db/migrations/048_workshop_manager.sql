-- Workshop manager (0.2.6, docs/plans/m27-contracts.md). Additive only: new columns and two new tables.

-- Stock order targets: the total wanted on the shelf; Order fills in as max(target - have, 0).
ALTER TABLE stock_items ADD COLUMN target INTEGER CHECK (target IS NULL OR target >= 0);

-- Maintenance items are recurring tasks of kind 'maintenance' (Workshop > Maintenance); NULL is an
-- ordinary Admin > Tasks rule.
ALTER TABLE recurring_tasks ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind IN ('maintenance'));
-- Confirm actioned's optional note, and the day an overdue occurrence last belled admin.
ALTER TABLE recurring_occurrences ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE recurring_occurrences ADD COLUMN overdue_belled_on TEXT;

-- Board and edge tape stock: edge rolls join the board list as a second kind (whole rolls).
-- on_hand is live: the board count sets it to what was counted; cutting a job takes its
-- confirmed reservations off.
ALTER TABLE boards ADD COLUMN kind TEXT NOT NULL DEFAULT 'board' CHECK (kind IN ('board', 'edge'));
ALTER TABLE boards ADD COLUMN width INTEGER CHECK (width IS NULL OR width > 0);       -- mm, edge only
ALTER TABLE boards ADD COLUMN colour TEXT NOT NULL DEFAULT '';
ALTER TABLE boards ADD COLUMN on_hand REAL CHECK (on_hand IS NULL OR on_hand >= 0);
ALTER TABLE boards ADD COLUMN on_hand_at TEXT;

-- Reserve from stock instead of ordering: a job's boards or edging order line, part or all of it.
-- covers = 1: nothing left to order on that line (it counts as ordered for the all-ordered rule).
CREATE TABLE stock_reservations (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  material_id INTEGER REFERENCES job_materials(id),
  board_id INTEGER NOT NULL REFERENCES boards(id),
  qty REAL NOT NULL CHECK (qty > 0),
  covers INTEGER NOT NULL DEFAULT 0 CHECK (covers IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'confirmed', 'cut', 'released')),
  reserved_by INTEGER REFERENCES users(id),
  reserved_at TEXT NOT NULL,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  cut_by INTEGER REFERENCES users(id),
  cut_at TEXT,
  released_by INTEGER REFERENCES users(id),
  released_at TEXT
);
CREATE INDEX idx_stock_reservations_job ON stock_reservations(job_id, status);
CREATE INDEX idx_stock_reservations_board ON stock_reservations(board_id, status);
CREATE INDEX idx_stock_reservations_order ON stock_reservations(order_id, status);

-- A job recorded as cut 100% (end of shift), once.
CREATE TABLE job_cuts (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id),
  date TEXT NOT NULL,                        -- Sydney YYYY-MM-DD
  cut_by INTEGER REFERENCES users(id),
  cut_at TEXT NOT NULL
);
