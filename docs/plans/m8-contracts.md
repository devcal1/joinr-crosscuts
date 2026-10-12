# M8 interface contracts: Pay runs (binding for all M8 subagents)

Read `docs/plans/m8-plan.md` first. Its **Decisions** (1–12) and **Lead's defaults** are binding and win over its section 2. This file is the *what*. Everything in `m1-contracts.md` … `m7-contracts.md` and `backup-contracts.md` still holds (UTC ISO timestamps with milliseconds, Sydney `YYYY-MM-DD` business dates, `defineRoutes`, audit, `lib/httperror.js`, errors `{error}`). If a contract looks wrong, report it instead of working around it. Points the integrator decided while writing this file are listed in §11; Todd can change any of them.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3` (the `node:sqlite` shim locally), Node 24, no build step, no framework.

**This repo is public.** No names, rates or hours from the workbook or from real staff go into code, tests, docs or screenshots. Smoke and screenshot data use made-up names (`M8 Test Worker`, etc.).

**Version.** 0.1.10 is pushed and on the device. M8 ships as **0.1.11**: the scaffold bumps `crosscuts/app/package.json` and the root version in `crosscuts/app/package-lock.json`. No further bump during the build.

**Keys:** none new (23 stays). `accounts.view` sees everything in this file; `invoices.edit` writes; `users.admin` alone may reopen a finalised pay run.

**Not touched in M8:** the board files (`schedule.*`, `workers.html`, `exportJpg()`, `alignPanels()`), `public/shared.js`, and every write path of `lib/schedule.js`, `lib/availability.js` and `lib/invoices.js`. Pay runs only **read** `workers`, `week_rows`, `assignments`, `jobs` and `leave`, with their own queries.

## 1. Files and owners

| File | What it is | Owner |
|---|---|---|
| `db/migrations/019_payruns.sql` | five tables, the holiday seed (§2), complete | scaffold |
| `public/paymaths.js` | the pure maths and parsing shared by server and pages (§3), complete | scaffold |
| `lib/settings.js` | four `DEFAULTS` keys (§4) | scaffold |
| `lib/pages.js` | three page entries (§7) | scaffold |
| `lib/payroll.js` | everything with the database: people, pay runs, timesheets, suggestions, summary, holidays, settings (§5) | stub in scaffold (binding signatures, throws 501), then A |
| `routes/payruns.js` | `defineRoutes('/api/payruns')`: every route of §6 declared with its access; handlers 501 in the scaffold | scaffold, then A |
| `server.js` | mounts `routes/payruns.js` | scaffold |
| `public/shell/shell.js` | Accounts menu gains "Pay runs"; two `PAGE_ALIASES` (§7) | scaffold |
| `ci/smoke.sh` | the M8 source loop (§9.1) | scaffold |
| `tools/screenshots/shoot.js` | four entries (§9.3) | scaffold |
| `docs/auth.md` | one line: pay runs use the Accounts keys; reopen is `users.admin` | scaffold |
| `crosscuts/app/package.json`, `crosscuts/app/package-lock.json` | 0.1.11 | scaffold |
| `ci/smoke-m8-payruns.sh` | §9.2 | A |
| `public/payruns.html`, `payruns.css`, `payruns.js` | the pay-runs page (§8.1), class prefix `py-` | B |
| `public/payrun.html`, `payrun.css`, `payrun.js` | one pay run: entry screen and summary (§8.2), prefix `pr-` | C |
| `public/payprint.html`, `payprint.css`, `payprint.js` | printable timesheets, overtime log, summary (§8.3), prefix `pp-` | D |
| `docs/how-to-pay-run.md` | a short guide for Accounts | integrator, 4.1 |

**Boundaries.**
- All hour maths (daily split, totals, display, parsing) lives in `public/paymaths.js` only. `lib/payroll.js` requires it (`require("../public/paymaths")`); the pages load it with `<script src="/paymaths.js">`. No other file splits hours into normal, OT and DT.
- `lib/payroll.js` takes `db` first in every function (as `lib/tasks.js` does) and never requires `../db`. `routes/payruns.js` passes it in.
- Every write runs in one `db.transaction` with its audit row.

## 2. Migration `019_payruns.sql` (scaffold, M8 · 2.2)

```sql
-- M8 Pay runs (docs/plans/m8-contracts.md section 2). Additive only: five new tables and a
-- seed of Victorian public holidays. No existing row changes.

-- Who can have a timesheet. A board worker gets a row the first time a pay-run write needs one
-- (no backfill: a worker with no row counts as on the pay run). Pay-only people (office staff)
-- always have a row and a name of their own.
CREATE TABLE pay_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER UNIQUE REFERENCES workers(id),
  name TEXT,                                            -- pay-only people only; NULL for workers
  on_pay_run INTEGER NOT NULL DEFAULT 1 CHECK (on_pay_run IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),  -- pay-only people only
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((worker_id IS NULL) <> (name IS NULL))
);

CREATE TABLE pay_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date TEXT NOT NULL UNIQUE,                      -- a Monday on the fortnight grid
  end_date TEXT NOT NULL,                               -- start_date + 11 (the second Friday)
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','finalised')),
  rules_json TEXT,                                      -- frozen at finalise (§3 rules object)
  summary_json TEXT,                                    -- frozen at finalise (§6.4 summary)
  finalised_at TEXT,
  finalised_by INTEGER REFERENCES users(id),
  myob_entered_date TEXT,                               -- Sydney date; finalised runs only
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One employee's sheet in one pay run.
CREATE TABLE pay_timesheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pay_run_id INTEGER NOT NULL REFERENCES pay_runs(id),
  person_id INTEGER NOT NULL REFERENCES pay_people(id),
  name TEXT NOT NULL,                                   -- set at add, refreshed at finalise
  notes TEXT NOT NULL DEFAULT '',
  signed INTEGER NOT NULL DEFAULT 0 CHECK (signed IN (0,1)),
  entered INTEGER NOT NULL DEFAULT 0 CHECK (entered IN (0,1)),   -- "typed in" tick
  saved_at TEXT,                                        -- NULL until the first save
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (pay_run_id, person_id)
);
CREATE INDEX idx_pay_timesheets_run ON pay_timesheets(pay_run_id);

-- One row of the paper form. Only days with something typed are stored. All hours are
-- integer minutes; start and finish are minutes after midnight.
CREATE TABLE pay_days (
  timesheet_id INTEGER NOT NULL REFERENCES pay_timesheets(id),
  date TEXT NOT NULL,                                   -- one of the run's ten weekdays
  start_min INTEGER,
  finish_min INTEGER,
  lunch_min INTEGER,
  phol_min INTEGER,
  sick_min INTEGER,
  arl_min INTEGER,
  onsite_min INTEGER,
  job TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (timesheet_id, date)
);

CREATE TABLE public_holidays (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Victorian public holidays on weekdays from the pay-run anchor (5 Oct 2026) to the end of 2027
-- (Decision 6). Weekend days are left out: they never touch a timesheet. Local days (Bendigo Cup)
-- and the Friday before the 2027 AFL Grand Final (not yet declared) are added by hand.
INSERT INTO public_holidays (date, name) VALUES
  ('2026-11-03', 'Melbourne Cup'),
  ('2026-12-25', 'Christmas Day'),
  ('2026-12-28', 'Boxing Day (substitute)'),
  ('2027-01-01', 'New Year''s Day'),
  ('2027-01-26', 'Australia Day'),
  ('2027-03-08', 'Labour Day'),
  ('2027-03-26', 'Good Friday'),
  ('2027-03-29', 'Easter Monday'),
  ('2027-06-14', 'King''s Birthday'),
  ('2027-11-02', 'Melbourne Cup'),
  ('2027-12-27', 'Christmas Day (substitute)'),
  ('2027-12-28', 'Boxing Day (substitute)');
```

ANZAC Day 2027 falls on a Sunday and Victoria gives no substitute day, so it is not listed. The scaffold checks the list against Business Victoria's published dates before committing and reports any difference instead of changing it silently.

## 3. `public/paymaths.js` (scaffold, complete)

A plain script that works in both places: `module.exports = PayMaths` under Node, `window.PayMaths` in the browser. No dependencies, no DOM, no dates from the clock (callers pass them in).

**The rules object:** `{anchor: 'YYYY-MM-DD', ordinaryMonThuMin: 480, ordinaryFriMin: 360, otBandMin: 120}`.

```js
const DAY_KEYS;                       // ['mon','tue','wed','thu','fri']
const DAY_LABELS;                     // {mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri'}

// Calendar (pure UTC arithmetic on YYYY-MM-DD strings).
function addDays(date, n);            // 'YYYY-MM-DD'
function onGrid(date, anchor);        // true when date is anchor + 14k days, k >= 0
function fortnightStartFor(date, anchor);  // the grid Monday whose fortnight holds date (a weekend
                                      // belongs to the fortnight before it); anchor if date < anchor
function fortnightDates(start);       // the ten weekday dates: start+0..4, start+7..11
function endOf(start);                // start + 11
function dayKeyOf(date);              // 'mon'..'fri', or null for a weekend
function fortnightLabel(start);       // '5–16 Oct 2026', '26 Oct – 6 Nov 2026', '28 Dec 2026 – 8 Jan 2027'
function shortDate(date);             // '5 Oct'

// The daily split (Decision 4 and the lead's defaults).
function ordinaryFor(dayKey, rules);  // fri → ordinaryFriMin, else ordinaryMonThuMin
// day: {startMin, finishMin, lunchMin, ...}. worked = finish - start - (lunch || 0), or 0 when start
// or finish is null. normal = min(worked, ordinary); ot = min(worked - normal, otBandMin);
// dt = worked - normal - ot. Leave and holiday hours never change the split (§11 point 1).
function split(day, dayKey, rules);   // {workedMin, normalMin, otMin, dtMin}
// Sums over days, each day already carrying split() fields and the typed leave fields.
function totals(days);                // {workedMin, normalMin, otMin, dtMin, pholMin, sickMin, arlMin, onsiteMin}

// Display.
function hours(min);                  // null/undefined → ''; else (min/60) to two places: 450 → '7.50', 0 → '0.00'
function clock(min);                  // null → ''; 450 → '07:30'; 1440 → '24:00'

// Parsing what Accounts types (returns minutes, null for blank, or NaN when unreadable).
function parseClock(text);            // '7:30', '07:30', '7.30', '730', '0730', '7' → 450 / 420 for '7';
                                      // hours 0–24, minutes 0–59, '24:00' the only 24
function parseHours(text);            // '7.5' → 450, '7.25' → 435, '7:30' → 450, '8' → 480; at most 24 h
function parseLunch(text);            // a bare whole number is minutes: '30' → 30; 'h:mm': '0:45' → 45,
                                      // '1:00' → 60; anything else NaN

// Validation of one day (the server's 400 sentences, §6.3; the page shows the same words).
// Returns null when the day is fine, else the sentence without the date prefix.
function dayProblem(day);
```

`dayProblem` checks, in this order, and returns the first that applies:
1. start without finish or finish without start → `"Give both a start and a finish"`;
2. `finishMin <= startMin` → `"Finish must be after start"`;
3. lunch with no start and finish → `"Lunch needs a start and a finish"`;
4. `lunchMin > finishMin - startMin` → `"Lunch is longer than the day"`;
5. `worked + phol + sick + arl > 1440` → `"More than 24 hours in one day"`;
6. `onsiteMin > workedMin` → `"On-site hours are more than the hours worked"`.

Range checks (integers, `0 ≤ startMin < finishMin ≤ 1440`, leave fields 0–1440) are the server's (§6.3); the page's parsers never produce values outside them.

**Unit table** (the scaffold proves it with a node check, kept out of the repo): with the default rules, Mon 07:00–17:00 lunch 30 → worked 570, normal 480, ot 90, dt 0; Tue 06:00–18:30 lunch 30 → 720 / 480 / 120 / 120; Fri 07:00–15:00 lunch 30 → 450 / 360 / 90 / 0; Fri 06:00–17:00 lunch 30 → 630 / 360 / 120 / 150; Wed 07:00–11:00 no lunch, arl 240 → 240 / 240 / 0 / 0; no times, phol 480 → 0 / 0 / 0 / 0. `onGrid('2035-01-01', '2026-10-05')` true; `fortnightStartFor('2026-10-18', anchor)` → `'2026-10-05'` (a Sunday); `fortnightStartFor('2026-10-19', anchor)` → `'2026-10-19'`; `fortnightLabel('2026-12-28')` → `'28 Dec 2026 – 8 Jan 2027'`. The parsers: each example above, plus `''` → null and `'abc'`, `'25:00'`, `'7:60'`, `'-1'` → NaN.

## 4. Settings (`lib/settings.js`, scaffold)

Four `DEFAULTS` keys, written through `settings.set` (audited as `settings.update`):

| Key | Default | Meaning |
|---|---|---|
| `pay.anchor` | `'2026-10-05'` | the first fortnight's Monday (Decision 7) |
| `pay.ordinary_mon_thu_min` | `'480'` | ordinary minutes Monday to Thursday |
| `pay.ordinary_fri_min` | `'360'` | ordinary minutes on Friday |
| `pay.ot_band_min` | `'120'` | minutes paid as OT before DT starts |

Settings apply to open pay runs as they are read. A finalised run keeps its frozen `rules_json` and `summary_json` (lead's defaults). They are not exposed by `/api/settings` (that page is `users.admin`); they have their own route (§6.6).

## 5. `lib/payroll.js` (stub in scaffold, then A)

Signatures binding; internals A's. Errors are `HttpError` (`lib/httperror.js`).

```js
function rules(db);                                    // the §3 rules object, from settings
function currentStart(db, today = sydneyToday());     // fortnightStartFor(today, anchor)

// People
function listPeople(db, {all = false} = {});           // [person], workers (not archived) first by
                                                       // sort_order then name, then pay-only by name;
                                                       // all = include archived pay-only people
function setWorkerOnPayRun(db, req, workerId, on);     // person (upserts the worker's row)
function addPayOnly(db, req, {name});                  // person
function updatePerson(db, req, id, body);              // person ({name?, onPayRun?, archived?})

// Pay runs
function listRuns(db);                                 // [run row], newest first
function getRun(db, id);                               // run object or null
function createRun(db, req, {startDate});              // run object (timesheets for everyone on the pay run)
function deleteRun(db, req, id);                       // open and every sheet unsaved only
function finalise(db, req, id);                        // run object
function reopen(db, req, id);                          // run object
function setMyob(db, req, id, entered);                // run object

// Timesheets
function addTimesheet(db, req, runId, {personId, workerId});   // timesheet
function removeTimesheet(db, req, runId, tsId);
function getTimesheet(db, runId, tsId);                // timesheet or null
function saveTimesheet(db, req, runId, tsId, body);    // timesheet
function suggestionsFor(db, run, person);              // {date: suggestion} for the ten dates

// Summary
function summary(db, runId);                           // §6.4 (frozen copy when finalised)

// Holidays and settings
function listHolidays(db, {from, to});
function addHoliday(db, req, {date, name});
function removeHoliday(db, req, date);
function getSettings(db);                              // §6.6
function putSettings(db, req, body);                   // §6.6
```

**Who is on the pay run** (used by `createRun` and `listPeople`): every worker with `archived = 0` whose `pay_people` row is missing or has `on_pay_run = 1`, plus every pay-only person with `on_pay_run = 1` and `archived = 0`. `createRun` inserts the missing worker rows (with `on_pay_run = 1`) in its transaction, then one `pay_timesheets` row per person with `name` = the worker's or person's current name. Switching someone on or off changes runs created afterwards; an open run is changed with add or remove (§6.3).

**Suggestions** (Decision 5; the server works them out, so Accounts needs no `scheduling.view`). For each of the ten dates, for a worker's sheet:
- **job:** the jobs the worker is assigned to that day (`assignments` on `week_rows` with `week_start = mondayOf(date)` and that `day`), each as `"<job name> (<quote number>)"` or just the name when there is no quote number, in panel then `sort_order` order, distinct, joined with `" / "`; `''` when none.
- **holiday:** a `public_holidays` row on that date → `pholMin` = that weekday's ordinary minutes, `reason: 'holiday'`, `holidayName`.
- **leave** (only when there is no holiday; not removed): kind `leave` → `arlMin` = ordinary, `reason: 'leave'`; `sick` → `sickMin` = ordinary, `reason: 'sick'`; `other` → no hours, `reason: 'other'`.
- A pay-only person gets the holidays only.

The suggestion object: `{job, pholMin, sickMin, arlMin, reason: 'holiday'|'leave'|'sick'|'other'|null, holidayName: string|null}` (hour fields null when not suggested). Suggestions are never stored.

## 6. API (`routes/payruns.js`, `defineRoutes('/api/payruns')`)

Literal paths (`/people`, `/holidays`, `/settings`) are registered before `/:id`. Validation → 400, not found → 404, rule break → 409. Ids are positive integers (else 404). Bodies that aren't objects are treated as `{}`.

### 6.1 Routes

| Method & path | Access | Body / query → response |
|---|---|---|
| `GET /` | `accounts.view` | → `{payRuns: [run row], current: fortnight, next: fortnight, rules}`. `fortnight` = `{startDate, endDate, label, payRunId: id|null}`; `current` from `currentStart`, `next` = current + 14. |
| `POST /` | `invoices.edit` | `{startDate?}` (default the current fortnight) → 201 run object. 400 `"That date doesn't start a pay fortnight"` unless `onGrid(startDate, anchor)`; 409 `"A pay run for that fortnight already exists"`. Audit `payrun.create`. |
| `GET /people` | `accounts.view` | `?all=1` → `{people: [person]}` |
| `POST /people` | `invoices.edit` | `{name}` (1–100 after trim) → 201 person (pay-only, on the pay run). Audit `payperson.create`. |
| `PUT /people/worker/:workerId` | `invoices.edit` | `{onPayRun: bool}` → person. 404 for an unknown or archived worker. Audit `payperson.update`. |
| `PATCH /people/:id` | `invoices.edit` | `{name?, onPayRun?, archived?}` → person. `name` or `archived` on a worker's row → 400 `"Board workers are changed on the Workers page"`. Audit `payperson.update` (changed fields). |
| `GET /holidays` | `accounts.view` | `?from&to` (default today − 31 days to today + 400 days; at most 800 days apart) → `{holidays: [{date, name, weekday}]}` by date. `weekday` = `'Mon'`…`'Sun'`. |
| `POST /holidays` | `invoices.edit` | `{date, name}` (valid date; name 1–80) → 201 holiday. 409 `"That date is already a public holiday"`. Audit `holiday.create`. |
| `DELETE /holidays/:date` | `invoices.edit` | → 204; 404 if none. Audit `holiday.remove` (before `{date, name}`). |
| `GET /settings` | `accounts.view` | → §6.6 |
| `PUT /settings` | `invoices.edit` | §6.6 |
| `GET /:id` | `accounts.view` | → run object |
| `DELETE /:id` | `invoices.edit` | → 204. 409 `"Only an open pay run with no sheets typed in can be deleted"` unless open and every sheet has `saved_at` null. Removes its timesheets. Audit `payrun.delete`. |
| `POST /:id/finalise` | `invoices.edit` | → run object. 409 `"This pay run is already finalised"`. Freezes `rules_json`, `summary_json` and each sheet's `name`; sets `finalised_at`, `finalised_by`. Audit `payrun.finalise` (after: the summary totals). |
| `POST /:id/reopen` | `users.admin` | → run object. 409 `"This pay run is open"` when open; 409 `"Untick Entered in MYOB first"` when ticked. Clears the frozen fields; status `open`. Audit `payrun.reopen`. |
| `POST /:id/myob` | `invoices.edit` | `{entered: bool}` → run object. 409 `"Finalise the pay run first"` when open. Sets `myob_entered_date` to today or null. Audit `payrun.myob`. |
| `GET /:id/summary` | `accounts.view` | → §6.4 |
| `POST /:id/timesheets` | `invoices.edit` | `{personId}` or `{workerId}` → 201 timesheet. Open runs only (409 `"This pay run is finalised"`); 409 `"That person already has a sheet in this pay run"`; 404 for an unknown person or worker. `workerId` upserts the person row. Audit `timesheet.add`. |
| `GET /:id/timesheets/:tsId` | `accounts.view` | → timesheet (404 when the sheet isn't in that run) |
| `PUT /:id/timesheets/:tsId` | `invoices.edit` | §6.3 → timesheet |
| `DELETE /:id/timesheets/:tsId` | `invoices.edit` | → 204. Open runs only (409 as above); 409 `"Clear the sheet before removing it"` when it has any `pay_days` row or notes. Audit `timesheet.remove`. |

### 6.2 Shapes

- **person:** `{id: id|null, workerId: id|null, name, kind: 'worker'|'pay_only', onPayRun: bool, archived: bool}`. A worker with no row yet has `id: null, onPayRun: true`.
- **run row:** `{id, startDate, endDate, label, status, myobEnteredDate, timesheetCount, enteredCount, finalisedAt}`.
- **run object:** `{id, startDate, endDate, label, status: 'open'|'finalised', finalisedAt, finalisedBy: {id, name}|null, myobEnteredDate, createdAt, updatedAt, timesheets: [sheet row]}`; `sheet row` = `{id, person, name, entered, signed, saved: bool, totals}`, by name.
- **timesheet:** `{id, payRunId, runStatus, person, name, notes, signed, entered, saved: bool, updatedAt, days, totals, suggestions}`.
  - `days`: always ten, in date order: `{date, day: 'mon'…, startMin, finishMin, lunchMin, pholMin, sickMin, arlMin, onsiteMin, job, workedMin, normalMin, otMin, dtMin}` (typed fields null when blank, `job` `''`; the split from `PayMaths.split` with the run's rules: frozen when finalised, live when open).
  - `totals`: `PayMaths.totals(days)`.
  - `suggestions`: `{date: suggestion}` (§5) while the run is open; `{}` when finalised.

### 6.3 Saving a sheet (`PUT /:id/timesheets/:tsId`)

Body: `{days: [{date, startMin, finishMin, lunchMin, pholMin, sickMin, arlMin, onsiteMin, job}], notes, signed, entered, updatedAt}`.
- `updatedAt` must equal the sheet's: else 409 `{error: "Someone else saved this sheet; reload it", timesheet}`.
- 409 `"This pay run is finalised"` when finalised.
- `days` replaces every stored row: a date not sent is cleared; a day sent with every field null and `job` `''` stores nothing.
- Each day: `date` one of the run's ten (else 400 `"<date> isn't in this pay run"`; a repeated date → 400); hour fields null or integers, `0 ≤ startMin < finishMin ≤ 1440` and each other field `0–1440` (else 400 `"<Mon 5 Oct>: hours out of range"`); then `PayMaths.dayProblem` → 400 `"<Mon 5 Oct>: <sentence>"`; `job` a string of at most 200 after trim.
- `notes` at most 2,000; `signed`, `entered` booleans.
- On success: sets `saved_at` (first time) and `updated_at`; audit `timesheet.update`, entity `timesheet`, before and after holding only the days that changed (by date) and any changed `notes`, `signed`, `entered`.
- Nothing is written when any check fails.

### 6.4 Summary (`GET /:id/summary`)

`{payRun: run row, rules, frozen: bool, rows: [{timesheetId, name, normalMin, otMin, dtMin, pholMin, arlMin, sickMin, onsiteMin, workedMin, notes, signed, entered}], totals: {normalMin, otMin, dtMin, pholMin, arlMin, sickMin, onsiteMin, workedMin}}`, rows by name. When finalised this is `summary_json` as stored (with `frozen: true`); while open it is worked out live. The MYOB lines (Decision 11 and the lead's defaults) are Normal Time (`normalMin`), Over Time, Double Time, Public Holiday (`pholMin`), Annual Leave (`arlMin`), Personal Leave (`sickMin`), then On Site hours and the notes.

### 6.5 Audit (actor `req.user`)

`payrun.create`, `payrun.delete`, `payrun.finalise`, `payrun.reopen`, `payrun.myob` (entity `pay_run`); `timesheet.add`, `timesheet.update`, `timesheet.remove` (entity `timesheet`); `payperson.create`, `payperson.update` (entity `pay_person`); `holiday.create`, `holiday.remove` (entity `holiday`, entity id the date); `settings.update` through `settings.set`.

### 6.6 Settings shape

`GET` → `{anchor, ordinaryMonThuMin, ordinaryFriMin, otBandMin, anchorLocked: bool}` (`anchorLocked` once any pay run exists). `PUT` takes any subset → the same shape. `ordinaryMonThuMin`, `ordinaryFriMin` and `otBandMin`: integers 0–720 (400 otherwise). `anchor`: a valid Monday (400 `"The fortnight must start on a Monday"`); a change while locked → 409 `"The fortnight start can't change once a pay run exists"`.

## 7. Pages, menu and access (scaffold)

- `lib/pages.js`: `"/payruns.html": "accounts.view"`, `"/payrun.html": "accounts.view"`, `"/payprint.html": "accounts.view"`.
- `public/shell/shell.js`: the Accounts menu becomes Accounts, **Pay runs** (`/payruns.html`, `accounts.view`), Reports. `PAGE_ALIASES` gains `"/payrun.html": "/payruns.html"` and `"/payprint.html": "/payruns.html"`. The bar itself doesn't change (the item is inside the dropdown), so no re-measure is needed beyond a glance at 1260 and 1440.

## 8. The pages (Wave 1)

All three pass `node ci/style-check.js`, follow the house style (`tokens.css`, `components.css` `hs-`, the shell's `cc-dialog*`, `shared.js` `api()` / `toast()` / `guarded()`), put user text in via `textContent`, and read `cc.can('invoices.edit')` (and `cc.can('users.admin')` for Reopen): without it every write control is hidden and the page is read-only. Hours show as `PayMaths.hours` (two decimals), times as `PayMaths.clock`. No horizontal page scroll at 375 px (wide tables scroll inside their own box).

### 8.1 `/payruns.html` (B, prefix `py-`)

1. **This fortnight and next:** a card each with the label, the status ("Not started", "Open: 3 of 7 typed in", "Finalised", "Entered in MYOB"), and buttons: **Open** (when it exists), **Start pay run** (`invoices.edit`, when it doesn't), **Print timesheets** (`/payprint.html?start=<date>&what=sheets`), **Print overtime log** (`…&what=overtime`).
2. **Pay runs:** a table, newest first: Fortnight (link to `/payrun.html?id=`), Status badge (open orange, finalised neutral, entered in MYOB teal), Sheets typed in (`n of m`).
3. **Who's on the pay run:** every person from `GET /people` with an "On the pay run" checkbox; pay-only people marked "Pay only" with Rename and Remove (archive); **Add person** dialog (name). A note under it: board workers are added and renamed on the Workers page.
4. **Public holidays:** the next 12 months (a "Show past" toggle loads the last year), date, weekday, name, Remove; **Add holiday** dialog (date, name).
5. **Pay rules:** Ordinary hours Mon–Thu, Ordinary hours Fri, Overtime hours before double time (all typed as hours, `PayMaths.parseHours`, sent as minutes), and the fortnight start date (disabled when `anchorLocked`, with the reason). **Save**. A line under it: "Changes apply to open pay runs; finalised ones keep their numbers."

### 8.2 `/payrun.html?id=N[&sheet=M]` (C, prefix `pr-`)

- **Header:** "Pay run" and the label; the status badge; buttons **Finalise** (open; a `confirm` naming any sheets not ticked as typed in), **Entered in MYOB** tick (finalised), **Reopen** (`users.admin`, finalised), **Delete** (open, nothing typed), **Print summary** (`/payprint.html?id=N&what=summary`), **Print timesheets** (`/payprint.html?start=<startDate>&what=sheets`), **Back** to `/payruns.html`.
- **Two tabs:** Timesheets and Summary (`#summary` in the URL opens the second).
- **Timesheets tab:** on the left, the sheets (name, a "typed in" tick mark as text, the total hours); **Add sheet** (a person not yet in the run) and **Remove** (empty sheets) for `invoices.edit` while open. On the right, the entry screen for the selected sheet (`&sheet=` keeps it across reloads):
  - **mirrors the paper row for row:** Employee, From, To at the top; ten rows in two week groups with a hairline between; columns **Date, Day, Start, Finish, Lunch, P HOL, SICK, ARL, ON SITE, JOB, Total, OT, DT**; a **TOTALS** row; **Notes**; **Signed** and **Typed in** ticks; then the summary block as on the paper (Normal Time, Over Time, Double Time, Public Holiday, Annual Leave, Personal Leave, On Site).
  - Date and Day are printed, not editable. Total, OT and DT are worked out live with `PayMaths.split` as Accounts types; the TOTALS row and summary block follow.
  - **Typing:** Start and Finish take `PayMaths.parseClock` forms, Lunch `parseLunch`, the hour columns `parseHours`. On blur a field is shown in its tidy form (`07:30`, `7.50`). An unreadable entry, or a day `dayProblem` objects to, outlines the cells in orange (`--orange`) with the sentence beside the row, and Save is refused until fixed. Tab moves across, Enter moves down the same column.
  - **Suggestions (Decision 5):** a sheet never saved (`saved: false`) opens with the suggestions filled in (job, P HOL, SICK, ARL), shown in the muted text colour until edited, with a key line "Grey values are suggestions from the board, leave and public holidays; check them against the paper." A saved sheet shows what was saved; a **Fill suggestions** button fills only the blank cells. `reason: 'other'` shows "Away" in the row's hint, with no hours.
  - **Save** and **Save and next** (the next sheet by name); Ctrl+S saves. Unsaved changes ask before switching sheet or leaving the page. A 409 for a stale sheet shows its sentence and a **Reload sheet** button.
  - Finalised or view-only: the same grid, read-only text.
- **Summary tab:** the §6.4 table (Name, Normal Time, Over Time, Double Time, Public Holiday, Annual Leave, Personal Leave, On Site, Notes) with totals, and the rules it was worked out with ("Ordinary 8.00 h Mon–Thu, 6.00 h Fri; first 2.00 h overtime, then double time"). "Not finalised: numbers can still change" while open.

### 8.3 `/payprint.html` (D, prefix `pp-`)

On screen: the house-style frame with **Print** and **Back** buttons (Back to `/payruns.html`, or `/payrun.html?id=` for a summary). `document.title` is set for the PDF name ("Timesheets 5–16 Oct 2026", "Overtime log 5–16 Oct 2026", "Pay run summary 5–16 Oct 2026"). Print CSS: A4, black on white, between the `style-check: print-start` / `print-end` comments, `page-break-after` between pages.

- **`?start=YYYY-MM-DD&what=sheets[&person=<personId>]`:** one portrait page per person, the blank paper form (Decision 1 and 5: nothing but name and dates filled): "Fortnightly timesheet", Employee (name), From and To (the fortnight's dates), the ten rows with only Date (`5 Oct`) and Day (`Mon`) printed, the empty columns as §8.2 (ON SITE, not OFF SITE), a TOTALS row, a Notes box, a Signature and date line, and the blank summary block. People: the run's sheets when a pay run exists for that start (`GET /` then `GET /:id`), else everyone on the pay run from `GET /people`. `start` off the grid shows "That date doesn't start a pay fortnight".
- **`?start=…&what=overtime`:** one portrait page: "Overtime log", the fortnight, and a ruled table Date, Name, Hours, Job with 20 blank rows (Decision 9).
- **`?id=N&what=summary`:** landscape A4: the §6.4 table with totals, the rules line, the finalised date and by whom, and "DRAFT: not finalised" across the top while open.

## 9. Tests and checks

### 9.1 `ci/smoke.sh` (scaffold)

After the M7 loop and before the Backup suite:

```bash
# M8 suites (ci/smoke-m8-*.sh, docs/plans/m8-contracts.md section 9): same rules.
for f in "$(dirname "$0")"/smoke-m8-*.sh; do [ -f "$f" ] && source "$f"; done
```

Step k (cutover rehearsal) must still pass: the old app's database is migrated through 019 there.

### 9.2 `ci/smoke-m8-payruns.sh` (A), `step "m8-payruns. pay runs, timesheets and the summary"`

M-suite rules (sourced, no shebang, no `set`, the shared helpers and jars, prefix `M8_`, no pristine-DB assumption). All pay runs are in **2035** (`2035-01-01` and `2035-01-15` are on the grid); made-up names only. It restores every setting it changes.
- **Access:** `GET /api/payruns` acct 200, admin 200, sched / dpm / show / wshop 403; `POST /` sched 403; `/payruns.html`, `/payrun.html`, `/payprint.html` acct 200, sched 403.
- **Defaults:** `GET /settings` → anchor `2026-10-05`, 480 / 360 / 120.
- **People:** admin makes a worker `M8 Test Worker` and a second `M8 Off Worker` (`POST /api/workers`); acct `PUT /people/worker/<off>` `{onPayRun:false}`; `POST /people` `{name:"M8 Office Person"}` → 201 pay-only; renaming a worker's row → 400.
- **Create:** `startDate 2035-01-02` → 400; `2035-01-01` → 201 with `endDate 2035-01-12`, a sheet for the test worker and the office person and none for the off worker; again → 409.
- **Suggestions:** a 2035-01-01 board row for a job with quote number `M8Q1` with the test worker on Monday; leave (`leave`) on 2035-01-03; a holiday added for 2035-01-04 → the sheet's `saved: false`, `suggestions['2035-01-01'].job` contains `M8Q1`, `['2035-01-03'].arlMin == 480`, `['2035-01-04'].pholMin == 480` with `reason 'holiday'`; the office person's sheet has no job suggestions.
- **Maths:** save the §3 unit-table days (Mon 2035-01-01, Tue 01-02, Fri 01-05, Fri 01-12, Wed 01-10 with ARL, Thu 01-04 with P HOL) → each day's split as the table, totals exact; the summary row matches.
- **Validation** (each 400, and a following GET shows nothing changed): start without finish, finish before start, lunch longer than the day, more than 24 hours, on-site more than worked, a date outside the run, a repeated date, `startMin: 1500`.
- **Concurrency:** a PUT with an old `updatedAt` → 409 with `.timesheet`.
- **Live rules:** `PUT /settings {ordinaryFriMin: 300}` → the open run's Friday splits change; put it back.
- **Finalise:** acct finalises → summary `frozen: true`; then `ordinaryFriMin: 300` again → the summary is unchanged (put it back); PUT on a sheet → 409; add sheet → 409; acct reopen → 403; MYOB tick → 200; admin reopen → 409 `Untick…`; untick; admin reopen → 200 and `status: "open"`.
- **Delete:** create `2035-01-15` → delete → 204; delete the 2035-01-01 run (typed sheets) → 409.
- **Holidays:** the seeded `2027-01-26` is listed (`?from=2027-01-01&to=2027-12-31`); adding 2035-01-04 again → 409; remove it → 204; again → 404.
- **Anchor:** `PUT /settings {anchor:"2026-10-12"}` → 409 (runs exist); `"2026-10-06"` → 400.
- **Audit:** admin `GET /api/audit?entityType=pay_run&entityId=<id>` has `payrun.create`, `payrun.finalise`, `payrun.reopen`, `payrun.myob`; `entityType=timesheet` has `timesheet.update`.

### 9.3 Screenshots (`tools/screenshots/shoot.js`, scaffold)

`["payruns", "/payruns.html", 1440, true]`, `["payrun", "/payrun.html?id=1", 1440, true]`, `["payrun-1100", "/payrun.html?id=1", 1100, true]`, `["phone-payruns", "/payruns.html", 375, true]`. The integrator adds made-up pay-run data to `tools/screenshots/seed.js` at 4.1.

### 9.4 Local checks (every task)

Docker isn't on the dev box (and no jq), so smoke files get `bash -n` only; CI is their real run. Every task: `node --check` on its JS, `node ci/style-check.js`, a shim boot on a fresh `.dev/<task>/` (`REMINDER_DISABLED=1 ROUNDUP_DISABLED=1 BACKUP_SCHEDULE_DISABLED=1 PLANNER_REMINDER_DISABLED=1`) and `fetch` calls against its routes. In addition:
- **Scaffold:** 019 on a fresh `.dev/m8/` and on a copy of the latest local test database; the §3 unit table as a node check; every route answers 501 for acct, 403 for sched, 401 logged out; the three pages 200 / 403; the menu entry shows for acct and not for sched.
- **A:** a node replay of every §9.2 assertion against the shim (the smoke file can't run locally).
- **B, C, D:** headless-Edge screenshots at 1440, 1100 and 375 with stubbed responses (an empty first fortnight, a busy run with seven sheets, a finalised run, view-only), keyboard reach of every control and dialog. C also: typing a whole sheet by keyboard only, the unsaved-changes guard, a stale-sheet 409. D also: Edge print-to-PDF of all three prints (A4, black on white, one sheet per page, nothing cut off), kept under `.dev/`.

## 10. Waves and file ownership

| Step | Who | Owns (only these files) | Starts after |
|---|---|---|---|
| **M8 · 2.2 Scaffold** | integrator | `db/migrations/019_payruns.sql`, `public/paymaths.js`, `lib/settings.js` (four keys), `lib/pages.js`, `lib/payroll.js` (stub), `routes/payruns.js` (declared, 501), `server.js`, `public/shell/shell.js` (§7), `ci/smoke.sh` (§9.1), `tools/screenshots/shoot.js`, `docs/auth.md`, `package.json` and `package-lock.json` (0.1.11) | — |
| **M8 · 3.1 Wave 1, A: backend** | worktree | `lib/payroll.js`, `routes/payruns.js`, `ci/smoke-m8-payruns.sh` | scaffold |
| **M8 · 3.1 Wave 1, B: pay-runs page** | worktree | `public/payruns.{html,css,js}` | scaffold (stubbed responses) |
| **M8 · 3.1 Wave 1, C: pay-run page** | worktree | `public/payrun.{html,css,js}` | scaffold (stubbed responses) |
| **M8 · 3.1 Wave 1, D: prints** | worktree | `public/payprint.{html,css,js}` | scaffold (stubbed responses) |
| **M8 · 4.1 Integrate** | integrator | merges; `tools/screenshots/seed.js` (made-up pay-run data); `docs/how-to-pay-run.md`; STATUS; real-data checks of B, C and D on the merged backend | all |

One wave: the pages code against §6 with stubbed responses, then 4.1 runs them against A's backend. `public/paymaths.js` is the scaffold's; a task that needs a change to it reports it. Worktree base: each agent resets to the commit the integrator names, and junctions `crosscuts/app/node_modules` from the main checkout.

## 11. Points the integrator decided (Todd can change any)

1. **Leave on a part-worked day doesn't lower the overtime threshold.** Four hours of ARL plus six worked on a Monday is 6.00 Normal and 4.00 Annual Leave, no OT: OT starts only after 8 hours actually worked (6 on a Friday). If Todd wants leave to count towards the day, it's one change in `PayMaths.split`.
2. **Work on a public holiday** is split by the normal daily rule and shown under Normal/OT/DT; the P HOL hours sit beside it. If MYOB needs public-holiday work as its own category, that's a later change.
3. **Weekend work** has no rows (as on the paper). Accounts writes it in Notes, which print on the summary.
4. **Melbourne Cup** is seeded as on the statewide list; if the Bendigo area takes a different day, Accounts swaps it on the pay-runs page.
5. **Finalise doesn't require every sheet to be ticked as typed in**; it asks first, naming the unticked ones.
6. **Reopen is refused while "Entered in MYOB" is ticked**, so a pay run already keyed into MYOB can't change silently.
7. **A pay run can be deleted** only while open and before any sheet is saved (a fortnight started by mistake).
8. **Leave of kind "other"** gives no hours, only an "Away" hint.
9. **Display:** each day shows to two decimals; totals are summed in minutes and only then shown, so they never drift from rounding.
