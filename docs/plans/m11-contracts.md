# M11 interface contracts: Ordering pages (binding for all M11 subagents)

Read `docs/plans/m11-plan.md` first. Its **Decisions** (section 5, 1–9) and **Lead's defaults** (section 3, where section 5 doesn't replace them) are binding and win over its section 2. This file is the *what*.

Everything in `m1-contracts.md` … `m10-contracts.md` and `backup-contracts.md` still holds:
- UTC ISO timestamps with milliseconds, Sydney `YYYY-MM-DD` business dates, `YYYY-MM` months.
- `defineRoutes`, audit, `lib/httperror.js`, errors as `{error}`, money in integer cents.
- `m10-contracts.md` §3–§4 is the orders baseline this file extends.

If a contract looks wrong, report it instead of working around it. Points the integrator decided while writing this file are in §15; Todd can change any of them.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3` (the `node:sqlite` shim locally), Node 24, no build step, no framework.

**This repo is public.** Smoke, screenshot and seed data use made-up names only (`M11 Test Board`, `M11 Test Paint`, `M11 Drawer Supplier`). No supplier, product range, price or stock value from the workbook appears in code, docs or tests.

**Version.** M11 ships as **0.1.15**. The scaffold bumps `crosscuts/app/package.json` and the root version in `crosscuts/app/package-lock.json`; there's no further bump during the build.

**Not touched in M11:**
- The board files (`schedule.*`, `workers.html`, `exportJpg()`, `alignPanels()`) and `public/shared.js`.
- The Planner (no new layer or automatic source) and the chat channels.
- `lib/invoices.js`: the progress-invoice trigger is unchanged and still reached only through `orders.markMaterialsOrdered`.
- `lib/bas.js` and migrations 001–022.

## 1. Files and owners

| File | What it is | Owner |
|---|---|---|
| `db/migrations/023_ordering_pages.sql` | every new table (§2), complete | scaffold |
| `lib/permissions.js` | two keys, presets (§3) | scaffold |
| `lib/settings.js` | three settings (§3.3) | scaffold |
| `lib/pages.js` | five pages (§10) | scaffold |
| `public/shell/shell.js` | Ordering and Accounts menu items, `PAGE_ALIASES` (§10) | scaffold |
| `public/drawers.js` | the drawer sizes module, shared by server and pages (§4.1), complete | scaffold |
| `lib/orderlinks.js` | what an order line belongs to, and the refusals (§5), complete | scaffold |
| `lib/orders.js` | the hooks of §5.2 (complete), and `deliveries()` gaining `stock` (§9) | scaffold |
| `routes/drawers.js`, `routes/stock.js`, `routes/paint.js`, `routes/boards.js` | every route of §6–§8 declared with its access value; handlers 501 | scaffold, then A / B / C |
| `lib/drawers.js`, `lib/stock.js`, `lib/boards.js`, `lib/paint.js` | binding signatures as stubs (501) | scaffold, then A / B / B / C |
| `lib/stockdeliveries.js` | `stockDeliveries()` stub (§9); it answers an empty list, not 501, so Deliveries and the M10 smoke keep working (scaffold note) | scaffold, then B |
| `ci/smoke.sh` | key counts 25 → 27, the presets, the M11 source loop (§12.1) | scaffold |
| `crosscuts/app/package.json`, `package-lock.json` | 0.1.15 | scaffold |
| `lib/joinr-sync.js` (`validateItem`, `LABELS`, `changedFields`), `lib/intake.js` (accept and link hooks), `ci/fake-joinr.js` | the `drawers` field (§4.4–§4.5) | A |
| `lib/drawers.js`, `routes/drawers.js`, `ci/smoke-m11-drawers.sh` | §4, §6 | A |
| `lib/stock.js`, `lib/boards.js`, `lib/stockdeliveries.js`, `routes/stock.js`, `routes/boards.js`, `ci/smoke-m11-stock.sh` | §7, §8, §9 | B |
| `lib/paint.js`, `routes/paint.js`, `ci/smoke-m11-paint.sh` | §6.3 (paint), §5 paint links | C |
| `public/drawers.html`, `drawerspage.css`, `drawerspage.js`; `public/job.js` (Orders section: the drawer grid), `public/job.html` (if the section needs markup) | §11.1, §11.2 (prefix `dw-`) | D |
| `public/stock.{html,css,js}`, `public/boards.{html,css,js}`, `public/stockvalue.{html,css,js}` | §11.3–§11.5 (prefixes `st-`, `bd-`, `sv-`) | E |
| `public/paint.{html,css,js}`, `public/deliveries.js` and `deliveries.css` (the Stock and paint group), `public/index.{js,html}` (dashboard lines), `public/orderui.js` (the managed-line actions) | §11.6–§11.8 (prefix `pt-`) | F |
| `docs/how-to-order-drawers.md`, `docs/how-to-do-the-stocktake.md`, `docs/auth.md`, `docs/how-to-add-user.md`, `docs/plans/menu-plan.md`, `docs/crosscuts-brief.md` §3 (Orders and the new pages, Todd's sign-off as in M10), `docs/integrations/joinr-crosscuts-intake.md` (version 2, §4.4), `tools/screenshots/seed.js`, `tools/screenshots/shoot.js` | docs and made-up data | integrator, 4.1 |
| tenon-quotr: `apps/portal/src/lib/crosscuts-intake.ts`, its tests, `docs/integrations/joinr-crosscuts-intake.md` | the Joinr side (§13) | task J2, separate |

**Boundaries.**
- Every rule about who may do what lives in `lib/` (routes declare only the coarse access value). Pages hide controls but never decide access.
- Every write runs in one `db.transaction` with its audit row.
- An order line's status only ever changes through `lib/orders.js` (`updateLine`, `cancelLine`, `createLine`, called with the `via` option of §5.2). `lib/drawers.js` and `lib/paint.js` never write `orders.status` themselves, so the all-ordered and materials-in rules always run.

## 2. Migration `023_ordering_pages.sql` (scaffold)

Additive only: new tables and indexes, no change to any existing table or row. Brands, heights and lengths aren't in CHECKs (they live in `public/drawers.js`, lead's default 2), so a new size never needs a table rebuild.

```sql
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
```

The runner's `VACUUM INTO` backup runs first as always. The scaffold proves 023 on a fresh `.dev/m11/` and on a copy of the latest local test database.

## 3. Keys, presets and settings (scaffold)

### 3.1 Keys

`KEYS` gains two keys, **appended**: `"stock.count"` and `"stock.order"`, making **27 keys**. Roles are unchanged (8), so no `user_roles` rebuild.

| Preset | Change |
|---|---|
| `admin` | every key, as now |
| `ordering` | + `stock.count`, `stock.order` |
| `workshop_manager` | + `stock.count` |
| others | unchanged |

### 3.2 What each key means

- **`stock.count`:**
  - Type **Have** on the monthly stock order and finish the count.
  - Type board quantities and finish the board count.
  - See the stock and board lists, without board prices.
- **`stock.order`:**
  - Edit the stock, paint and board lists, the board prices and the drawer name list.
  - The monthly stock order's **Order** column and its supplier groups.
  - The Drawer order page, paint orders, and confirming the board value.
  - The two drawer supplier settings and the litres factor.
- **Already existing:**
  - **`orders.mark_ordered`** is also needed to **place** a drawer order, and to mark a paint order with job lines ordered, because both mark job lines ordered.
  - **`orders.receive`** receives the drawer stock row, a stock supplier group and a paint order (§9), just as it receives order lines.
  - **`orders.edit`** adds and edits a job's drawer grid (§6.1).
  - **`jobs.edit`** **checks** a drawer grid (Decision 2: Design/PM; admin too).
  - **`accounts.view`** opens the Stock value page.

### 3.3 Settings (`lib/settings.js` `DEFAULTS`)

```js
// M11 (docs/plans/m11-contracts.md section 3.3): changed through PUT /api/drawers/settings and
// PUT /api/paint/settings only (never /api/settings).
"drawers.supplier.edge": "Finista EDGE",
"drawers.supplier.dtc": "DTC DragonPro",
"paint.litres_per_kg": "0.85",
```

## 4. Drawers

### 4.1 `public/drawers.js` (scaffold, complete)

A UMD-style file (`module.exports` on the server, `window.Drawers` in pages), the single source of the sizes:

```js
const BRANDS = [
  { id: "edge", label: "EDGE", heights: [
    { mm: 93, label: "Low 93" }, { mm: 126, label: "Mid 126" },
    { mm: 174, label: "High 174" }, { mm: 238, label: "Super High 238" } ] },
  { id: "dtc", label: "DTC", heights: [
    { mm: 95, label: "95" }, { mm: 127, label: "127" }, { mm: 178, label: "178" }, { mm: 209, label: "209" } ] },
];
const LENGTHS = [300, 350, 400, 450, 500, 550, 600];
// brand(id) -> brand|null; validSize(brandId, height, length) -> bool;
// describe(brandId, counts) -> "Drawers (EDGE): 6 × Mid 126/500, 4 × High 174/500" (cut to 500 characters with "…");
// total(counts) -> number; grid(counts) -> {[height]: {[length]: qty}}.
```

Counts everywhere are `[{height, length, qty}]` with `qty` a whole number from 1 to 999. A zero count is simply absent, and a duplicate cell is refused with 400.

### 4.2 A job's drawer line

- **A drawer line is an ordinary `orders` row plus an `order_drawers` row**, and its counts.
  - `supplier` is the brand's supplier setting at creation; `description` is `describe()`, rewritten whenever the counts change.
  - **One drawer line per brand per job** while it is `to_order`. A second one is 409 `"This job already has an EDGE drawer line waiting to be ordered"`.
- **The present object.** `present()` (in `lib/orders.js`, §5) gains:
  - `kind`: `"drawers"`, `"paint"` or `null`.
  - For drawers, `drawers: {brand, source, checked: {at, by: {id, name}}|null, drawerOrderId}`.
  - For paint, `paintOrderId`.
- **The checked state:**
  - It can be set only by a `jobs.edit` holder.
  - It's cleared whenever the counts change, unless the same request sets it again.
  - **Only checked lines** go into the Drawer order page's totals. Unchecked ones are listed as "Waiting for Design/PM check".

### 4.3 The grid as sent (`drawer_orders.grid_json`)

```js
{ brand: "edge", supplier, orderedDate, expectedDate,
  rows: [ { orderId, jobId, jobName, notes?, counts: [...] }, ... ],   // by job name (case-blind), then orderId
  stock: [ {height, length, qty} ],                             // the stock row, may be empty
  totals: [ {height, length, qty} ], total: n }
```

`notes` is the line's notes at the moment of placing, set only when it has some (§15.15, Todd 2026-10-14); orders placed before that have none. The placed sheet and its reprint show it under the job's name.

The print layout is the workbook's:
- One block per height, with the seven lengths across.
- A row per job, then **Stock**, then the totals.
- The grand total and the date at the foot.

### 4.4 The Joinr field (A on the Crosscuts side, J2 on the Joinr side; contract version 2)

The intake item gains one **optional** top-level field. The wire `contract` stays **1**: older Crosscuts installs drop unknown fields (`validateItem` copies only known ones), and an older Joinr simply doesn't send it.

| Field | Type | Meaning |
|---|---|---|
| `drawers` | `{section, name, qty}[]` or absent | The revision's lines in the catalogue sections with id `drawers` and `innerDrawers`. `section` is that id. `name` is the catalogue item name as stored on the line. `qty` is the sum for that name in that section across every room (rows with the same name added together), a positive number. |

Joinr's rules for the field:
- It skips lines whose name isn't in the quote's card (stale lines, as the engine's `sumQty` does), lines whose quantity isn't a positive finite number, and the room-level custom items.
- It sends `[]` when the quote has no such lines, or the org has deleted both sections.
- Order: by section (`drawers` first), then by name.

**`validateItem`** (A):
- Absent or `null` → `drawers: null` ("not reported").
- Otherwise it must be an array of at most 200 entries, each with:
  - `section` in `["drawers", "innerDrawers"]`
  - `name` a non-empty string of at most 200 characters (trimmed)
  - `qty` a finite number above 0 and at most 100000, rounded to a whole number (a fractional quantity rounds half up; 0 after rounding is dropped)
- A bad entry (or a `drawers` that isn't an array) **doesn't refuse the quote** (§15.22): the item is imported with `drawers: null` ("not reported"), the problem is logged (`[joinr] item <cursor>: drawers not read (drawers[<i>] ...); imported without them`, naming the field, never the value), and the `users.admin` holders get a notice: kind `joinr.drawers`, title `Drawers not read from Joinr: <quote number and site>`, link `/intake.html?item=<id>`, entity `joinr_intake` with id `<rootQuoteId>:<hash of the problem>`, sent once per quote and distinct problem (a repeat of the same item sends nothing). Every other field's rules still refuse the quote as before.
- The normalised copy gains `drawers` after `raw`.

**Changed detection** (A):
- `LABELS` gains `drawers: "drawers"`.
- In `changedFields`, **`drawers` counts as changed only when both payloads have an array** and the arrays differ by `canonical`. Going from `null` (an older payload) to an array is **not** a change. This way the first sync after Joinr starts sending the field doesn't mark every accepted record "changed".
- **Clarified at 3.1 (A):** in `applyItem`'s no-change branch, when the new item has a `drawers` array and the stored payload has none, the new payload **is stored** (with `last_seen_at`), still without flagging the record changed. Otherwise the list would never be kept, Refill couldn't see it, and a later quantity change would compare `null` with a list again and go unflagged.

### 4.5 Filling from Joinr (A, in `lib/drawers.js`, called by `lib/intake.js`)

`fillFromJoinr(db, jobId, payloadDrawers, req, {quoteNumber})`, run inside `accept()` and `link()`'s transactions after the job is written, only when `payloadDrawers` is an array:

1. Each entry is looked up in `drawer_names` by `name_key` and becomes one of:
   - **mapped:** `{brand, height, length}`
   - **ignored**
   - **unmapped**
2. Mapped entries are summed per brand and cell.
3. For each brand with any mapped count, a drawer line is created:
   - `source: 'joinr'`, unchecked.
   - `joinr_lines` = **every** entry of the quote's drawer lines as Joinr sent them (not only that brand's), as `[{section, name, qty, map: {brand, height, length}|"ignored"|null}]`, `map` being the mapping at the time. "Changed in Joinr" (§6.1 `changedSinceFill`) compares these raw lines (section, name, summed qty) with the payload's, never the mapping, so remapping a name on our side is not a change (review A-m5).
   - `notes` = `From Joinr <quoteNumber>.`
   - **Skipped** when the job already has **any live (not cancelled) drawer line of that brand** (to order, ordered or received; §15.18, review A-m4). On `link()` the job may have one; while it is still to order the job page offers Refill (§6.1).
4. **Unmapped names, when there are any:**
   - If no line was created, the job's unmapped entries are still found later through the stored intake payload (`intake.forJob`).
   - One notice goes to `stock.order` holders: kind `drawers.unmapped`, title `Drawer names to add: <job name>`, body the names (cut to 300), link `/drawers.html#names`, entity `job`.
5. **When at least one line was created**, one notice goes to `jobs.edit` holders: kind `drawers.check`, title `Drawers to check: <job name>`, link `/job.html?id=<id>#orders`, entity `job`.
   - Both notices skip the actor.

**Fill from Joinr** (§15.18) runs the same fill for an existing job on demand: `POST /api/job-records/:id/drawers/fill` (§6.1). It creates, unchecked, a line for each brand that has mapped counts in the job's latest Joinr drawer lines and no live drawer line of that brand, sends the `drawers.check` notice (not the `drawers.unmapped` one), and is 409 `"Nothing to fill from Joinr"` when it would create none.

Nothing else in accept or link changes. A job accepted before M11, or from an older Joinr, has no drawer data. Design/PM then types its grid by hand (`source: 'manual'`).

## 5. Order lines that belong to something (`lib/orderlinks.js`, `lib/orders.js` hooks; scaffold, complete)

### 5.1 `lib/orderlinks.js`

```js
// What an order line belongs to: {kind: "drawers", brand, drawerOrderId, checked} |
// {kind: "paint", paintOrderId} | null.
linkOf(db, orderId) -> object|null
// SQL fragments for lib/orders.js's SELECT_LINE / listRows:
JOIN_SQL   // "LEFT JOIN order_drawers od ON od.order_id = o.id LEFT JOIN paint_order_jobs poj ON poj.order_id = o.id
           //  LEFT JOIN users uc ON uc.id = od.checked_by"
COLUMNS_SQL // "od.brand AS drawer_brand, od.source AS drawer_source, od.checked_at AS drawer_checked_at,
            //  od.checked_by AS drawer_checked_by, uc.display_name AS drawer_checked_by_name,
            //  od.drawer_order_id AS drawer_order_id, poj.paint_order_id AS paint_order_id"
```

### 5.2 The rules in `lib/orders.js`

- **`updateLine(db, id, patch, req, opts = {})`** and **`cancelLine(db, id, req, opts = {})`** take a new last argument, `opts.via`: `"drawers"`, `"paint"` or undefined. A plain call (the routes) has no `via`. The refusals below apply only to plain calls:

| Line | Plain call | Answer |
|---|---|---|
| drawers | `to_order → ordered` | 409 `"Drawer lines are ordered from the Drawer order page"` |
| drawers | `ordered → to_order` while `drawerOrderId` is set (on a placed drawer order) | 409 `"These drawers are on a placed drawer order. Use Undo order on the Drawer order page."` (§15.17) |
| drawers | `supplier` or `description` changed | 409 `"The drawer grid sets this line; change the grid"` |
| drawers | anything else (receive, undo, notes, expected date, ordered date, delivery note, cancel) | allowed as for any line |
| paint | any status change, any field, cancel | 409 `"This line is part of paint order <id>; change it there"` |

- **A drawer line moving `ordered → to_order`** (only ever through `lib/drawers.js`, §15.17: Undo order on the Drawer order page; a plain call is refused while the line is on a placed order), sets `order_drawers.drawer_order_id = NULL` in the same transaction (the placed order's frozen `grid_json` keeps it as history).
- **`createLine(db, jobId, fields, req, opts = {})`** is unchanged for plain calls. `lib/drawers.js` and `lib/paint.js` call it and then write their own link row in the same transaction.
- **`present()`** adds `kind`, `drawers`, `paintOrderId` (§4.2) from the joined columns. A drawer line's `drawers.drawerOrderId` is the placed drawer order's id, or `null`; the pages hide Undo ordered on a drawer line while it is set. `list()`, `listForJob()` and `deliveries()` rows carry them.
- **`deliveries()`:**
  - It leaves **paint lines** out of its five groups and `recent`, because they're received with their paint order (§9).
  - It keeps drawer lines (the Workshop Manager receives each job's drawers).
  - It gains `stock: require("./stockdeliveries").stockDeliveries(db, today)`.
  - `counts.today` and `counts.overdue` include the stock items' `today` and `overdue` counts.

## 6. Drawer and paint routes and libraries

### 6.1 Drawers (`routes/drawers.js`, `lib/drawers.js`; A)

| Method & path | Access | What |
|---|---|---|
| `GET /api/job-records/:id/drawers` | `jobs.view` | `{lines: [drawer line + counts + joinrLines], joinr: {drawers: [...] |null, unmapped: [...], changedSinceFill: bool}, canFill: bool}`; `canFill` is true when the caller holds `orders.edit` and Fill from Joinr would create at least one line (§15.18); `joinr` is from the job's latest intake payload (`intake.forJob`), null when none |
| `POST /api/job-records/:id/drawers` | `orders.edit` | `{brand, counts, notes?, expectedDate?, checked?}` → 201 `{order, job}`; `source: 'manual'`; `checked: true` needs `jobs.edit` (403 otherwise) |
| `POST /api/job-records/:id/drawers/fill` | `orders.edit` | Fill from Joinr (§4.5, §15.18) → 201 `{lines, joinr, canFill, created: [orderId]}` (the `GET` body plus the new ids); 409 `"Nothing to fill from Joinr"` |
| `PUT /api/orders/:id/drawers` | `orders.edit` | `{counts, notes?, checked?}`, on a `to_order` drawer line only (409 `"Only a drawer line still to order can be changed"`); empty `counts` → 400 `"Add at least one drawer, or cancel the line"`; the check rules of §4.2 |
| `POST /api/orders/:id/drawers/check` | `jobs.edit` | sets the check on a `to_order` line without changing counts; `{checked: false}` clears it |
| `POST /api/orders/:id/drawers/refill` | `orders.edit` | replaces the counts and `joinr_lines` from the latest intake payload and the current name list, `source: 'joinr'`, unchecked; 409 `"No drawers from Joinr for this job"` when the payload has none for the brand |
| `GET /api/drawers?brand=edge` | `stock.order` | `{brand, supplier, sheetKey, rows: [checked to_order lines on live jobs], waiting: [unchecked to_order lines], stock: [...draft], totals, total}`; `sheetKey` is a hash of what the sheet shows (§15.23) |
| `PUT /api/drawers/stock` | `stock.order` | `{brand, counts}` replaces the stock draft |
| `POST /api/drawers/place` | `stock.order` (+ `orders.mark_ordered` checked in lib, 403) | `{brand, orderedDate?, expectedDate?, orderIds, sheetKey}` → 201 `{drawerOrder}` (§6.2) |
| `GET /api/drawers/placed?brand=` | `stock.order` | newest first, 50 |
| `GET /api/drawers/placed/:id` | `stock.order` | one, with `grid` |
| `POST /api/drawers/placed/:id/undo` | `stock.order` (+ `orders.mark_ordered`) | §6.2 |
| `POST /api/drawers/placed/:id/stock-received` | `orders.receive` | `{receivedDate?, deliveryNote?}`; `{undo: true}` clears it |
| `GET /api/drawers/names` | `stock.order` | the name list, by name |
| `POST /api/drawers/names` | `stock.order` | `{name, brand, height, length}` or `{name, ignored: true}`; 409 `"That name is already on the list"` |
| `PATCH /api/drawers/names/:id`, `DELETE /api/drawers/names/:id` | `stock.order` | edit, remove (audited `drawer_name.*`) |
| `GET /api/drawers/unmapped` | `stock.order` | distinct unmapped names (with qty and job) from the intake payloads of accepted or linked records whose job is live and has no ordered drawer line yet |
| `GET /api/drawers/settings`, `PUT /api/drawers/settings` | `stock.order` | `{supplierEdge, supplierDtc}` (text, 1–200 characters) |

### 6.2 Placing and undoing

**Place** works only on what the user saw:
- `sheetKey` (from `GET /api/drawers?brand=`) is required (400 `"sheetKey is required"`) and must equal the sheet's current key: a hash of the brand's line ids, counts, notes and check state (checked and waiting lines) and the stock row. Otherwise it's 409 `"The drawer order changed while you were looking; reload it"` (§15.23).
- `orderIds` must equal exactly the brand's checked `to_order` drawer lines on live jobs, with the same 409.
- An empty set with an empty stock draft is 400 `"Nothing to order"`.
- `orderedDate` defaults to today and can't be in the future; `expectedDate` can't be before it (400 `"The expected date can't be before it was ordered (<date>)"`, as for a stock group and a paint order).

In one transaction it:
1. Writes `drawer_orders` with `grid_json`.
2. Calls `orders.updateLine(db, id, {status: "ordered", orderedDate, expectedDate}, req, {via: "drawers"})` for each line. So the all-ordered rule (the job's progress invoice) and the audit run per line, and `expectedDate` is set on each line, so they show on Deliveries.
3. Sets each line's `drawer_order_id`.
4. Empties the brand's stock draft.

Audit: `drawer_order.place`.

**Undo** is refused with 409 `"Something on this order has already been received"` when any line is received or the stock row is. Otherwise it:
1. Moves each line that is still `ordered` and still linked back to `to_order` (through `updateLine` with `via`).
2. Puts the stock row back as the draft (adding to any newer draft; a cell that would pass 999 is held at 999).
3. Deletes the `drawer_orders` row.

Audit: `drawer_order.undo`, with the frozen grid in `before`. A job whose progress invoice already fell due keeps it: `materials_ordered_date` is "done once", as with any undo today.

### 6.3 Paint (`routes/paint.js`, `lib/paint.js`; C)

| Method & path | Access | What |
|---|---|---|
| `GET /api/paint/items` | `stock.order` | active first, by `sort` |
| `POST /api/paint/items`, `PATCH /api/paint/items/:id`, `POST /api/paint/items/reorder` | `stock.order` | `{name, finish, manufacturer, kind, unit, active}`; reorder `{ids}` |
| `GET /api/paint/orders?status=` | `stock.order` | newest first; `status` open (draft or ordered, the default), all, or one status |
| `POST /api/paint/orders` | `stock.order` | `{supplier, notes?, expectedDate?, lines}` → 201, a draft |
| `GET /api/paint/orders/:id` | `["stock.order","orders.receive"]` | with lines, litres and the job links (no prices exist on paint) |
| `PUT /api/paint/orders/:id` | `stock.order` | draft only (409 `"Only a draft can be changed"`); replaces supplier, notes, expected date, lines |
| `POST /api/paint/orders/:id/ordered` | `stock.order` (+ `orders.mark_ordered` when it has job lines) | `{orderedDate?, expectedDate?}`; empty order → 400 `"Add at least one line"` |
| `POST /api/paint/orders/:id/undo-ordered` | `stock.order` (+ `orders.mark_ordered` when it has job lines) | ordered → draft |
| `POST /api/paint/orders/:id/received` | `orders.receive` | `{receivedDate?, deliveryNote?}`; `{undo: true}` → ordered |
| `POST /api/paint/orders/:id/cancel` | `stock.order` | draft only |
| `GET /api/paint/settings`, `PUT /api/paint/settings` | `stock.order` | `{litresPerKg}` (a number from 0.1 to 5) |

**A line** is `{paintItemId?, name?, finish?, manufacturer?, unit?, qty, jobId?}`:
- With `paintItemId`, the item's text and unit are copied. Without it, `name` and `unit` are required: a one-off line.
- `qty` is above 0 and at most 9999, in steps of 0.01. `jobId` must be a job that isn't archived.
- `litres = qty × litres_per_kg`, rounded to 0.01, for `kg` lines only. It's worked out when read, not stored.

**Job lines (Decision 6):**
- **On every draft write**, per job in the order's lines, there is exactly one `orders` line on that job, linked in `paint_order_jobs`:
  - `supplier` = the paint order's supplier.
  - `description` = `Paint: 4 kg Example Colour (Matt, Example Maker); 1 × Hardener` (cut to 500).
  - `notes` = `Paint order <id>`.
- **A job no longer in the lines** has its line cancelled (`cancelLine` with `via: "paint"`) and its link row removed. The cancelled order line stays on the job's Orders, as any cancelled line does.
- **Ordered:** each job line goes `to_order → ordered` (`updateLine`, `via: "paint"`, with the order's dates). So the all-ordered rule and the progress invoice run per job.
- **Received:** each job line goes `ordered → received` with the received date, and `received_by` is the receiver. `refreshMaterialsIn` runs per job (materials in, the board's mark, the notice).
- **Undo received** and **undo ordered** reverse these the same way.
- **Cancel** cancels the job lines.

Audit: `paint_order.create`, `.update`, `.status`, `.cancel`, and `paint_item.*`.

## 7. Monthly stock order (`routes/stock.js`, `lib/stock.js`; B)

| Method & path | Access | What |
|---|---|---|
| `GET /api/stock/items` | `["stock.count","stock.order"]` | by `sort`; `?all=1` includes inactive (stock.order) |
| `POST /api/stock/items`, `PATCH /api/stock/items/:id`, `POST /api/stock/items/reorder` | `stock.order` | `{supplier, code, item, link, active}` (supplier and item required, at most 200 each; code at most 100; link http(s) or `''`) |
| `GET /api/stock/orders` | `["stock.count","stock.order"]` | the months that have a record, newest first, with their state |
| `GET /api/stock/orders/:period` | `["stock.count","stock.order"]` | §7.1; no record yet → the month's empty view (nothing written) |
| `PUT /api/stock/orders/:period/have` | `stock.count` | `{lines: [{itemId, have}]}` (`have` a whole number 0–99999 or null); refused once counted (409 `"The count is finished; ask Ordering to reopen it"`) |
| `POST /api/stock/orders/:period/counted` | `stock.count` | finishes the count; notice §7.2 |
| `POST /api/stock/orders/:period/reopen` | `stock.order` | counted → counting; 409 when any group is ordered |
| `PUT /api/stock/orders/:period/order` | `stock.order` | `{lines: [{itemId, order}]}`; a line in a group already ordered can't change (409 `"<supplier> has already been ordered"`) |
| `POST /api/stock/orders/:period/groups` | `stock.order` | `{supplier, orderedDate?, expectedDate?}` marks a group ordered (it needs at least one line with order > 0: 400); `{supplier, undo: true}` before it's received |
| `POST /api/stock/orders/:period/groups/received` | `orders.receive` | `{supplier, receivedDate?, deliveryNote?}`; `{supplier, undo: true}` |

**The period:**
- `:period` is `YYYY-MM` (400 otherwise), and no later than the current month.
- The record is created on the first write.
- Each line copies its item's `supplier`, `code` and `item` when it's first written, so a later list edit doesn't change history.
- Items added to the list later appear in the open month only.

### 7.1 The month view

```js
{ period, state: "counting" | "counted" | "ordering" | "ordered" | "received",
  counted: {at, by: {id, name}}|null,
  groups: [ { supplier, ordered: {date, by}|null, expectedDate, received: {date, by}|null, deliveryNote,
              lines: [ {itemId, code, item, link, have, order} ] } ] }   // groups in list order
```

The state is worked out, in this order:
- `counting` until counted.
- Then `counted` until any group is ordered. A counted month with **no order quantities at all** needs nothing, so it is `ordered` (done) as soon as the count is finished, and the dashboard stops listing it (§15.19).
- `ordering` while some groups with order > 0 aren't ordered (a group with no order quantities needs no order and never holds the month back).
- `ordered` when all are.
- `received` when every ordered group is received.

### 7.2 Notices

- **Counted** → `stock.order` holders, except the actor: kind `stock.counted`, title `Stock counted: <Month yyyy>`, link `/stock.html?period=<p>`.
- **Delivery note** (§15.20) → `orders.mark_ordered` holders, except the actor, each time a group's note changes to a non-empty one (at `groups/received`): kind `stock.delivery_note`, title `Delivery note: Stock order <Month yyyy>`, body `<supplier>: <note, cut to 200>`, link `/stock.html?period=<p>`, entity `stock_order` (the period). Paint orders send `paint.delivery_note` (title `Delivery note: Paint order <id>`, body `<supplier>: <note>`, link `/paint.html?id=<id>`, entity `paint_order`) when marked received with a changed note (§6.3), and a placed drawer order's stock row sends `drawers.delivery_note` (title `Delivery note: Drawer stock (EDGE)`, link `/drawers.html?placed=<id>`, entity `drawer_order`) at `stock-received`.
- **Dates:** `expectedDate` before the ordered date is 400 `"The expected date can't be before it was ordered (<date>)"` on a group's Mark ordered (and on a paint order's and a placed drawer order's).

## 8. Board stocktake and stock value (`routes/boards.js`, `lib/boards.js`; B)

| Method & path | Access | What |
|---|---|---|
| `GET /api/boards` | `["stock.count","stock.order"]` | by `sort`; `priceCents` **only for `stock.order` holders** (the key is absent for others); `?all=1` includes inactive (only for `stock.order` holders, as for stock items) |
| `POST /api/boards`, `PATCH /api/boards/:id`, `POST /api/boards/reorder` | `stock.order` | `{supplier, thickness, name, finish, priceCents, active}` |
| `GET /api/boards/counts` | `["stock.count","stock.order"]` | months with a record, newest first, with status (and value for `stock.order`) |
| `GET /api/boards/counts/:period` | `["stock.count","stock.order"]` | `{period, status, counted, valued, lines: [{boardId, supplier, thickness, name, finish, qty, priceCents?, lineCents?}], subtotalCents?, adjustmentCents?, adjustmentNote?, valueCents?, unpriced: n?}`; the money keys only for `stock.order` |
| `PUT /api/boards/counts/:period/lines` | `stock.count` | `{lines: [{boardId, qty}]}` (`qty` 0–9999 in 0.5 steps, null clears); open only (409 `"The count is finished"`) |
| `POST /api/boards/counts/:period/counted` | `stock.count` | open → counted; notice §8.1 |
| `POST /api/boards/counts/:period/reopen-count` | `stock.order` | counted → open (before it's valued) |
| `PUT /api/boards/counts/:period/adjustment` | `stock.order` | `{adjustmentCents?, adjustmentNote?}` saves the adjustment and its note on a **counted** month as they are typed (added in 4.1, §15.13); **per field**: an absent field keeps the saved value, `null` or `""` clears it (§15.24); same validation as `value` (whole cents within ±$10,000,000, note up to 500 characters), but a nonzero adjustment may have no note while drafting; 409 `"Finish the count first"` when open, `"The value is already confirmed"` when valued; audited `board_count.adjustment`; answers the month as `GET` does |
| `POST /api/boards/counts/:period/value` | `stock.order` | `{adjustmentCents?, adjustmentNote?}` (a note is required when the adjustment isn't 0; **each field overrides the saved one only when it is in the body**, an absent field keeps the saved value, §15.24); refused 409 `"<n> counted board(s) have no price"` while any counted line with qty > 0 is unpriced; freezes each line's `price_cents` and `value_cents = Σ round(qty × price) + adjustment`; counted → valued; notice §8.1 |
| `POST /api/boards/counts/:period/reopen` | `users.admin` | valued → counted (clears the frozen prices and value); audited |
| `GET /api/stockvalue` | `accounts.view` | `{months: [{period, status, valueCents (valued only), counted: {at, by}, valued: {at, by}, adjustmentCents, adjustmentNote}]}`, newest first; the adjustment fields are `null` unless the month is valued (§15.24) |

**Counting and values:**
- The period rules are as §7: a record is created on first write, lines copy the board's text, boards added later appear in the open month only.
- **Before it's valued**, the value a `stock.order` holder sees is worked out live from today's prices. It's marked `provisional: true`, with `unpriced` counted.
- **Accounts sees only valued months' values.** A counted month shows "waiting for the value".

### 8.1 Notices

- **Counted** → `stock.order` holders: kind `boards.counted`, title `Board count done: <Month yyyy>`, body `Confirm the stock value.`, link `/boards.html?period=<p>`.
- **Valued** → `accounts.view` holders: kind `boards.valued`, title `Board stock value: <Month yyyy>`, link `/stockvalue.html`.
- Both skip the actor.

## 9. Stock and paint deliveries (`lib/stockdeliveries.js`; B)

`stockDeliveries(db, today)` returns:

```js
{ items: [ { type: "stock" | "paint" | "drawer_stock", id, label, supplier, orderedDate, expectedDate,
             overdue: bool, deliveryNote, link } ],     // waiting: by expected date (nulls last), then label
  recent: [ { ...same, receivedDate, receivedBy: {id, name} } ],   // received in the last 14 days, newest first
  counts: { today: n, overdue: n } }
```

| `type` | `id` | `label` | `link` |
|---|---|---|---|
| `stock` | `"<period>:<supplier>"` | `Stock order <Month yyyy>` | `/stock.html?period=<p>` |
| `paint` | paint order id | `Paint order <id>` | `/paint.html?id=<id>` |
| `drawer_stock` | drawer order id | `Drawer stock (EDGE)` | `/drawers.html?placed=<id>` |

What appears:
- **`stock`:** each ordered and not yet received group.
- **`paint`:** each `ordered` paint order (the paint order's lines are listed by `GET /api/paint/orders/:id`, which a receiver may also call: its access becomes `["stock.order","orders.receive"]`, and prices aren't involved).
- **`drawer_stock`:** each placed drawer order with a non-empty stock row not yet received.

The receive actions are §6.1 (`stock-received`), §6.3 (`received`) and §7 (`groups/received`), all `orders.receive`. A new non-empty delivery note on any of them tells `orders.mark_ordered` holders, as an order line's does (§7.2, §15.20).

## 10. Pages, menus and access (scaffold)

`lib/pages.js` gains:

```js
"/drawers.html": "stock.order",
"/stock.html": ["stock.count", "stock.order"],
"/boards.html": ["stock.count", "stock.order"],
"/paint.html": ["stock.order", "orders.receive"],
"/stockvalue.html": "accounts.view",
```

`public/shell/shell.js`:

- **Ordering:** Orders, Deliveries, then:
  - **Drawer order** (`/drawers.html`, `stock.order`)
  - **Stock order** (`/stock.html`, `stock.count`)
  - **Paint order** (`/paint.html`, `stock.order`)
  - **Board stocktake** (`/boards.html`, `stock.count`)
  - The comment there is updated.
- **Accounts:** after BAS sales, **Stock value** (`/stockvalue.html`, `accounts.view`).
- **The bar's width doesn't change** (items are inside the dropdowns). The Workshop Manager now sees Ordering with Orders, Deliveries, Stock order and Board stocktake.

## 11. The pages

All pages:
- Pass `node ci/style-check.js` and follow the house style (`tokens.css`, `components.css` `hs-`, the shell's `cc-dialog*`, `shared.js`).
- Put user text in through `textContent`, and hide every control the user can't use (`cc.can()`).
- Have no horizontal page scroll at 375 px (grids and tables scroll inside their own box), and carry `#cc-shell`.
- Print black on white, A4, between the `style-check: print-start` and `print-end` comments, with `document.title` naming the sheet.
- Show a job name as a link to `/job.html?id=…#orders` only with `jobs.view`; otherwise it's plain text.

### 11.1 Job page: the drawer grid (D, `public/job.js` Orders section)

- **In the Orders section**, each drawer line shows its brand, the grid (heights down, lengths across, only the rows and columns in use, with totals), and the checked state ("Checked by <name>, <d Mon>" or **Not checked** in orange).
- **The Joinr box.** With Joinr data (`GET /api/job-records/:id/drawers` → `joinr`), a small box lists the quote's drawer lines with each one's mapping. Unmapped names are in orange ("not on the drawer name list"). It also says "Changed in Joinr since the grid was filled" when that's true.
- **Buttons** (by key):
  - **Add drawers** (`orders.edit`) opens a dialog: brand, then the full grid of number inputs, notes, and **Checked** (shown with `jobs.edit`).
  - **Edit grid** (`orders.edit`, `to_order` only).
  - **Check** and **Uncheck** (`jobs.edit`).
  - **Refill from Joinr** (`orders.edit`, when Joinr data exists for the brand), with a confirm saying the check is cleared.
- **The line's other actions** come through `OrderUI` as now; Mark ordered isn't offered for a drawer line (§11.8).

### 11.2 `/drawers.html` (D, prefix `dw-`)

- **Tabs:** **EDGE**, **DTC**, **Placed**, **Names**, **Settings**. The tab is kept in the hash.
- **A brand tab** shows the grid of §4.3 built from the checked lines:
  - A row per job (the job name, plus the line's notes in small type), the **Stock** row as number inputs (saved on change, `PUT /api/drawers/stock`), the totals and the grand total.
  - Below it, **Waiting for Design/PM check**: those jobs, with their counts, not in the totals.
  - **Print** prints the sheet as §4.3, with the supplier and date.
  - **Mark ordered** (shown with `orders.mark_ordered`) opens a dialog: ordered date (default today), expected date, and the list of jobs it will mark ordered (a progress invoice may fall due). It sends the `orderIds` shown.
- **Placed:** the brand's placed orders (date, supplier, jobs, total, stock received or not). Opening one shows its frozen grid with **Print again**, **Undo** (when allowed), and **Stock received** (with `orders.receive`).
- **Names:**
  - The name list, with add, edit and remove. A brand select, then height and length selects from `Drawers`, or **Ignore** (for runner sets, accessories and other non-drawer lines).
  - Above it, **Names from Joinr not on the list** (`GET /api/drawers/unmapped`), each with **Add** prefilled.
- **Settings:** the two supplier names.

### 11.3 `/stock.html` (E, prefix `st-`)

- **A month picker** (default the current month; `?period=`), and the state in words.
- **Count view** (everyone with `stock.count`):
  - Supplier groups in list order, each item's code, item, link ("Open" in a new tab) and a **Have** number input (saved on change).
  - **Finish count**, and **Print blank count sheet** (every active item, empty Have boxes, a "Counted by" line).
- **Order view** (with `stock.order`):
  - The same with an **Order** input per item, Have shown read-only.
  - Per group: **Mark ordered** (date, expected), **Undo**, the dates, **Print order** (that group's items with order > 0: code, item, quantity), and **Print all orders** (one page per group).
  - **Reopen count.**
- **Received** isn't on this page. It's on Deliveries; the dates show here read-only.
- **A List tab** (`stock.order`): add, edit, deactivate and reorder items (move up or down within a group; a group sorts by its first item).

### 11.4 `/boards.html` (E, prefix `bd-`)

- **A month picker** and the state.
- **Count** (`stock.count`):
  - The board list in order: supplier, thickness, board, finish, and a **Qty** input (step 0.5, saved on change). Rows that are active and have a count sit together; no prices are shown.
  - **Finish count**, and **Print blank count sheet** (two columns per A4 page, as the workbook).
- **Value** (`stock.order`, once counted):
  - Each line's price and amount, the subtotal, an **Adjustment** with its note, and the value.
  - The unpriced lines flagged in orange, with **Set price** inline.
  - **Confirm value**, and **Reopen count**.
  - Once valued: the frozen figures, and **Reopen** for `users.admin`.
- **A List tab** (`stock.order`): add, edit, deactivate and reorder boards, with the **price per sheet (ex GST)**.

### 11.5 `/stockvalue.html` (E, prefix `sv-`)

- A table, newest month first: Month, Board stock value (ex GST), Counted (by, date), Confirmed (by, date), Adjustment (with its note as a tooltip and in print).
- A counted month that isn't valued shows "Waiting for the value".
- **Print.** No editing.

### 11.6 `/paint.html` (F, prefix `pt-`)

- **The list of orders:** open first; status, supplier, date, jobs, line count.
- **An order:**
  - Supplier (with a datalist of past paint suppliers), expected date, notes.
  - The lines: item (a select of the paint list, grouped by kind, or **Other…** for a typed line), qty with its unit, litres shown for kg lines, job (a search of live jobs, optional).
  - **Save**, **Mark ordered** (a dialog listing the jobs whose order lines will be marked ordered), **Undo**, **Cancel**, **Print**.
  - Print is the company letterhead (`settings` business details), "Paint order <id>", the date, supplier, a table of Kg, Litres, Name, Finish, Manufacturer, and Job (the job name). It has no edge key.
- **A receiver without `stock.order`** opening `?id=` sees the order read-only, with **Received**.
- **List and Settings tabs** (`stock.order`): the paint list, and the litres factor.

### 11.7 Deliveries (F, `public/deliveries.js`)

- **A "Stock and paint" section** after the five groups: `stock.items` with label, supplier, ordered and expected dates (overdue in orange), the delivery note, and **Received** (date and delivery note dialog, built like `OrderUI.receive` but posting to the item's own route) and **Open**.
- **Received recently** gains the `stock.recent` entries, with **Undo**.
- **The print checklist** includes the stock and paint items due by the end of next week.
- **Drawer lines** stay in the job groups, labelled with their description (already "Drawers (EDGE): …").

### 11.8 `OrderUI` and the dashboard (F)

- **`OrderUI.actions(line)`:**
  - For `kind: "paint"` it returns no actions except a link "Open paint order <id>".
  - For `kind: "drawers"` it omits `markOrdered`. **`edit` offers notes, expected date and the ordered and received dates to the same people as any other line, but not the supplier or description (§15.14, Todd 2026-10-14; replaces "notes and expected date only").** `lib/orders.js` already allows those date edits on a drawer line in a plain call.
- **`OrderUI.noteBlock` is unchanged.** The Orders page and job page show a small "PAINT ORDER <id>" or "DRAWERS" label (uppercase, letterspaced, grey) under the description.
- **Dashboard (`public/index.js`)** gets lines like the Deliveries line, each hidden when there's nothing to say:
  - **`stock.count`:**
    - "Stock count: <Month> not done" from the 25th of a month to the 7th of the next, for the month being counted (the previous month during days 1–7 when it isn't counted).
    - "Board count: <Month> not done", with the same rule.
  - **`stock.order`:**
    - "Drawers: N to order · N waiting for check" (both brands).
    - "Stock order <Month>: counted, to order" when the state is `counted` or `ordering`.
    - "Board count <Month>: value to confirm" when counted.
  - **One request:** `GET /api/stock/summary` (`["stock.count","stock.order"]`, B, in `routes/stock.js`), which returns only the parts the user's keys allow. The drawer counts come from `lib/drawers.js` `summary(db)` (A exports it; B calls it).

## 12. Tests and checks

### 12.1 `ci/smoke.sh` (scaffold)

- The two "25 keys" lines become **27**.
- `.presets.ordering` and `.presets.workshop_manager` equal §3.1 exactly.
- After the M10 loop and before the Backup suite: `for f in "$(dirname "$0")"/smoke-m11-*.sh; do [ -f "$f" ] && source "$f"; done`.
- Step k must still pass (the old app's database migrated through 023).

### 12.2 The M11 smoke files

M-suite rules apply: sourced, no shebang, no `set`, the shared helpers and jars (`$ADMIN`, `$ORDR`, `$WSMGR`, `$DPM`, `$ACCT`, `$SCHED`), prefix `M11_`, no pristine-DB assumption, made-up names, today from the server.

**`smoke-m11-drawers.sh` (A):**
- **Access:**
  - `/drawers.html`: ordr 200, wsmgr 403, dpm 403.
  - `GET /api/drawers?brand=edge`: ordr 200, wsmgr 403.
  - `POST /api/drawers/names`: ordr 201, dpm 403.
- **Manual grid:**
  - dpm adds an EDGE grid (201, `kind: "drawers"`, description from `describe`, unchecked).
  - A second EDGE line → 409.
  - ordr edits counts → 200, and the line stays unchecked.
  - ordr `checked: true` → 403; dpm checks → 200.
  - A bad height → 400; a duplicate cell → 400.
  - A plain `PATCH {status: "ordered"}` → 409 with the sentence; `PATCH {supplier}` → 409.
- **Drawer order:**
  - `GET` shows the checked line in `rows`, an unchecked one in `waiting`; the stock draft saves.
  - place with a stale `orderIds` → 409; wsmgr place → 403.
  - place → 201: the lines are `ordered` with the expected date, the job's progress invoice is due when it was the job's last line (as `smoke-m10-orders.sh` checks), and the stock draft is empty.
  - The lines appear in `GET /api/orders/deliveries`; wsmgr receives one (200).
  - Undo → 409 (one received). Undo receiving, then undo the order → 200, the lines are back to `to_order`, and the stock draft is restored.
  - stock-received by wsmgr → 200, and it appears in `stock.recent`.
- **Joinr:**
  - The fake Joinr serves an item with `drawers: [{section: "drawers", name: "M11 Drawer Mid 500", qty: 6}, {section: "innerDrawers", name: "M11 Unknown", qty: 2}]`.
  - With a name mapping for the first, accept creates one EDGE line with 6 × Mid 126/500, `source: "joinr"`, `joinrLines` holding both. A `drawers.unmapped` notice reaches ordr, and a `drawers.check` notice reaches dpm.
  - An item with `drawers` absent → no line.
  - Re-serving an accepted item that gains `drawers` where its stored payload had none → **not** marked changed. Changing the quantity after that → changed, with "drawers" among the fields.
  - Refill after adding the second name's mapping → the counts change and the line is unchecked.
  - A malformed `drawers` (qty -1, a 201-character name, section "doors") → the item is refused with the field named.

**`smoke-m11-stock.sh` (B):**
- **Stock order:**
  - ordr adds two items in two groups.
  - wsmgr types Have → 200 and finishes the count; ordr gets `stock.counted`.
  - wsmgr Have after counting → 409; ordr reopens → 200, then wsmgr finishes again.
  - ordr types Order; wsmgr Order → 403.
  - Marking a group with nothing ordered → 400. Marking a group ordered → it appears in `GET /api/orders/deliveries` `.stock.items`, and `counts.today` includes it when expected today.
  - Changing a line in an ordered group → 409.
  - wsmgr receives the group → `recent`, and the state is `received` when it's the only group.
  - A future period → 400.
- **Boards:**
  - ordr adds three boards, prices two.
  - wsmgr `GET /api/boards` has no `priceCents` key; wsmgr sets qty 2.5 → 200; qty 0.3 → 400.
  - wsmgr finishes the count; ordr gets `boards.counted`.
  - value → 409 (one counted board unpriced). Price it, then value with an adjustment and no note → 400, then with a note → 200. `value_cents` = the exact sum; acct gets `boards.valued`.
  - `GET /api/stockvalue`: acct 200 with the value, ordr 403, wsmgr 403.
  - Reopen by ordr → 403; by admin → 200, and the month is counted again with no value.
- **Summary:** `GET /api/stock/summary` as wsmgr has no drawer or value parts.

**`smoke-m11-paint.sh` (C):**
- ordr adds paint items (a kg colour, an each abrasive).
- A draft with three lines (job A colour 4 kg, job A hardener 1, no-job abrasive 2) → 201. Job A has one order line `kind: "paint"` with the description, and litres = 3.4 for 4 kg.
- A plain `PATCH` or cancel of that order line → 409 with the sentence.
- Moving the colour line to job B → job A's line is cancelled, and job B has one.
- Mark ordered by a user without `orders.mark_ordered` → 403 (use a grant/revoke override on a test user). By ordr → job B's line is `ordered`, and job B's progress invoice is due when it was B's only line.
- The paint order appears in deliveries `stock.items`; job B's paint line is **not** in the five groups.
- wsmgr `GET /api/paint/orders/:id` → 200; wsmgr receives → job B's line is `received` and its `materialsInDate` is set.
- Undo received, then undo ordered → back to `to_order`.
- A draft PUT after ordering → 409. Cancel a draft → its job lines are cancelled.
- A bad litres factor → 400.

### 12.3 Pages (D, E, F): local checks

As M10 §10.3:
- `node --check`, the style check, a shim boot.
- Headless-Edge screenshots at 1440, 1100 and 375:
  - **D:** a busy EDGE tab, Waiting, Names with unmapped names, a placed order, print to PDF, and the job grid dialog.
  - **E:** stock count and order views, the blank count sheet and order print, boards count and value, stock value.
  - **F:** a paint order and its print, Deliveries with the Stock and paint section, the dashboard lines.
- As each relevant role: admin, ordering, workshop manager, design_pm, accounts.
- Keyboard reach of every control, no console errors.
- Wave 2 runs against the merged Wave 1.

### 12.4 Local checks (every task)

As M10 §10.5:
- `bash -n` and the smoke harness on each smoke file (fresh, then again on the same DB).
- `node --check`, `node ci/style-check.js`, a shim boot on a fresh `.dev/<task>/` with the four `*_DISABLED=1` flags.
- **Scaffold:** 023 on a fresh DB and on a copy (backup written, `foreign_key_check` clean, the route matrix with every access value and 501s, `smoke.sh`'s changed lines).
- **A:** also `smoke-m6-intake.sh` and `smoke-m6-inbox.sh` still pass (the payload with and without `drawers`).
- **A and C:** `smoke-m3-orders.sh` and `smoke-m10-orders.sh` still pass.

## 13. The Joinr side (task J2, tenon-quotr, separate from the waves)

**CLAUDE.md rule 12: tenon-quotr may be read, but no change in it (code, docs, branch, commit, push, merge, deploy) starts until Todd has been warned "THIS WILL TOUCH JOINR" and has said yes twice.** This section is the agreed design only.

From the survey on 2026-10-13: the SQL read already returns each room's whole `qty` map and the pruned card (section ids and the names in use), so this needs **no migration** in Joinr.

- **Code:**
  - In `apps/portal/src/lib/crosscuts-intake.ts`, a `drawerLines(doc)` beside `boardLines`. It walks the card's sections with id `drawers` and `innerDrawers`, reads each room's list-shaped qty (`[{id, name, qty}]`, `Number()`-coerced), sums by name per section across rooms, skips names not in `section.items`, non-positive and non-finite quantities, and sorts as §4.4.
  - `buildItem` adds `drawers`, and the `IntakeItem` type gains it. `CONTRACT_VERSION` stays 1.
- **Tests:** `crosscuts-intake.test.ts`'s exact-shape tests gain `drawers`, plus cases for duplicate rows, two rooms, a stale name, a string qty, a deleted section, and no lines (`[]`). Optionally the RLS fixture gains drawer lines.
- **The contract doc:** `docs/integrations/joinr-crosscuts-intake.md` goes to **version 2**, identical in both repos. The item table gains the `drawers` row of §4.4, the Normalisation section its rules, and a note that `contract` stays 1 and the field is optional. tenon-quotr's `CLAUDE.md` notes the change.
- **Order:**
  1. Crosscuts 0.1.15 can ship first, because it treats an absent field as "no drawer data".
  2. J2 can ship before or after. An older Crosscuts drops the field harmlessly.
  3. Each step in tenon-quotr (the branch push for CI, the merge to `master`, which deploys to production) needs **Todd's go**.
- **Checks after deploy:** the endpoint still answers 401 without a key; a Crosscuts sync shows a won quote's drawer lines in the intake record; the first sync marks no accepted record "changed".

## 14. Waves and file ownership

| Step | Who | Owns (only these files) | Starts after |
|---|---|---|---|
| **M11 · 2.2 Scaffold** | integrator | §1's scaffold rows | — |
| **3.1 Wave 1, A: drawers backend and Joinr field** | worktree | `lib/drawers.js`, `routes/drawers.js`, `lib/joinr-sync.js` (the §4.4 parts), `lib/intake.js` (the two hooks), `ci/fake-joinr.js`, `ci/smoke-m11-drawers.sh` | scaffold |
| **3.1 Wave 1, B: stock, boards, stock deliveries** | worktree | `lib/stock.js`, `lib/boards.js`, `lib/stockdeliveries.js`, `routes/stock.js`, `routes/boards.js`, `ci/smoke-m11-stock.sh` | scaffold |
| **3.1 Wave 1, C: paint backend** | worktree | `lib/paint.js`, `routes/paint.js`, `ci/smoke-m11-paint.sh` | scaffold |
| **3.2 Wave 2, D: drawer pages** | worktree | `public/drawers.html`, `drawerspage.{css,js}`, `public/job.js` (Orders section), `public/job.html` (if needed) | Wave 1 merged |
| **3.2 Wave 2, E: stock, boards, stock value pages** | worktree | `public/stock.*`, `public/boards.*`, `public/stockvalue.*` | Wave 1 merged |
| **3.2 Wave 2, F: paint page, deliveries, dashboard, OrderUI** | worktree | `public/paint.*`, `public/deliveries.{js,css}`, `public/index.{js,html}`, `public/orderui.js` | Wave 1 merged |
| **4.1 Integrate** | integrator | merges; §1's 4.1 docs; STATUS; real-data checks of D, E, F | all |
| **J2 Joinr side** | worktree in tenon-quotr | §13 | contracts; independent of the waves |

- **Worktree base:** each agent resets to the commit the integrator names, and junctions `crosscuts/app/node_modules` from the main checkout (PowerShell `New-Item -ItemType Junction` if `cmd //c mklink` is refused).
- **Wave-specific rules:**
  - B calls `drawers.summary(db)`, so the scaffold's stub returns `{toOrder: 0, waiting: 0}` until A lands.
  - C relies on the scaffold's `orders.js` hooks, not on A.
  - `public/drawers.js` (the sizes) is the scaffold's. The page script is `drawerspage.js` so the two never clash.

## 15. Points the integrator decided (Todd can change any)

1. **Checking a drawer grid uses `jobs.edit`** (Design/PM and admin), so Ordering can edit counts but not mark them checked; editing clears the check.
2. **Joinr's drawer lines are mapped by name, through a list Ordering keeps** (`drawer_names`), with an **Ignore** choice for runner sets and other non-drawer items. A name maps to one brand, height and length.
3. **Drawer lines are created when a quote is accepted or linked**, one per brand with mapped counts, unchecked. A later change in Joinr never rewrites a grid by itself; the job page says it changed and offers **Refill**.
4. **Drawer lines are ordered only from the Drawer order page** (a plain Mark ordered is refused), and placing needs both `stock.order` and `orders.mark_ordered`, because it can make progress invoices due.
5. **One paint order makes one order line per job**, managed entirely by the paint order (it can't be edited or received from the Orders page). A received paint order receives its job lines, so "materials in" and the board's mark follow.
6. **Board prices are per sheet, ex GST;** the value is ex GST.
7. **The board value has three states:** the Workshop Manager finishes the count (`counted`), and Ordering confirms the value once every counted board has a price (`valued`). Only valued months reach Accounts. Reopening a valued month needs `users.admin`, as BAS.
8. **Stock "have" and "order" are whole numbers;** board quantities take half sheets.
9. **The drawer supplier names are two settings** (defaulting to the product names already in `jobs-master-tabs.md`), used as each drawer line's supplier.
10. **Paint quantities are kg or each;** litres show for kg lines only (factor 0.85, a setting).
11. **The dashboard reminds counters** from the 25th to the 7th of the next month.
12. **The Joinr wire `contract` stays 1** (an optional added field); only the document's version goes to 2.
13. **The board adjustment and its note save as they're typed** (Todd, 2026-10-14), before Confirm value, so a reload keeps them. Built in 4.1: a save route under `stock.order` for a counted month, and the Value tab saves on change.
14. **A drawer line's Edit offers the ordered and received dates** (Todd, 2026-10-14) to the same people as any other line (`orders.mark_ordered` placed, `orders.receive` received), besides notes and expected date. Supplier and description stay refused. Replaces §11.8's "limits edit to notes and expected date".
15. **A placed drawer order keeps each job's note** (Todd, 2026-10-14) in `grid_json` (an optional `notes` per row, §4.3), so a reprint matches what was sent. No migration.
16. **The Deliveries print uses one 7-day window** (Todd, 2026-10-14) for job, stock and paint deliveries (overdue included), not "end of next week" (§11.7).
17. **A drawer line on a placed drawer order can't be taken back to To order from the Orders or job page** (Todd, 2026-10-14, review A-M1). `PATCH /api/orders/:id {status:"to_order"}` on such a line is 409 "These drawers are on a placed drawer order. Use Undo order on the Drawer order page."; OrderUI doesn't offer Undo ordered on it. Undo order on the Drawer order page stays the only way back. Replaces §5.2's "by any path" for the ordered → to_order move.
18. **Fill from Joinr** (Todd, 2026-10-14, review C): `POST /api/job-records/:id/drawers/fill` (`orders.edit`) creates, unchecked, a drawer line for each brand that has mapped counts in the job's Joinr drawer lines and **no live (not cancelled) drawer line of that brand**; 409 "Nothing to fill from Joinr" when it would create none. `GET /api/job-records/:id/drawers` adds `canFill` (boolean). The job page shows **Fill from Joinr** when `canFill`. §4.5 step 3's skip on accept and link is likewise "any live drawer line of that brand", not only `to_order` (review A-m4).
19. **A stock supplier group with no order quantities counts as done** (Todd, 2026-10-14, review C): a counted month is finished (`ordered`/done state, off the dashboard) once every group that has something to order is marked ordered; a month needing nothing is done as soon as the count is finished.
20. **Delivery notes on stock groups, paint orders and drawer stock rows tell Ordering** (Todd, 2026-10-14), as M10's order-line notes do: a notice to `orders.mark_ordered` holders each time the note changes (same wording style as M10's).
21. **The board count keeps the board list's fixed order** (Todd, 2026-10-14), matching the printed sheet; §11.4's "counted rows sit together" is dropped.
22. **A malformed `drawers` field doesn't refuse the quote** (Todd, 2026-10-14): the item is imported with `drawers` treated as absent (null), the problem is logged and admin (`users.admin`) gets a notice naming the quote. §4.4 changes accordingly; the wire `contract` stays 1.
23. **Placing checks the whole sheet, not only the line ids** (integrator, review A-m1): `GET /api/drawers?brand=` adds `sheetKey`, a hash of what's shown (line ids, counts, notes, check state and the stock row); `POST /api/drawers/place` requires it and answers 409 "The drawer order changed while you were looking; reload it" when it differs.
24. **`/api/stockvalue` gives the adjustment only for valued months** (integrator, review A-m2); **adjustment fields override per field** on `PUT …/adjustment` and `POST …/value` (review A-m3).
