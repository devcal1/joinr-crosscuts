# M3 interface contracts (binding for all M3 subagents)

Read `docs/plans/m3-plan.md` for the why (its §10 decisions are binding); this file is the *what*. Everything in `m1-contracts.md` and `m2-contracts.md` still holds (timestamps, dates, `defineRoutes`, audit, errors `{error}`, the notification shape, the board files that must not be edited). Do not change anything here without the integrator's say-so. If a contract looks wrong, report it instead of working around it. Points the integrator must settle before the waves start are in §11.

App root: `crosscuts/app/`. CommonJS, Express 4, `better-sqlite3` (the `node:sqlite` shim locally), no build step, no framework. Money is integer cents (GST-inclusive). Business dates are Sydney `YYYY-MM-DD` (`lib/time.js` `sydneyToday()`), times of day are Sydney `HH:MM`, timestamps are UTC ISO. Removal is soft (a status), except where noted.

**No version bump in M3** (release deferred by Todd, 2026-10-10). **No new feature keys:** the CI count of 21 stays. **Not touched:** `schedule.html`, `schedule.css`, `schedule.js`, `workers.html`, `exportJpg()`, `public/shared.js`. All stage and "To start" rules live in `lib/jobstage.js` and the routes.

## 1. Migrations (scaffold, M3 · 2.2)

### `010_design_pm.sql`

```sql
-- M3 Design/PM (docs/plans/m3-contracts.md section 1). Additive only: two new tables,
-- one nullable jobs column, one index. photos.job_id already exists (003_jobs.js).
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  supplier TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'to_order'
    CHECK (status IN ('to_order','ordered','received','cancelled')),
  ordered_date TEXT,                                    -- Sydney YYYY-MM-DD
  expected_date TEXT,                                   -- Sydney YYYY-MM-DD
  received_date TEXT,                                   -- Sydney YYYY-MM-DD
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_orders_job ON orders(job_id, status);
CREATE INDEX idx_orders_status ON orders(status, expected_date);

CREATE TABLE inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  date TEXT NOT NULL,                                   -- Sydney YYYY-MM-DD
  time TEXT,                                            -- Sydney HH:MM (24 h); null = time not set
  host TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'booked'
    CHECK (status IN ('booked','done','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_inspections_job ON inspections(job_id);
CREATE INDEX idx_inspections_date ON inspections(status, date);

CREATE INDEX idx_photos_job ON photos(job_id);

ALTER TABLE jobs ADD COLUMN materials_in_date TEXT;     -- Sydney date; set when every live line is received
```

`photos.job_id INTEGER REFERENCES jobs(id)` was already added by `003_jobs.js:48` in M1 and has never been written, so 010 adds only its index (see §11.1). No existing row changes. No card-position column (plan Q2).

### `011_tidy_photo_tags.js` (Todd's signed-off data change, plan §3 / Q4)

The runner (`db/migrate.js:118-129`) wraps `up(db)` in a transaction, records the file's sha256 (line endings normalised), and has already written the `VACUUM INTO` backup before the first pending migration. A `.js` migration exports `up(db)`.

The tidy rule is **inlined in this file**, not required from `lib/tags.js`. A migration's checksum covers only its own file: if 011 required app code, a later edit to that code would silently change what 011 does to the live data at cutover without tripping the checksum. `lib/tags.js` (§2) implements the same rule for the routes; the two must agree, and the smoke and local checks in §8 test both.

Exact behaviour:

```js
// 011_tidy_photo_tags: one-off tidy of photos.tags (Todd, 2026-10-11; m3-plan §3, Q4).
// Rewrites photos.tags only. Split on commas, trim, lowercase, drop empties, drop
// duplicates (first occurrence kept, order otherwise unchanged), join with ", ".
// Rows already tidy are not written. No row is deleted; no other column changes.
// The rule is inlined on purpose (see m3-contracts.md section 1): never require app code here.
function tidy(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of String(tags == null ? "" : tags).split(",")) {
    const t = raw.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join(", ");
}

function up(db) {
  const rows = db.prepare("SELECT id, tags FROM photos ORDER BY id").all();
  const update = db.prepare("UPDATE photos SET tags = ? WHERE id = ?");
  let changed = 0;
  for (const row of rows) {
    const next = tidy(row.tags);
    if (next !== row.tags) {
      update.run(next, row.id);
      changed++;
    }
  }
  console.log(`[migrate] 011 tag tidy: ${changed} of ${rows.length} photo(s) rewritten`);
}

module.exports = { up };
```

- `trim()` and `toLowerCase()` are the plain JS ones (not locale-aware). Whitespace inside a tag (`white oak`) is kept as typed.
- The log line is part of the contract: the rehearsal (§8) greps it.

| Stored before | After 011 |
|---|---|
| `Kitchen, kitchen ,White Oak,, OAK` | `kitchen, white oak, oak` |
| `Oak` | `oak` |
| `A,a,B` | `a, b` |
| ` , ,` | `` (empty) |
| `already, tidy` | unchanged, not written |
| `` (empty) | unchanged, not written |

## 2. Shared library signatures

All are synchronous, take the better-sqlite3 handle `db` first, and are safe inside a caller's `db.transaction` (a nested `db.transaction` is a savepoint). "Throws" means throws an `HttpError` from `lib/httperror.js`; any other exception is a server error (500).

### `lib/httperror.js` (scaffold, new, complete)
- `class HttpError extends Error { constructor(status, message, extra) }`: `extra` is an optional plain object merged into the response body.
- `bad(msg)` → 400, `forbidden()` → 403 `"Forbidden"`, `notFound()` → 404 `"Not found"`, `conflict(msg, extra)` → 409.
- `sendError(res, e, label)`: if `e.status` is a number from 400 to 499, `res.status(e.status).json({error: e.message, ...e.extra})`; otherwise `console.error(label, e)` and 500 `{error:'Server error'}`. It duck-types on `status`, so it also maps the existing `invoices.HttpError` and the local class in `routes/jobs.js`.
- `can(req, key)`: true when `req.user.perms` (Set or array) has `key`; false with no user.

### `lib/tags.js` (scaffold, new, complete; C uses it)
- `splitTags(input)`: `input` is a comma-separated string or an array of strings (array items are themselves split on commas). It returns the tidy array: trimmed, lowercased, empties dropped, de-duplicated with the first occurrence kept. `null`/`undefined` → `[]`.
- `normaliseTags(input)` → `splitTags(input).join(', ')`. **Must give the same result as `tidy()` in 011** for every string.
- `countTags(rows)`: `rows` = `[{tags}]` → `[{tag, count}]`, counting each tag once per photo, sorted by count descending, then tag ascending.
- C must not change the rule. A change needs a matching new migration, so report it instead.

### `lib/notify.js` (scaffold edit)
- `toKey(db, featureKey, payload, opts = {})` gains `opts.exceptUserId` (a user id, or null/undefined). That user is skipped even if they hold the key. It returns the number of users notified. M2 callers pass no fourth argument and keep their behaviour exactly (trap 10).
- `toUser` and `usersWithKey` are unchanged. `toUser` doesn't get `exceptUserId`, because a single-recipient caller simply doesn't call it.
- New kinds (free text, as M2): `materials.in`, `inspection.booked`, `inspection.moved`, `inspection.cancelled`. Links are site-relative: `/job.html?id=<jobId>#orders` and `/job.html?id=<jobId>#inspection`.

### `lib/jobstage.js` (scaffold writes in full; Wave 1 A owns it afterwards)
New exports. The existing ones (`setStage`, `onScheduled`, `onSentToBacklog`, `onFinishedComplete`, `onDesignReadyToCut`, `createBoardJob`) keep their behaviour; the board routes keep calling them.
- `STAGES` (the ten, in order), `MANUAL_STAGES` = `lead quoted won design_ordering ready_to_cut lost archived`, `DERIVED_STAGES` = `on_board complete invoiced`.
- `STAGE_DATE` = `{quoted:'quoted_date', won:'won_date', ready_to_cut:'ready_to_cut_date'}`.
- `allowedTargets(fromStage)`: the pipeline rules, pure. It returns the manual stages a job may be moved to from `fromStage` (never `fromStage` itself):
  - `on_board` → `[]` (trap 2);
  - `complete`, `invoiced` → `['archived']` (trap 1);
  - any other stage, or `null` → every manual stage except `fromStage`.
  The pipeline page and the job page mirror this table (§6).
- `addToBacklog(db, jobId)`: `INSERT OR IGNORE INTO backlog (job_id, sort_order)` at the end (`MAX(sort_order)+1`), unless the job has current or future week rows (`hasCurrentOrFutureRows`). Returns true if a row was added. **It throws on error** (no `safely`).
- `removeFromBacklog(db, jobId)`: `DELETE FROM backlog WHERE job_id = ?`, unless the job has current or future week rows. Returns true if a row was removed. Throws on error. A backlog row is a pointer, not data (as `DELETE /api/jobs/backlog/:id` today), so this is not a hard delete of anything a human would regret.
- **`moveStage(db, jobId, {stage, from}, req, {override = false} = {})`**: the one path for hand moves (trap 5). It returns `{changed, from, to, toStart}`, where `toStart` is `'added'`, `'removed'` or `null`. Checks, in this order:
  1. `stage` not in `STAGES` → 400 `"stage must be one of …"`. `stage` not manual → 400 `"stage '<s>' is set automatically and cannot be changed by hand"` (smoke: a drop on `complete`, `on_board` or `invoiced` is 400 for everyone).
  2. No job → 404.
  3. `from !== undefined` and `from !== job.stage` → 409 `"Someone else has moved this job"` with `extra {stage: job.stage}`. `from: null` matches a null stage.
  4. `stage === job.stage` → `{changed:false}`: nothing is written or audited and no backlog row is added (trap 4).
  5. Source rules:
     - **Without `override`:** if `stage` isn't in `allowedTargets(job.stage)` → 409. The message is `"This job is on the board; it moves from the board"` for `on_board`, and `"Complete and invoiced jobs can only be archived"` otherwise.
     - **With `override`** (the admin's PATCH, §3): from `on_board`, only when the job has no current or future week rows (409 with the same message otherwise), so a job really on the board can never be labelled anything else (trap 2). From `complete` or `invoiced`, any manual stage.
  6. In one `db.transaction` (a savepoint when nested), which throws on any failure so the caller's whole request rolls back:
     - **Key date:** if `STAGE_DATE[stage]` exists and that column is null or empty, set it to `sydneyToday()`. Existing dates are never overwritten, and nothing is cleared (see §11.6 on direction).
     - **Archived link (Q5):** `stage === 'archived'` sets `archived = 1`; leaving `archived` sets `archived = 0`. A column is written only if its value changes.
     - Update `stage`, `stage_changed_at`, `updated_at` and the columns above in one `UPDATE`.
     - **To start:** entering `ready_to_cut` calls `addToBacklog`; leaving `ready_to_cut` (for any stage) calls `removeFromBacklog` (trap 3, Q3).
     - **Audit:** one `job.stage` row. `before` is `{stage}` plus the old value of every other column changed. `after` is `{stage}` plus the new values, plus `toStart:'added'|'removed'` when the backlog changed.
  - `moveStage` never calls `safely()`, the invoice hooks, `setStage` or `onDesignReadyToCut`. Manual targets fire no invoice event.
- `onDesignReadyToCut` stays exported, unchanged and (after A's edits) unused by the routes. The board's own hooks still use `safely()`, because a board edit must never fail on stage bookkeeping. That is M1/M2 behaviour and unchanged.

### `lib/orders.js` (scaffold: `markMaterialsOrdered` complete, the rest as stubs throwing `HttpError(501, 'Not built')`; Wave 1 B fills in)
- `STATUSES` = `to_order ordered received cancelled`.
- **`markMaterialsOrdered(db, jobId, req, date = sydneyToday())`** → `true` | `false`. It was moved out of `routes/jobs.js:316-341`, and both the Materials ordered button and the orders path call it.
  - No job → 404. Invalid `date` → 400.
  - In one `db.transaction`: if `materials_ordered_date` is already set, return `false` and do nothing. Otherwise set it and `updated_at`, audit `job.update` (before `{materials_ordered_date:null}`, after `{materials_ordered_date:date}`, as M2), call `invoices.onMaterialsOrdered(db, jobId, date, req)`, and return `true`.
  - The job date is the "done once" flag. `invoices.onMaterialsOrdered` is unchanged: it never throws, and it creates at most one live progress invoice (the unique index). That hook's failure is logged and swallowed, as in M2 (§11.7).
- `present(row, today)` → the **order object**: `{id, jobId, supplier, description, status, orderedDate, expectedDate, receivedDate, notes, createdAt, updatedAt, createdBy, createdByName, overdue}`. `overdue` = status `to_order` or `ordered`, with `expectedDate < today`.
- `jobState(db, jobId)` → `{id, materialsOrderedDate, materialsInDate}`.
- `listForJob(db, jobId, {includeCancelled})` → `[order]`, by `id`.
- `list(db, {status, supplier, jobId})` → `[order + {jobName, jobStage}]`.
  - `status`: `open` (the default: `to_order` + `ordered`), a single status, or `all`. `supplier` is case-insensitive exact. Lines of jobs with `archived = 1` are left out unless `jobId` is given.
  - Order: `expected_date` ascending with nulls last, then job name, then `id`.
- `suppliers(db, q)` → up to 50 distinct supplier names (distinct by `lower(trim())`, the most recent spelling), most-used first. `q` filters by case-insensitive prefix.
- `createLine(db, jobId, {supplier, description, expectedDate, notes}, req)` → `{order, job: jobState}`.
  - Status is always `to_order`. `supplier` is required, non-empty after trim, up to 200 characters. `description` up to 500. `expectedDate` is a valid date or null.
  - Sets `created_by`. Audits `order.create`. Then calls `refreshMaterialsIn`, which clears `materials_in_date` because the new line isn't received.
- `updateLine(db, orderId, patch, req)` → `{order, job}`.
  - `patch` keys: `supplier`, `description`, `expectedDate`, `notes`, `status`, `orderedDate`, `receivedDate`. Unknown keys are ignored. `status:'cancelled'` → 400 `"Use cancel"`.
  - A cancelled line → 409 `"Cancelled lines can't be changed"`.
  - The permission checks are made **here**, from `req.user.perms`, so no caller can bypass Q1: text fields need `orders.edit`.
  - Status transitions (anything else → 409):

    | From → to | Needs | Dates |
    |---|---|---|
    | `to_order` → `ordered` | `orders.mark_ordered` (Q1) | `ordered_date` = `patch.orderedDate` or today |
    | `ordered` → `received` | `orders.edit` | `received_date` = `patch.receivedDate` or today |
    | `ordered` → `to_order` (undo) | `orders.mark_ordered` | `ordered_date` cleared; `materials_ordered_date` is **not** undone |
    | `received` → `ordered` (undo) | `orders.edit` | `received_date` cleared |
    | `to_order` → `received` | refused: 409 `"Mark it ordered first"` | |

    `orderedDate` alone (no status change, line `ordered` or `received`) needs `orders.mark_ordered`. `receivedDate` alone (line `received`) needs `orders.edit`.
  - Audits `order.update` for text and date fields that changed, and `order.status` (before/after status and dates) for a status change.
  - **The all-ordered rule:** after a move to `ordered`, if the job has at least one non-cancelled line and none is `to_order`, call `markMaterialsOrdered(db, jobId, req, line.ordered_date)`. It does nothing when the job date is already set, so lines added later never undo it or fire it twice.
  - Then call `refreshMaterialsIn`.
- `cancelLine(db, orderId, req)` → `{order, job}`.
  - Needs `orders.edit`. 409 if already cancelled.
  - Sets `status='cancelled'` and keeps the dates. Audits `order.cancel` (before status). Calls `refreshMaterialsIn`.
  - **Cancelling fires the all-ordered rule only for `orders.mark_ordered` holders** (§11.8): if the canceller has `orders.mark_ordered` and the job now has at least one non-cancelled line and none `to_order`, call `markMaterialsOrdered(db, jobId, req)`. A design_pm cancel never fires it (Q1); Todd then uses Materials ordered.
- `refreshMaterialsIn(db, jobId, req)` → `'set'`, `'cleared'` or `null`.
  - "All in" = the job has at least one non-cancelled line and every one is `received`.
  - All in and the date empty: set `materials_in_date` to the latest `received_date` of those lines and audit `job.update`. Then `notify.toKey(db, 'scheduling.view', {kind:'materials.in', title:'Materials in: <job name>', link:'/job.html?id=<id>#orders', entityType:'job', entityId:jobId}, {exceptUserId: req.user && req.user.id})`.
  - Not all in and the date set: clear it, audit `job.update`, no notification.
- `upcoming(db, from, to)` → `{materials, materialsIn}` (the shapes are in §4 `/api/scheduling/upcoming`).

### `lib/inspections.js` (scaffold stub; Wave 1 B)
- `STATUSES` = `booked done cancelled`. `TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/`.
- `present(row)` → the **inspection object**: `{id, jobId, jobName, date, time, host, notes, status, createdAt, updatedAt, createdBy, createdByName}`.
- `listForJob(db, jobId)` → `[inspection]` in every status, date descending.
- `create(db, jobId, {date, time, host, notes}, req)` → inspection.
  - `date` is required and valid. `time` matches `TIME_RE` or is null. `host` defaults to `req.user.displayName` when blank.
  - Status `booked`. Audits `inspection.create`.
  - Notifies `scheduling.view`, except the actor: kind `inspection.booked`, title `"Inspection booked: <job>, <d Mon> <HH:MM>"` (the time part is left out when null).
- `update(db, id, patch, req)` → inspection.
  - Keys: `date`, `time`, `host`, `notes`, `status` (`booked` or `done` only; `cancelled` → 400 `"Use cancel"`). A cancelled one → 409.
  - Audits `inspection.update` (the changed fields).
  - A date or time change while `booked` notifies `inspection.moved`, `"Inspection moved: <job>, <d Mon> <HH:MM>"`, except the actor. `done` doesn't notify.
- `cancel(db, id, req)` → inspection. 409 if already cancelled. Audits `inspection.cancel` and notifies `inspection.cancelled`, `"Inspection cancelled: <job>, <d Mon>"`, except the actor.
- `upcoming(db, from, to)` → booked inspections with `from <= date <= to`, ordered by date and then time (nulls last), excluding jobs with `archived = 1`.
- `<d Mon>` is e.g. `14 Nov`. Use `lib/time.js` arithmetic, not the server's timezone.

## 3. Hooks into existing code (who owns each edit)

- **`routes/jobs.js`, scaffold (M3 · 2.2), only this:** `POST /:id/materials-ordered` (`jobs.js:316-341`) keeps its access, body, validation order and responses. It validates the date (400), then `if (!orders.markMaterialsOrdered(db, id, req, date)) throw 409 "Materials already marked ordered"`, then returns the job object. The inline update, audit and hook call go.
- **`routes/jobs.js`, Wave 1 A, everything else:**
  - `handle()` maps any error with a numeric `status` from 400 to 499 through `sendError`, so `moveStage`'s errors (including the 409 `extra`) reach the client.
  - The local `STAGES` and `MANUAL_STAGES` (`jobs.js:13-19`) are replaced by the `jobstage` exports.
  - New route `POST /:id/stage` (§4).
  - **`PATCH /:id` with `stage` after M3** (replacing `jobs.js:297-309`). The field update runs first, then the stage, in the same transaction, so an error rolls back both. A stage sent together with `archived` wins.
    - **Manual target:** `jobstage.moveStage(db, id, {stage}, req, {override: can(req,'users.admin')})`. There is no `from` check. The source rules, key dates, archived link and To start effects all apply. A same-stage PATCH does nothing, so trap 4 is fixed on the job page too.
    - **Derived target** (`users.admin` only; anyone else still gets 400 from `parseStage`): exactly as M2. `complete` (from anything but `invoiced`) goes through `jobstage.onFinishedComplete(db, id, req, values.completed_date)`, and `on_board`, `invoiced` and `invoiced → complete` through `setStage`. In addition, if the job was in `archived` with `archived = 1`, set `archived = 0` (audited `job.update`). This is the admin's hand override, kept as today.
  - **`POST /` with a stage:** after the insert, a manual stage gets the entry effects (the key date if the body didn't send it, `archived = 1` for `archived`, and `jobstage.addToBacklog` for `ready_to_cut`), all inside the existing transaction. This replaces the `onDesignReadyToCut` call at `jobs.js:264`. Derived stages on create are admin-only, with no effects (as today).
- **`lib/invoices.js`:** not edited. `onMaterialsOrdered` and the `due_reason 'materials_ordered'` value are reused (trap 9).
- **`routes/schedule.js` and the board files:** not edited.

## 4. API surface

Errors are `{error}` (plus `stage` on a stale move). Validation → 400, forbidden → 403, not found → 404, rule break or stale → 409, hook failure inside `moveStage` → 500, with the whole request rolled back. The **job object** is M1's (`routes/jobs.js` `toJob`), which now also carries `materialsInDate` automatically.

### `/api/job-records` (`routes/jobs.js`, Wave 1 A)

| Method & path | Access | Body / query → response |
|---|---|---|
| `POST /:id/stage` | `jobs.edit` | `{stage, from}` (both required; `from` may be `null`; a missing `from` → 400 `"from is required"`) → the job object. Calls `moveStage` with no override, so these are the pipeline rules for everyone, admin included. A same-stage request → 200 with the job unchanged. A stale `from` → 409 `{error, stage}`. |
| `PATCH /:id` | `jobs.edit` | As M1/M2, with `stage` handled as in §3. |
| `GET /` | `jobs.view` | Unchanged. **The pipeline reuses it** (no new list endpoint): `?archived=0` for the board, plus `?stage=archived` when "Show lost and archived" is on. |

### Orders (`routes/orders.js`, `defineRoutes('/api')`, Wave 1 B)

Mutations return `{order, job:{id, materialsOrderedDate, materialsInDate}}`.

| Method & path | Access | Body / query → response |
|---|---|---|
| `GET /job-records/:id/orders` | `jobs.view` | `?all=0\|1` (default 0 hides cancelled) → `[order]`. Unknown job → 404. |
| `POST /job-records/:id/orders` | `orders.edit` | `{supplier, description?, expectedDate?, notes?}` → 201. |
| `GET /orders` | `jobs.view` | `?status=open\|to_order\|ordered\|received\|cancelled\|all&supplier=&jobId=` → `[order + {jobName, jobStage}]`. A bad status → 400. |
| `GET /orders/suppliers` | `jobs.view` | `?q=` → `[string]` |
| `PATCH /orders/:id` | `['orders.edit','orders.mark_ordered']` | The `updateLine` keys → mutation response. The per-change checks (§2) give 403 `"Forbidden"`; e.g. dpm marking a line ordered → 403. |
| `POST /orders/:id/cancel` | `orders.edit` | `{}` → mutation response. |

`GET /orders/suppliers` is registered before `/orders/:id` routes (there is no `GET /orders/:id`).

### Inspections (`routes/inspections.js`, `defineRoutes('/api')`, Wave 1 B)

| Method & path | Access | Body → response |
|---|---|---|
| `GET /job-records/:id/inspections` | `['jobs.view','scheduling.view']` | → `[inspection]`. Unknown job → 404. |
| `POST /job-records/:id/inspections` | `inspections.edit` | `{date, time?, host?, notes?}` → 201 inspection |
| `PATCH /inspections/:id` | `inspections.edit` | `{date?, time?, host?, notes?, status?}` → inspection |
| `POST /inspections/:id/cancel` | `inspections.edit` | `{}` → inspection |

### Scheduling (`routes/scheduling.js`, `defineRoutes('/api/scheduling')`, Wave 1 B)

| Method & path | Access | → |
|---|---|---|
| `GET /upcoming` | `scheduling.view` | `{from, to, inspections, materials, materialsIn}` (below) |

- `from` = today, `to` = today + 13 (14 days inclusive).
- `inspections`: `[{id, jobId, jobName, date, time, host}]`, from `inspections.upcoming`.
- `materials`: `[{id, jobId, jobName, supplier, description, expectedDate, overdue}]`. These are lines with status `ordered`, a non-null `expected_date <= to` (overdue ones included and flagged), on jobs with `archived = 0`, sorted by expected date.
- `materialsIn`: `[{jobId, jobName, materialsInDate}]`. Jobs whose `materials_in_date >= today - 13` and whose stage is not `complete`, `invoiced`, `lost` or `archived`, most recent first.

### Photos (`routes/photos.js`, Wave 1 C)

**The photo object** is `{id, url, thumbUrl, width, height, tags, createdAt}` as today (`photos.js:57`), plus `jobId` and `jobName` **only when the caller has `jobs.view`** (trap 7). Without `jobs.view` the keys are absent, not null. The showroom sees exactly today's shape. One `toPhoto(req, row)` function applies this rule to every response, uploads included.

| Method & path | Access | Change |
|---|---|---|
| `GET /photos` | `['photos.search','photos.admin']` | `?jobId=N` filters to one job; it needs `jobs.view` (403 otherwise; 400 if not a positive integer). The rows are joined to `jobs` for `jobName`. |
| `GET /photos/tags` | `['photos.search','photos.admin']` | **New.** → `[{tag, count}]` from `countTags` over every photo, computed on every call, so counts are never stale. |
| `POST /photos` | `photos.admin` | The multipart form gains an optional `jobId` field. A `jobId` from a user without `jobs.view` → 403; one that isn't an existing job → 400 `"No such job"`. Both are checked before any file is processed, and the files multer already wrote are removed. `tags` is saved through `normaliseTags`. Each created photo is audited `photo.upload`. The response shape is unchanged (`{created:[photo], failed}`), and the `.rotate()` and dimension-swap code is untouched (trap 12). |
| `PATCH /photos/:id` | `photos.admin` | JSON `{tags?, jobId?}`. `tags` goes through `normaliseTags` (audited `photo.tags` if changed). `jobId` is an integer or `null` to clear; it needs `jobs.view` (403), and an unknown job → 400 (audited `photo.link` if changed). → photo. |
| `DELETE /photos/:id` | `photos.admin` | Unchanged: it stays a hard delete, row first and then files (§11.9). It now audits `photo.delete` first (before `{filename, thumbFilename, tags, jobId}`). |
| `POST /suggest-tags` | `photos.admin` | Unchanged. |

## 5. Audit actions (additions)

- `order.create`, `order.update`, `order.status`, `order.cancel` (entity `order`).
- `inspection.create`, `inspection.update`, `inspection.cancel` (entity `inspection`).
- `photo.upload`, `photo.tags`, `photo.link`, `photo.delete` (entity `photo`).

Existing actions are reused for:
- the stage move (`job.stage`, with the extra columns and `toStart` in before/after);
- `materials_ordered_date` and `materials_in_date` changes (`job.update`);
- the archived untick on an admin derived override (`job.update`).

The actor is `req.user`. `/api/audit/actions` lists them automatically.

## 6. Pages and front end

All new or changed pages:
- pass `node ci/style-check.js`;
- use `tokens.css` (which imports `components.css`: `hs-btn`, `hs-card`, `hs-table`, `hs-pill`, `hs-badge`, `hs-sectionbar`, `hs-input`, `hs-callout`) and the shell's `cc-dialog`;
- have no icons, no shadows, and Arial 400/700 with letterspaced uppercase.

Page classes take a page prefix (`pl-` pipeline, `or-` orders, `sc-` scheduling, `jo-` job-page sections, `tg-` tag chips). **Never `ph-`**: the style check reads `ph-<letter>` as a Phosphor icon.

- **`lib/pages.js`** (scaffold): `'/pipeline.html': 'jobs.view'` and `'/orders.html': 'jobs.view'`.
- **Shell `LINK_GROUPS`** (scaffold, `public/shell/shell.js:13`): in "Jobs and money", after Jobs, add `{label:'Pipeline', href:'/pipeline.html', key:'jobs.view'}` and `{label:'Orders', href:'/orders.html', key:'jobs.view'}` (§11.2). No other shell change.

### `/pipeline.html` (Wave 1 A: `public/pipeline.{html,css,js}`)

Loads `tokens.css`, `pipeline.css`, `shared.js`, `pipeline.js` and the shell.

**Columns**, in order: Lead · Quoted · Won · Design / ordering · Ready to cut · On board · Complete · Invoiced · Lost · Archived (the labels as `jobs.js`).
- Each column header shows the label and the count.
- Lost and Archived are always drop zones. Their cards show only when the **Show lost and archived** toggle is on (`hs-btn` with `aria-pressed`; remembered in `localStorage` inside try/catch).
- Data: `GET /api/job-records?archived=0`, plus `?stage=archived` when the toggle is on. Jobs with `archived = 1` in another stage aren't shown.
- **Cap (§11.4):** Complete and Invoiced show only jobs whose `stageChangedAt` is within the last 60 days; the column header count is the full count, and a **Show all N** button at the column foot reveals the rest (per column, not remembered). Every other column shows everything.
- Within a column: `promisedInstallDate` ascending with blanks last, then name (Q2).

**Card** (`article.pl-card.hs-card`):
- the name and client;
- "Install 14 Nov" and "24 sheets" when set;
- the value only when `valueCents` is present (it is absent without `jobs.value`);
- an orange "attend to" mark (`border-left: 3px solid var(--orange)`, and the install text in `var(--orange-tint)`) when the promised install date is within 14 days of today, or past, and the stage is lead to ready_to_cut;
- a footer with **Open** (a link to `/job.html?id=`) and **Move to…** (`hs-btn hs-btn-quiet`).

**Drag** (pointer events only, no HTML5 drag-and-drop; only when `cc.can('jobs.edit')`):
- **Handle:** the card's header row `.pl-handle` (the job name, bold) has `touch-action:none` and `cursor:grab`. The rest of the card scrolls normally on touch.
- **Start:** `pointerdown` on the handle, then 6 px of movement starts a drag (`setPointerCapture`). A release without moving opens the job page, so the card is still clickable.
- **While dragging:**
  - A fixed-position clone `.pl-ghost` (`pointer-events:none`, `background: var(--raised)`, `outline: 2px solid var(--teal)`, no shadow) follows the pointer. The source card is dimmed (`.pl-lifted`).
  - Columns in `allowedTargets(from)` get `.pl-col-ok` (a dashed teal outline), and the one under the pointer (`document.elementFromPoint`) gets `.pl-col-over` (a solid teal outline). Others are muted.
  - The board auto-scrolls horizontally within 48 px of its edges.
  - `Escape` or `pointercancel` cancels. `user-select:none` stays on the body until the drag ends.
- **Drop:**
  - On the same column, or on a column not allowed: nothing is sent and the card goes back (trap 4).
  - On an allowed column: the card moves there optimistically and is marked `aria-busy`. The page sends `POST /api/job-records/:id/stage {stage, from}` through its own small `fetch` wrapper (`shared.js` `api()` hides the status and can't be edited). That wrapper keeps `api()`'s 401 → login redirect.
  - On 200: re-render the card from the returned job.
  - On 409: toast the server message, then `GET /api/job-records/:id` and re-render the card in its real column.
  - On any other error: toast, and the card goes back.
- **Move to…:** a small `role="menu"` list of the allowed targets only, opened under the button. It does the same request and works by keyboard (arrow keys, Enter, Escape returns focus to the button) and on small screens. For `on_board` the button is disabled with the title "Moves from the board".
- **Read-only:** without `jobs.edit` there is no handle behaviour and no Move to…; cards still open.
- **Rules mirror:** `pipeline.js` holds a copy of `allowedTargets` (§2), and the server stays authoritative.
- **Phone width:** the columns scroll horizontally (`min-width: 260px`, scroll-snap) with a 16 px gutter and no page-level horizontal scroll.

### `/job.html` and `public/job.js`

- **Wave 1 A, the stage dropdown only:**
  - Options not in `allowedTargets(job.stage)` are disabled for non-admins. A job `on_board` shows the select disabled with the title "Moves from the board". Admins see every option, as today.
  - On save of an existing job: the other changed fields go by `PATCH` (without `stage`). Then, if the stage changed:
    - a manual target allowed by `allowedTargets` → `POST /api/job-records/:id/stage {stage, from: job.stage}`;
    - otherwise, for an admin (a derived target, or a locked source) → `PATCH {stage}` (the override).
  - A stage failure shows "Saved, but the stage was not changed: <error>", reloads the job and refills the form.
  - New jobs are unchanged (`POST` with `stage`).
- **Wave 2 D, new sections** (each a `section.jo-…` with an `hs-sectionbar` heading and an id for the bell links):
  - **`#orders` Orders** (shown with `jobs.view`):
    - The lines with status badges and overdue expected dates in orange, and a **Show cancelled** toggle (`?all=1`).
    - With `orders.edit`: an add-line form (supplier with a `<datalist>` from `/api/orders/suppliers`, description, expected date, notes).
    - Per-line buttons, shown by the §2 permission table: **Mark ordered** (`orders.mark_ordered`), **Received**, **Undo**, and **Cancel** (behind a `cc-dialog` confirm).
    - The materials-ordered date with the M2 button, and a read-only **Materials in** date.
    - After every mutation, update `job` from `response.job` and reload the Invoices section (a progress invoice may now be due).
  - **`#inspection` Inspection** (shown when `job.isTwoPac === true` or the job has any inspection):
    - The list (date, time, host, notes, status).
    - With `inspections.edit`: a Book form (date required; time `type=time`; host pre-filled with `cc.me.displayName`; notes), plus Edit (a `cc-dialog`), **Done** and **Cancel**.
  - **`#photos` Photos** (shown with `photos.search` or `photos.admin`):
    - Thumbnails from `GET /api/photos?jobId=`, each a link to the full photo.
    - With `photos.admin`: an **Upload photos** form (files and tags) posting multipart to `/api/photos` with `jobId`, through a `fetch` that keeps the 401 redirect (`api()` forces a JSON content type).

### `/orders.html` (Wave 2 D: `public/orders.{html,css,js}`)

Todd's ordering list:
- Filters: status (Open, the default, To order, Ordered, Received, Cancelled, All) and supplier (from `/api/orders/suppliers`).
- An `hs-table` with Job (a link to `/job.html?id=<id>#orders`), Supplier, Description, Status, Expected (orange when `overdue`), Ordered, Notes, and actions as on the job page (the same permission table).
- Read-only without `orders.edit` or `orders.mark_ordered`.

### `/scheduling.html` (Wave 2 D: `scheduling.html`, new `scheduling.js` and `scheduling.css`; `index.css` is not edited)

- A new **Upcoming, next 14 days** section after "Available now", from `GET /api/scheduling/upcoming`, read-only, each row linking to the job:
  - Inspections: date, time, job, host.
  - Materials: expected date (orange if overdue), job, supplier, description.
  - Materials in: job and date.
- Each list has its own empty state.
- The header line "This section is not built yet…" goes. The Planned tiles stay below (§11.3).

### `/design.html` (Wave 2 D)

- The Pipeline board, Orders and Client inspections tiles move to "Available now" as live links: `/pipeline.html`, `/orders.html`, and `/scheduling.html` (text: "Book inspections on the job page; upcoming ones are listed on the Scheduling page").
- The emptied Planned section and the "not built yet" line are removed.

### `/search.html` (Wave 1 C: `public/search.{html,js,css}`; no shell, as today)

- **Tag chips:** a `div.tg-chips` (`role="group"`, `aria-label="Filter by tag"`) under the search box.
  - Built from `GET /api/photos/tags`: the top 20 by count, then an **All tags** toggle.
  - Each chip is a `button.hs-pill` with `aria-pressed`, the tag and its count. A **Clear** button shows when any chip is chosen.
  - Chosen chips narrow the photos to those whose `splitTags(tags)` contains **every** chosen tag. The fuzzy text search then ranks within that set.
- **Keyboard:**
  - Tiles become `<button type="button" class="tile">` (Tab, Enter, Space) with `aria-label` = the tags or "Job photo".
  - The caption shows on `:focus-visible` as well as `:hover`.
  - The lightbox gets `role="dialog"` and `aria-modal="true"`, focuses Close on open, keeps focus inside, closes on Escape, and returns focus to the tile.

### `/admin.html` (Wave 1 C: `public/admin.{html,js,css}`)

- **Job picker:** the upload form gains a **Job** `<select>` ("No job", then jobs from `GET /api/job-records?archived=0`).
  - "Open" = stage `lead` to `on_board`. "Recent" = `complete` or `invoiced` with `stageChangedAt` within 180 days. Lost and older jobs are left out.
  - The select is hidden without `cc.can('jobs.view')`. The bulk import is unchanged.
- **Job column:** the photo table gains a Job column (the name links to the job) with a per-row picker to change or clear the job (`PATCH {jobId}`).
- **Filters:** a job filter (All, Unlinked, or each job that has photos) and the same tag chip bar as search, filtering the table client-side.
- **Counts:** the chip counts are re-fetched from `/api/photos/tags` after every upload, tag save, link change and delete (this fixes the WIP's stale counts).

## 7. Server composition (scaffold; the integrator owns `server.js`)

- Append `require('./routes/orders')`, `require('./routes/inspections')` and `require('./routes/scheduling')` to the `routers` array (`server.js:36-48`), after `./routes/settings`.
- The scaffold creates all three as empty guarded `defineRoutes` routers with their final prefixes (`/api`, `/api`, `/api/scheduling`).
- `/api/job-records/:id/orders` and `.../inspections` live in those routers. Express falls through `routes/jobs.js`, whose `/:id` routes don't match two segments, so B never edits `routes/jobs.js`.
- `assertAllRoutesGuarded` covers them as before.

## 8. Tests

### Smoke files

`ci/smoke.sh` (scaffold) gains, right after the M2 loop at `smoke.sh:1100`:

```bash
for f in "$(dirname "$0")"/smoke-m3-*.sh; do [ -f "$f" ] && source "$f"; done
```

- The files share the helpers, the jars (`$ADMIN $SCHED $ACCT $DPM $SHOW`), `$CONTAINER` and `sydney_monday`. Each starts with `step "m3-…"`, has no shebang and no `set`, and must not assume a pristine database (the M2 suites have run).
- Use far-future weeks (2034) for any board placement.
- Step b's logged-out sweep already reads `/api/meta/routes`, so **401 on every new route is automatic**.
- A small `db_exec` helper (as `db_value` in `smoke-m2-notify.sh`) may write to `/data/db/photos.db` through `docker exec … node -e` where noted.

**`ci/smoke-m3-pipeline.sh`** (Wave 1 A), `step "m3-a. pipeline and stage moves"`:
- **Access:**
  - `POST /api/job-records/1/stage`: sched, acct and show → 403.
  - `/pipeline.html` and `/orders.html`: dpm and sched 200, show 403.
- **Moves and key dates:**
  - dpm creates a job (lead). `{stage:'quoted', from:'lead'}` → 200; `quotedDate` is today and `wonDate` is null.
  - A job created with `quotedDate:"2030-01-01"` and moved to quoted keeps 2030-01-01.
  - Stale: `{stage:'won', from:'lead'}` on the quoted job → 409 and `.stage == "quoted"`.
  - The same stage `{stage:'quoted', from:'quoted'}` → 200, and the `job.stage` audit total for the job is unchanged.
  - `complete`, `on_board` and `invoiced` as targets → 400, for dpm and for admin.
- **To start:**
  - Move to `ready_to_cut` → `readyToCutDate` is today, `inBacklog` is true, and `GET /api/schedule` backlog has the job.
  - Back to `won` → `inBacklog` false, and it's gone from the backlog.
  - Ready to cut again, then `DELETE /api/jobs/backlog/:id`, then `PATCH {stage:'ready_to_cut'}` (the same stage) → still not in the backlog (trap 4).
- **On board:** place it (`POST /api/jobs/backlog/:id/place`, week 2034-03-06) → `on_board`.
  - `POST stage {stage:'won', from:'on_board'}` → 409, for dpm and for admin.
  - `PATCH {stage:'won'}` as admin → 409 (it has future rows).
  - As dpm → 409.
- **Archived:**
  - Move to `archived` → `archived == true`, and `GET /api/jobs` (the board picker) doesn't list it.
  - Move to `lead` → `archived == false`, and the board picker lists it.
- **Complete:** a fresh job set `complete` by admin `PATCH` → `POST stage` to `lead` → 409; to `archived` → 200.
- **Rollback (trap 5):**
  - `db_exec` creates `CREATE TRIGGER m3_smoke_block BEFORE INSERT ON backlog BEGIN SELECT RAISE(ABORT,'blocked'); END`.
  - Moving a won job to `ready_to_cut` → 500, then `GET` shows it still `won` with `readyToCutDate` unchanged.
  - Drop the trigger.

**`ci/smoke-m3-orders.sh`** (Wave 1 B), `step "m3-b. orders and inspections"`:
- **Access:**
  - `GET /api/orders`: sched and acct 200, show 403.
  - `POST /api/job-records/:id/orders`: dpm 201; sched, acct and show 403.
  - `GET /api/scheduling/upcoming`: sched and dpm 200; acct and show 403.
  - `GET …/inspections`: sched 200, show 403.
  - `POST …/inspections`: dpm 201; acct and sched 403.
  - `PATCH /api/inspections/:id`: acct 403.
- **The progress invoice:** admin sets a value of 2000000 on a new job, and dpm adds two lines.
  - dpm `PATCH {status:'ordered'}` → 403.
  - admin orders line 1 → `materialsOrderedDate` is still null and there are no invoices.
  - admin orders line 2 → `materialsOrderedDate` is today, and exactly one progress invoice is `due` with `dueReason == "materials_ordered"`.
  - `POST /materials-ordered` → 409.
  - dpm adds line 3 and admin orders it → still exactly one live progress invoice.
- **Materials in:**
  - dpm adds line 4 and `PATCH {status:'received'}` on it while it is `to_order` → 409 `"Mark it ordered first"`. dpm cancels line 4.
  - dpm marks lines 1 to 3 `received` → `materialsInDate` is today.
  - sched has a `materials.in` notification whose link contains the job id; dpm (the actor) has none for that job.
  - dpm adds line 5 → `materialsInDate` null. Cancel line 5 → `materialsInDate` is today again.
  - `PATCH` a cancelled line → 409.
- **Audit:** `order.create`, `order.status` and `order.cancel` rows exist for those lines.
- **Lists:** `GET /api/orders?status=all&jobId=` lists the five lines, and `/api/orders/suppliers?q=M3` has the supplier name.
- **Inspections:** dpm books one on a two-pac job, today + 3 at 10:30.
  - 201, and the host is "CI Design PM".
  - sched gets `inspection.booked`; dpm doesn't.
  - A date `PATCH` → sched gets `inspection.moved`.
  - `time:"25:00"` → 400.
  - The inspection appears in `upcoming.inspections`.
  - Cancel → sched gets `inspection.cancelled`, and it is gone from upcoming.
- **Upcoming materials:** a line with an expected date of today + 5, ordered by admin, appears in `upcoming.materials`.

**`ci/smoke-m3-photos.sh`** (Wave 1 C), `step "m3-c. photos and tags"`:
- **Upload and tidy:**
  - admin uploads with `jobId=J` and `tags= M3Kitchen, m3kitchen ,M3 Oak,,` → `created[0].tags == "m3kitchen, m3 oak"`, plus `jobId == J` and `jobName`.
  - A bad `jobId` 999999 → 400, and the photo count is unchanged.
  - A second photo with `tags=M3KITCHEN` → `"m3kitchen"`.
- **Tags:** `GET /api/photos/tags` as show → 200, with `m3kitchen` 2, `m3 oak` 1, and no mixed-case tag.
- **Privacy:**
  - As show, `GET /api/photos` has length ≥ 2 and `all(.[]; (has("jobId") or has("jobName")) | not)`.
  - As dpm, the linked photo has `jobId == J` and `jobName`.
  - `?jobId=J` as dpm → exactly one photo; as show → 403.
- **Edits:**
  - dpm `PATCH {jobId:null}` → null; `{jobId:J}` → J; `{tags:"B, a, b"}` → `"b, a"`.
  - show and sched `PATCH` → 403.
- **Audit and clean-up:**
  - `photo.upload`, `photo.tags`, `photo.link` and `photo.delete` rows exist.
  - Delete both photos (204).
  - Step c's upload, orientation-6 and empty-list checks are untouched and must still pass.

### Migration 011 in CI (scaffold, `smoke.sh` step k)

This goes beyond the plan, which expected a local-only check; it adds no risk (§11.10).
- **Old app, before it stops:** upload `$WORK/test.png` twice with `curl -sf -F` (no auth, as `oapi`), with `tags=  Kitchen, kitchen ,White Oak,, OAK ` and `tags=already, tidy`.
- **After this image boots on the same volume:**
  - `photos` has 2 rows (the same count as before).
  - Their tags are `kitchen, white oak, oak` and `already, tidy` (read with `docker exec … better-sqlite3`).
  - The logs contain `[migrate] 011 tag tidy: 1 of 2 photo(s) rewritten`.

### Local checks

Docker isn't on the dev box, so smoke files get `bash -n` only. Every task:
- boots the shim on a fresh `.dev/<task>/` data directory and runs `curl` against the routes it owns (setup and login through `/api/auth/*`);
- runs `node ci/style-check.js` if it touches `public/`;
- takes headless-Edge screenshots (`tools/screenshots/`) of the pages it changes.

Report what was run.
- **A** also drags on the pipeline in a browser at desktop and at phone width (375 px), including a 409: move the same card from two tabs.
- **Scaffold, for 011:** a throwaway `node -r tools/dev-sqlite-shim.js -e` script (not committed):
  1. On a fresh DB, call `migrate(db, {dbDir, migrationsDir: <temp copy of 001–010>})`.
  2. Insert photos with every "before" value in the §1 table.
  3. Call `migrate(db, {dbDir})` with the real directory.
  4. Assert every "after" value; that no other column changed (full-row compare apart from `tags`); that the row count is the same; that `photos-pre-011-*.db` exists; and that the log line reads `4 of 6`.
  5. Assert `lib/tags.js` `normaliseTags` gives the same results.

## 9. Waves and file ownership

| Step | Who | Owns (only these files) |
|---|---|---|
| **M3 · 2.2 Scaffold** | integrator | `db/migrations/010_design_pm.sql`, `db/migrations/011_tidy_photo_tags.js`, `lib/httperror.js`, `lib/tags.js`, `lib/notify.js` (`exceptUserId`), `lib/jobstage.js` (§2 exports, complete), `lib/orders.js` (`markMaterialsOrdered` complete, other exports stubbed), `lib/inspections.js` (stub), `routes/jobs.js` (the materials-ordered route only), `routes/{orders,inspections,scheduling}.js` (empty guarded routers), `server.js`, `lib/pages.js`, `public/shell/shell.js` (two `LINK_GROUPS` entries only), `ci/smoke.sh` (the source line and the step-k 011 check), `docs/auth.md` (`orders.edit`, `inspections.edit`, `design.view` live) |
| **M3 · 3.1 Wave 1, A: pipeline** | Sonnet, worktree | `routes/jobs.js`, `lib/jobstage.js` (fixes only), `public/pipeline.{html,css,js}` (new), `public/job.js` (the stage dropdown and save path only), `ci/smoke-m3-pipeline.sh` |
| **M3 · 3.1 Wave 1, B: orders and inspections backend** | Sonnet, worktree | `lib/orders.js`, `lib/inspections.js`, `routes/orders.js`, `routes/inspections.js`, `routes/scheduling.js`, `ci/smoke-m3-orders.sh` |
| **M3 · 3.1 Wave 1, C: photos** | Sonnet, worktree | `routes/photos.js`, `public/search.{html,js,css}`, `public/admin.{html,js,css}`, `ci/smoke-m3-photos.sh` |
| **M3 · 3.2 Wave 2, D: pages** | Sonnet, worktree | `public/job.{html,js}`, `public/jobs.css` (additions for `jo-` sections only), `public/orders.{html,css,js}` (new), `public/scheduling.html`, `public/scheduling.{js,css}` (new), `public/design.html` |
| **M3 · 4.1 Integrate** | integrator | merges; STATUS; `docs/auth.md` if anything moved |

How the files that more than one step needs are split:
- **`routes/jobs.js`:** the scaffold edits only the materials-ordered handler and commits before Wave 1 branches; then A alone. B's job-scoped routes live in its own routers (§7).
- **`lib/jobstage.js`:** the scaffold writes `moveStage` in full; A may fix it. Nobody else touches it.
- **`lib/orders.js`:** the scaffold writes `markMaterialsOrdered` (the button must keep working on `main`); B fills in the rest and must not change `markMaterialsOrdered`'s signature or return values.
- **`public/job.js`:** A (Wave 1) edits the stage path only; D (Wave 2) starts from merged `main`. `public/job.html` is D's alone.
- **`routes/photos.js`, `lib/tags.js`:** C owns `routes/photos.js`. `lib/tags.js` is the scaffold's, and C reports any change it wants (it must match 011).
- **`server.js`, `lib/pages.js`, `lib/notify.js`, `shell.js`, `ci/smoke.sh`:** scaffold only. A wave that needs a change reports it.

Wave 2 starts only after Wave 1 is merged on `main`, so D codes against real APIs. No task edits files outside its row, the board files, or `shared.js`.

## 10. Feature keys and docs

No key is added; the count of 21 stays. `docs/auth.md` drops the † from `orders.edit`, `inspections.edit` and `design.view`, and notes that `jobs.view` now also opens Pipeline and Orders.

## 11. Open points, settled by the integrator (2026-10-11)

All settled as below; the contract text above already reflects them. Items 4 and 8 changed from the draft; the rest stand as drafted.

1. **`photos.job_id` already exists.** Plan §3 says 010 adds it, but `003_jobs.js:48` added it in M1 (nullable, `REFERENCES jobs(id)`, never written). 010 therefore adds only `idx_photos_job`. Re-adding the column would fail the migration.
2. **No "Design" group in the shell.** Plan §8 puts Pipeline and Orders in "the shell's Design group", but `LINK_GROUPS` has "Production", "Jobs and money", "Photos" and "Admin". **Accepted:** both go in "Jobs and money" after Jobs; the scaffold checks the menu bar still fits at desktop width.
3. **Scheduling Planned tiles.** Plan §6 says the Planned tiles "give way" to Upcoming, but those tiles (Leave and availability, Lookahead) are still-planned M5 items. Default: keep them below the new Upcoming section and remove only the "not built yet" line. **Accepted.**
4. **Pipeline volume.** The 003 backfill made every historical job `complete`, so after cutover the Complete column (and later Invoiced) will hold hundreds of cards. The plan has no cap. Recommendation: Complete and Invoiced show jobs whose `stage_changed_at` is within 60 days, with a "Show all N" button per column. **Adopted** (§6 pipeline, "Cap").
5. **The admin override on `PATCH {stage}`** isn't in the plan, which only says an admin can still set a derived stage by hand. This contract adds two rules:
   - An admin may also move a job out of `complete` or `invoiced` to any manual stage.
   - An admin may move a job out of `on_board` only when it has no current or future week rows, so a stale `on_board` (rows deleted) can still be fixed and a job really on the board can't be mislabelled.
   **Accepted.**
6. **Key dates "on the way forward".** The contract fills the target stage's date whenever a move enters that stage and the date is empty, whatever the direction. For example, lost → quoted with no `quoted_date` fills it. It never overwrites and never clears. **Accepted:** filling an empty date on entry is harmless in either direction.
7. **The invoice hook still swallows errors on the orders path.** `invoices.onMaterialsOrdered` never throws (M2 design), so if it fails, the line and `materials_ordered_date` are still saved and no progress invoice appears (the failure is logged). This matches M2's button. Trap 5's "fail loudly" is applied only to stage moves, as the plan scopes it.
8. **Cancelling doesn't fire the 50% invoice.** Cancelling the last `to_order` line, with the others ordered, does not call `markMaterialsOrdered`, because design_pm can cancel and Q1 reserves the trigger for Todd. **Changed:** a cancel by an `orders.mark_ordered` holder (Todd) does fire the rule, so Todd cancelling the last outstanding line behaves like ordering it; a design_pm cancel still never fires it (§2 `cancelLine`). Smoke: B adds one assertion (admin cancels the last `to_order` line on a job whose other lines are ordered → one progress invoice due).
9. **Photo delete stays a hard delete** (row and files), as today. Brief §8.5 prefers soft delete "everywhere a human might regret it", but the M3 plan only adds an audit row. Default: unchanged in M3, noted for a later milestone.
10. **011 checked in CI as well.** The plan says the tag tidy can only be checked locally because CI starts empty, but the cutover rehearsal (step k) boots this image on an old-app database. The contract adds a 011 check there (the scaffold edits `smoke.sh`), as well as the local check.
11. **The archived link is one-way from the stage.** Moving into or out of the `archived` stage sets the checkbox. Ticking the checkbox on the job page doesn't change the stage, and a job unticked by hand stays in the `archived` stage. **Accepted** as the reading of Q5.
12. **Decisions the plan left open, taken here:**
    - an `on_board` source returns 409 (the plan gives no code);
    - `from` is required on `POST /stage`;
    - an inspection's time is optional;
    - `to_order → received` is refused;
    - the Design page's "Client inspections" tile links to Scheduling, because there is no inspections page;
    - pipeline data reuses `GET /api/job-records` instead of a new endpoint.

## 12. Changes after the M3 · 4.2 review (integrator, 2026-10-11)

These override the text above where they differ.
- **Job page save:** the stage request's `from` is the stage the user saw (captured before the field PATCH), so a concurrent move gives 409.
- **Pipeline cap:** a `complete` card's recency is `completedDate`, else its last `onBoardWeeks` week, else it counts as old; `invoiced` keeps `stageChangedAt`. (003 set `stage_changed_at` to the cutover time on every backfilled job.)
- **`moveStage` without override:** a job with current or future week rows gives 409 `ON_BOARD_MSG` whatever its stage, **except** `complete` and `invoiced` (finished rows; Finish week leaves the current week's row; their only target is `archived`). The pipeline and job page lock the same cards for non-admins.
- **To start:** `moveStage` removes the backlog row when leaving `ready_to_cut` and on any move to `archived` or `lost`. The admin's derived override on `PATCH` removes it when the job was `ready_to_cut`. The `job.stage` audit `after` carries `toStart:'removed'`; `setStage` and `onFinishedComplete` gained an optional trailing `auditExtra`.
- **`materials.in`:** sent only if no `materials.in` notification exists for the job yet (one per job, per recipient).
- **Order dates:** `orderedDate` and `receivedDate` after Sydney today → 400.
