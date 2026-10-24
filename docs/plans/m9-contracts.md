# M9 interface contracts: BAS sales and supplier accounts (binding for all M9 subagents)

Read `docs/plans/m9-plan.md` first. Its **Decisions** (section 5, 1–7) and **Lead's defaults** (section 3) are binding and win over its section 2. This file is the *what*. Everything in `m1-contracts.md` … `m8-contracts.md` and `backup-contracts.md` still holds (UTC ISO timestamps with milliseconds, Sydney `YYYY-MM-DD` business dates, `defineRoutes`, audit, `lib/httperror.js`, errors `{error}`). If a contract looks wrong, report it instead of working around it. Points the integrator decided while writing this file are listed in §11; Todd can change any of them.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3` (the `node:sqlite` shim locally), Node 24, no build step, no framework.

**This repo is public.** No figures, client or supplier names, account numbers or amounts from the workbook or from real accounts go into code, tests, docs or screenshots. Smoke and screenshot data use made-up names (`M9 Test Supplier`, etc.) and made-up amounts.

**Version.** 0.1.10 is on the device; 0.1.11 (M8) is committed and unpushed. M9 ships as **0.1.12**: the scaffold bumps `crosscuts/app/package.json` and the root version in `crosscuts/app/package-lock.json`. No further bump during the build.

**Keys:** none new (23 stays). `accounts.view` sees everything in this file; `invoices.edit` writes; `users.admin` alone reopens a lodged month.

**Not touched in M9:** the board files (`schedule.*`, `workers.html`, `exportJpg()`, `alignPanels()`), `public/shared.js`, `lib/payroll.js`, `public/paymaths.js`, and every write path of `lib/invoices.js` except `markPaid` (§3). BAS only **reads** `invoices` and `jobs`, with its own queries.

## 1. Files and owners

| File | What it is | Owner |
|---|---|---|
| `db/migrations/020_bas_suppliers.sql` | three tables and one index (§2), complete | scaffold |
| `public/periods.js` | month and financial-year helpers shared by server and pages (§4), complete | scaffold |
| `lib/invoices.js` | `markPaid` refuses a date before issue or in the future (§3) | scaffold |
| `public/accounts.js` | the Paid on date input gets `min` (issue date) and `max` (today) (§3) | scaffold |
| `ci/smoke-m2-invoices.sh` | the paid-date step follows §3 | scaffold |
| `lib/pages.js` | two page entries (§8) | scaffold |
| `lib/bas.js` | everything BAS with the database (§5) | stub in scaffold (binding signatures, throws 501), then A |
| `routes/bas.js` | `defineRoutes('/api/bas')`: every route of §6 declared with its access; handlers 501 in the scaffold | scaffold, then A |
| `lib/suppliers.js` | everything supplier with the database (§7.1) | stub in scaffold, then B |
| `routes/suppliers.js` | `defineRoutes('/api/suppliers')`: every route of §7.2 declared; handlers 501 in the scaffold | scaffold, then B |
| `routes/files.js` | a third access clause: a supplier statement file needs `accounts.view` (§7.4) | scaffold |
| `lib/roundup.js` | the "statements still waiting" line (§7.5) | B |
| `server.js` | mounts `routes/bas.js` and `routes/suppliers.js` | scaffold |
| `public/shell/shell.js` | the Accounts menu gains two items (§8) | scaffold |
| `ci/smoke.sh` | the M9 source loop (§10.1) | scaffold |
| `tools/screenshots/shoot.js` | five entries (§10.4) | scaffold |
| `docs/auth.md` | one line: BAS and supplier accounts use the Accounts keys; reopening a lodged month is `users.admin` | scaffold |
| `crosscuts/app/package.json`, `crosscuts/app/package-lock.json` | 0.1.12 | scaffold |
| `ci/smoke-m9-bas.sh` | §10.2 | A |
| `ci/smoke-m9-suppliers.sh` | §10.3 | B |
| `public/bas.html`, `bas.css`, `bas.js` | the BAS sales page (§9.1), class prefix `ba-` | C |
| `public/suppliers.html`, `suppliers.css`, `suppliers.js` | the supplier accounts page and its prints (§9.2), prefix `su-` | D |
| `docs/how-to-bas.md`, `docs/how-to-suppliers.md`, a `docs/cutover.md` note | short guides for Accounts; the cutover-month hand amount | integrator, 4.1 |

**Boundaries.**
- All month and financial-year arithmetic lives in `public/periods.js` only. `lib/bas.js` and `lib/suppliers.js` require it (`require("../public/periods")`); the pages load it with `<script src="/periods.js">`.
- `lib/bas.js` and `lib/suppliers.js` take `db` first in every function and never require `../db`. The routes pass it in.
- Every write runs in one `db.transaction` with its audit row.
- Money is integer cents everywhere (GST-inclusive as stored, lead's default 3). Dollars appear only on the page and in the CSV.

## 2. Migration `020_bas_suppliers.sql` (scaffold, M9 · 2.2)

```sql
-- M9 BAS sales and supplier accounts (docs/plans/m9-contracts.md section 2). Additive only:
-- three new tables and one index. No existing row changes.

-- One row per month that has a hand amount or has been lodged. A month with neither has no row.
-- period is 'YYYY-MM' (a Sydney calendar month).
CREATE TABLE bas_months (
  period TEXT PRIMARY KEY,
  hand_cents INTEGER,                                   -- GST-inclusive; may be negative (a refund)
  hand_gst_cents INTEGER,                               -- NULL = not known (imported history)
  hand_note TEXT NOT NULL DEFAULT '',
  lodged_at TEXT,                                       -- NULL while not lodged
  lodged_by INTEGER REFERENCES users(id),
  lodged_json TEXT,                                     -- frozen at lodge (section 5)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (hand_gst_cents IS NULL OR hand_cents IS NOT NULL),
  CHECK ((lodged_at IS NULL) = (lodged_json IS NULL))
);

-- The suppliers Accounts keep (never deleted; archived instead). Separate from the free-text
-- supplier names on Orders.
CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  from_period TEXT NOT NULL,                            -- first month it is listed in
  archived_from TEXT,                                   -- first month it is no longer listed in
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One supplier's line for one month. A listed supplier with no row is Waiting with blanks.
-- file_id is the statement attached to the line (Decision 6: one file per supplier per month);
-- this table is the link table, as task_files is for tasks.
CREATE TABLE supplier_statements (
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  period TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('have','waiting','na')),
  total_cents INTEGER,
  note TEXT NOT NULL DEFAULT '',
  reconciled INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0,1)),
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0,1)),
  myob INTEGER NOT NULL DEFAULT 0 CHECK (myob IN (0,1)),
  file_id INTEGER UNIQUE REFERENCES files(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (supplier_id, period)
);
CREATE INDEX idx_supplier_statements_period ON supplier_statements(period);

-- BAS reads paid invoices by month.
CREATE INDEX idx_invoices_paid_date ON invoices(paid_date) WHERE status = 'paid';
```

## 3. Paid dates (scaffold; Decision 1)

`lib/invoices.js` `markPaid`, inside its transaction, after the status check:
- `date < inv.issue_date` → 400 `"The paid date can't be before the invoice was issued (<d Mon yyyy>)"`, e.g. `(5 Oct 2026)`;
- `date > sydneyToday()` → 400 `"The paid date can't be in the future"`.

Nothing else in `lib/invoices.js` changes. Paid invoices already in the database are left as they are (none are real before cutover).

`public/accounts.js`: the `paid-on` input gets `min = inv.issueDate` and `max = todayISO()`. The server's sentence still shows when the browser lets a typed date through (the page already shows a refused request's error).

`ci/smoke-m2-invoices.sh`: the step that marks `$FIN` paid on `2033-01-05` becomes three requests: `2033-01-05` → 400 (future); the day before `$M2A_TODAY` → 400 (before issue, since smoke invoices are issued today); `$M2A_TODAY` → 200 with that `paidDate`. Nothing else in that file changes.

## 4. `public/periods.js` (scaffold, complete)

A plain script that works in both places: `module.exports = Periods` under Node, `window.Periods` in the browser. No dependencies, no DOM, no clock (callers pass `today`).

A **period** is `'YYYY-MM'`. A **financial year** is a number, the calendar year it ends in: FY 2027 = Jul 2026 – Jun 2027 (lead's default 2). Quarters are the FY's: Q1 Jul–Sep, Q2 Oct–Dec, Q3 Jan–Mar, Q4 Apr–Jun.

```js
const PERIOD_RE;                       // /^\d{4}-(0[1-9]|1[0-2])$/
const HISTORY_START;                   // '2023-06' (Decision 3): the first month anything can be typed for
function validPeriod(p);               // PERIOD_RE and year 2000-2099
function periodOf(date);               // '2026-10-05' → '2026-10'
function addMonths(period, n);         // ('2026-11', 2) → '2027-01'; n may be negative
function compare(a, b);                // -1 / 0 / 1 (string order works; this is for readability)
function firstDay(period);             // '2026-10-01'
function lastDay(period);              // '2026-10-31'; leap years handled
function label(period);                // 'Oct 2026'
function longLabel(period);            // 'October 2026'
function fyOf(period);                 // '2026-07' → 2027; '2026-06' → 2026
function fyMonths(fy);                 // the twelve periods, Jul (fy-1) to Jun (fy)
function fyLabel(fy);                  // 'FY 2027'
function fyRangeLabel(fy);             // 'Jul 2026 – Jun 2027'
function quarterOf(period);            // 1..4 (FY quarters)
function quarterLabel(fy, q);          // 'Q1 Jul–Sep 2026', 'Q3 Jan–Mar 2027'
function currentPeriod(today);         // periodOf(today)
function ended(period, today);         // true when period < currentPeriod(today)
function dollars(cents);               // 1234567 → '$12,345.67'; -1200 → '-$12.00'; null → ''
function parseDollars(text);           // '12,345.67', '$12345.6', '12345', '-50' → cents;
                                       // '' → null; anything else NaN; at most 2 decimals
```

**Unit table** (the scaffold proves it with a node check, kept out of the repo): `fyOf('2026-07')` 2027, `fyOf('2026-06')` 2026, `fyOf('2023-06')` 2023; `fyMonths(2027)[0]` `'2026-07'`, `[11]` `'2027-06'`; `quarterOf('2026-09')` 1, `'2026-10'` 2, `'2027-01'` 3, `'2027-06'` 4; `addMonths('2026-12', 1)` `'2027-01'`, `addMonths('2027-01', -13)` `'2025-12'`; `lastDay('2028-02')` `'2028-02-29'`, `lastDay('2027-02')` `'2027-02-28'`; `ended('2026-09', '2026-10-01')` true, `ended('2026-10', '2026-10-31')` false; `dollars(0)` `'$0.00'`, `dollars(-1200)` `'-$12.00'`; `parseDollars('1,234.5')` 123450, `parseDollars('$0.07')` 7, `parseDollars('1.234')` NaN, `parseDollars('abc')` NaN, `parseDollars('')` null; `validPeriod('2026-13')` false.

## 5. `lib/bas.js` (stub in scaffold, then A)

Signatures binding; internals A's. Errors are `HttpError`.

```js
function year(db, fy, today = sydneyToday());          // §6.2 year object
function month(db, period, today = sydneyToday());     // §6.2 month detail
function compare(db, today = sydneyToday());           // §6.2 comparison
function csv(db, period);                              // the month's invoice list as CSV text (§6.4)
function setHand(db, req, period, body);               // month detail (§6.3)
function lodge(db, req, period, today = sydneyToday());// month detail
function reopen(db, req, period);                      // month detail
```

**A month's live figures** (Decision 1, cash basis): the invoices with `status = 'paid'` and `paid_date` inside the month (`firstDay` to `lastDay`), plus the month's hand amount.
- `invoiceCount`, `invoiceCents` = Σ `total_cents`, `invoiceGstCents` = Σ `gst_cents`;
- `handCents`, `handGstCents`, `handNote` from `bas_months` (null, null, `''` when none);
- `salesCents` = `invoiceCents + (handCents || 0)`: **Sales including GST (G1)**;
- `gstCents` = `invoiceGstCents + handGstCents`, or **null** when the month has a hand amount whose GST isn't known (Decision 4): **GST on sales (1A)**;
- `exGstCents` = `salesCents − gstCents`, or null when `gstCents` is null;
- `notInMyobCount` = how many of the month's invoices have `myob_entered_date` null;
- `kind`: `'empty'` (no invoices, no hand amount), `'invoices'`, `'imported'` (a hand amount and no invoices), `'mixed'` (both).

**Lodging** (Decision 2) freezes into `lodged_json`: `{figures: <the live figures above>, invoices: [<the month's invoice rows, §6.2>]}`. While lodged:
- the year and month views show the **frozen** figures as the month's figures, with the live ones beside them;
- `changed` is true when the live figures or the live invoice list differ from the frozen ones (an invoice's id, `paidDate`, `totalCents` or `gstCents`; the hand fields). `changes` lists them as sentences: `"CC-0012 is no longer paid in this month"`, `"CC-0015 was marked paid in this month after lodging"`, `"CC-0012's paid date moved from 3 Sep 2026 to 2 Oct 2026"`, `"The hand amount changed from $120.00 to $95.00"`;
- the hand amount can't change (409, §6.3). Invoices stay editable on the Accounts page: lodging never blocks Mark paid or Mark unpaid, it only shows the change.

A month can be lodged only once it has ended (`Periods.ended`) and only from `HISTORY_START` on. Reopening clears `lodged_at`, `lodged_by` and `lodged_json`.

## 6. BAS API (`routes/bas.js`, `defineRoutes('/api/bas')`)

Validation → 400, not found → 404, rule break → 409. A `:period` that isn't `Periods.validPeriod` → 404. Bodies that aren't objects are treated as `{}`.

### 6.1 Routes

| Method & path | Access | Body / query → response |
|---|---|---|
| `GET /` | `accounts.view` | `?fy=2027` (default the current FY) → year object. 400 `"Choose a financial year from FY 2023"` when `fy < fyOf(HISTORY_START)`; 400 for a FY after the current one. |
| `GET /compare` | `accounts.view` | → comparison |
| `GET /months/:period` | `accounts.view` | → month detail. 404 before `HISTORY_START` or after the current month. |
| `GET /months/:period/invoices.csv` | `accounts.view` | → `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="BAS sales <Mon yyyy>.csv"` (§6.4). Always the **live** list. |
| `PUT /months/:period/hand` | `invoices.edit` | §6.3 → month detail |
| `POST /months/:period/lodge` | `invoices.edit` | → month detail. 409 `"A month can be lodged once it has ended"`; 409 `"This month is already lodged"`. Audit `bas.lodge` (after: the frozen figures). |
| `POST /months/:period/reopen` | `users.admin` | → month detail. 409 `"This month isn't lodged"`. Audit `bas.reopen` (before: the frozen figures). |

### 6.2 Shapes

- **figures:** `{invoiceCount, invoiceCents, invoiceGstCents, handCents, handGstCents, handNote, salesCents, gstCents, exGstCents, notInMyobCount, kind}` (§5).
- **month row:** `{period, label, quarter, future: bool, figures, live: figures, lodged: {at, by: {id, name}}|null, changed: bool}`. `figures` is the frozen copy when lodged, else the same as `live`. A future month has empty figures and `future: true`.
- **year object:** `{fy, label, rangeLabel, firstFy, currentFy, months: [twelve month rows], quarters: [four {q, label, salesCents, gstCents, exGstCents, invoiceCount, lodgedCount}], total: {salesCents, gstCents, exGstCents, invoiceCount, lodgedCount}}`. Quarter and year sums add each month's `figures`. A sum's `gstCents` (and `exGstCents`) is null when any month in it with sales has a null `gstCents`. Months before `HISTORY_START` (FY 2023's Jul–May) have empty figures with `future: false` and are left out of the sums (4.3).
- **invoice row:** `{id, number, kind, client, job: {id, name}, issueDate, paidDate, totalCents, gstCents, exGstCents, myobEnteredDate}`. `client` is the frozen `bill_to_name`, falling back to the job's `client_name`.
- **month detail:** `{month: month row, invoices: [live invoice rows by paidDate, then number length, number and id], lodgedInvoices: [frozen rows, each carrying the invoice's current `myobEnteredDate` (§12.11; `lodged_json` itself is never rewritten)]|null, changes: [sentence], prev: period|null, next: period|null}`. `prev` is null at `HISTORY_START`; `next` is null at the current month.
- **comparison:** `{fys: [firstFy … currentFy], rows: [twelve {monthIndex: 0..11, label: 'Jul'…'Jun', values: {<fy>: salesCents|null}}]}`. A value is null for a future month or a month before `HISTORY_START`; a past month with nothing is 0. Values are each month's `figures.salesCents` (frozen when lodged).

### 6.3 Hand amount (`PUT /months/:period/hand`)

Body: `{handCents: int|null, handGstCents: int|null, handNote: string}`.
- 409 `"This month is lodged; an admin can reopen it"` when lodged.
- 400 for a period before `HISTORY_START` or after the current month (`"Hand amounts go from Jun 2023 to this month"`).
- `handCents`: null (clears the hand amount) or an integer, −1,000,000,000 to 1,000,000,000 and not 0 (400 `"Enter an amount, or clear it"`).
- `handGstCents`: null or an integer whose absolute value is at most `|handCents| / 11` rounded (400 `"GST can't be more than a tenth of the amount before GST"`); when not 0, the same sign as `handCents` (400 `"GST must have the same sign as the amount"`, added at 4.3, checked before the tenth rule); must be null when `handCents` is null.
- `handNote`: at most 500 after trim.
- Clearing a month with no lodging deletes its row. Nothing is written (no stamp, no audit) when nothing changes. Audit `bas.hand`, entity `bas_month`, entity id the period, before and after the three hand fields.

### 6.4 CSV

Header row then one row per live invoice (in the month detail's order): `Invoice,Client,Job,Kind,Issued,Paid,Total inc GST,GST,Ex GST,Entered in MYOB`. Dates `YYYY-MM-DD`; money as plain `1234.56` (no `$`, no commas); `Entered in MYOB` the date or blank; a hand amount, if any, as a last row `,,,Hand amount,,,<amount>,<gst or blank>,<ex or blank>,` with its note in the Client column. RFC 4180 quoting; a text cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`. CRLF line ends, a UTF-8 BOM first (so Excel reads it).

### 6.5 Audit (actor `req.user`)

`bas.hand`, `bas.lodge`, `bas.reopen`, entity `bas_month`, entity id the period.

## 7. Supplier accounts (B)

### 7.1 `lib/suppliers.js` (stub in scaffold, then B)

```js
function list(db, {all = false} = {});                 // [supplier] by name; all = with archived
function create(db, req, {name, fromPeriod});          // supplier
function update(db, req, id, body);                    // supplier ({name?, archived?})
function month(db, period, today = sydneyToday());     // §7.3 month object
function saveLine(db, req, period, supplierId, body);  // line
function attach(db, req, period, supplierId, accepted);// line (caller discards the file when it throws)
function detach(db, req, period, supplierId);          // line
function waitingCount(db, period);                     // number, for the round-up
```

**Who is listed in month P:** every supplier with a `supplier_statements` row for P, plus every supplier with `from_period <= P` and (`archived_from` null or `P < archived_from`). Archiving sets `archived_from` to the current month. **Restoring skips the gap** (Todd, 2026-10-13): in one transaction it gives every month from the old `from_period` up to the month before the old `archived_from` that has no row a `waiting` row (so the months before the archive keep listing it), then sets `from_period` to the current month and clears `archived_from`; the months it was archived gain nothing, and the round-up's count doesn't change. `create` takes `fromPeriod` (default the current month; the page sends the month on screen, so a supplier added while doing last month's pass shows there).

### 7.2 Routes (`routes/suppliers.js`, `defineRoutes('/api/suppliers')`)

Literal paths (`/months`) are registered before `/:id`. A `:period` that isn't valid, is before `HISTORY_START` or after next month → 404 (next month allowed, approved by Todd 2026-10-24).

| Method & path | Access | Body / query → response |
|---|---|---|
| `GET /` | `accounts.view` | `?all=1` → `{suppliers: [supplier]}` |
| `POST /` | `invoices.edit` | `{name, fromPeriod?}` (name 1–100 after trim) → 201 supplier. 409 `"A supplier with that name already exists"` (case-blind, Unicode: NFC and `en-AU` lower-case, on create and rename; a case-only rename of itself is allowed). Audit `supplier.create`. |
| `PATCH /:id` | `invoices.edit` | `{name?, archived?}` → supplier. 409 as above for a clashing name. Audit `supplier.update` (changed fields). |
| `GET /months/:period` | `accounts.view` | → month object |
| `PUT /months/:period/:supplierId` | `invoices.edit` | §7.3 → line. 404 when the supplier isn't listed in that month. |
| `POST /months/:period/:supplierId/file` | `invoices.edit` | multipart, field `file` (`files.single("file")`, `files.accept`, as `routes/tasks.js`) → 201 line. A file already there is replaced (the old one soft-removed with `files.remove`). Audit `supplier_statement.file` (after `{fileId, name}`). |
| `DELETE /months/:period/:supplierId/file` | `invoices.edit` | `?fileId=<id>` optional (4.3) → line. 404 when there is no file. With `fileId`: 409 `{error: "This statement was replaced meanwhile; reload the line", line}` when the line holds another file; 400 `"fileId must be a positive whole number"` when it isn't one. The page always sends it. Audit `supplier_statement.file` (before `{fileId, name}`, after null). |

### 7.3 Shapes and saving

- **supplier:** `{id, name, fromPeriod, archivedFrom, archived: bool}` (`archived` = `archivedFrom` not null).
- **line:** `{supplier: {id, name}, period, state: 'have'|'waiting'|'na', totalCents, note, reconciled, paid, myob, file: <files.toFile>|null, saved: bool, updatedAt: string|null, updatedBy: {id, name}|null}`. A listed supplier with no row: `state 'waiting'`, blanks, `saved: false`, `updatedAt: null`.
- **month object:** `{period, label, prev, next, lines: [line by supplier name], counts: {have, waiting, na, listed}, totalCents: Σ totalCents of lines that have one, ticks: {reconciled, paid, myob}}`. `prev` null at `HISTORY_START`, `next` null at next month (next month allowed, approved by Todd 2026-10-24).

`PUT` body: `{state, totalCents, note, reconciled, paid, myob, updatedAt}`.
- `updatedAt` must equal the line's (`null` for a never-saved line): else 409 `{error: "Someone else changed this line; reload it", line}`.
- `state` one of the three; `totalCents` null or an integer, −1,000,000,000 to 1,000,000,000; `note` at most 500 after trim; the ticks booleans.
- Upserts the row, sets `updated_by` and `updated_at`. Nothing is written when nothing changes. Audit `supplier_statement.update`, entity `supplier_statement`, entity id `<supplierId>:<period>`, before and after holding only the changed fields.

### 7.4 Files (`routes/files.js`, scaffold)

`GET /api/files/:id` gains a third clause: a file linked from `supplier_statements.file_id` is allowed with `accounts.view`. Allowed types and size are `lib/files.js`'s (PDF and images are what Accounts will use; Office files are allowed as for tasks).

### 7.5 The round-up line (`lib/roundup.js`, B; Decision 7)

`buildSummary` gains `statementsWaitingCount` = `suppliers.waitingCount(db, previous month of today)` and `statementsPeriod`. When it is not 0:
- the title gains `"<n> statements waiting"`;
- the body gains `"<n> supplier statement(s) still waiting for <Month>."` (`"1 supplier statement still waiting for September."`, `"3 supplier statements still waiting for September."`);
- `run` sends when any count, this one included, is not 0. The link stays `/accounts.html` unless this is the only non-zero count, then `/suppliers.html?period=<YYYY-MM>`.

Nothing else in the round-up changes.

### 7.6 Audit (actor `req.user`)

`supplier.create`, `supplier.update` (entity `supplier`; a restore records `fromPeriod` and `archivedFrom` before and after, and the waiting lines it fills have no audit rows of their own); `supplier_statement.update`, `supplier_statement.file` (entity `supplier_statement`, id `<supplierId>:<period>`).

## 8. Pages, menu and access (scaffold)

- `lib/pages.js`: `"/bas.html": "accounts.view"`, `"/suppliers.html": "accounts.view"`.
- `public/shell/shell.js`: the Accounts menu becomes Accounts, Pay runs, **BAS sales** (`/bas.html`, `accounts.view`), **Supplier accounts** (`/suppliers.html`, `accounts.view`), Reports (lead's default 7). Both items are inside the dropdown, so the bar's width doesn't change; a glance at 1260 and 1440 is enough.

## 9. The pages (Wave 1)

Both pass `node ci/style-check.js`, follow the house style (`tokens.css`, `components.css` `hs-`, the shell's `cc-dialog*`, `shared.js` `api()` / `toast()` / `guarded()`), put user text in via `textContent`, and read `cc.can('invoices.edit')` (and `cc.can('users.admin')` for Reopen): without it every write control is hidden and the page is read-only. Money shows as `Periods.dollars`; amounts are typed with `Periods.parseDollars`. No horizontal page scroll at 375 px (wide tables scroll inside their own box). Prints are by browser print (Save as PDF), A4, black on white, between the `style-check: print-start` / `print-end` comments; on-screen controls are hidden in print.

### 9.1 `/bas.html[?fy=2027][#2026-09]` (C, prefix `ba-`)

- **Header:** "BAS sales", the FY label and range, previous / next FY buttons (from `firstFy` to `currentFy`), **Print**. A line under it: "Cash basis: a month's sales are the invoices paid in it. Amounts include GST."
- **The year table:** one row per month (Jul to Jun) with a quarter subtotal row after each quarter and the year total at the foot. Columns: Month, **Sales inc GST (G1)**, **GST (1A)**, **Ex GST**, Invoices, Not in MYOB, Status. A null GST or ex-GST shows as a dash with a key line "A dash: imported history has no GST split." Status: "Lodged <d Mon>" (neutral badge), "Changed since lodged" (orange badge), "Imported", "Includes a hand amount", "Not ended" for the current month, nothing for a future month (its figures blank). A lodged month's figures are the frozen ones, except **Not in MYOB**, which is a to-do count and stays live (`live.notInMyobCount`, summed live in the quarter and year rows; the as-lodged list's In MYOB cells show each invoice's current date) (§12 point 11).
- **Click a month** (a button, keyboard reachable) to open its detail below the table (`#YYYY-MM` keeps it across reloads):
  - its figures; when lodged and changed, the live figures beside the frozen ones and the `changes` sentences in orange;
  - **Lodge** (`invoices.edit`, ended and not lodged; a `confirm` naming the month and its Sales inc GST), **Reopen** (`users.admin`, lodged);
  - **Hand amount** (`invoices.edit`, not lodged): amount, GST (optional, "leave blank if not known"), note, **Save** / **Clear**. The help line: "For months before Crosscuts (one figure from the old workbook, including GST), payments received before the switch-over, or a refund (a negative amount)."
  - the invoice list (Invoice number linking to `/invoice.html?id=`, Client, Job, Issued, Paid, Total, GST, Ex GST, In MYOB) with **Download CSV** (`GET …/invoices.csv`); when lodged, the frozen list is shown, with a "Show current list" toggle.
  - previous / next month buttons.
- **Comparison:** the same month across financial years, as a table (rows Jul–Jun, a column per FY) and a small line chart above it drawn as inline SVG: the current FY in teal (`--teal`), the FY before it in the label grey, older years in the muted grey, each line labelled at its end with its FY; no other colours. Hidden in print.
- **Print:** the FY table only (with quarter and year totals), "BAS sales FY 2027", the basis line, and the printed date; `document.title` "BAS sales FY 2027".

### 9.2 `/suppliers.html[?period=2026-09][&print=blank]` (D, prefix `su-`)

- **Header:** "Supplier accounts", the centre month (`longLabel`), Previous month / This month / Next month buttons (the centre goes from `HISTORY_START` to next month; the default is the **current** month). The page shows three months side by side as compact lists (the month before, the centre month, the month after; Option B, approved by Todd 2026-10-24), each with "Left to pay" (the totals of unpaid lines that are not N/A) and an orange "N missing" line; every month is editable. **Print** and **Print blank form** are the centre month's. An admin sees an Audit log link to `/audit.html?entityType=<statement entity>`.
- **The month's list:** one row per listed supplier, alphabetical: Supplier, **Have statement / Waiting / N/A** (a three-way choice), **Total** (typed in dollars), **Reconciled**, **Paid**, **Entered in MYOB** (ticks), Note, Statement (the file's name linking to its `url`, opening in a new tab; **Attach** / **Replace** / **Remove** for `invoices.edit`, accepting `.pdf,.jpg,.jpeg,.png`: what `lib/files.js` allows for a statement; `.webp` and `.heic` dropped at 4.1, Todd 2026-10-12).
  - Each line saves on its own (a change commits on blur or on choosing; one request per line, the `updatedAt` it last saw). A 409 shows its sentence on that row with **Reload**. A refused value outlines the cell in orange with the sentence beside the row.
  - The footer: "Have 12, Waiting 3, N/A 2 of 17", the sum of the totals, and the tick counts.
- **Suppliers:** **Add supplier** (dialog: name; it is listed from the month on screen), **Rename**, **Archive** (from this month on) and, with "Show archived", **Restore**. A note: "Archived suppliers stay on the months they already have lines in."
- **Print** (`document.title` "Supplier accounts September 2026"): the month's list as a table (Supplier, Statement state as a word, Total, the three ticks as ✓, Note), with the counts and the sum.
- **Print blank form** (`&print=blank`, `document.title` "Supplier statements form"): as the paper form (m9-plan §1.4): "Suppliers" and a "Month" line left blank (no business name: `/api/settings` is admin-only, and the paper is for in-house use); the listed suppliers' names in tall rows, then five blank rows; columns Supplier name, Have statement, Waiting, N/A, Total, Reconciled, Paid, MYOB, Notes, all empty.

The check mark ✓ is a character, not an icon (house style allows text).

## 10. Tests and checks

### 10.1 `ci/smoke.sh` (scaffold)

After the M8 loop and before the Backup suite:

```bash
# M9 suites (ci/smoke-m9-*.sh, docs/plans/m9-contracts.md section 10): same rules.
for f in "$(dirname "$0")"/smoke-m9-*.sh; do [ -f "$f" ] && source "$f"; done
```

Step k (cutover rehearsal) must still pass: the old app's database is migrated through 020 there.

### 10.2 `ci/smoke-m9-bas.sh` (A), `step "m9-bas. BAS sales by month"`

M-suite rules (sourced, no shebang, no `set`, the shared helpers and jars, prefix `M9B_`, no pristine-DB assumption). Smoke invoices are issued and paid today, so past months are made by moving dates with SQL through the container's own better-sqlite3 (as `ci/smoke-m3-pipeline.sh` `m3a_db_exec`). It uses **2024** months (before cutover, after `HISTORY_START`, never touched by other suites) and the current month; it reads figures as differences from what was there before it started.
- **Access:** `GET /api/bas` acct 200, admin 200, sched / dpm / show / wshop 403; `PUT …/hand` sched 403, dpm 403; `/bas.html` acct 200, sched 403; `POST …/reopen` acct 403.
- **Year shape:** `?fy=2025` → twelve months `2024-07` … `2025-06`, four quarters; `?fy=2022` → 400; `?fy=<current+1>` → 400.
- **Cash basis:** make a job and two invoices, issue both (today), mark one paid today → the current month's `invoiceCount` +1 and `salesCents` + its total, `gstCents` + its `gst_cents`; the unpaid one doesn't count. With SQL, move a paid invoice's `issue_date` and `paid_date` to `2024-08-10` → `2024-08` shows it, the current month no longer does.
- **Hand amounts:** `PUT /months/2024-09/hand {handCents: 1234500, handGstCents: null, handNote: "M9 history"}` → kind `imported`, `salesCents` 1234500, `gstCents` null, `exGstCents` null; the FY 2025 Q1 `gstCents` is null; `handCents: 0` → 400; `handGstCents` larger than a tenth → 400; a period `2023-05` → 400; the next month → 404 on GET; on `2024-08` (which has an invoice) → kind `mixed`, with `handGstCents` given → `gstCents` = invoices' GST + hand GST; clear `2024-08` → back to `invoices`.
- **Lodging:** lodge the current month → 409 `ended`; lodge `2024-08` → 200, `lodged` set; lodge again → 409; `PUT hand` → 409; with SQL, move the invoice's `paid_date` to `2024-10-02` → `2024-08` still shows the frozen figures, `changed: true`, a `changes` sentence mentions its number; `2024-10` shows it live; acct reopen → 403; admin reopen → 200, `changed: false`, figures live.
- **Compare:** `GET /compare` → `fys` includes 2025; the `Sep` row's 2025 value equals `2024-09`'s `salesCents`.
- **CSV:** `GET /months/2024-10/invoices.csv` → 200, `text/csv`, header line exact, one row with the invoice number; a job whose client name starts with `=` comes out as `'=`.
- **Paid-date rule (§3):** a future date → 400; a date before issue → 400.
- **Audit:** admin `GET /api/audit?entityType=bas_month&entityId=2024-08` has `bas.hand`, `bas.lodge`, `bas.reopen`.
- **Tidy:** clears the hand amounts it set and reopens anything it lodged.
- **Added at 4.3:** GST of the opposite sign → 400; a pre-`HISTORY_START` row made with SQL is ignored and left out of the sums; the as-lodged list carries the live MYOB date; `GET /compare` gives a lodged month's frozen figure; tomorrow and yesterday come from the issue response's `issueDate`.

### 10.3 `ci/smoke-m9-suppliers.sh` (B), `step "m9-suppliers. supplier accounts and the round-up line"`

M-suite rules, prefix `M9S_`; made-up names (`M9 Test Supplier A` …); periods in 2024 plus the previous month (for the round-up).
- **Access:** `GET /api/suppliers` acct 200, sched / dpm / show / wshop 403; `POST /` sched 403; `/suppliers.html` acct 200, sched 403.
- **Suppliers:** create A with `fromPeriod 2024-03`, B with `2024-05`; the same name in other case → 409; rename A → 200; `GET /months/2024-04` lists A and not B; `2024-05` lists both.
- **Lines:** a fresh line is `waiting`, `saved: false`; `PUT` `{state:"have", totalCents: 50000, note:"M9", reconciled:true, paid:false, myob:false, updatedAt:null}` → 200; the same body with the old `updatedAt` → 409 with `.line`; `state:"maybe"` → 400; the month's `counts.have` +1 and `totalCents` includes 50000; a PUT for B in `2024-04` → 404.
- **Archive:** archive A → the current month doesn't list it; `2024-05` still does (it has a line there).
- **File:** attach a small PDF (`%PDF-` header) → 201 with `file.url`; `GET` it as acct → 200 `application/pdf`; as sched → 404; attach a second → the first file id now 404; a `.txt` → 400; `DELETE …/file` → 200, `file: null`.
- **Round-up:** with a supplier listed and waiting in the previous month, admin `POST /api/notifications/roundup/run` → the acct user's newest `invoice.roundup` body contains "still waiting for"; mark it `have` and run again → the newest has no such line (or no new round-up when every count is 0).
- **Audit:** `entityType=supplier_statement&entityId=<A>:2024-05` has `supplier_statement.update` and `supplier_statement.file`.
- **Added at 4.3:** a line keeps an archived supplier listed in the current month; restore skips the archived months (an SQL-moved `archived_from`; the previous month's waiting count unchanged; the restore audit); the replaced and removed files have `removed_at` set; `DELETE …/file?fileId=` stale → 409 with the file kept, bad → 400, right → 200; the Unicode name clash.

### 10.4 Screenshots (`tools/screenshots/shoot.js`, scaffold)

`["bas", "/bas.html", 1440, true]`, `["bas-1100", "/bas.html", 1100, true]`, `["suppliers", "/suppliers.html", 1440, true]`, `["phone-bas", "/bas.html", 375, true]`, `["phone-suppliers", "/suppliers.html", 375, true]`. The integrator adds made-up BAS and supplier data to `tools/screenshots/seed.js` at 4.1.

### 10.5 Local checks (every task)

Docker isn't on the dev box (and no jq), so smoke files get `bash -n` only; CI is their real run. Every task: `node --check` on its JS, `node ci/style-check.js`, a shim boot on a fresh `.dev/<task>/` (`REMINDER_DISABLED=1 ROUNDUP_DISABLED=1 BACKUP_SCHEDULE_DISABLED=1 PLANNER_REMINDER_DISABLED=1`) and `fetch` calls against its routes. In addition:
- **Scaffold:** 020 on a fresh `.dev/m9/` and on a copy of the latest local test database (pre-020 backup written, foreign keys ok); the §4 unit table as a node check; the §3 paid-date rule (future 400, before issue 400, today 200); every new route answers 501 for acct (403 for sched, 401 logged out), except `reopen`, which is 403 for acct; the two pages 200 / 403; the menu shows both items for acct and not for sched.
- **A and B:** a node replay of every §10.2 / §10.3 assertion against the shim (the SQL steps through the shim's own database handle).
- **C and D:** headless-Edge screenshots at 1440, 1100 and 375 with stubbed responses (an imported FY, the current FY with a lodged and a changed month, a busy supplier month, view-only), keyboard reach of every control and dialog, and an Edge print-to-PDF of each print (A4, black on white, nothing cut off), kept under `.dev/`. D also: two tabs editing one line (the 409 and Reload), and an attach / replace / remove.

## 11. Waves and file ownership

| Step | Who | Owns (only these files) | Starts after |
|---|---|---|---|
| **M9 · 2.2 Scaffold** | integrator | `db/migrations/020_bas_suppliers.sql`, `public/periods.js`, `lib/invoices.js` (§3 only), `public/accounts.js` (§3 only), `ci/smoke-m2-invoices.sh` (§3 only), `lib/pages.js`, `lib/bas.js` and `lib/suppliers.js` (stubs), `routes/bas.js` and `routes/suppliers.js` (declared, 501), `routes/files.js` (§7.4), `server.js`, `public/shell/shell.js` (§8), `ci/smoke.sh` (§10.1), `tools/screenshots/shoot.js`, `docs/auth.md`, `package.json` and `package-lock.json` (0.1.12) | — |
| **M9 · 3.1 Wave 1, A: BAS backend** | worktree | `lib/bas.js`, `routes/bas.js`, `ci/smoke-m9-bas.sh` | scaffold |
| **M9 · 3.1 Wave 1, B: supplier backend** | worktree | `lib/suppliers.js`, `routes/suppliers.js`, `lib/roundup.js` (§7.5), `ci/smoke-m9-suppliers.sh` | scaffold |
| **M9 · 3.1 Wave 1, C: BAS page** | worktree | `public/bas.{html,css,js}` | scaffold (stubbed responses) |
| **M9 · 3.1 Wave 1, D: supplier page** | worktree | `public/suppliers.{html,css,js}` | scaffold (stubbed responses) |
| **M9 · 4.1 Integrate** | integrator | merges; `tools/screenshots/seed.js` (made-up data); `docs/how-to-bas.md`, `docs/how-to-suppliers.md`, the `docs/cutover.md` note; STATUS; real-data checks of C and D on the merged backend | all |

One wave: the pages code against §6 and §7 with stubbed responses, then 4.1 runs them against A's and B's backends. `public/periods.js` is the scaffold's; a task that needs a change to it reports it. Worktree base: each agent resets to the commit the integrator names, and junctions `crosscuts/app/node_modules` from the main checkout.

## 12. Points the integrator decided (Todd can change any)

1. **One hand amount per month**, which covers all three uses: an imported history figure, payments received before the switch-over in the cutover month, and a refund (negative). Its GST is optional; when it isn't given the month's GST and ex-GST show as a dash (Decision 4), and so do the quarter and year sums that include it.
2. **No boundary setting for "imported" months.** After cutover the months before it have no invoices in Crosscuts, so a month with only a hand amount is shown as Imported; nothing has to be set on cutover day.
3. **Lodging is per month**, and only once the month has ended. A quarterly BAS is lodged by lodging its three months; the quarter row shows "3 of 3 lodged".
4. **Lodging never blocks invoice changes** (Decision 2 says "shows as changed since lodged"): Mark paid and Mark unpaid still work on the Accounts page, and the BAS page then shows the frozen figures, the live ones and what changed. The hand amount itself is locked while lodged.
5. **The comparison goes by financial year** (rows Jul–Jun, a column per FY), to match the year table, rather than the workbook's calendar-year grid. The average and "FY Predict" formulas are dropped (plan §2.1).
6. **The supplier page opens on the previous month**, because statements for a month arrive after it ends; the round-up line counts that same month.
7. **Suppliers are listed from the month they are added on** (the month on screen), and archived from the current month on; a month that already has a line for an archived supplier keeps it.
8. **The supplier line is the link table** for its statement file (`supplier_statements.file_id`), rather than a separate `supplier_statement_files` table: there is one file per line (Decision 6), and the table is new, so this stays additive.
9. **Supplier months aren't locked.** Only BAS months lock (Decision 2 covers BAS only).
10. **Paid invoices already in the database aren't re-checked** by the new paid-date rule (§3); there are no real ones before cutover.
11. **Not in MYOB stays live on a lodged month** (decided at 4.1): it's a to-do signal, not a BAS figure, so entering a lodged month's invoices in MYOB clears it. Every BAS figure and the lodged invoice list stay frozen; MYOB ticks never make a month "changed since lodged".
12. **Statement files are PDF, JPEG or PNG** (Todd, 4.1): what `lib/files.js` allows; `.webp` and `.heic` were dropped from §9.2.
13. **Pre-cutover invoices paid after cutover** (issued in MYOB, never in Crosscuts) don't count by themselves under the cash basis; Accounts add them to the hand amount of the month they're paid in (`docs/cutover.md`, `docs/how-to-bas.md`).
14. **Restore skips the gap** (Todd, 4.3; §7.1): a restored supplier is listed from the current month on; the months it was archived stay as they were.
15. **Error text is orange app-wide** (Todd, 4.3): `.cc-dialog-error` in the shell uses the orange tint (attend), not red, so dialog and form errors follow the house style's colour roles.

## 2026-10-16 change: BAS sales are typed in by hand (Todd's decision; supersedes §5, §6 and §9.1 where they differ)

Invoices no longer count towards BAS at all. Every month's sales (including GST) and its GST are typed in by hand, for past months and for each new month. No migration: the `bas_months` hand columns (`hand_cents`, `hand_gst_cents`, `hand_note`) now hold the month's figure, and a month with no `hand_cents` is "not entered".

- **Figures** (per month): `{entered, salesCents, gstCents, exGstCents, note}`. Not entered: `entered false`, every amount null, note `''`. GST stays optional (null = not typed; Ex GST then null). `invoiceCount`, `invoiceCents`, `invoiceGstCents`, `notInMyobCount`, `kind`, `live` and `changed` are gone.
- **Every month is listed:** the year view lists all twelve months of the financial year; months up to the current one are blank until entered (`entered false`), future months are `future true`. Months before Jun 2023 stay blank and out of the sums.
- **Sums** (quarters and year): `{salesCents, gstCents, exGstCents, enteredCount, lodgedCount}`, over the entered months only. All amounts null when none is entered; `gstCents` null while any entered month has no GST.
- **Writing:** `PUT /api/bas/months/:period/sales` (was `/hand`; `invoices.edit`) with `{salesCents, gstCents, note}`. `salesCents` null clears the month (and its GST and note). `0` is a real entry (a month with no sales); negative is allowed (net refunds). Same GST rules as before (same sign, at most a tenth of the amount before GST). Sentences say "sales" instead of "hand amount". Audit action `bas.sales` (was `bas.hand`), before and after `{salesCents, gstCents, note}`.
- **Lodging** is unchanged except: a month with nothing entered can't be lodged (409 "Enter this month's sales before lodging it"). A lodged month's figure is locked and nothing else feeds it, so "changed since lodged", the live-beside-frozen figures and the invoice lists are gone; the detail is `{month, prev, next}`. `lodged_json` still stores `{figures}` as a record. Reopen is unchanged.
- **CSV:** the per-invoice `GET /months/:period/invoices.csv` is removed. Replaced by `GET /api/bas/sales.csv?fy=` (`accounts.view`): the financial year's months up to the current one, columns `Month, Sales inc GST, GST, Ex GST, Note` (blank where not entered), file name `BAS sales FY 2027.csv`.
- **Comparison:** a month with nothing entered is null (not 0), so the chart skips it.
- **Page:** the year table drops the Invoices and Not in MYOB columns and shows "Not entered" for a blank month; a month's detail is the three figures, Lodge/Reopen and the "This month's sales" form (no invoice list); a "Download CSV" button sits in the page header.
- **Cutover:** the "hand amount for payments received before the load" workaround is gone: type each month's figure in full (`docs/cutover.md`, `docs/how-to-bas.md`).
- Decision 1 (cash basis from invoices), Decision 4 as worded, and §12 points 4, 11 and 13 no longer apply. Marking invoices paid on the Accounts page is untouched; BAS just doesn't read it.
- Smoke: `ci/smoke-m9-bas.sh` rewritten to this (invoices don't count, blank months listed, typed figures and sums, lodging, comparison, CSV).

## 13. Admin accounts (added 2026-10-16, Todd)

Accounts that are not regular suppliers (BAS, Workcover policies, insurance payments) get their own page, **Admin accounts**, in the Accounts menu right after Supplier accounts. It works exactly as Supplier accounts does (§7, §9): the same monthly lines (statement state, total, reconciled, paid, entered in MYOB, note, one attached file), the same archive and restore rules, the same print and blank form. Todd chose a separate page rather than a flag on the supplier list.

- **Migration `028_admin_accounts.sql`** (additive): `suppliers.kind TEXT NOT NULL DEFAULT 'supplier' CHECK (kind IN ('supplier','admin'))` and an index on it. Every existing row stays a supplier. Admin accounts share the `suppliers` and `supplier_statements` tables (and the `files` link), so there is one set of rules. `suppliers.name` stays UNIQUE across both kinds: a supplier and an admin account can't share a name (409).
- **`lib/suppliers.js`** builds its functions per kind (`make(kind)`). The default export is the supplier kind, exactly as before; `suppliers.admin` is the admin kind. Every read and write filters by `kind`, so an id of the other kind is a 404 on every route. Audit names differ: `admin_account.create`/`.update` (entity `admin_account`) and `admin_account_statement.update`/`.file` (entity `admin_account_statement`, id `<id>:<period>`).
- **API `/api/admin-accounts`**: the same routes as §7.2, built by `lib/statement-routes.js` (shared with `routes/suppliers.js`). Read with `accounts.view`, write with `invoices.edit`. The JSON shapes are identical to the supplier ones (the list is `{suppliers: [...]}` and a line's account is `line.supplier`), so the page code is shared.
- **Page `/adminaccounts.html`** (gate `accounts.view`, same as `/suppliers.html`): `public/adminaccounts.html` with `<body data-kind="admin">`, using `suppliers.css` and `suppliers.js`; the script reads `data-kind` to choose the API base, the page path and the wording. Menu: "Admin accounts" in Accounts after "Supplier accounts".
- **What stays suppliers-only**: the Friday round-up's "statements still waiting" line (`suppliers.waitingCount` counts suppliers only), and the free-text supplier names on Orders, Stock and Paint, which never read this table. Admin accounts are never offered as order suppliers. Statement files download with `accounts.view`, as before.
- **Tests**: `ci/smoke-m14-adminaccounts.sh` (create, month listing, line save and stale 409, archive and restore, file attach/replace/remove, the two kinds kept apart in both directions, audit names). `ci/smoke-m9-suppliers.sh` is unchanged and must still pass.
