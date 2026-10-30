# Jobs as containers, Tradify style: contract (ships in 0.2.8, Todd 2026-10-30)

Plan: `jobs-tradify-plan.md` (approved 2026-10-30; decision 1 revised at contracts). Builds on everything before (`m22-project-jobs.md`, `m23-contracts.md`, `m26-contracts.md`, `m6-contracts.md`). Everything before still holds except where a section below changes it. CLAUDE.md applies: additive migration, `defineRoutes` with an access value, house style, board layout untouched, no push without Todd's yes, hands off Joinr (rule 12).

**Todd's answers at contracts (2026-10-30):** jobs are made only when a quote is won (today's intake, unchanged); J- numbers from the job id, gaps allowed; a won quote matching 2+ jobs goes to the inbox as today; Invoices tab for `accounts.view` only, no new key; notes added by anyone with `jobs.view`, edited or deleted by their author, soft-deleted by an admin; the alert reads "needs a project manager". Section 1.4 lists exactly what migration 051 writes to existing rows.

Code (new): migration `051_jobs_tradify.sql`; `lib/jobnotes.js`, `routes/jobnotes.js`; `public/jobtabs.js`, `public/jobtabs.css`, `public/jobnotes.js`. Changes: `lib/intake.js` (one alert in `autoDecide`), `lib/projectjobs.js` (`setOwner` alert), `lib/projectsteps.js` (alert words), `routes/jobs.js` (list filters and columns), `routes/files.js` (one more allow branch), `server.js` (mount), `public/job.html`, `public/job.js`, `public/jobs.html`, `public/jobs.js`, `public/projectowner.js`, `public/project.html|js`, `public/pipeline.js` (label text). Test: new `ci/smoke-jobs-tradify.sh`, sourced from `ci/smoke.sh`; `ci/smoke-m23-project-steps.sh:76` updated.

## 0. Why jobs start at Won (the code)

The plan first said every new Joinr quote makes a job at Quoted. The won-quotes feed, which intake reads, never carries a quote that has not been won: its only events are `won`, `unwon`, `changed`, `deleted`, all about won quotes (`docs/integrations/joinr-crosscuts-intake.md:85-91`); `applyItemInner` skips any first-seen item that is not a live `won` (`crosscuts/app/lib/joinr-sync.js:569`); the fake serves only such items (`ci/fake-joinr.js:9,222,227`). Sent quotes appear only in the open-quotes snapshot (J3), which cannot tell lost from archived. Todd chose (2026-10-30): **jobs are made only on a win, as today.** `autoDecide` (`lib/intake.js:524-556`), `acceptTx` (`:338`), `linkTx` (`:437`) and the open-quotes code are unchanged except the one alert in section 2.

## 1. Data: migration 051

### 1.1 Choices

- **Note files: a separate `job_note_files` table pointing at the existing private `files` table**, not `photos` rows with a `note_id`:
  - `photos` is read by four modules (`lib/issues.js`, `lib/shift.js`, `routes/photos.js`, `routes/shift.js`); each would need a new filter, and one missed filter leaks a note photo into the library. A separate table cannot leak by omission.
  - Library photos are served by the `/photos` static route; files in `<UPLOADS_DIR>/files` are never served by it (`lib/files.js:4`) and leave the server only through `GET /api/files/:id`, which answers 404 unless the caller passes an allow check for the owning record (`routes/files.js:15-31`).
  - The upload code exists and is hardened: `files.single`, `files.accept`, `files.discard` (`lib/files.js:274-285`), used this way by task attachments (`routes/tasks.js:70-88`). Allowlist by magic bytes (pdf, png, jpg, xlsx, docx, xls, csv; `lib/files.js:37-71`), 25 MB (`lib/files.js:24`), one file per request (`lib/files.js:86`).
  - Cost: no thumbnails (images shown scaled from `/api/files/:id`), no WebP/HEIC (phone file inputs send JPEG). Accepted.
- **Job number `jobs.job_number`**, filled by an `AFTER INSERT` trigger, so all three insert paths (`lib/intake.js:375`, `lib/jobstage.js:139`, `routes/jobs.js:300`) are covered without code changes.
  - Rule: the job's `quote_number` (trimmed) when non-blank, not starting `J-`, and held by no other job (case-insensitive); otherwise `J-` + the job id padded to four digits (`J-0042`). Approved: the series has gaps.
  - Set once at insert; never rewritten by code (not when a quote number is typed or linked later). Editing it is out of scope.
  - Unique index on `job_number COLLATE NOCASE`.
  - Quote numbers can repeat across jobs today (that is why `matches()` exists, `lib/intake.js:243-257`). In the backfill a quote number held by two or more jobs gives **all** of them J- numbers.
- **PM:** no schema change. `jobs.project_owner_id` (`db/migrations/041_project_jobs.sql:9`) is the project manager.
- **No new feature key.** Key count stays 39, admin preset 35 (`lib/permissions.js:4-57,73`).

### 1.2 The SQL (verbatim; `crosscuts/app/db/migrations/051_jobs_tradify.sql`)

```sql
-- Jobs as containers, Tradify style (0.2.8, docs/plans/jobs-tradify-contracts.md section 1;
-- Todd 2026-10-30). Additive: two new tables, one new column with an index and a trigger.
-- The only write to existing rows is the backfill of the NEW column jobs.job_number (section 1.4).

-- 1. Notes on a job: a running list, newest first. Soft delete only.
CREATE TABLE job_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  user_id INTEGER NOT NULL REFERENCES users(id),           -- who wrote it
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at TEXT,                                           -- last edit by the author, or NULL
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_job_notes_job ON job_notes(job_id, created_at);

-- 2. Files on a note: rows in files (migration 012) under <UPLOADS_DIR>/files, served only by
-- GET /api/files/:id. Never in photos, so never in the photo library.
CREATE TABLE job_note_files (
  note_id INTEGER NOT NULL REFERENCES job_notes(id),
  file_id INTEGER NOT NULL UNIQUE REFERENCES files(id),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (note_id, file_id)
);

-- 3. Job number: the Joinr quote number, else J-<id>. Backfill first, then the index and trigger.
ALTER TABLE jobs ADD COLUMN job_number TEXT;

UPDATE jobs
   SET job_number = CASE
     WHEN trim(coalesce(quote_number, '')) <> ''
      AND upper(substr(trim(quote_number), 1, 2)) <> 'J-'
      AND (SELECT COUNT(*) FROM jobs o
            WHERE upper(trim(o.quote_number)) = upper(trim(jobs.quote_number))) = 1
     THEN trim(quote_number)
     ELSE 'J-' || printf('%04d', id)
   END
 WHERE job_number IS NULL;

CREATE UNIQUE INDEX idx_jobs_job_number ON jobs(job_number COLLATE NOCASE) WHERE job_number IS NOT NULL;

CREATE TRIGGER trg_jobs_job_number AFTER INSERT ON jobs
WHEN NEW.job_number IS NULL
BEGIN
  UPDATE jobs
     SET job_number = CASE
       WHEN trim(coalesce(NEW.quote_number, '')) <> ''
        AND upper(substr(trim(NEW.quote_number), 1, 2)) <> 'J-'
        AND NOT EXISTS (SELECT 1 FROM jobs o
                         WHERE o.id <> NEW.id
                           AND o.job_number = trim(NEW.quote_number) COLLATE NOCASE)
       THEN trim(NEW.quote_number)
       ELSE 'J-' || printf('%04d', NEW.id)
     END
   WHERE id = NEW.id;
END;
```

Notes for the builder:

- The runner applies a `.sql` file with one `db.exec` in a transaction (`crosscuts/app/db/migrate.js:122`), so the trigger's inner semicolons are fine (`004_audit.sql` already has a trigger).
- In the backfill the job's own row counts once, so `= 1` means no other job has the number.
- No code sets `job_number` today, so the trigger fires on every insert.
- A typed quote number cannot collide with a J- number (a `J-` prefixed quote number always takes the J- branch).

### 1.3 What the backup covers

Before any pending migration runs on an existing database, `backupBefore` writes `VACUUM INTO <dbDir>/backups/` (`crosscuts/app/db/migrate.js:53-67`): a complete copy of `photos.db` before 051, every table. It does not cover `/data/uploads` (051 touches no files). Restoring it undoes 051 entirely.

### 1.4 Writes to existing rows (Todd to sign off)

- **One:** the backfill fills the new, empty `job_number` column on **every existing job**. No existing column changes; `updated_at` is not touched, so "last activity" does not jump.
- Nothing else: no rows deleted, no other table updated, the inbox (`joinr_intake`) untouched.
- On Todd's Umbrel today this numbers the M1 test jobs; at cutover the old app's database goes through 001-051 and its jobs are numbered the same way.

## 2. Intake

Unchanged: a won quote links the one matching job, else makes a Won job, else (2+ matches) stays in the inbox (`lib/intake.js:524-556`); the design team task and `joinr.job` alert as now. Quotes already in the inbox at release are untouched.

One addition in `autoDecide`, after the job is made or linked: if the job has no project manager, every `design.view` holder gets kind `job.unassigned`, title "New job from Joinr: <name>", body "<job number> · <client>. No project manager yet.", link `/job.html?id=N`, `entityType: "job"`, `entityId: N` (`notify.toKey`, `lib/notify.js:38`). It runs inside the same transaction, so a failure rolls back as today. The existing Won-without-owner sweep to admins (`lib/projectsteps.js:339-365`) is unchanged.

## 3. Project manager

- `jobs.project_owner_id`, unchanged in the database and API (`ownerId`, `GET /api/project-owners`, `PUT /api/job-records/:id/owner`, `routes/projectjobs.js:39-50`). Every UI label for it reads **"Project manager"** (`public/projectowner.js`, `public/job.js`, `public/project.html|js`, `public/pipeline.js`, the jobs table).
- The alert "<job> needs a project owner" (`lib/projectsteps.js:360`) becomes **"<job> needs a project manager"**; the kind `project.owner_needed` stays.
- **Who may assign:** unchanged: `users.admin`, or `jobs.edit` with `design.view` (`canSetOwner`, `routes/projectjobs.js:35-37`). The PM must be an active user with `design.view` (`checkOwner`, `lib/projectjobs.js:54-61`). Setting a PM on a Won job still moves it to Projects (`lib/projectjobs.js:81-87`).
- **New alert:** `setOwner` (`lib/projectjobs.js:63-90`), when it sets a new non-null PM who is not the person assigning: `notify.toUser(pm, {kind: "job.pm_assigned", title: "You are project manager for <name>", body: "<job number> · <client>", link: "/job.html?id=N", entityType: "job", entityId: N})`. Clearing, or setting the same PM again, sends nothing.

## 4. API

All declared with `defineRoutes` and an access value (`lib/routes.js:27`; boot refuses an unguarded `/api` route, `lib/routes.js:93`). Errors are `{error}`: 400 bad input, 403 rule refused, 404 no job / no note / note deleted, 409 conflict. New router `routes/jobnotes.js` = `defineRoutes("/api/job-records")`, mounted in `server.js` beside `routes/jobs` (`server.js:58`).

### 4.1 Notes

A note as JSON: `{id, jobId, body, createdAt, editedAt, author: {id, name}, files: [{id, name, mime, size, url: "/api/files/<id>", image}], canEdit, canDelete}`. `canEdit`: the caller wrote it. `canDelete`: the caller wrote it or holds `users.admin`.

| Method, path | Access | Body | Answer | Rules |
|---|---|---|---|---|
| `GET /api/job-records/:id/notes` | `jobs.view` | none | `{notes}`, newest first, deleted left out | 404 no job |
| `POST /api/job-records/:id/notes` | `jobs.view` | `{body}` | 201 the note | trimmed, 1-5000 chars else 400. Audited `job.note_add` (`entityType: "job_note"`). |
| `PATCH /api/job-records/:id/notes/:noteId` | `jobs.view` | `{body}` | the note | author only (403); deleted 404. Sets `edited_at`. Audited `job.note_edit` with before/after. No time limit. |
| `DELETE /api/job-records/:id/notes/:noteId` | `["jobs.view", "users.admin"]` | none | `{ok: true}` | author or `users.admin` (403). Soft: `deleted_at`, `deleted_by`; its files get `files.removed_at`/`removed_by` (kept on disk, as task files). Audited `job.note_delete` with the body and `byAdmin: true` when not the author. |
| `POST /api/job-records/:id/notes/:noteId/files` | `jobs.view` | multipart field `file` (`files.single("file")`) | 201 the note | author only (403); at most 10 files a note (409). Handler shaped exactly as `routes/tasks.js:72-88` (accept, link, discard on any error, `.part` removed before replying). Audited `job.note_file`. |
| `DELETE /api/job-records/:id/notes/:noteId/files/:fileId` | `["jobs.view", "users.admin"]` | none | the note | as note delete. Audited `job.note_file_remove`. |

`GET /api/files/:id` (`routes/files.js:15-31`) gains one allow branch: the file is in `job_note_files`, its note is not deleted, and the caller holds `jobs.view`. Otherwise 404 as now.

The pinned **Job summary** is the existing `notes` field (`public/job.js:121`) and the Projects notes (`PUT /api/job-records/:id/project/notes`, `routes/projectjobs.js:64`), shown at the top of the Notes tab; API unchanged.

### 4.2 Jobs list

`GET /api/job-records` (`routes/jobs.js:234-269`, `jobs.view`) gains, combinable with `stage`, `archived`, `q`:

- `mine=1`: `project_owner_id = <caller>`.
- `unassigned=1`: `project_owner_id IS NULL AND archived = 0 AND stage NOT IN ('complete','invoiced','lost','archived')`.
- Both together, or any value other than `1` or empty: 400.
- `q` also matches `job_number` and `quote_number`.

`toJob` camel-cases every column (`routes/jobs.js:132-140`), so `jobNumber` and `projectOwnerId` appear by themselves. New fields: `projectManager: {id, name, hue} | null`, `lastActivityAt`.

**Last activity** = the latest of `jobs.updated_at`, the job's newest non-deleted `job_notes.created_at` / `edited_at`, and its newest `photos.created_at` (stored `YYYY-MM-DD HH:MM:SS` UTC, `db/migrations/001_baseline.sql:10`; normalised to ISO before comparing). One grouped query each, joined in JS.

### 4.3 Invoices on the job

No new route: the tab uses `GET /api/invoices/job/:jobId` (`routes/invoices.js:161`, `accounts.view`), as the job page already does (`public/job.js:390`). Read-only: kind, amount, due date, paid, a link to Accounts. **Shown only to `accounts.view` holders**; a PM without it doesn't see the tab.

## 5. Pages

House style: ink ground, teal accent, outlined uppercase buttons, Arial/Helvetica, no icons, emoji or shadows. New page classes `jo-` / `jn-`; `cc-` is only for the shell (CLAUDE.md rule 8). `ci/style-check.js` must pass.

### 5.1 `job.html`

- **Header** (sticky under the menu bar, `--shell-h`): job number, name, stage, client, site, Project manager (the existing `#pjOwner` control moves into it), and the orange lines (`#banner`, `#confirmComplete`).
- **Tabs** (text buttons in a `role="tablist"` strip). Existing sections are moved, not rewritten:

  | Tab | Holds |
  |---|---|
  | Overview | `#meta`, `#form`, `#people` |
  | Quote | `#joinr`, `#fullquote` |
  | Notes | Job summary, then the notes list (`#jobNotes`, `#jnForm`, `#jnBody`, `#jnFile`, `#jnAdd`, `#jnList`) |
  | Photos | `#photos` (job photos, needs `photos.search`), then "Photos on notes" (`#jnPhotos`) |
  | Invoices | `#invoices` (`accounts.view` only) |
  | Orders & materials | `#materials`, `#orders`, `#drawersBlock`, `#orderForm` |
  | Planner & tasks | `#planner`, `#tasks`, `#comments` |
  | Workshop | `#benchtops`, `#reservations`, `#issues`, `#inspection` |

  A tab whose sections are all hidden for the caller is not shown.
- **Remembered tab:** `localStorage` key `cc.job.tab`, every read and write in try/catch; the page works without storage.
- **Deep links win:** a hash naming a section opens its tab and scrolls to it. Used today: `#orders`, `#issues`, `#inspection`, `#reservations`, `#comments`, `#confirmComplete` (alert and Planner links; e.g. `ci/smoke-m7-auto.sh:159,166,226`, `ci/smoke-m25-shift.sh:112-121`, `ci/smoke-m10-orders.sh:186`). `#tab-<name>` opens a tab.
- **Implementation:** `public/jobtabs.js` + `jobtabs.css` move the section elements into tab panels at load. The served HTML keeps every section element and id (the smokes read the raw HTML); section scripts stay as they are.
- **Ids the smokes assert in the raw HTML** (each before its script tag):
  - `id="pjOwner"` … `projectowner.js` (`ci/smoke-m22-project-jobs.sh:48-49`)
  - `id="issues"` … `jobissues.js` (`ci/smoke-m25-shift.sh:129-130`)
  - `id="confirmComplete"` … `confirmcomplete.js` (`ci/smoke-m26-morning-complete.sh:70-71`)
  - `id="reservations"` … `jobreserve.js` (`ci/smoke-m27-workshop-manager.sh:271-272`)
  - Keep every other id in today's `job.html` too (`job.js` and the section scripts find them by id), and the script order; add `jobnotes.js` and `jobtabs.js` before `/shell/shell.js`.
  - `ci/smoke-m10-orders.sh:107-108` (403 for `/job.html` without job pages): unchanged.
- **Phone (< 720 px):** the header folds to one line (job number, name, stage) with a More toggle for client, site and PM; tabs become one horizontally scrolling strip (the strip scrolls, never the page; no horizontal page scroll at 375 px); 44 px targets; the note form full width.
- **Print:** all panels in order, black on white, tabs hidden.

### 5.2 `jobs.html`

A table: **Job no. | Name | Client | Stage | Project manager | Last activity** (relative, full date in `title`), each row linking to `/job.html?id=N`. Filters as outlined buttons: **My jobs** (default for a user who is PM on at least one live job, else **All**), **Unassigned**, **All**, plus the existing stage select, search and Show archived. Keep the ids `newJob q stage showArchived head rows count`. Filter remembered in `localStorage` key `cc.jobs.filter` (try/catch). Click a heading to sort (client-side). Phone: stacked rows, no horizontal page scroll.

## 6. Smoke plan

### 6.1 New `ci/smoke-jobs-tradify.sh`

`ci/smoke.sh` sources M-numbered files by glob (`ci/smoke.sh:1179-1277`), so it gets one explicit line after the m28 loop and before the backup suite (`:1279`): `[ -f "$(dirname "$0")/smoke-jobs-tradify.sh" ] && source "$(dirname "$0")/smoke-jobs-tradify.sh"`. Outline:

1. **Job numbers:** every job from earlier smokes has a unique `job_number`; a Joinr job's is its quote number; a hand-made job's is `J-` + padded id; two jobs sharing a quote number both get J- numbers (insert the second through the API and check the trigger); a typed `J-…` quote number takes the J- branch.
2. **Won quote, no PM:** a won-quotes item makes a Won job (as today) and each `design.view` holder gets one `job.unassigned`; the inbox clash case (2+ matches) is unchanged and sends no `job.unassigned`.
3. **PM:** assign by a dpm → the PM gets one `job.pm_assigned`; self-assign sends none; showroom 403; a user without `design.view` 400.
4. **Jobs list:** `mine=1`, `unassigned=1`, both → 400, bad value → 400, `q` by job number; `lastActivityAt` moves when a note is added.
5. **Notes:** add (201), list newest first, edit own (`editedAt` set), edit another's 403, delete another's 403 for a non-admin, admin delete 200 with audit `byAdmin`, deleted note gone and 404 on edit; empty or 5001-char body 400; no `jobs.view` 403; accounts (jobs.view, no jobs.edit) can add.
6. **Note files:** PNG 201; a renamed non-image 400; over 25 MB refused as `lib/files.js` answers; served with `jobs.view`, 404 without, 404 after the note is deleted; **`GET /api/photos` and `?jobId=N` never list it** and the `photos` row count is unchanged; 11th file 409.
7. **Pages:** raw `job.html` holds the four asserted ids with their scripts, plus `jobtabs.js`, `jobnotes.js`, `id="jobNotes"`; `jobs.html` holds `id="rows"` and loads `jobs.js`.

### 6.2 Existing assertions affected

- **`ci/smoke-m23-project-steps.sh:76`**: expects the title `"$M23_TAG job needs a project owner"`; change to `"$M23_TAG job needs a project manager"`.
- Nothing else: intake behaviour is unchanged, so the M6 intake and inbox smokes stand; `job_number`, `projectManager` and `lastActivityAt` are new keys on job objects, and no smoke asserts the full key set of a job object (checked with `grep -n keys ci/*.sh`).

## 7. Build waves

Disjoint files per piece; one full smoke run at a time.

- **Wave 1 (one builder):** `051_jobs_tradify.sql`; `routes/jobs.js` list filters and columns (4.2). Gate: boots on a copy of the dev DB, every job numbered.
- **Wave 2 (parallel):**
  - A. Notes API: `lib/jobnotes.js`, `routes/jobnotes.js`, `server.js` mount, `routes/files.js` branch.
  - B. PM and alerts: `lib/projectjobs.js` (`job.pm_assigned`), `lib/intake.js` (`job.unassigned` in `autoDecide`), `lib/projectsteps.js` (alert words), label text in `public/projectowner.js`, `public/project.html|js`, `public/pipeline.js`.
- **Wave 3 (parallel):**
  - C. Job page: `public/job.html`, `public/job.js` (only what the tabs need), `public/jobtabs.js|css`, `public/jobnotes.js`.
  - D. Jobs list: `public/jobs.html`, `public/jobs.js`.
- **Wave 4:** `ci/smoke-jobs-tradify.sh`, the `ci/smoke.sh` line, `ci/smoke-m23-project-steps.sh:76`; style check; overflow 375-1100; screenshots on PC and phone for Todd; STATUS.md.

## 8. Version

Stays **0.2.8**. The CI guard (`.github/workflows/publish.yml:71-83`) compares `crosscuts/app/package.json` at the push's `before` commit with the pushed one and fails only if app code changed with the same version. `origin/main` holds 0.2.7, local 0.2.8, so one push of 0.2.8 with this feature passes however many local commits it carries. `crosscuts/app/package-lock.json` is already 0.2.8. The merge job's tag-exists check passes because 0.2.8 was never published.

## 9. Open questions

None blocking. Todd still signs off the backfill (section 1.4).

## 10. Risks

- **Job numbers are fixed at insert.** A job made by hand and later linked to a Joinr quote keeps its J- number (by design; editing it is out of scope).
- **Note files have no thumbnails;** a note with many large phone photos loads full images. Capped at 10 files a note.
- **Note bodies are free text** shown on the page: render with `textContent` only.
- **Moving sections into tabs** could break a section script that measures its element at load while hidden; the builder checks each tab after the move (screenshots in wave 4).

## Sign-off

Todd signed off migration 051, including the job_number backfill of existing jobs (rule 5), on 2026-10-30. Build approved; local commits only, no push.
