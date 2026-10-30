# Jobs as containers, Tradify style: contract (ships in 0.2.8, Todd 2026-10-30)

Plan: `jobs-tradify-plan.md` (approved 2026-10-30). Builds on everything before (`m22-project-jobs.md`, `m23-contracts.md`, `m26-contracts.md`, `m6-contracts.md`, `m3-contracts.md` section 13 for the open-quotes cache). Everything before still holds except where a section below changes it. CLAUDE.md applies: additive migration, `defineRoutes` with an access value, house style, board layout untouched, no push without Todd's yes, hands off Joinr (rule 12).

**Todd signs off this contract before the build starts.** Section 1.4 lists exactly what migration 051 writes to existing rows. Section 8 holds the open questions; **Q1 changes the plan's assumption about where new quotes come from** and must be answered first.

Code (new): migration `051_jobs_tradify.sql`; `lib/jobnotes.js`, `routes/jobnotes.js`; `lib/quotedjobs.js`; `public/jobtabs.js`, `public/jobtabs.css`, `public/jobnotes.js`. Changes: `lib/intake.js` (`autoDecide`, a new `adoptTx`), `lib/joinr-open-quotes.js` (`storeAnswer` hook), `routes/pipeline.js` (`fromCache`), `lib/projectjobs.js` (`setOwner` alert), `routes/jobs.js` (list filters and columns), `routes/files.js` (one more allow branch), `server.js` (mount), `public/job.html`, `public/job.js`, `public/jobs.html`, `public/jobs.js`, `public/projectowner.js` (label). Test: new `ci/smoke-jobs-tradify.sh`, sourced from `ci/smoke.sh`; `ci/smoke-m16-openquotes.sh` gains assertions (section 6.2).

## 0. What the code says about the Joinr feeds (read before section 2)

The plan says "every new Joinr quote creates its own job". The won-quotes feed, which today's intake reads, **never carries a quote that has not been won**:

- The wire contract lists the only item events: `won`, `unwon` (a won quote that stopped being won), `changed` (a quote *currently won* was edited), `deleted` (a won quote soft-deleted) (`docs/integrations/joinr-crosscuts-intake.md:85-91`).
- `applyItemInner` skips any first-seen item that is not a live `won` (`crosscuts/app/lib/joinr-sync.js:569`: `if (item.event !== "won" || !isLive(item)) return { action: "skipped" };`). `reportDrawerProblem` says so too: "never imported (not a won quote)" (`joinr-sync.js:545`).
- The fake serves exactly those items (`ci/fake-joinr.js:9`, its default item is `event: "won", status: "won"` at `fake-joinr.js:222,227`).

Non-won quotes reach Crosscuts only through the **open-quotes list** (J3, already live): a full snapshot, every 5 minutes, of every quote that is `sent` or `won`, not deleted, not archived, one line per job, at most 200 lines, twelve fields (no phone, email, spec or drawers) (`joinr-crosscuts-intake.md:268-292,300-325`; poll interval `lib/joinr-open-quotes.js:28`; cache table `db/migrations/031_*.sql`, replaced whole on each good fetch in `storeAnswer`, `joinr-open-quotes.js:231-254`). In the fake it is `POST /_control/openquotes` (driven only by `ci/smoke-m16-openquotes.sh`).

What that means, and what this contract does about it:

| Need | Signal available today | This contract |
|---|---|---|
| New quote | A `sent` line whose `rootQuoteId` Crosscuts has not seen before in the open-quotes list | Creates the job at Quoted (section 2.2). Drafts and "ready" quotes are never listed, so a job appears **when the quote is sent**, not when it is first drafted. |
| Revision | The line's `quoteId`, `quoteNumber`, value or `url` changes for the same `rootQuoteId` (the revision rule, `joinr-crosscuts-intake.md:288`) | Updates the Quoted job (section 2.3). |
| Won | The won-quotes feed `won` item (unchanged) | Moves the existing job to Won and makes the design team task (section 2.4). |
| Lost / withdrawn | **None that is reliable.** A lost, deleted or archived quote simply drops off the list (`joinr-crosscuts-intake.md:285,290`), and so does an old one past the 200-line cap (`truncated: true`). The won-quotes `unwon` event only exists for quotes that had been won. | No automatic stage change. The job shows "No longer open in Joinr" (section 2.5). Q1 and Q2 in section 8. |

Telling lost apart from archived, or carrying the quote's author, needs a Joinr change: "THIS WILL TOUCH JOINR" and two yeses (CLAUDE.md rule 12). Nothing here changes Joinr.

## 1. Data: migration 051

### 1.1 Choices

- **Note files: a separate `job_note_files` table that points at the existing private `files` table**, not `photos` rows with a `note_id`. Reasons:
  - `photos` is read by four modules (`lib/issues.js`, `lib/shift.js`, `routes/photos.js`, `routes/shift.js`); every one of those queries would need a new `note_id IS NULL` filter, and one missed filter leaks a note photo into the library or photo search. A separate table cannot leak by omission.
  - Library photos are served by the `/photos` static route (`lib/files.js:4` says the files directory is the one place it never serves). Files in `<UPLOADS_DIR>/files` leave the server only through `GET /api/files/:id`, which answers 404 unless the caller passes an allow check for the file's owner record (`routes/files.js:15-31`). Note files get the same protection with one extra branch.
  - The upload code already exists and is hardened: `files.single`, `files.accept`, `files.discard` (`lib/files.js:274-285`), used exactly this way by task attachments (`routes/tasks.js:70-88`). Type allowlist by magic bytes (pdf, png, jpg, xlsx, docx, xls, csv; `lib/files.js:37-71`), 25 MB (`lib/files.js:24`), one file per request (`lib/files.js:86`).
  - Cost: no thumbnails (images are shown scaled from `/api/files/:id`) and no WebP/HEIC (phones send JPEG from a file input). Accepted.
- **Job number: `jobs.job_number`**, filled for every job by an `AFTER INSERT` trigger, so all three insert paths (`lib/intake.js:375`, `lib/jobstage.js:139`, `routes/jobs.js:300`) and the new one in `lib/quotedjobs.js` are covered without code changes.
  - Rule: the job's `quote_number` (trimmed) when it is non-blank, does not start with `J-`, and no other job already has that number (case-insensitive); otherwise `J-` and the job id padded to four digits (`J-0042`).
  - The J- series is the job id, so it is unique by construction, in id order, and needs no sequence table. It has gaps (ids used by Joinr-numbered jobs are skipped). Q4.
  - The number is set once, at insert, and never rewritten by the code (not when a quote number is typed or linked later). Editing it is out of scope.
  - Unique: `idx_jobs_job_number` on `job_number COLLATE NOCASE`.
  - Quote numbers can repeat across jobs today (`matches()` exists for exactly that: `lib/intake.js:243-257`). In the backfill, a quote number held by two or more jobs gives **all** of them a J- number, so no job "wins" a shared number by accident.
- **`joinr_quote_seen`**: one row per `rootQuoteId` the open-quotes list has ever shown, so a new quote is recognised once (idempotency) and a revision is recognised as a change. It also holds the baseline (section 2.1).
- **PM**: no schema change. `jobs.project_owner_id` (`db/migrations/041_project_jobs.sql:9`) is the project manager.
- **No new feature key.** Notes use `jobs.view` / `users.admin`; the key count stays 39 and the admin preset stays 35 (`lib/permissions.js:4-57,73`). The "next key is the 40th" in STATUS stays unused.

### 1.2 The SQL (verbatim; `crosscuts/app/db/migrations/051_jobs_tradify.sql`)

```sql
-- Jobs as containers, Tradify style (0.2.8, docs/plans/jobs-tradify-contracts.md section 1;
-- Todd 2026-10-30). Additive: three new tables, one new column with a trigger and an index.
-- The only write to existing rows is the backfill of the NEW column jobs.job_number (section 1.4).
-- Nothing else existing is changed or deleted.

-- 1. Notes on a job: a running list, newest first. Soft delete only (deleted_at, deleted_by).
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

-- 2. Files on a note. The file itself is a row in files (migration 012) stored under
-- <UPLOADS_DIR>/files, served only by GET /api/files/:id. Never in photos, so never in the library.
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

-- 4. Every root quote the open-quotes list has shown (section 2). baseline = 1: it was already
-- open on the first good fetch after this release, so no job was made for it (Todd's decision 8).
CREATE TABLE joinr_quote_seen (
  root_quote_id TEXT PRIMARY KEY,
  last_quote_id TEXT NOT NULL,                              -- the revision last applied
  last_line TEXT NOT NULL,                                  -- JSON of the line last applied
  baseline INTEGER NOT NULL DEFAULT 0 CHECK (baseline IN (0,1)),
  job_id INTEGER REFERENCES jobs(id),                       -- the job made for it, if any
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  missing_since TEXT                                        -- first good, untruncated fetch it was absent from
);

-- 5. Has the baseline been taken? One row; NULL until the first good fetch after this release.
CREATE TABLE joinr_quote_seen_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  baseline_at TEXT
);
INSERT INTO joinr_quote_seen_meta (id, baseline_at) VALUES (1, NULL);
```

Notes for the builder:

- The runner applies a `.sql` file with one `db.exec` in a transaction (`crosscuts/app/db/migrate.js:122`), so the trigger's inner semicolons are fine (a trigger already exists in `004_audit.sql`).
- In the backfill the job's own row counts once in the `COUNT(*) = 1` test, so "= 1" means no other job has the number.
- In the trigger, `NEW.job_number IS NULL` is always true for today's inserts (no code sets the column). A future insert that sets `job_number` itself skips the trigger.
- A collision between a typed quote number and an existing J- number is impossible (`J-` prefixed quote numbers always take the J- branch).

### 1.3 What the backup covers

Before any pending migration runs on an existing database, `backupBefore` writes `VACUUM INTO <dbDir>/backups/` (`crosscuts/app/db/migrate.js:53-67`), a complete copy of `photos.db` as it was before 051, every table included. It does not cover files in `/data/uploads` (051 touches none). Restoring that copy undoes 051 entirely.

### 1.4 Writes to existing rows (Todd to sign off)

- **One:** the `UPDATE jobs SET job_number = ...` backfill fills the new, empty `job_number` column on **every existing job**. No existing column is changed; `quote_number`, `external_ref`, stages and everything else stay as they are. `updated_at` is not touched, so "last activity" does not jump.
- Nothing else: no rows deleted, no other table updated, the inbox (`joinr_intake`) untouched (decision 8).
- Live data is copied into Crosscuts only at cutover (CLAUDE.md). On Todd's Umbrel today the backfill runs on the M1 test data; at cutover the old app's database is migrated through 001-051, so its jobs get numbers the same way.

## 2. Intake: a job for every sent quote

New module `lib/quotedjobs.js`, called from `storeAnswer` in `lib/joinr-open-quotes.js` **after** the cache transaction commits (`joinr-open-quotes.js:231-254`), inside its own try/catch so a failure never undoes the cache or escapes the timer (the module's rule: `refresh()` never throws, `joinr-open-quotes.js:15`). It runs as one transaction with `SYSTEM_REQ` (`lib/intake.js`, exported at the end of the file) as the audit actor.

`apply(db, lines, {truncated})` does sections 2.1 to 2.5, in that order, for each line.

### 2.1 Baseline (decision 8: no data changes at release)

If `joinr_quote_seen_meta.baseline_at` is NULL, this fetch is the first good one since 051: every line gets a `joinr_quote_seen` row with `baseline = 1`, `job_id` = the job whose `external_ref` is the root (if any), no job is made, and `baseline_at` is set. So quotes already out with clients at release, like quotes already in the inbox, are handled by hand. Q3.

### 2.2 New root quote

A `sent` line whose `rootQuoteId` has no `joinr_quote_seen` row:

1. If a job already has `external_ref = rootQuoteId`, or a `joinr_intake` row has that root: record it as seen with that `job_id` (or NULL) and stop. (The won-quotes path got there first.)
2. Otherwise the clash rules of today's won path, with today's matcher (`lib/intake.js:243-257`: same quote number, case-insensitive, no `external_ref`, not archived, not lost):
   - **exactly one match**: that job gets `external_ref = rootQuoteId` and its empty `joinr_quote_url`, `quote_number`, `client_name`, `site_address`, `value_cents` filled from the line (the same fill-only-empty rule as `linkFills`, `lib/intake.js:418-433`). Its stage is not changed. Audited `job.update` and `joinr.link_quoted` (`entityType: "job"`).
   - **two or more**: nothing is made; the job is not created. One `joinr.new` style alert to `design.view`: "Sent in Joinr: more than one job has quote number X. Link it from the job." (kind `joinr.quoted_clash`, link `/jobs.html?q=<quote number>`), once per root. The line stays in the Pipeline's Quoted column as today, so it is not lost. (The inbox holds only won-feed records, so a sent quote cannot be put there without a schema change; see Q5.)
   - **none**: a new job, `stage = 'quoted'`, `source = 'joinr'`, `external_ref = rootQuoteId`, `quote_number`, `name` (site address, else label, else client name, else quote number, else "Joinr quote", clipped to 200, as `acceptTx` builds it at `lib/intake.js:346`), `client_name`, `site_address`, `value_cents = valueIncGstCents`, `joinr_quote_url = url`, `quoted_date` = the date part (Sydney) of `sentAt`, else today; `project_owner_id` NULL; `stage_changed_at` and `updated_at` now. The trigger gives it its job number. Audited `job.create` with `via: "joinr_sent"`. No drawers, no Materials prefill and no design team task yet (the line carries none of that; they come with the win, as today).
3. Record the `joinr_quote_seen` row (`job_id` set, `last_quote_id`, `last_line`).
4. A new **unassigned** job alerts every `design.view` holder: kind `job.unassigned`, title "New job from Joinr: <name>", body "<client>. No project manager yet.", link `/job.html?id=N`, `entityType: "job"`, `entityId: N` (`notify.toKey`, `lib/notify.js:38`).

A `won` line with no seen row is recorded as seen and nothing else: wins are made by the won-quotes feed only (`joinr-crosscuts-intake.md:292`: "the won-quotes feed is the record of wins").

**Idempotency:** the `joinr_quote_seen` primary key and the unique `jobs.external_ref` index (`db/migrations/003_jobs.js:45`) mean a repeated fetch, a restart mid-run, or two refreshes racing (they cannot: `refresh` shares one in-flight fetch, `joinr-open-quotes.js:315-320`) never make a second job. A unique-constraint failure on `external_ref` inside the transaction is treated as "already done".

### 2.3 Revisions

For a line whose seen row has a `job_id` and whose job is still at `quoted` (or the retired `lead`) and still has `external_ref = rootQuoteId`: if `quoteId`, `quoteNumber`, `valueIncGstCents`, `url`, `siteAddress`, `clientName` or `label` differ from `last_line`, update the job's `value_cents`, `joinr_quote_url`, `quote_number` (the job number stays as it was), and `client_name` / `site_address` only where the job's value is still the one the last line gave (a hand edit is never overwritten). Audited `job.update` with `via: "joinr_revision"` and the before/after. `last_quote_id`, `last_line`, `last_seen_at` move. A job past Quoted is never touched by the open-quotes list.

### 2.4 Won (the won-quotes feed; `lib/intake.js` `autoDecide`, ~`524-556`)

One new first step in `autoDecide`, before `matches()`:

- If a live job has `external_ref = row.root_quote_id` (the job section 2.2 made or linked), call the new **`adoptTx(db, req, id, jobId)`**: as `linkTx` (`lib/intake.js:437-523`) except that it does not refuse a job tied to this same root and does not require the quote number to match. It fills empty columns from the full won payload (`linkFills`), moves `quoted`/`lead` to `won` with the Joinr won date (as `linkTx` does), fills drawers and Materials (`payloadDrawers`, `fillMaterials`), sets the intake row `state = 'linked'`, `job_id`, and audits `job.update` and `joinr.link` with `adopted: true`. Then the existing design team task, `teamTasks.createFromJoinr(..., mode: "linked")`, as now (`lib/intake.js:546-551`).
- **New rule:** after the move to Won, a job that already has a project manager moves on to Projects at once (`jobstage.moveStage(..., {stage: "projects", from: "won"})`, the same move `setOwner` makes, `lib/projectjobs.js:81-87`), so a PM assigned while quoting doesn't have to re-assign.
- A job already further along than Quoted stays where it is (as `linkTx`).
- Otherwise `autoDecide` is unchanged: 1 match → link, 0 → accept (a quote that was won without ever being listed as sent, or won before the baseline), 2+ → inbox.
- The manual Accept from the inbox still answers 409 "A job already has this Joinr quote" with the job id when a Quoted job holds the root (`lib/intake.js:343-344`); the inbox page's existing Link button works through `adoptTx` for that job (the route chooses `adoptTx` when `job.external_ref === row.root_quote_id`).

### 2.5 Lost, withdrawn, archived

- **No automatic stage change** (recommended; Q1). A quote absent from a good, **untruncated** fetch gets `missing_since` set (cleared when it comes back). A job at `quoted` whose seen row has `missing_since` shows an orange line on the job page and a "Not open in Joinr" mark in the jobs table: "No longer open in Joinr (won, lost, archived or deleted) since D Mon. Set the stage if it is lost." The PM moves it to Lost by hand (the existing stage control).
- A truncated fetch never sets `missing_since` (the quote may only have fallen past the 200-line cap).
- A job past Quoted is never touched. The won-quotes `unwon`/`deleted` handling is unchanged (`joinr-sync.js:627-630,660-672`: a decided record is flagged "Changed in Joinr", the job is not changed).

### 2.6 Pipeline

`fromCache` (`routes/pipeline.js:38-50`) additionally leaves out a line whose `root_quote_id` is a job's `external_ref`, so a quote with its own job shows once (as the job), not twice:

```sql
AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.external_ref = c.root_quote_id)
```

### 2.7 Quotes already in the inbox at release

Untouched. `joinr_intake` rows in state `new` stay there for a person (decision 8). 051 writes nothing to `joinr_intake`; `quotedjobs.apply` never reads or changes intake state except the "already held" test in 2.2 step 1.

## 3. Project manager

- `jobs.project_owner_id`, unchanged in the database and the API (`ownerId`, `GET /api/project-owners`, `PUT /api/job-records/:id/owner`, `routes/projectjobs.js:39-50`). Every UI label that says "Project owner" / "Owner" for it reads **"Project manager"** (`public/projectowner.js`, `public/job.js`, `public/project.html|js`, `public/pipeline.js`, the jobs table). Alert text in `lib/projectsteps.js` "needs a project owner" (`lib/projectsteps.js:360`) becomes "needs a project manager"; the kind `project.owner_needed` stays (no smoke asserts the title; check with `grep -n "needs a project" ci/` at build).
- **Who may assign:** unchanged: `users.admin`, or `jobs.edit` together with `design.view` (`canSetOwner`, `routes/projectjobs.js:35-37`). The PM must be an active user with `design.view` (`checkOwner`, `lib/projectjobs.js:54-61`).
- Assigning at Quoted leaves the job at Quoted (`setOwner` moves only Won to Projects, `lib/projectjobs.js:81`).
- **New alert:** `setOwner` (`lib/projectjobs.js:63-90`), when it sets a new non-null PM who is not the person assigning: `notify.toUser(pm, {kind: "job.pm_assigned", title: "You are project manager for <name>", body: "<job number> · <client>", link: "/job.html?id=N", entityType: "job", entityId: N})`. Clearing or re-setting the same PM sends nothing.
- The unassigned alert is section 2.2 step 4 (new jobs from Joinr only; a hand-made job is made by someone who can assign it). The existing Won-without-owner sweep to admins (`lib/projectsteps.js:339-365`) is unchanged.

## 4. API

All declared with `defineRoutes` and an access value (`lib/routes.js:27`; boot refuses an unguarded `/api` route, `lib/routes.js:93`). Errors are `{error}` with 400 (bad input), 403 (rule refused), 404 (no job / no note / note deleted), 409 (conflict). New router `routes/jobnotes.js` = `defineRoutes("/api/job-records")`, mounted in `server.js` beside `routes/jobs` (`server.js:58`).

### 4.1 Notes

A note as JSON: `{id, jobId, body, createdAt, editedAt, author: {id, name}, files: [{id, name, mime, size, url: "/api/files/<id>", image: bool}], canEdit, canDelete}`. `canEdit` = the caller wrote it; `canDelete` = the caller wrote it or holds `users.admin`.

| Method, path | Access | Body | Answer | Rules |
|---|---|---|---|---|
| `GET /api/job-records/:id/notes` | `jobs.view` | none | `{notes: [...]}`, newest first, deleted left out | 404 no job |
| `POST /api/job-records/:id/notes` | `jobs.view` | `{body}` | 201 the note | body trimmed, 1-5000 chars else 400. Audited `job.note_add` (`entityType: "job_note"`, after `{jobId, body}`). Touches no `jobs` column. |
| `PATCH /api/job-records/:id/notes/:noteId` | `jobs.view` | `{body}` | the note | author only, else 403; deleted 404. Sets `edited_at`. Audited `job.note_edit` with before/after body. No time limit (Todd: own notes). |
| `DELETE /api/job-records/:id/notes/:noteId` | `["jobs.view", "users.admin"]` | none | `{ok: true}` | author, or `users.admin`, else 403. Soft: `deleted_at`, `deleted_by`; its files' `files.removed_at`/`removed_by` set (the file stays on disk, as task files do). Audited `job.note_delete` with the body and `byAdmin: true` when not the author. Already deleted 404. |
| `POST /api/job-records/:id/notes/:noteId/files` | `jobs.view` | multipart, field `file` (`files.single("file")`) | 201 the note | author only (403), at most 10 files per note (409 "A note holds at most 10 files"). Handler shape exactly as `routes/tasks.js:72-88` (accept, link, discard on any error, `.part` removed before the reply). Audited `job.note_file`. |
| `DELETE /api/job-records/:id/notes/:noteId/files/:fileId` | `["jobs.view", "users.admin"]` | none | the note | as note delete. Audited `job.note_file_remove`. |

`GET /api/files/:id` (`routes/files.js:15-31`) gains one allow branch: the file is in `job_note_files`, its note is not deleted, and the caller holds `jobs.view`. Anything else stays 404.

The pinned **Job summary** is the existing `notes` field on the job (`public/job.js:121`) and the Projects notes (`PUT /api/job-records/:id/project/notes`, `routes/projectjobs.js:64`), shown together at the top of the Notes tab, unchanged in the API.

### 4.2 Jobs list

`GET /api/job-records` (`routes/jobs.js:234-269`, `jobs.view`) gains, all optional and combinable with today's `stage`, `archived`, `q`:

- `mine=1`: `project_owner_id = <caller>`.
- `unassigned=1`: `project_owner_id IS NULL AND stage NOT IN ('complete','invoiced','lost','archived') AND archived = 0`.
- `mine` and `unassigned` together: 400.
- `q` also matches `job_number` and `quote_number`.
- Any other value for `mine`/`unassigned` than `1` or empty: 400.

Each job object already carries every column camel-cased (`toJob`, `routes/jobs.js:132-140`), so `jobNumber` and `projectOwnerId` appear by themselves. New fields: `projectManager: {id, name, hue} | null`, `lastActivityAt`, `notOpenInJoinr` (bool, section 2.5).

**Last activity** = the latest of: `jobs.updated_at`; the job's newest non-deleted `job_notes.created_at` or `edited_at`; its newest `photos.created_at` (stored as `YYYY-MM-DD HH:MM:SS` UTC, `db/migrations/001_baseline.sql:10`; normalised to ISO before comparing). One grouped query each, joined in JS, not per row.

Order stays `name` (the table sorts on the page).

### 4.3 Invoices on the job

No new route. The tab uses the existing `GET /api/invoices/job/:jobId` (`routes/invoices.js:161`, `accounts.view`), as the job page already does (`public/job.js:390`). Read-only: kind, amount, due date, paid, and a link to Accounts. **The tab is shown only to `accounts.view` holders**; others don't see it (Q6: the design_pm preset has no `accounts.view`, `lib/permissions.js:82-87`).

## 5. Pages

House style throughout: ink ground, teal accent, outlined uppercase buttons, Arial/Helvetica, no icons, emoji or shadows. New classes are `jo-` / `jn-` (page classes); `cc-` is only for the shell (CLAUDE.md rule 8). `ci/style-check.js` must pass.

### 5.1 `job.html`

- **Header (fixed under the menu bar, `--shell-h`):** job number, name, stage, client, site, Project manager (the existing `#pjOwner` control moves into it), and the orange lines (`#banner`, `#confirmComplete`, "No longer open in Joinr").
- **Tabs** (buttons in a `role="tablist"` strip; text only):

  | Tab | Holds (existing sections, moved, not rewritten) |
  |---|---|
  | Overview | `#meta`, `#form`, `#people` |
  | Quote | `#joinr`, `#fullquote` (for a Quoted job from the open-quotes list, the line's value, revision and link, and "The full quote arrives when the quote is won") |
  | Notes | Job summary, then the new notes list (`#jobNotes`, `#jnForm`, `#jnBody`, `#jnFile`, `#jnAdd`, `#jnList`) |
  | Photos | `#photos` (job photos, needs `photos.search`), then "Photos on notes" (`#jnPhotos`, images from note files) |
  | Invoices | `#invoices` (accounts.view only) |
  | Orders & materials | `#materials`, `#orders`, `#drawersBlock`, `#orderForm` |
  | Planner & tasks | `#planner`, `#tasks`, `#comments` |
  | Workshop | `#benchtops` (stone), `#reservations` (stock), `#issues`, `#inspection` |

  A tab whose sections are all hidden for the caller (permissions) is not shown.
- **Remembered tab:** `localStorage` key `cc.job.tab`, every read and write in try/catch; the page works with no storage.
- **Deep links win:** a hash naming a section (`#orders`, `#issues`, `#inspection`, `#reservations`, `#comments`, `#confirmComplete`, all used in alert and Planner links: `lib`, `routes`, `public` and `ci/smoke-m7-auto.sh:159,166,226`, `ci/smoke-m25-shift.sh:112-121`, `ci/smoke-m10-orders.sh:186`) opens the tab holding it and scrolls to it. A hash naming a tab (`#tab-notes`) opens that tab.
- **Implementation:** `public/jobtabs.js` + `jobtabs.css` move the existing section elements into tab panels at load; the HTML keeps every section element and its id **in the served file** (the smokes read the raw HTML). Section scripts stay as they are.
- **Element ids that must survive** (asserted in the raw HTML by `curl` + `case`, each followed by its script tag later in the file):
  - `id="pjOwner"` before `projectowner.js` (`ci/smoke-m22-project-jobs.sh:48-49`)
  - `id="issues"` before `jobissues.js` (`ci/smoke-m25-shift.sh:129-130`)
  - `id="confirmComplete"` before `confirmcomplete.js` (`ci/smoke-m26-morning-complete.sh:70-71`)
  - `id="reservations"` before `jobreserve.js` (`ci/smoke-m27-workshop-manager.sh:271-272`)
  - Keep **every** id in today's `job.html` (list: `cc-shell title banner people pjOwner confirmComplete meta form joinr joinrStatus joinrBody fullquote fqBody materials jm* orders ordersSummary ordersStatus ordersBody showCancelled drawersBlock drawersStatus drawersBody addDrawers orderForm o* reservations rs* benchtops jt* inspection inspection* i* planner plannerStatus plannerBody issues issuesList photos photosStatus photosBody photoForm pFiles pTags pUpload tasks newTask tasksStatus tasksBody comments commentsBody invoices invoicesBody` and the `*-h` headings), because `job.js` and the section scripts find them by id; and keep the script order (`job.html` script tags: `shared.js` ... `confirmcomplete.js`, `jobreserve.js`, `/shell/shell.js`), adding `jobnotes.js` and `jobtabs.js` before `/shell/shell.js`.
  - `ci/smoke-m10-orders.sh:107-108` expects 403 for `/job.html` without `jobs.view`: unchanged.
- **Phone (< 720 px):** the header folds to one line (job number, name, stage) with a "More" toggle for client, site and PM; the tabs become one horizontally scrolling strip (the strip scrolls, never the page; no horizontal page scroll at 375 px); 44 px targets; the note form is full width with the file picker (`accept="image/*,.pdf"` plus the other allowlisted types, `capture` not forced).
- Print: all panels print in order, black on white, tabs hidden.

### 5.2 `jobs.html`

A table: **Job no. | Name | Client | Stage | Project manager | Last activity** (relative, with the full date in a `title`), each row a link to `/job.html?id=N`. Filters above it, outlined buttons: **My jobs** (the default for a user who is PM on at least one live job; else **All**), **Unassigned**, **All**, plus today's stage select (`#stage`), search (`#q`) and Show archived (`#showArchived`). Keep the ids `newJob q stage showArchived head rows count`. Remember the filter in `localStorage` key `cc.jobs.filter` (try/catch). Sort by clicking a column heading (client-side). Phone: the table becomes stacked rows (job no. and stage on line one, name, then client and PM), no horizontal page scroll.

## 6. Smoke plan

### 6.1 New `ci/smoke-jobs-tradify.sh`

`ci/smoke.sh` sources the M-numbered files by glob (`ci/smoke.sh:1179-1277`); this file is not matched, so `smoke.sh` gets one line after the m28 loop: `[ -f "$(dirname "$0")/smoke-jobs-tradify.sh" ] && source "$(dirname "$0")/smoke-jobs-tradify.sh"` (before `smoke-backup.sh`). Fixed fake ports only (memory: parallel smoke port clash). Outline:

1. **Migration:** `job_number` filled and unique for every job made by earlier smokes; a Joinr job's number is its quote number; a hand-made job's is `J-` + padded id; two jobs sharing a quote number both got J- numbers (seed two such jobs, insert a third through the API and check the trigger).
2. **Baseline:** if `joinr_quote_seen_meta.baseline_at` is NULL, one refresh takes it and makes no job (job count unchanged, every line `baseline = 1`). If m16 already took it, assert it is set.
3. **New sent quote:** post a new sent line (new root) to `/_control/openquotes`, unguard, refresh: one job at `quoted`, `source = joinr`, `external_ref` = root, `jobNumber` = quote number, `projectOwnerId` null; one `job.unassigned` alert per `design.view` holder; audit `job.create` with `via: "joinr_sent"`; the line is gone from `GET /api/pipeline/joinr-quotes`. Refresh again: still one job, one alert (idempotent).
4. **Clash:** one typed-in job with quote number X → the sent line links it (stage unchanged, `external_ref` set). Two typed-in jobs with Y → no job, one `joinr.quoted_clash` alert, the line still in the Pipeline.
5. **Revision:** same root, new `quoteId` and value → the job's value and URL move, its job number does not; a hand-edited client name is kept; audited `via: "joinr_revision"`.
6. **Won:** a won-quotes `won` item for that root → the same job (no second job), stage `won`, intake `linked`, the design team task made once, drawers/materials filled; with a PM set first → stage `projects`.
7. **Missing:** an untruncated list without the root → `notOpenInJoinr: true`, stage still `quoted`; a truncated list does not set it; back in the list clears it.
8. **PM:** assign by a dpm → the PM gets one `job.pm_assigned`; self-assign gets none; a showroom user 403; a PM without `design.view` 400.
9. **Jobs list:** `mine=1`, `unassigned=1`, both 400, `q` by job number; `lastActivityAt` moves when a note is added.
10. **Notes:** add (201), list newest first, edit own (edited_at set), edit another's 403, delete another's 403 for a non-admin, admin delete 200 with audit `byAdmin`, deleted note gone from the list and 404 on edit; body empty or 5001 chars 400; no `jobs.view` 403.
11. **Note files:** upload a PNG (201), a `.exe` renamed `.png` 400, 25 MB + 1 413/400 as `lib/files.js` answers; the file serves with `jobs.view` and 404 without; after the note is deleted 404; **`GET /api/photos` and `GET /api/photos?jobId=N` never list it** and `photos` row count is unchanged; 11th file 409.
12. **Pages:** raw `job.html` holds the four smoke-asserted ids with their scripts, plus `jobtabs.js`, `jobnotes.js`, `id="jobNotes"`; `jobs.html` holds `id="rows"` and loads `jobs.js`.

### 6.2 Existing assertions affected

Because only the open-quotes list makes Quoted jobs, and the baseline is taken on the first good fetch, the M6 intake smokes (won-quotes feed) are **not** affected: no sent-only item ever reaches `applyItemInner` there (`joinr-sync.js:569`), and none of their jobs gets an `external_ref` before its won item. Checked: `ci/smoke-m6-intake.sh:211-215,276,300,348,543` and `ci/smoke-m6-inbox.sh:124,134,203,224` all concern won items and stay true.

`ci/smoke-m16-openquotes.sh` is the only smoke that drives the open-quotes list. Its first good fetch (`:201-204`) is the baseline, so it makes no job and these stay true unchanged:

- `:204` the Quoted-column order `["M16-W1","M16-S1","M16-W4","M16-S2"]`
- `:210` eleven cached lines
- `:244`, `:260` `(.quotes | length) == 4` after 429 / failures
- `:276-277` truncated pass-through, `:279-282` replaced whole (S1 already seen: a revision, no job), `:285-286` empty list
- `:290-295` the 505 lines inserted straight into the cache by SQL (no refresh, so no jobs)

**Order risk:** if any smoke sourced before m16 (`smoke-m2-*` to `smoke-m15-*`) or the background timer (first tick 40 s, `joinr-open-quotes.js:30`) makes a good open-quotes fetch first, the baseline is taken there and m16 is still unaffected (its roots are then new, and `:201` would make jobs for M16-S1, S2 and the won lines' roots stay won-only). Today no earlier smoke serves the open-quotes list (the fake answers 404 until `/_control/openquotes`), so this does not happen; the new smoke 6.1 step 2 copes either way. **To add to m16** (so the order risk is visible, not silent): after `:210`, `expect_eq "$(m16_val "SELECT baseline_at IS NOT NULL AS v FROM joinr_quote_seen_meta")" "1"` and `SELECT COUNT(*) FROM jobs WHERE source='joinr' AND stage='quoted'` unchanged from before `:201`.

Text-only changes from section 3 (label "Project manager", "needs a project manager"): grep `ci/` for "project owner" titles at build; none found in assertions on alert titles today (`grep -n "needs a project" ci/` empty when this was written; recheck).

## 7. Build waves

Disjoint files per piece, so each wave's pieces can run in parallel (one full smoke run at a time; memory: local smoke harness).

**Wave 1 (foundation, one builder):** `051_jobs_tradify.sql`; `routes/jobs.js` list filters and columns (4.2). Gate: boots on a copy of the dev DB, every job numbered.

**Wave 2 (parallel):**
- A. Intake: `lib/quotedjobs.js`, the hook in `lib/joinr-open-quotes.js`, `adoptTx` + `autoDecide` step in `lib/intake.js` (and the inbox Link route choosing it, `routes/joinr.js`), `routes/pipeline.js` `fromCache`.
- B. Notes API: `lib/jobnotes.js`, `routes/jobnotes.js`, `server.js` mount, `routes/files.js` branch.
- C. PM: `lib/projectjobs.js` alert, `lib/projectsteps.js` title text, label text in `public/projectowner.js`, `public/project.html|js`, `public/pipeline.js`.

**Wave 3 (parallel):**
- D. Job page: `public/job.html`, `public/job.js` (only what the tabs need), `public/jobtabs.js|css`, `public/jobnotes.js` (+ its CSS in `jobtabs.css`).
- E. Jobs list: `public/jobs.html`, `public/jobs.js`.

**Wave 4:** `ci/smoke-jobs-tradify.sh`, the `ci/smoke.sh` source line, the m16 additions; style check; overflow 375-1100; screenshots on PC and phone for Todd; STATUS.md.

## 8. Version

Stays **0.2.8**. The CI guard (`.github/workflows/publish.yml:71-83`) compares `crosscuts/app/package.json` at the push's `before` commit with the pushed one and fails only if app code changed and the version is the same. `origin/main` holds 0.2.7 (checked: `git show origin/main:crosscuts/app/package.json`), local holds 0.2.8, so one push carrying 0.2.8 and this feature passes, however many local commits it holds. `package-lock.json` root version is already in step with 0.2.8 (bumped with the Planner work). The merge job's "tag must not exist" check (`publish.yml:180-183` area) passes because 0.2.8 was never published.

## 9. Open questions for Todd

1. **Where new quotes come from (blocks section 2).** The won-quotes feed carries only won quotes, so jobs for new quotes can only come from the open-quotes list: a job appears **when the quote is marked sent** in Joinr (drafts are never listed), within about 5 minutes. OK? The alternative, a job at first draft, needs a Joinr change ("THIS WILL TOUCH JOINR").
2. **Lost quotes.** Joinr's list cannot tell lost from archived or deleted. This contract never moves a job to Lost by itself; it shows "No longer open in Joinr" and the PM sets Lost. OK, or should a Quoted job move to Lost automatically after, say, 7 days absent? (Risk: an archived-but-live quote becomes Lost.)
3. **Quotes already sent at release.** The first fetch after release is a baseline: no jobs for quotes already out with clients (matches decision 8 for the inbox). Or should every currently sent quote get its job on day one (up to 200 jobs at once)?
4. **J- numbers** use the job id (`J-0042`), so the series has gaps where Joinr-numbered jobs took ids. OK, or a gapless counter (needs a sequence table and one more write per insert)?
5. **Two jobs already carry a sent quote's number.** No job is made and design.view is alerted, but there is no inbox entry for a sent quote (the inbox is the won feed). OK?
6. **Invoices tab** is shown only to holders of `accounts.view` (Todd, Tracey, admins). PMs on the design_pm preset don't have it, so they won't see the tab. Give design_pm read-only invoices (a new key, the 40th), or leave it?
7. **Who may add notes:** this contract lets anyone who can see the job (`jobs.view`, which includes Accounts and Scheduling) add notes. OK, or `jobs.edit` only?

## 10. Risks

- **The open-quotes list is a 200-line snapshot.** A burst of more than 200 open quotes could hide a new one until older ones close; a truncated fetch still makes jobs for new roots it does show.
- **Duplicate job risk at the won step** is closed by `adoptTx` looking up `external_ref` before `matches()`; if `adoptTx` failed, `acceptTx` would hit the unique `external_ref` index and the record would stay `new` in the inbox (safe, not silent: today's alert fires).
- **Smoke order** (6.2): the baseline is taken by whichever good fetch comes first. Covered by the m16 additions.
- **Notes body is free text** shown on the page: render with `textContent` only.
