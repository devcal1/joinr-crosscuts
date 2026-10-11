# M5 interface contracts (binding for all M5 subagents)

Read `docs/plans/m5-plan.md` for the why (its §11 decisions are binding); this file is the *what*. Everything in `m1-contracts.md` … `m4-contracts.md` still holds (timestamps, Sydney dates, `defineRoutes`, audit, `lib/httperror.js`, errors `{error}`). If a contract looks wrong, report it instead of working around it.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3` (the `node:sqlite` shim locally), no build step. Days are `mon`…`fri` only.

**The board (CLAUDE.md rule 7, with Todd's M5 exception of 2026-10-11).** Only these board changes are allowed, each mirrored in `exportJpg()` and print (black on white): (1) a materials mark and a short stage label on each row's **existing** icon line; (2) an "away" chip style and an over-days outline; (3) a "Stage reached" select in the Finish week dialog; (4) a leave/over-days warning in the "+" picker; (5) a 5-minute data reload when nothing is open. Rows, columns, sizes, the grid, `.nav`, `--nav-h` and `alignPanels()` sharing stay exactly as they are. **No version bump** during the build (the next push is 0.1.6). **No new feature keys** (21 stays); `leave.edit` goes live.

## 1. Migration (scaffold, M5 · 2.2): `013_scheduling.sql`

```sql
-- M5 Scheduling extras (docs/plans/m5-contracts.md section 1). Additive only: two new
-- tables and two nullable workers columns. No existing row changes; no backfill.
CREATE TABLE production_stages (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  week_start TEXT NOT NULL,                           -- Monday of the finished week, Sydney YYYY-MM-DD
  stage TEXT NOT NULL CHECK (stage IN ('cut_edge','kit','assemble','inspect','paint','install','return_visit')),
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (job_id, week_start)
);

CREATE TABLE leave (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  date_from TEXT NOT NULL,                            -- Sydney YYYY-MM-DD, inclusive
  date_to TEXT NOT NULL,                              -- Sydney YYYY-MM-DD, inclusive, >= date_from
  kind TEXT NOT NULL CHECK (kind IN ('leave','sick','other')),
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_leave_worker ON leave(worker_id, date_from, date_to);
CREATE INDEX idx_leave_dates ON leave(date_from, date_to);

ALTER TABLE workers ADD COLUMN days_per_week INTEGER CHECK (days_per_week IS NULL OR days_per_week BETWEEN 1 AND 4);
ALTER TABLE workers ADD COLUMN regular_days_off TEXT;   -- comma-separated day keys, e.g. 'fri' or 'mon,fri'; NULL = none
```

## 2. Shared library signatures

### `lib/production.js` (scaffold, new, complete)

```js
const STAGES;      // ['cut_edge','kit','assemble','inspect','paint','install','return_visit'] (in order)
const LABELS;      // {cut_edge:'Cut & edge', kit:'Kit', assemble:'Assemble', inspect:'Inspect',
                   //  paint:'Paint', install:'Install', return_visit:'Return visit'}
const SHORT;       // {cut_edge:'CUT', kit:'KIT', assemble:'ASM', inspect:'INSP', paint:'PAINT',
                   //  install:'INST', return_visit:'RV'}
// The stages that apply to a job ({is_two_pac, benchtop} row): is_two_pac 1 → all but
// return_visit, plus return_visit when benchtop = 'stone'; is_two_pac 0 → without paint and
// return_visit; is_two_pac NULL → all seven. Always in STAGES order.
function stagesFor(job);
// Map jobId -> latest stage key (by week_start), for the given job ids. One query.
function currentStages(db, jobIds);
// Upsert one row for (jobId, weekStart). Validates stage against stagesFor(job) (throws
// HttpError 400 "That stage doesn't apply to this job"). Audits 'job.production_stage'
// (entity job; before {stage, weekStart} or null, after {stage, weekStart}) when it changes.
// Synchronous; for use inside the caller's transaction.
function record(db, req, jobId, weekStart, stage);
```

### `lib/availability.js` (scaffold: the reads complete; Wave 1 B adds the writes)

```js
// For the Monday weekStart: Map workerId -> {mon..fri: 'leave'|'sick'|'other'|'off'|null}
// for workers with at least one away day. Leave (not removed) beats a regular day off.
// One leave query per call. Complete in the scaffold.
function awayForWeek(db, weekStart);
// Map workerId -> days_per_week for workers that have one. Complete in the scaffold.
function daysPerWeek(db);
// Set of worker ids assigned on more distinct days in that week (both panels) than their
// days_per_week. Complete in the scaffold.
function overDaysForWeek(db, weekStart);

// Wave 1 B (signatures binding):
function listWorkers(db);                       // [{id, name, archived, daysPerWeek, regularDaysOff:[...]}]
function listLeave(db, {from, to, workerId});   // [leave object], not removed, overlapping [from, to]
function addLeave(db, req, body);               // leave object
function removeLeave(db, req, id);
function setPattern(db, req, workerId, body);   // worker object as listWorkers
```

**Leave object:** `{id, worker:{id, name}, from, to, kind, note, createdBy:{id,name}, createdAt, days}` (`days` = weekdays covered).

### `lib/schedule.js` (scaffold edit; additive)

- `rowToWorker` gains `daysPerWeek` (number or null) and `regularDaysOff` (array of day keys).
- Each **row** gains `materials` (`'in'` when `jobs.materials_in_date` is set; else `'ordered'` when `materials_ordered_date` is set; else `null`), `productionStage` (latest key or `null`), and `stageOptions` (`stagesFor(job)`).
- Each **chip** gains `away` (`'leave'|'sick'|'other'|'off'|null` for that worker on that day) and `overDays` (boolean: the worker is over their days that week).
- Each **week** gains `away` (`{"<workerId>": {mon..fri: kind|null}}`, only workers with an away day) and `overDays` (array of worker ids).
- Computed with one extra query per week (leave), one per panel (job fields, joined into `selectPanelRows`), and one for current stages; the single-row path (`buildScheduleRow` without pre-fetched groups) computes the same fields for that row.
- Every existing field and order stays (the cutover rehearsal compares them).

### `routes/scheduling.js` (Wave 1 C adds lookahead; the existing Upcoming route is unchanged)

## 3. API surface

### Finish week (`routes/schedule.js`, Wave 1 A)

- `POST /api/rows/finish-week` results accept an optional `stage` per item (`null`/absent = not recorded). Validated **before** the transaction with the others: an unknown key → 400 `stage must be one of …`; a stage not in `stagesFor(job)` → 400. Inside the existing transaction, for every result with a stage (any outcome, including `complete`), `production.record(db, req, jobId, sourceWeek, stage)`. Absent stage writes nothing (an earlier record stays). The response gains `stages: [{jobId, stage}]` (those recorded). `created`, `skipped`, `completed` are unchanged, so an identical repeat still creates nothing.

### Availability (`routes/availability.js`, `defineRoutes('/api/availability')`, Wave 1 B)

- `GET /api/availability` — `scheduling.view` → `{workers: listWorkers, leave: listLeave(from = today − 30 days, to = today + 180 days)}`; optional `?from&to&workerId`.
- `POST /api/availability/leave` `{workerId, from, to, kind, note?}` — `leave.edit` → 201 leave. Valid dates, `from <= to`, at most 366 days, worker exists (archived allowed), kind one of three, note ≤ 500.
- `DELETE /api/availability/leave/:id` — `leave.edit` → 204 (soft; 404 if missing or already removed).
- `PATCH /api/availability/workers/:id` `{daysPerWeek?, regularDaysOff?}` — `leave.edit` → worker. `daysPerWeek` null or 1–4; `regularDaysOff` an array of distinct day keys (max 4) or empty.
- Audit: `leave.create`, `leave.remove` (entity `leave`), `worker.pattern` (entity `worker`, changed fields).

### Lookahead (`routes/scheduling.js`, Wave 1 C)

- `GET /api/scheduling/lookahead?weeks=N` — `scheduling.view`; N default 4, 1–6 (400 otherwise) → `{weeks: [buildWeek(sydneyMonday + 7k)], toStart: [{backlogId, jobId, name, promisedInstallDate, materials, productionStage}]}`. `toStart` = the backlog ordered by `promised_install_date` (nulls last), then the backlog's own `sort_order`, `id`. The board's `/api/schedule` backlog order is unchanged.

## 4. Pages and front end

All pages pass `node ci/style-check.js`; house style; user text via `textContent`. Prefixes: `av-` availability, `la-` lookahead. **Never `ph-` outside the board files.**

- **`lib/pages.js`** (scaffold): `/availability.html` and `/lookahead.html`, both `scheduling.view`.
- **`/scheduling.html`** (scaffold): the "Leave and availability" and "Lookahead" tiles become live links (no "Planned" badge).
- **`/availability.html`** (Wave 1 B, `public/availability.{html,css,js}`): workers table (name, pattern: "Full time" / "3 days a week" / "Day off: Fri", Edit pattern for `leave.edit`), upcoming leave grouped by worker or by date (from, to, days, kind, note, Remove for `leave.edit`), Add leave dialog (worker, from, to, kind, note). Read-only without `leave.edit`.
- **`/lookahead.html`** (Wave 1 C, `public/lookahead.{html,css,js}`): four week blocks, each with the two panels as compact read-only tables (job name linking to `/job.html?id=N` when `jobs.view`, the five days with worker names (away workers marked), a materials mark as text ("In", "Ordered"), the stage label), then "To start" by promised date (name, promised date, materials, stage). Weeks with no rows say so.
- **The board, Wave 1 A** (`public/schedule.js`, `public/schedule.css` only):
  - **Row indicators** on the existing icon line after the delete button: the materials mark (`ph-package`, teal for `in`, orange for `ordered`, absent for null; `title` text "Materials in" / "Materials ordered, not in") and the stage label (`SHORT[stage]`, 10–11 px uppercase, muted; `title` = full label). Must not add a line or widen anything: measure at 1920 and 1440 that row heights are unchanged with and without indicators.
  - **JPG twin** in `exportJpg()`: a small filled square (teal/orange, from tokens via the `C` map) and the short label beside the notes dot; shrink the job-name `maxWidth` accordingly.
  - **Print twin:** text markers after the name (`● materials in`, `● materials ordered`, and the stage label), black on white, in the print block, as `● note` does.
  - **Finish week:** a "Stage reached" `select` on each job line (options: "Not recorded" + `stageOptions` labels; default the row's `productionStage` if it is in the options, else "Not recorded"); optional (Done's rule unchanged); sends `stage` (key or null). Lines grouped by name keep one stage per jobId.
- **The board, Wave 2 D** (`public/schedule.js`, `public/schedule.css`, `public/workers.html` only if needed for the legend):
  - **Away chips:** chips with `away` get a grey style from tokens (`--na` ground, `--muted` text; inline colours replaced, class `away`), with `title` "On leave" / "Sick" / "Away" / "Day off"; `overDays` chips get an orange outline (`--orange`). Same in the legend if relevant.
  - **JPG twin:** away chips drawn with the grey fill and muted text; over-days with an orange stroke. **Print twin:** `(away)` / `(over days)` text after the name, black on white.
  - **Picker:** workers away that day listed last with their kind; workers who would go over their days marked "Over days"; choosing one asks `confirm()` first ("Sam is on leave that day. Assign anyway?").
  - **Idle reload:** every 5 minutes, `refresh()` only if no popover, dialog, note editor or drag is open and no input is focused; otherwise skip that tick.

## 5. Tests

`ci/smoke.sh` (scaffold) gains after the M4 loop: `for f in "$(dirname "$0")"/smoke-m5-*.sh; do [ -f "$f" ] && source "$f"; done`. Same rules as M3/M4 (shared helpers and jars, `step "m5-…"`, no `set`, no pristine-DB assumption, far-future weeks such as 2035 for board data).

- **`smoke-m5-stages.sh`** (A): a two-pac stone job, a non-two-pac laminate job and a job with unknown spec on 2035 rows; Finish week with stages (`paint` on the non-two-pac → 400 and nothing written, incl. no next-week rows; an unknown key → 400); valid stages recorded per week (`/api/schedule` row `productionStage` for that job in a later week; `stageOptions` correct for the three jobs); a repeat with a different stage overwrites and `created` is empty; absent stage keeps the old one; the audit has `job.production_stage`; `materials` is `in`/`ordered`/`null` as set through the M3 routes.
- **`smoke-m5-availability.sh`** (B): access (show, acct → 403 on GET; dpm GET 200, POST 403; sched POST 201); leave over a 2035 week → that week's chips for the worker have `away: "leave"`, `week.away` has the worker; a regular day off `fri` → `off` on Fridays; `daysPerWeek: 3` and assignments on 4 days → `overDays` true and the worker in `week.overDays`; removing the leave clears `away`; bad dates / `from > to` / 367 days / unknown worker → 400.
- **`smoke-m5-lookahead.sh`** (C): access (show 403, sched 200); `weeks` 0/7/x → 400; four weeks returned starting at the Sydney Monday; `toStart` ordered by promised date with nulls last (three backlog jobs with 2035 dates set through `PATCH /api/job-records/:id`); `/api/schedule` backlog order unchanged.
- Existing Finish week and cutover assertions must keep passing unchanged.

**Local checks** (every task): node --check, bash -n, style check, a shim boot on a fresh `.dev/<task>/`, `curl`/`fetch` against its routes, headless-Edge screenshots. A and D additionally: the board at 1920×1080 and 1440, the JPG export saved and compared with the screen, a print preview (`emulateMedia print` or Edge print-to-PDF), and row heights measured with and without indicators/away chips.

## 6. Waves and file ownership

| Step | Who | Owns (only these files) |
|---|---|---|
| **M5 · 2.2 Scaffold** | integrator | `db/migrations/013_scheduling.sql`, `lib/production.js`, `lib/availability.js` (reads complete, writes stubbed), `lib/schedule.js`, `routes/availability.js` (empty guarded router), `server.js`, `lib/pages.js`, `public/scheduling.html` (two tiles), `ci/smoke.sh` (source line), `tools/screenshots/shoot.js` (entries), `docs/auth.md` |
| **M5 · 3.1 Wave 1, A: stages and row indicators** | worktree | `routes/schedule.js` (Finish week only), `public/schedule.js`, `public/schedule.css`, `ci/smoke-m5-stages.sh` |
| **M5 · 3.1 Wave 1, B: availability** | worktree | `lib/availability.js` (the writes), `routes/availability.js`, `public/availability.{html,css,js}`, `ci/smoke-m5-availability.sh` |
| **M5 · 3.1 Wave 1, C: lookahead** | worktree | `routes/scheduling.js` (the lookahead route), `public/lookahead.{html,css,js}`, `ci/smoke-m5-lookahead.sh` |
| **M5 · 3.2 Wave 2, D: away chips, picker, idle reload** | worktree | `public/schedule.js`, `public/schedule.css` (after A is merged) |
| **M5 · 4.1 Integrate** | integrator | merges; seed data; STATUS |

Only A (Wave 1) and then D (Wave 2) edit the board files. `lib/schedule.js`, `lib/production.js` and the read half of `lib/availability.js` are the scaffold's; a wave that needs a change reports it. Worktree base: each agent resets to the commit the integrator names, and junctions `crosscuts/app/node_modules` from the main checkout.

## 7. Changes after the M5 · 4.2 review (integrator, 2026-10-11)

1. **Idle reload vs the Monday rollover:** `idleReloadTick` returns early when the local date has changed since the last render, leaving the 60-second rollover tick to re-anchor the week. (Before, an idle refresh just after midnight on Monday marked the new day as rendered and the TV stayed on last week.)
2. **Refreshes are serialised** (`refresh()` chains `refreshNow()`), so an older response can't render after a newer one.
3. **The panels' "Add job…" text survives a rebuild**, as the To start box's already did.
4. **`production.record` returns true when it wrote**; Finish week's `stages` lists only stages written (new or changed), as §3 says. `smoke-m5-stages.sh` asserts it on the repeat.
