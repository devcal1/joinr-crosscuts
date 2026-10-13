# M11 Ordering pages: plan

Status: **M11 · 1.2: plan written, questions put to Todd (2026-10-13).** Not approved yet.

Scope (Todd, 2026-10-12, `jobs-master-tabs.md`): one **drawer order** merged from the two drawer tabs (EDGE and DTC), filled in from Orders, overseen by Ordering and handed to the Workshop Manager for delivery; the **monthly stock order** (the Workshop Manager fills in "have", Ordering places the order; the invoice check on the side of the sheet is dropped); the **paint order**; the **board stocktake**, with the monthly value shown to Accounts.

This repo is public: no supplier, client or product-range details from the workbook, no prices, no stock values.

## 1. Audit (M11 · 1.1, 2026-10-13)

### 1.1 The workbook tabs

**Drawers-EDGE and Drawers-DTC** (one tab per drawer brand, the same layout):

- One block per **drawer height**: four each. EDGE has Low 93, Mid 126, High 174 and Super High 238 mm. DTC has 95, 127, 178 and 209 mm.
- Each block has seven **runner lengths** across, 300 to 600 mm in 50 mm steps.
- Each block has one row per **job** (the job's name typed in), then a **Stock** row for extra drawers ordered to keep on the shelf.
- Each cell holds a count. Each block has a total row, and the sheet has a grand total and the date (`NOW()`).
- One cell holds text instead of a number (a note like "3 fronts"), so a line needs room for a note.
- Most counts sit in the 500 mm column. Several jobs appear in more than one height.

**Stock** (the monthly hardware order):

- About 60 items in seven **supplier groups**, each headed "Monthly Stock Order" and the supplier's name.
- Columns: **Link** (the supplier's product page, on a few rows), **Code** (the supplier's code; some items have none), **Item**, **Have**, **Order**.
- Have and Order are empty on the saved sheet: it's filled in on paper each month.
- The side columns are the invoice check, which is dropped (Todd).

**Paint Order:**

- A printed form with the company's web address and street address.
- Lines: **Kgs**, **Litres** (worked out as kg × 0.85), **Name** (chosen from a list), **Finish** and **Manufacturer** (looked up from the list).
- The list beside it has about 24 entries: colours (name, finish, manufacturer), plus hardener, thinners, primers and sanding discs.
- The list has a price column, but it's empty.
- The form has no job, date or supplier field.
- An edge key (square, rolled, raw) at the foot is left over from another form.

**Board Stocktake:**

- About 100 board rows: **Qty**, **Supplier** (one letter), **Thickness**, **Board** (the colour name) and **Finish**. It's laid out over two printed pages (the header repeats).
- **Qty is empty on every row.** The count is done on paper.
- Some rows are listed twice (a block near the end repeats an earlier block).
- **The monthly stock value is typed in by hand**, one figure a month beside the list. It isn't worked out from the counts. There are no board prices anywhere in the tab.
- The other side columns are unrelated calculations.

**A separate workbook** on the desktop (`Joinr_paintOrder - Copy.xlsx`) is a different thing: an order form for painted doors and panels priced per square metre, from another business. It isn't one of the 30 tabs, and M11 leaves it out (lead's default 8).

### 1.2 Orders today (after M10)

- **Order lines are free text** (`010_design_pm.sql`, plus M10's `022`): job (required), supplier, description, status (to order, ordered, received or cancelled), the three dates, notes, and the delivery note. Lines have no quantity, code, unit, price or item. Suppliers are free text; the name list just collects past names.
- **Every line belongs to a job** (`job_id NOT NULL`). So stock and paint bought for the workshop can't go on Orders without a job.
- **Marking a job's last line ordered sets the job's 50% progress invoice due.** When every line is received, the job's materials date is set, the board's materials mark turns teal, the Planner shows "Materials in", and Scheduling and Ordering are told. The Deliveries page lists ordered lines by expected date for the Workshop Manager.
- **M9's supplier list** (`suppliers`) belongs to Accounts' statements (`accounts.view`). It's deliberately separate from the supplier names on Orders.
- **Joinr sends no line items:** only a sheet count, two-pac, the benchtop and the job type, plus the raw doors and panels text. Drawer counts can't come from Joinr unless its contract adds them, which would be a change in the other repo.
- **Jobs have no drawer, hardware, board colour or paint fields.** Two-pac only decides whether the job has the paint production stage.
- **No code mentions stock, stocktake, inventory or drawers.** The brief (§3, Orders) covers per-job order lines only.

### 1.3 Roles, keys and pages to build on

- **Ordering** has board.view, jobs.view, design.view, photos.search, orders.view, orders.edit, orders.mark_ordered, orders.receive, tasks, messages and the Planner.
- **Workshop Manager** has board.view, orders.view, orders.receive, tasks, messages and the Planner. It has no jobs.view (no client details).
- **Accounts** has accounts.view, among others.
- **A new key needs no migration** (`permission_overrides.feature_key` has no CHECK). Its touch points are listed in M10's plan §1.1, including the smoke "25 keys" counts.
- **The Ordering menu** holds Orders and Deliveries (its comment says the drawer, stock and paint orders "join later"). **The Accounts menu** holds Accounts, Pay runs, BAS sales, Supplier accounts and Reports.
- **Patterns to reuse:**
  - **Month records:** `bas_months`, `supplier_statements`, and the pay runs (a row only once something is entered; finalise freezes a JSON snapshot; reopening needs `users.admin`).
  - **Shared maths:** `public/periods.js` and `public/paymaths.js`, shared by the server and the pages.
  - **Paper forms:** `payprint` (A4, set by the query string), the blank sheet at `suppliers.html?print=blank`, and the Deliveries print sheet.
  - **Plumbing:** `defineRoutes` with access values, and `audit.log` inside the transaction.

## 2. Proposed shape

### 2.1 Drawer order (the key question: question 1)

The drawer tabs list counts **per job**, and Todd wants them "filled in automatically from Orders". The free-text lines can't be added up, so the counts need a structured home. Recommended:

- **A drawer line on the job's Orders.** On the job page's Orders section, **Add drawers** opens a grid for one brand: the four heights down the side, the seven lengths across, a count in each cell, and a note. It saves as an ordinary order line ("Drawers (EDGE)", status to order), with its counts in a new table, `order_drawer_counts` (order line, height, length, count). The line's description is written from the counts, e.g. "6 × Mid 126 / 500", so the Orders and Deliveries pages read as now.
- **The Drawer order page** (Ordering menu) has one tab per brand. It adds up every drawer line still **to order** into the same grid as the workbook: a row per job, then a **Stock** row that Ordering types in, then the totals. **Print** gives the sheet to send to the supplier.
- **Mark ordered** on the page places that brand's order: it marks each job's drawer line ordered (with the date). So the 50% invoice rule, Deliveries and "materials in" all work as they do today. Each placed order is kept (date, who placed it, the grid as sent, the stock row) and can be printed again.
- **Receiving:** each job's drawer line appears on Deliveries like any other line, and the Workshop Manager marks it received. The stock row has its own Received on the placed order.
- **Sizes:** the two brands' heights and the seven lengths live in one shared module (`public/drawers.js`), used by the job grid, the page and the server. Changing them takes a release (lead's default 2).

### 2.2 Monthly stock order

- **The stock list** (Ordering edits it): supplier group, code, item, an optional link, and an active flag, kept in the workbook's order.
- **One stock order per month:**
  - The Workshop Manager types **Have** for each item, on the page or from a printed blank count sheet.
  - Ordering then types **Order** and prints the order sheet, one page per supplier group, with only the items being ordered.
  - Each supplier group gets **Ordered** and **Received** dates.
- **Not on Orders:** these aren't for one job, and they don't affect any invoice.
- **States:** open, then counted (the Workshop Manager finishes counting), then ordered. "Counted" tells Ordering.

### 2.3 Paint order

- **The paint list** (Ordering edits it): name, finish, manufacturer, a kind (colour, hardener, thinners, primer, abrasive or other), and an active flag.
- **A paint order** has a date, a supplier (free text), and lines: kg, item, and an optional job. Litres are worked out (kg × 0.85, the factor kept as a setting, `paint.litres_per_kg`). It prints on the company letterhead, without the stray edge key.
- **States:** draft, ordered (date) and received (date).
- **Not on Orders** (question 4 asks Todd about paint for a particular job).

### 2.4 Board stocktake and the value for Accounts

- **The board list** (Ordering edits it): supplier, thickness, board, finish, an active flag, and (if question 2 says so) a price per sheet. Duplicates are merged once when the list is entered.
- **One count per month:**
  - The Workshop Manager types the quantity per board, on the page or from a printed blank count sheet in the workbook's order.
  - **Finish count** freezes the month (reopening needs `users.admin`, as with BAS).
- **The month's value:**
  - **Recommended:** counts × price per sheet, worked out, with an optional adjustment and a note.
  - **The alternative** is a typed value, as today (question 2).
- **Accounts** gets a **Stock value** item in the Accounts menu (`accounts.view`): one row per month (value, counted by, finished date), read-only, printable.

### 2.5 Keys, menus, dashboard

- **Two new keys** (25 → 27; no migration):
  - **`stock.count`** lets you type Have on the stock order and do the board count. Presets: workshop_manager, ordering (and admin automatically).
  - **`stock.order`** lets you edit the stock, paint and board lists, prices, orders and the drawer order page. Presets: ordering (and admin).
  - Adding drawer counts on a job's Orders uses `orders.edit`, like any order line (Design/PM and Ordering today).
- **Ordering menu:** Orders, Deliveries, **Drawer order** (`stock.order`), **Stock order** (`stock.count`), **Paint order** (`stock.order`), **Board stocktake** (`stock.count`).
- **Accounts menu:** **Stock value** (`accounts.view`).
- **Dashboard:**
  - For `stock.count`: "Stock count due" and "Board count due" in the last three days of a month and the first seven of the next, until done.
  - For `stock.order`: "Stock counted, order to place" and "N drawer lines to order".
- **Notifications:**
  - "Stock counted" and "Board count finished" go to `stock.order` holders.
  - A board count finished also goes to `accounts.view` holders ("stock value for <month> is ready").

### 2.6 Building it

- **Migration `023_ordering_pages.sql`, additive only (new tables):**
  - **Drawers:** `order_drawer_counts`, plus `drawer_orders` and its lines (placed orders).
  - **Stock:** `stock_items`, `stock_orders`, `stock_order_lines` and `stock_order_groups` (the per-supplier dates).
  - **Paint:** `paint_items`, `paint_orders` and `paint_order_lines`.
  - **Boards:** `boards`, `board_counts` (a month) and `board_count_lines`.
  - Nothing on `orders` changes.
- **Server:** `lib/drawers.js`, `lib/stock.js`, `lib/paint.js`, `lib/boards.js`, and routes for each.
- **Pages:** `drawers`, `stock`, `paint` and `boards`, each with its print view, plus `stockvalue`. The job page gets the drawer grid.
- **Elsewhere:** the menus, the dashboard, notifications, `public/users.js`, and smoke (`smoke-m11-*.sh`, the key counts).
- **Docs:** `how-to-order-drawers.md`, `how-to-do-the-stocktake.md`, `auth.md`, and the brief's §3 (Orders, and the new pages).
- **Version 0.1.15.** Probably two build waves: A is the lists, stock order and board count; B is the drawer order and the paint order. The detail comes in 2.1 contracts.

## 3. Lead's defaults (not asked; Todd can change any)

1. **New keys** `stock.count` and `stock.order`, as in section 2.5.
2. **Drawer sizes are fixed in code** (two brands, four heights each, seven lengths). A new brand or size takes a release.
3. **Stock and paint orders aren't Orders lines** (no job, no invoice effect). Drawers are, through each job's drawer line.
4. **No minimum stock levels:** Ordering decides each quantity from "have", as on paper today.
5. **Supplier names stay free text** on the lists, as on Orders; they don't link to Accounts' supplier list.
6. **Board counts take whole and half sheets** (0.5 steps).
7. **The stray side calculations** on the Stock and Board Stocktake tabs aren't carried over.
8. **The separate painted-door order form** (`Joinr_paintOrder - Copy.xlsx`) isn't part of M11.

## 4. Questions for Todd

1. **How do drawer counts get in?** Recommended: on each job's Orders, an **Add drawers** line with a size grid (heights × lengths, counts, a note), entered by whoever adds that job's orders. The Drawer order page adds up all drawer lines still to order, by brand, plus a stock row. Mark ordered marks each job's drawer line ordered, so the 50% invoice works as now. Alternatives:
   - (b) Ordering types the grid straight onto the Drawer order page, as in the workbook, with no link to the jobs' Orders.
   - (c) Joinr sends drawer counts from the quote. That's a change in the Joinr app, and only works if the quote knows the heights and lengths.

   And who usually fills in a job's drawers: Design/PM when the design is signed off, or Ordering?
2. **Board stock value:** worked out from the counts × a price per sheet (Ordering keeps the prices; the value updates when the count is finished), or typed in once a month as now? Recommended: worked out, with an adjustment line. If worked out: who keeps the prices, Ordering or Accounts?
3. **Receiving stock and paint:** should the monthly stock order (per supplier) and paint orders also show on the Deliveries page for the Workshop Manager to mark received? Recommended: yes, in their own "Stock and paint" group, so all deliveries are in one place.
4. **Paint for a job:** is paint ordered for the workshop in general, or for particular two-pac jobs? Recommended: general, with an optional job on a line for reference that doesn't touch the job's Orders or invoice. The alternative is that paint for a job becomes an order line on that job, counting toward its "all ordered".
5. **Lists and history:** start fresh for orders and counts, and enter the three lists (stock items, paints, boards) once on the pages. To save typing, each list page gets a **Paste from spreadsheet** box: you copy the rows from the workbook and they're added. Nothing from the workbook goes into this repo. Recommended: yes. Should the past monthly stock values be typed in too (one figure a month, marked "imported", as BAS did), and from which month?
